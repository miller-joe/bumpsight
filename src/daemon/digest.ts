import type { Database as DB } from "better-sqlite3";
import {
  findUndigestedApplied,
  findUndigestedSuppressed,
  getLastDigestSent,
  markDigested,
} from "../state/db.js";
import { buildDigestEmail } from "../notify/digest.js";
import { archiveMessage } from "../notify/outbox.js";
import { notifyAll } from "../notify/index.js";
import type { Notifier } from "../notify/types.js";

/**
 * v0.4.3 daily-digest scheduler.
 *
 * Strategy: a 60s timer wakes up and asks `shouldFireDigest(now, lastSent,
 * hour)`. The scheduler fires once per local day, at the first wake-up at-or-
 * after the configured hour. Subsequent wake-ups on the same day do nothing.
 *
 * The "did we fire today" check uses `MAX(digested_at)` from the updates
 * table. That's a real persistent marker — if the daemon restarts mid-day
 * after a successful send, the new process won't double-fire.
 *
 * Edge cases:
 *   - Empty digest day: no rows are marked, so MAX(digested_at) doesn't
 *     advance. Next day's check still sees yesterday-or-earlier as the
 *     last fire and will attempt again. Empty days are silent (no email
 *     sent) per the v0.4.3 requirement, so that's fine.
 *   - Daemon down across the configured hour: catches up at the next start
 *     after the hour. Misses are acceptable — this is a daily roll-up, not
 *     a SLA timer.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface DigestSchedulerDeps {
  db: DB;
  notifiers: Notifier[];
  hour: number;
  publicUrl?: string;
  outboxDir?: string;
  outboxKeepCount?: number;
  /** How far back to look for un-digested rows. Defaults to 25h to allow a
   *  small overlap so border-of-window rows always show up exactly once. */
  windowMs?: number;
  log: (msg: string) => void;
  /** Test seam — overrides Date.now() for the scheduler. */
  now?: () => number;
}

export interface DigestRuntime {
  /** Stop the scheduler. Resolves after the in-flight (if any) digest
   *  send completes. */
  stop(): Promise<void>;
  /** Force one digest pass for tests / manual triggers. */
  runOnce(): Promise<boolean>;
}

/**
 * True iff a digest should fire right now: clock is at-or-past the configured
 * hour, and we haven't already fired on this calendar day.
 */
export function shouldFireDigest(
  now: Date,
  lastSentMs: number | null,
  hour: number,
): boolean {
  if (now.getHours() < hour) return false;
  if (lastSentMs === null) return true;
  const lastSent = new Date(lastSentMs);
  return !sameLocalDay(lastSent, now);
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Run a single digest pass. Returns true when an email was actually
 * dispatched, false when there was nothing to send (or send failed).
 */
export async function runDigestOnce(
  deps: DigestSchedulerDeps,
): Promise<boolean> {
  const windowMs = deps.windowMs ?? 25 * 60 * 60 * 1000;
  const applied = findUndigestedApplied(deps.db, windowMs);
  const suppressed = findUndigestedSuppressed(deps.db, windowMs);
  const rows = [...applied, ...suppressed];
  if (rows.length === 0) {
    deps.log("digest: nothing to report — skipping send");
    return false;
  }
  const built = buildDigestEmail({
    rows,
    date: new Date(deps.now ? deps.now() : Date.now()),
    publicUrl: deps.publicUrl,
  });
  if (!built) return false;
  if (deps.notifiers.length === 0) {
    // No notifiers configured — mark digested so we don't accumulate forever
    // and log so the operator knows we suppressed an empty-channel send.
    markDigested(deps.db, built.rowIds);
    deps.log(
      `digest: ${built.rowIds.length} row(s) marked digested (no notifiers configured)`,
    );
    return false;
  }
  const result = await notifyAll(deps.notifiers, built.message);
  if (deps.outboxDir) {
    archiveMessage(
      { dir: deps.outboxDir, keepCount: deps.outboxKeepCount },
      built.message,
      {
        kind: "digest",
        rowIds: built.rowIds,
        delivered: result.delivered,
        deliveryErrors: result.failed.length > 0 ? result.failed : undefined,
      },
    );
  }
  if (result.delivered > 0) {
    markDigested(deps.db, built.rowIds);
    deps.log(
      `digest: sent (${built.rowIds.length} rows: ` +
        `${built.sections.appliedAuto.length} auto, ` +
        `${built.sections.appliedApproved.length} approved, ` +
        `${built.sections.failures.length} failed, ` +
        `${built.sections.suppressedDigests.length} digest-class)`,
    );
    return true;
  }
  deps.log(
    `digest: send failed on every notifier (${result.failed
      .map((f) => `${f.name}: ${f.error}`)
      .join("; ")}); will retry next tick`,
  );
  return false;
}

/**
 * Start the digest scheduler. Wakes every 60s and fires once per local day
 * at-or-after the configured hour. Returns a runtime with stop() + runOnce()
 * for shutdown + manual triggers.
 */
export function startDigestScheduler(
  deps: DigestSchedulerDeps,
): DigestRuntime {
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopping) return;
    inFlight = (async () => {
      try {
        const now = new Date(deps.now ? deps.now() : Date.now());
        const lastSent = getLastDigestSent(deps.db);
        if (!shouldFireDigest(now, lastSent, deps.hour)) return;
        await runDigestOnce(deps);
      } catch (err) {
        deps.log(`digest-failed: ${(err as Error).message}`);
      }
    })();
    await inFlight;
    if (!stopping) {
      timer = setTimeout(tick, 60_000);
    }
  };

  // First tick after a short delay so the daemon's startup log gets to flush
  // first; subsequent ticks at 60s.
  timer = setTimeout(tick, 5_000);

  return {
    stop: async () => {
      stopping = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
    runOnce: async () => {
      const r = await runDigestOnce(deps);
      return r;
    },
  };
}

export const _internal = { ONE_DAY_MS, sameLocalDay };
