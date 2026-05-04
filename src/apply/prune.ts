import type { CommandRunner } from "./docker.js";
import { realRunner } from "./docker.js";

/**
 * v0.4.2: post-apply targeted image prune.
 *
 * After a successful version bump, the OLD image tag is no longer
 * referenced by the rewritten compose file. If no other container or
 * compose stack still uses it locally, we can free the disk space it
 * was occupying. Without this, version churn from frequent bumpsight
 * upgrades silently accumulates GB of unused image layers — Joe's
 * homelab grew from ~68 GB to 145 GB of docker storage in a few days
 * before this feature was added.
 *
 * Safety properties:
 *  - Never `--force`. If another container references the image (running
 *    OR stopped), Docker refuses removal and we report "kept".
 *  - Skipped entirely for moving-tag bumps (the rolling tag still points
 *    at the old digest implicitly via `:latest` and cleanup is the
 *    responsibility of the deep-prune path, not this targeted one).
 *  - Skipped when the image isn't present locally (already pruned).
 */

export interface PruneOptions {
  runner?: CommandRunner;
  /** Image ref WITHOUT a tag. E.g. `vaultwarden/server` or `ghcr.io/foo/bar`. */
  image: string;
  /** The old tag we want to clean up. E.g. `1.35.8`. */
  oldTag: string;
  /** When true, report what would happen but don't actually remove. */
  dryRun?: boolean;
}

export interface PruneResult {
  removed: boolean;
  /** Best-effort estimate of bytes freed (image's apparent size pre-removal). */
  freedBytes?: number;
  /** Human-readable log line for the apply log + email. */
  log: string;
}

const DOCKER_TIMEOUT_MS = 30_000;

export async function pruneOldImage(
  opts: PruneOptions,
): Promise<PruneResult> {
  const runner = opts.runner ?? realRunner;
  const ref = `${opts.image}:${opts.oldTag}`;

  const inspect = await runner(
    "docker",
    ["image", "inspect", "--format", "{{.Size}}", ref],
    { timeoutMs: DOCKER_TIMEOUT_MS },
  );
  if (inspect.exitCode !== 0) {
    return {
      removed: false,
      log: `prune: ${ref} not present locally (skipped)`,
    };
  }
  const size = Number(inspect.combinedOutput.trim());
  const sizeMB =
    Number.isFinite(size) && size > 0 ? Math.round(size / 1_048_576) : 0;

  if (opts.dryRun) {
    return {
      removed: false,
      freedBytes: Number.isFinite(size) ? size : 0,
      log: `prune (dry-run): would remove ${ref} (~${sizeMB} MB)`,
    };
  }

  const rm = await runner("docker", ["image", "rm", ref], {
    timeoutMs: DOCKER_TIMEOUT_MS,
  });
  if (rm.exitCode !== 0) {
    const firstLine = rm.combinedOutput.split("\n")[0]?.slice(0, 160) ?? "";
    return {
      removed: false,
      log: `prune: ${ref} kept (${firstLine})`,
    };
  }
  const layerDeletes = (rm.combinedOutput.match(/^Deleted: /gm) ?? []).length;
  if (layerDeletes === 0) {
    return {
      removed: true,
      freedBytes: 0,
      log: `prune: untagged ${ref} (layers shared with other images, 0 MB freed)`,
    };
  }
  return {
    removed: true,
    freedBytes: Number.isFinite(size) ? size : 0,
    log: `prune: removed ${ref}, freed ~${sizeMB} MB (${layerDeletes} layer${layerDeletes === 1 ? "" : "s"})`,
  };
}

/**
 * Strip a tag from an image reference. Keeps the registry/namespace prefix
 * and any digest suffix. Returns the bare image name.
 *
 *   "vaultwarden/server:1.35.8"               → "vaultwarden/server"
 *   "ghcr.io/immich-app/server:release"       → "ghcr.io/immich-app/server"
 *   "localhost:5000/myapp:1.0"                → "localhost:5000/myapp"
 *   "qmcgaw/gluetun"                          → "qmcgaw/gluetun"
 *   "qmcgaw/gluetun@sha256:abc..."            → "qmcgaw/gluetun"
 */
export function stripTagFromRef(ref: string): string {
  const atIdx = ref.indexOf("@");
  const head = atIdx >= 0 ? ref.slice(0, atIdx) : ref;
  const lastSlash = head.lastIndexOf("/");
  const lastColon = head.lastIndexOf(":");
  const tagColon = lastColon > lastSlash ? lastColon : -1;
  return tagColon >= 0 ? head.slice(0, tagColon) : head;
}
