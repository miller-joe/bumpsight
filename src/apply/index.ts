import { readFileSync, writeFileSync } from "node:fs";
import type { Database as DB } from "better-sqlite3";
import { findUpdate, setApplied, type UpdateRow } from "../state/db.js";
import { rewriteImageTag, rewriteImageRef } from "./compose.js";
import { pullAndUp, type CommandRunner } from "./docker.js";
import { pruneOldImage, stripTagFromRef } from "./prune.js";
import { commitComposeChange } from "./git.js";
import {
  buildBundlePlan,
  formatBundleLog,
  parsePairedDepsJson,
  type BundlePlanResult,
} from "./paired-deps-plan.js";

export interface ApplyDeps {
  db: DB;
  /** For each stack name, the compose file path we should rewrite. */
  composeFiles: Record<string, string>;
  /** Test seam — defaults to the real spawn-based runner. */
  runner?: CommandRunner;
  /** v0.4.2: when false, skip the post-apply targeted prune. Default true. */
  pruneAfterApply?: boolean;
  /** v0.5.4: when true for this row's stack, atomically rewrite paired dep
   *  pins alongside the primary pin using the recommendations captured at
   *  hold time. Default false. */
  bundlePairedDeps?: boolean;
  /** When true, commit the rewritten compose file if its stack dir is a git
   *  working copy (so auto-bumps land as tracked commits instead of leaving
   *  the tree dirty). Opt-in; falls back to the BUMPSIGHT_GIT_COMMIT env flag.
   *  Best-effort — a git failure never fails the apply. Default false. */
  gitCommit?: boolean;
  /** When true (and gitCommit is on), also `git push` after committing.
   *  Falls back to BUMPSIGHT_GIT_PUSH. Default false. */
  gitPush?: boolean;
  /** When true (and gitCommit is on), chown `.git` back to the compose file's
   *  owner after committing — for operators running bumpsight as root against
   *  repos owned by an unprivileged uid. Falls back to
   *  BUMPSIGHT_GIT_RESTORE_OWNERSHIP. Default false. */
  gitRestoreOwnership?: boolean;
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

  // Moving-tag bumps (e.g. :latest digest changes that resolved to a semver
  // pair) keep the original `:latest` in the compose file — the upgrade is
  // achieved by `pull` picking up the new digest. Don't try to rewrite.
  const isMovingApply = row.family?.startsWith("moving:") ?? false;

  // v0.5.4: resolve the paired-dep bundle plan up front (when bundling is
  // enabled). We snapshot the compose file before any rewrites so a partial
  // failure can roll back the whole bundle atomically — the entire point of
  // bundling. Bundle is intentionally skipped on moving-tag applies (no tag
  // rewrites happen there at all).
  const bundling = deps.bundlePairedDeps === true && !isMovingApply;
  const plan: BundlePlanResult = bundling
    ? buildBundlePlan(composePath, parsePairedDepsJson(row.paired_deps_json))
    : { rewrites: [], skipped: [] };
  // Snapshot the compose before ANY rewrite so a failed apply (a rewrite drift
  // OR a failed docker pull/up) can be rolled back. A failed apply must never
  // leave the compose pinning a tag that wasn't successfully pulled — that drift
  // is invisible until the next recreate/reboot, and a bad target poisons every
  // future recreate. Moving-tag applies don't rewrite, so they need no snapshot.
  const composeSnapshot = !isMovingApply ? readFileSync(composePath, "utf-8") : null;
  const restoreSnapshot = () => {
    if (composeSnapshot !== null) {
      writeFileSync(composePath, composeSnapshot, "utf-8");
    }
  };

