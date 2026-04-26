import type { Database as DB } from "better-sqlite3";
import { findUpdate, setApplied, type UpdateRow } from "../state/db.js";
import { rewriteImageTag } from "./compose.js";
import { pullAndUp, type CommandRunner } from "./docker.js";

export interface ApplyDeps {
  db: DB;
  /** For each stack name, the compose file path we should rewrite. */
  composeFiles: Record<string, string>;
  /** Test seam — defaults to the real spawn-based runner. */
  runner?: CommandRunner;
}

/**
 * Apply a single update row: rewrite the compose file's tag, then run
 * `docker compose pull` + `up -d`. Records success/failure in the DB.
 *
 * The caller is responsible for choosing which row to apply (auto-apply
 * sweep or post-approval). If the row was already applied/failed, this
 * is a no-op and returns the existing row.
 */
export async function applyOne(
  deps: ApplyDeps,
  updateId: number,
): Promise<UpdateRow> {
  const row = findUpdate(deps.db, updateId);
  if (!row) throw new Error(`apply: update ${updateId} not found`);
  if (row.status === "applied" || row.status === "failed") return row;

  const composePath = deps.composeFiles[row.stack];
  if (!composePath) {
    setApplied(deps.db, row.id, {
      ok: false,
      log: `apply: no compose path configured for stack '${row.stack}'`,
    });
    return findUpdate(deps.db, updateId)!;
  }

  try {
    rewriteImageTag({
      composePath,
      serviceName: row.service,
      expectedCurrentTag: row.current_tag,
      newTag: row.target_tag,
    });
  } catch (err) {
    setApplied(deps.db, row.id, {
      ok: false,
      log: `apply: rewrite failed: ${(err as Error).message}`,
    });
    return findUpdate(deps.db, updateId)!;
  }

  const result = await pullAndUp({
    composePath,
    serviceName: row.service,
    runner: deps.runner,
  });
  setApplied(deps.db, row.id, { ok: result.ok, log: result.log });
  return findUpdate(deps.db, updateId)!;
}
