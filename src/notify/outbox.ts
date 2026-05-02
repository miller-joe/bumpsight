import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { NotifyMessage } from "./types.js";

/**
 * Archive every dispatched notification to disk so a human (or Claude) can
 * read what actually went out without having to re-render or re-call the
 * LLM. Lives at `BUMPSIGHT_OUTBOX_DIR` (default `/var/lib/bumpsight/outbox`),
 * one JSON file per dispatch.
 *
 * Filenames are `<ISO-timestamp>-<kind>-<short-id>.json`, sortable by name
 * and easy to grep. Retention is bounded — by default only the most recent
 * 200 files are kept; older ones are unlinked on every write to amortize
 * cleanup. Operators on tiny disks can shrink the keepCount via env.
 *
 * Failures here NEVER throw — archiving is best-effort. If the disk is
 * full or the dir is read-only, we want the daemon to keep delivering
 * notifications, just without the audit trail.
 */
export interface OutboxOptions {
  /** Directory to write archive files. Created on first write if missing. */
  dir: string;
  /** Most recent N files to retain. Older files unlinked after each write. */
  keepCount?: number;
}

export interface ArchiveContext {
  /** Free-form tag for the kind of message: `hold`, `applied`, `failed`, `digest`, `apply-failure`. */
  kind: string;
  /** Optional row id(s) the message refers to — embedded in the archive metadata. */
  rowIds?: number[];
  /** Optional advise summary text the daemon rendered into this email. */
  adviseText?: string;
  /** Optional delivery result summary. */
  delivered?: number;
  /** Optional list of notifier failure messages. */
  deliveryErrors?: { name: string; error: string }[];
}

interface ArchiveRecord {
  timestamp: string;
  kind: string;
  subject: string;
  body: string;
  htmlBody?: string;
  rowIds?: number[];
  adviseText?: string;
  delivery?: {
    delivered?: number;
    errors?: { name: string; error: string }[];
  };
}

const DEFAULT_KEEP_COUNT = 200;

/**
 * Archive one outgoing message. Best-effort: any I/O error is swallowed
 * (archiving must not break notification delivery). The optional `log`
 * callback gets a one-line summary of what was archived OR what failed.
 */
export function archiveMessage(
  opts: OutboxOptions,
  msg: NotifyMessage,
  ctx: ArchiveContext,
  log?: (msg: string) => void,
): void {
  try {
    mkdirSync(opts.dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const shortId = ctx.rowIds && ctx.rowIds.length > 0 ? `r${ctx.rowIds[0]}` : "n";
    const fname = `${ts}-${ctx.kind}-${shortId}.json`;
    const path = join(opts.dir, fname);

    const record: ArchiveRecord = {
      timestamp: new Date().toISOString(),
      kind: ctx.kind,
      subject: msg.subject,
      body: msg.body,
      htmlBody: msg.htmlBody,
      rowIds: ctx.rowIds,
      adviseText: ctx.adviseText,
    };
    if (ctx.delivered !== undefined || ctx.deliveryErrors !== undefined) {
      record.delivery = {
        delivered: ctx.delivered,
        errors: ctx.deliveryErrors,
      };
    }
    writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
    pruneOldArchives(opts.dir, opts.keepCount ?? DEFAULT_KEEP_COUNT);
    log?.(`outbox: archived ${ctx.kind} → ${fname}`);
  } catch (err) {
    log?.(`outbox: archive failed (${(err as Error).message}); continuing`);
  }
}

/**
 * Keep only the most recent `keepCount` files; unlink the rest. Order is
 * by modification time (most recent kept). Hidden files are ignored.
 *
 * Best-effort: any unlink failure is silently skipped — partial pruning
 * is fine, the next archive call will retry.
 */
function pruneOldArchives(dir: string, keepCount: number): void {
  if (keepCount <= 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const stats = entries
    .filter((name) => !name.startsWith(".") && name.endsWith(".json"))
    .map((name) => {
      const path = join(dir, name);
      try {
        return { name, path, mtime: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { name: string; path: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime);

  if (stats.length <= keepCount) return;
  for (const entry of stats.slice(keepCount)) {
    try {
      unlinkSync(entry.path);
    } catch {
      // ignore — partial pruning is acceptable
    }
  }
}