  if (!isMovingApply) {
    try {
      // v0.6.4: an upstream `image-change` recommendation carries a full target
      // ref, because the image NAME moves (redis -> valkey). Swapping only the
      // tag there would write a real-but-wrong image.
      if (row.target_image) {
        rewriteImageRef({
          composePath,
          serviceName: row.service,
          expectedCurrentRef: row.image,
          newRef: row.target_image,
        });
      } else {
        rewriteImageTag({
          composePath,
          serviceName: row.service,
          expectedCurrentTag: row.current_tag,
          newTag: row.target_tag,
        });
      }
    } catch (err) {
      restoreSnapshot();
      setApplied(deps.db, row.id, {
        ok: false,
        log: `apply: rewrite failed: ${(err as Error).message}`,
      });
      return findUpdate(deps.db, updateId)!;
    }

    // Bundle the paired dep rewrites in the same compose-edit transaction. If
    // any drift check fails here, restore the pre-apply file and mark the
    // whole row failed — half-applied bundles would surprise the operator.
    for (const rw of plan.rewrites) {
      try {
        rewriteImageTag({
          composePath,
          serviceName: rw.serviceName,
          expectedCurrentTag: rw.currentTag,
          newTag: rw.newTag,
        });
      } catch (err) {
        restoreSnapshot();
        setApplied(deps.db, row.id, {
          ok: false,
          log:
            `apply: paired-dep rewrite failed for ${rw.serviceName}: ${(err as Error).message}` +
            (plan.rewrites.length > 1
              ? `\n(bundle rolled back; primary pin restored to ${row.current_tag})`
              : ""),
        });
        return findUpdate(deps.db, updateId)!;
      }
    }
  }

  const services = [
    row.service,
    ...plan.rewrites.map((r) => r.serviceName).filter((s) => s !== row.service),
  ];

  const result = await pullAndUp({
    composePath,
    serviceName: services,
    runner: deps.runner,
  });

  // On ANY docker failure, roll the compose back to its pre-apply state. A
  // failed apply must leave the stack on its last-known-good (pulled, running)
  // image — never pinned to a tag that wasn't successfully pulled, which would
  // otherwise detonate on the next recreate/reboot. The row is still marked
  // `failed` and notified; a re-trigger re-applies cleanly from the restored
  // tag. (Before v0.5.6 only bundled applies rolled back; a plain single-service
  // bump left the rewrite in place and silently drifted the compose.)
  if (!result.ok) {
    restoreSnapshot();
  }

  // v0.4.2: targeted prune of the just-replaced image tag. Only attempted on
  // a successful apply where the bump rewrote a concrete tag (not a moving
  // tag — those still resolve through `:latest` and need the deep-prune
  // path). Always best-effort: a prune failure never marks the apply failed.
  let log = result.log;
  const bundleLog = formatBundleLog(plan);
  if (bundleLog) log += `\n${bundleLog}`;
  const shouldPrune =
    result.ok &&
    !isMovingApply &&
    deps.pruneAfterApply !== false &&
    row.current_tag !== row.target_tag;
  if (shouldPrune) {
    try {
      const prune = await pruneOldImage({
        runner: deps.runner,
        image: stripTagFromRef(row.image),
        oldTag: row.current_tag,
      });
      log += `\n==== ${prune.log} ====`;
    } catch (err) {
      log += `\n==== prune: skipped (${(err as Error).message}) ====`;
    }
  }

  // Commit the rewritten compose when the stack dir is a git working copy and
  // the feature is enabled. Best-effort, opt-in — only on a successful apply
  // that actually rewrote a tag (moving-tag applies don't touch the file).
  // Mirrors prune: a git failure is logged but never fails the apply.
  const gitCommit =
    deps.gitCommit ??
    (process.env.BUMPSIGHT_GIT_COMMIT === "true" ||
      process.env.BUMPSIGHT_GIT_COMMIT === "1");
  if (result.ok && !isMovingApply && gitCommit) {
    try {
      const depBumps = plan.rewrites.map(
        (r) => `${r.serviceName} ${r.currentTag}->${r.newTag}`,
      );
      const message =
        `${row.stack}: bump ${row.service} ${row.current_tag} -> ${row.target_tag}` +
        (depBumps.length ? ` (+${depBumps.join(", ")})` : "");
      const gitPush =
        deps.gitPush ??
        (process.env.BUMPSIGHT_GIT_PUSH === "true" ||
          process.env.BUMPSIGHT_GIT_PUSH === "1");
      const gitRestoreOwnership =
        deps.gitRestoreOwnership ??
        (process.env.BUMPSIGHT_GIT_RESTORE_OWNERSHIP === "true" ||
          process.env.BUMPSIGHT_GIT_RESTORE_OWNERSHIP === "1");
      const c = await commitComposeChange({
        composePath,
        message,
        push: gitPush,
        restoreOwnership: gitRestoreOwnership,
        runner: deps.runner,
      });
      if (c.log) log += `\n==== ${c.log} ====`;
    } catch (err) {
      log += `\n==== git: skipped (${(err as Error).message}) ====`;
    }
  }

  setApplied(deps.db, row.id, { ok: result.ok, log });
  return findUpdate(deps.db, updateId)!;
}
