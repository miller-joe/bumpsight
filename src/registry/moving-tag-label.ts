/**
 * v0.6.0: derive a human-readable "from → to" delta for a moving-tag digest
 * bump (`:latest`, `:main`, `:stable`, …) when semver-tag resolution failed and
 * the row would otherwise show two opaque `sha256:…` prefixes.
 *
 * Two sources, in priority order, drawn from the OCI image config of each side:
 *   1. `org.opencontainers.image.version` — but only when it *looks like* a
 *      version (has a digit and isn't a branch/channel word like `main` /
 *      `latest`). Many images set this label to a branch name or base-image
 *      tag, which is useless as a version delta.
 *   2. the image build timestamp (`created`), shown as `YYYY-MM-DD HH:MM:SS`.
 *      Present on essentially every image, so this is the universal fallback — a
 *      timestamp delta still tells the operator "this build is newer", and the
 *      time component distinguishes multiple builds on the same day.
 *
 * A source is only used when BOTH sides have it and they DIFFER — otherwise it
 * carries no information and we try the next source. When only the "to" side is
 * known (e.g. a backfill of an existing row whose old digest is gone), we still
 * surface it so at least the target is meaningful.
 */

import { extractVersion, type OciImageLabels } from "./oci-config.js";

/** Words an image commonly puts in the version label that aren't a version. */
const NON_VERSION_WORDS = new Set([
  "main",
  "master",
  "latest",
  "stable",
  "edge",
  "nightly",
  "dev",
  "develop",
  "current",
  "rolling",
  "head",
  "release",
  "prod",
  "production",
]);

/**
 * Heuristic: does this string read like an app version rather than a branch
 * name or channel? Must contain a digit and not be a known channel word.
 */
export function looksLikeVersion(s: string | undefined): boolean {
  if (!s) return false;
  const t = s.trim().toLowerCase();
  if (!t || NON_VERSION_WORDS.has(t)) return false;
  return /\d/.test(t);
}

export interface MovingTagInfo {
  /** A version-looking label value, or undefined. */
  version?: string;
  /** Build timestamp as `YYYY-MM-DD HH:MM:SS` (UTC), or undefined. */
  date?: string;
}

/** Reduce an OCI label set + created timestamp to the display-worthy fields. */
export function movingTagInfo(oci: OciImageLabels): MovingTagInfo {
  const rawVersion = extractVersion(oci.labels);
  const version = looksLikeVersion(rawVersion) ? rawVersion!.trim() : undefined;
  // RFC3339 `2026-07-19T04:13:11.269Z` → `2026-07-19 04:13:11`. Keeping the time
  // component lets two builds on the same day still register as a delta.
  const date =
    typeof oci.created === "string" && oci.created.length >= 10
      ? oci.created.slice(0, 19).replace("T", " ")
      : undefined;
  return { version, date };
}

export interface MovingDelta {
  from?: string;
  to?: string;
  /** True when both sides decode to the SAME version — a phantom digest change
   *  (e.g. a rebuild of the same version, or a local build vs the CI push).
   *  The caller suppresses these: it's not a real update, and comparing build
   *  timestamps of the same version can even read backwards. */
  sameVersion?: boolean;
}

/**
 * Pick the best display pair from the two sides. When both decode to the SAME
 * version it's a phantom (sameVersion). Otherwise: a differing version pair,
 * then a differing timestamp pair, then a "to"-only value (backfill). Returns
 * an empty object when nothing beats the raw digests — the caller keeps the
 * existing hash display.
 */
export function resolveMovingDelta(
  from: MovingTagInfo,
  to: MovingTagInfo,
): MovingDelta {
  if (from.version && to.version) {
    if (from.version === to.version) return { sameVersion: true };
    return { from: from.version, to: to.version };
  }
  if (from.date && to.date && from.date !== to.date) {
    return { from: from.date, to: to.date };
  }
  // Only the target is known (or both sides are equal on a source). Surface the
  // most specific "to" value we have so the destination is at least meaningful.
  if (to.version) return { to: to.version };
  if (to.date) return { to: to.date };
  return {};
}
