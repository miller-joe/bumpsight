/**
 * Minimal semver-ish tag comparison for Docker image tags. Not a general
 * semver library. Tuned to the patterns real homelab images actually use.
 *
 * Tags come in many flavors: `1.2.3`, `v1.2.3`, `4.0`, `latest`, `develop`,
 * `16-alpine`, `2025-04-01`, `sha-abc123`. We bucket tags into "families"
 * based on an approximate shape and only compare within a family so
 * `1.2.3` isn't reported as "older than `develop`".
 */

export interface ParsedTag {
  raw: string;
  /** The family the tag belongs to (see {@link detectFamily}). */
  family: string;
  /** Parsed semver-like components, if the family is semver-shaped. */
  numeric?: number[];
  /** Extra suffix after the numeric part (e.g. "-alpine", "-slim"). */
  suffix?: string;
  /** For date-based tags, a YYYYMMDD integer. */
  dateYMD?: number;
}

export function parseTag(raw: string): ParsedTag {
  // Strip leading `version-` (LinuxServer.io convention) FIRST, then `v`
  // (semver convention). Order matters: `^v` would otherwise eat the v of
  // "version-" and leave "ersion-..." which doesn't match anything.
  // Use a lookahead on `^v` to require a digit after — `v1.2.3` strips,
  // `vault` (channel name) does not.
  const trimmed = raw.replace(/^version-/, "").replace(/^v(?=\d)/, "");

  // YYYY-MM-DD or YYYYMMDD
  const dateDash = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if (dateDash) {
    return {
      raw,
      family: `date${dateDash[4]!.toLowerCase()}`,
      dateYMD: Number(dateDash[1]! + dateDash[2]! + dateDash[3]!),
      suffix: dateDash[4]!,
    };
  }
  const dateCompact = trimmed.match(/^(\d{8})(.*)$/);
  if (dateCompact) {
    return {
      raw,
      family: `date${dateCompact[2]!.toLowerCase()}`,
      dateYMD: Number(dateCompact[1]!),
      suffix: dateCompact[2]!,
    };
  }

  // semver-like: 1, 1.2, 1.2.3, 1.2.3.4, with optional -suffix
  const semver = trimmed.match(/^(\d+(?:\.\d+)*)([-+]?.*)$/);
  if (semver) {
    const numeric = semver[1]!.split(".").map((n) => Number(n));
    const suffix = semver[2] ?? "";
    // Build-number patterns ARE per-build, not per-variant — strip them
    // from the family discriminator so `4.0.0.701-r0-ls123` and
    // `4.0.0.702-r0-ls124` end up in the same family and compare cleanly.
    // Keeps `-alpine`, `-slim`, `-debian` etc. as variant discriminators.
    const familySuffix = suffix
      .replace(/-r\d+/g, "")
      .replace(/-ls\d+/g, "")
      .replace(/-build\.\d+/g, "")
      // Collapse `-` runs that may form after stripping (e.g. "-r0-ls5" -> "--").
      .replace(/-+/g, "-")
      .replace(/-$/, "");
    // Include the numeric part count in the family so a bare build number
    // like `176` isn't compared against 3-part semver like `4.0.14`.
    return {
      raw,
      family: `semver${familySuffix.toLowerCase()}:${numeric.length}`,
      numeric,
      suffix,
    };
  }

  // channel names: latest, stable, develop, edge, nightly, rolling
  if (/^(latest|stable|develop|edge|nightly|rolling|mainline|ci|preview)$/i.test(trimmed)) {
    return { raw, family: `channel:${trimmed.toLowerCase()}` };
  }

  // Digest-like or unidentified
  return { raw, family: `opaque:${raw.toLowerCase()}` };
}

/**
 * Compare two tags within the same family. Returns:
 *  - negative if a < b
 *  - 0 if equal or incomparable
 *  - positive if a > b
 *
 * Returns 0 when the families differ — comparing across families is
 * meaningless and should be treated by the caller as "not comparable".
 */
export function compareTags(a: ParsedTag, b: ParsedTag): number {
  if (a.family !== b.family) return 0;
  if (a.numeric && b.numeric) {
    const len = Math.max(a.numeric.length, b.numeric.length);
    for (let i = 0; i < len; i++) {
      const av = a.numeric[i] ?? 0;
      const bv = b.numeric[i] ?? 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  }
  if (a.dateYMD !== undefined && b.dateYMD !== undefined) {
    return a.dateYMD - b.dateYMD;
  }
  return 0;
}

/**
 * Given the current tag and a list of candidate remote tags, return the
 * highest candidate in the same family that is strictly newer than the
 * current tag. Returns null when nothing comparable-and-newer is found.
 */
export function findLatestInFamily(currentRaw: string, candidatesRaw: string[]): string | null {
  const current = parseTag(currentRaw);
  let best: ParsedTag | null = null;
  for (const candidateRaw of candidatesRaw) {
    const candidate = parseTag(candidateRaw);
    if (candidate.family !== current.family) continue;
    if (compareTags(candidate, current) <= 0) continue;
    if (best === null || compareTags(candidate, best) > 0) {
      best = candidate;
    }
  }
  return best ? best.raw : null;
}
