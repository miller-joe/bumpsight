import { dirname, basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import { loadComposeFile, parseImageRef } from "../compose/parse.js";
import { isSupportedRegistry, listTags } from "../registry/index.js";
import { findLatestInFamily } from "../util/semver.js";
import { classifyBump, decideAction } from "./rules.js";
import type { BumpKind, RulesConfig } from "./rules.js";
import type { DaemonConfig } from "./config.js";
import {
  recordUpdate,
  setNotified,
  findUpdate,
  type UpdateRow,
} from "../state/db.js";
import { notifyAll } from "../notify/index.js";
import type { Notifier, NotifyMessage } from "../notify/types.js";

export interface ScanRunResult {
  /** Number of services examined across all compose files. */
  scanned: number;
  /** Number of new bumps discovered (not seen in DB before). */
  discovered: number;
  /** Number of bumps queued for auto-apply. */
  autoApplied: number;
  /** Number of bumps held for human approval. */
  held: number;
  /** Errors encountered, keyed by image ref. */
  errors: Record<string, string>;
}

export interface ScanRunDeps {
  db: DB;
  notifiers: Notifier[];
  rules: RulesConfig;
  composeFiles: string[];
  /** For tests: inject a tag lister. Defaults to the real registry client. */
  listTagsFn?: typeof listTags;
  /** For tests: inject a clock. Defaults to Date.now. */
  now?: () => number;
}

/**
 * One pass of the daemon: scan every configured compose file, record any
 * new bumps in the DB, dispatch hold-for-approval notifications, and
 * leave auto-applies queued for the apply loop (Phase B).
 */
export async function runScanOnce(
  deps: ScanRunDeps,
): Promise<ScanRunResult> {
  const result: ScanRunResult = {
    scanned: 0,
    discovered: 0,
    autoApplied: 0,
    held: 0,
    errors: {},
  };
  const lister = deps.listTagsFn ?? listTags;

  for (const composePath of deps.composeFiles) {
    const stack = stackNameFromPath(composePath);
    let compose: ReturnType<typeof loadComposeFile>;
    try {
      compose = loadComposeFile(composePath);
    } catch (err) {
      result.errors[composePath] = (err as Error).message;
      continue;
    }
    const services = Object.entries(compose.services ?? {}).filter(
      ([, svc]) => svc.image,
    );

    for (const [serviceName, svc] of services) {
      result.scanned += 1;
      const ref = parseImageRef(svc.image!);
      if (!isSupportedRegistry(ref)) continue;

      let latest: string | null;
      try {
        const tags = await lister(ref, {});
        latest = findLatestInFamily(
          ref.tag,
          tags.map((t) => t.name),
        );
      } catch (err) {
        result.errors[ref.raw] = (err as Error).message;
        continue;
      }
      if (!latest || latest === ref.tag) continue;

      const bump: BumpKind = classifyBump(ref.tag, latest);
      const decision = decideAction(deps.rules, stack, bump);
      if (decision === "skip") continue;

      const token = randomBytes(18).toString("base64url");
      const id = recordUpdate(deps.db, {
        stack,
        service: serviceName,
        image: ref.raw,
        currentTag: ref.tag,
        targetTag: latest,
        family: undefined,
        bump,
        approvalToken: token,
      });

      const row = findUpdate(deps.db, id);
      if (!row || row.status !== "pending") {
        // Already seen and decided — don't re-spam.
        continue;
      }
      result.discovered += 1;

      if (decision === "auto-apply") {
        result.autoApplied += 1;
        // Apply step lands in Phase B. For now we leave the row pending and
        // let a human or the future apply loop pick it up. We still send a
        // courtesy notification so the admin sees what's queued.
        await dispatchHoldNotification(deps.notifiers, row, "auto-apply queued");
        setNotified(deps.db, row.id);
      } else {
        result.held += 1;
        await dispatchHoldNotification(deps.notifiers, row, "approval needed");
        setNotified(deps.db, row.id);
      }
    }
  }
  return result;
}

function stackNameFromPath(path: string): string {
  return basename(dirname(resolve(path)));
}

async function dispatchHoldNotification(
  notifiers: Notifier[],
  row: UpdateRow,
  banner: string,
): Promise<void> {
  if (notifiers.length === 0) return;
  const msg: NotifyMessage = {
    subject: `[bumpsight] ${row.stack}/${row.service}: ${row.image} → ${row.target_tag} (${row.bump}, ${banner})`,
    body: [
      `Stack:   ${row.stack}`,
      `Service: ${row.service}`,
      `Image:   ${row.image}`,
      `From:    ${row.current_tag}`,
      `To:      ${row.target_tag}`,
      `Kind:    ${row.bump} bump`,
      ``,
      banner === "approval needed"
        ? `This bump is held for approval. Approve / deny links arrive in v0.3 (HTTP approval server).`
        : `This bump matches your auto-apply policy and will be applied by the apply loop (v0.3).`,
    ].join("\n"),
  };
  await notifyAll(notifiers, msg);
}

export interface DaemonRuntime {
  /** Stop the scheduler. Resolves when the in-flight scan finishes. */
  stop(): Promise<void>;
}

/**
 * Start the daemon scheduler. Invokes runScanOnce immediately and then
 * every `intervalMs`. Reports progress via the `log` callback so the
 * caller can route to stdout, journal, etc.
 */
export function startDaemon(
  cfg: DaemonConfig,
  deps: Omit<ScanRunDeps, "composeFiles" | "rules"> & {
    log: (msg: string) => void;
  },
): DaemonRuntime {
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopping) return;
    inFlight = (async () => {
      const started = Date.now();
      try {
        const result = await runScanOnce({
          db: deps.db,
          notifiers: deps.notifiers,
          rules: cfg.rules,
          composeFiles: cfg.composeFiles,
          listTagsFn: deps.listTagsFn,
          now: deps.now,
        });
        const ms = Date.now() - started;
        deps.log(
          `scan: ${result.scanned} services, ${result.discovered} new (${result.autoApplied} auto, ${result.held} held), ${ms}ms`,
        );
        for (const [k, v] of Object.entries(result.errors)) {
          deps.log(`scan-error: ${k}: ${v}`);
        }
      } catch (err) {
        deps.log(`scan-failed: ${(err as Error).message}`);
      }
    })();
    await inFlight;
    if (!stopping) {
      timer = setTimeout(tick, cfg.intervalMs);
    }
  };

  tick();

  return {
    stop: async () => {
      stopping = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
