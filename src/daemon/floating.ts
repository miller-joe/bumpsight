/**
 * Digest checks for floating tags.
 *
 * A floating tag (`4.39`, `2`, `6-alpine`, `release`, `main-stable`, or any
 * tag pinned as `tag@sha256:…`) keeps its name while the image under it
 * moves. Comparing tag names can never see that: `v1 -> v1` is not a bump.
 * These checks compare DIGESTS instead — the digest the registry serves for
 * the tag now against the digest we run (the pinned one, or the local
 * image's) — and then decode both digests into real versions so the change
 * can be classified and shown as `1.7.1 -> 1.11.2`.
 */

import type { Database as DB } from "better-sqlite3";
import type { ImageRef } from "../compose/parse.js";
import type { RemoteTag } from "../registry/index.js";
import type { fetchManifestDigest } from "../registry/manifest.js";
import { registryTarget } from "../registry/v2.js";
import { compareTags, parseTag } from "../util/semver.js";
import { classifyBump, type BumpKind } from "./rules.js";
import {
  getDigestVersion,
  getStoredDigest,
  saveDigest,
  saveDigestVersion,
} from "../state/db.js";
import type { CommandRunner } from "../apply/docker.js";

export type FloatingOutcome =
  /** First observation with nothing to compare against; recorded silently. */
  | { kind: "baseline" }
  /** Registry digest matches what we run. */
  | { kind: "current" }
  /** Digest moved but it is the same version (a rebuild), or an older one. */
  | { kind: "no-bump"; reason: "rebuild" | "older"; fromDigest: string; toDigest: string }
  | {
      kind: "bump";
      fromDigest: string;
      toDigest: string;
      fromVersion?: string;
      toVersion?: string;
      bump: BumpKind;
    };

export interface FloatingDeps {
  db: DB;
  fetchDigest: typeof fetchManifestDigest;
  /** Digest of the locally present image for the ref, if any. */
  localDigest: (ref: ImageRef) => Promise<string | undefined>;
  /** Version from the image's OCI labels at a digest, if any. */
  labelVersion: (ref: ImageRef, digest: string) => Promise<string | undefined>;
  now?: () => number;
}

/** Re-try a failed digest decode after this long (a version tag may be
 *  pushed after the floating tag moves). */
const NEGATIVE_CACHE_MS = 12 * 60 * 60 * 1000;

export async function checkFloatingTag(
  ref: ImageRef,
  tags: RemoteTag[],
  deps: FloatingDeps,
): Promise<FloatingOutcome> {
  const inline = tags.find((t) => t.name === ref.tag)?.digest;
  const registryDigest = inline ?? (await deps.fetchDigest(ref, ref.tag));
  if (!registryDigest) {
    throw new Error(`registry returned no digest for :${ref.tag}`);
  }

  const stored = getStoredDigest(deps.db, ref.raw, ref.tag);
  let baseline = ref.digest;
  if (!baseline) baseline = await deps.localDigest(ref);
  if (!baseline) baseline = stored?.digest;
  if (!baseline) {
    saveDigest(deps.db, ref.raw, ref.tag, registryDigest, null);
    return { kind: "baseline" };
  }
  if (baseline === registryDigest) {
    if (stored?.digest !== registryDigest) {
      saveDigest(deps.db, ref.raw, ref.tag, registryDigest, null);
    }
    return { kind: "current" };
  }

  const [fromVersion, toVersion] = await Promise.all([
    versionForDigest(ref, tags, baseline, deps),
    versionForDigest(ref, tags, registryDigest, deps),
  ]);

  if (fromVersion && toVersion) {
    const a = parseTag(fromVersion);
    const b = parseTag(toVersion);
    if (fromVersion === toVersion) {
      return { kind: "no-bump", reason: "rebuild", fromDigest: baseline, toDigest: registryDigest };
    }
    if (a.family === b.family && a.numeric && b.numeric) {
      const cmp = compareTags(b, a);
      if (cmp === 0) {
        return { kind: "no-bump", reason: "rebuild", fromDigest: baseline, toDigest: registryDigest };
      }
      if (cmp < 0) {
        return { kind: "no-bump", reason: "older", fromDigest: baseline, toDigest: registryDigest };
      }
    }
  }

  // Only a version pair we can classify earns patch/minor/major; everything
  // else is `unknown`, which every policy holds for a human.
  const bump: BumpKind =
    fromVersion && toVersion ? classifyBump(fromVersion, toVersion) : "unknown";
  return {
    kind: "bump",
    fromDigest: baseline,
    toDigest: registryDigest,
    fromVersion,
    toVersion,
    bump,
  };
}

/**
 * Decode a digest to a version: first a version tag in the registry that
 * shares the digest, then the image's own OCI version label. Cached per
 * repository — digests are immutable.
 */
export async function versionForDigest(
  ref: ImageRef,
  tags: RemoteTag[],
  digest: string,
  deps: FloatingDeps,
): Promise<string | undefined> {
  const t = registryTarget(ref);
  const repoKey = `${t.host}/${t.repo}`;
  const now = deps.now ? deps.now() : Date.now();
  const cached = getDigestVersion(deps.db, repoKey, digest);
  if (cached) {
    if (cached.version) return cached.version;
    if (now - cached.seenAt < NEGATIVE_CACHE_MS) return undefined;
  }
  let version = await resolveDigestToTag(ref, tags, digest, ref.tag, deps.fetchDigest);
  if (!version) {
    try {
      version = await deps.labelVersion(ref, digest);
    } catch {
      version = undefined;
    }
  }
  saveDigestVersion(deps.db, repoKey, digest, version ?? "");
  return version;
}

/**
 * Given a digest (of a moving or floating tag), return the most specific
 * version tag in the registry that shares it.
 *
 * Candidates are version-shaped tags other than the floating tag itself.
 * For a numeric floating tag (`4.39`, `6-alpine`) only tags inside that line
 * are considered (`4.39.x`, `6.x.y-alpine`). Order: same suffix variant
 * first, then most precise, then HIGHEST VERSION — the newest release is the
 * likeliest match for a tag that just moved. (This used to sort by name, so
 * `v1.9.0` beat `v1.11.2` and the probe budget ran out on old releases; a
 * `:latest` then resolved to the bare major tag `v1` and every later move
 * read as `v1 -> v1`.)
 *
 * Inline digests (Docker Hub) are matched directly; otherwise manifests are
 * probed, capped at MAX_PROBES.
 */
export async function resolveDigestToTag(
  ref: ImageRef,
  tags: RemoteTag[],
  digest: string,
  floatingTag: string,
  fetchFn: typeof fetchManifestDigest,
): Promise<string | undefined> {
  const floating = parseTag(floatingTag);
  const floatingSuffix = variantSuffix(floating.suffix);
  interface Candidate {
    name: string;
    numeric: number[];
    suffixMatch: boolean;
    digest?: string;
  }
  const candidates: Candidate[] = [];
  for (const t of tags) {
    if (t.name.toLowerCase() === floatingTag.toLowerCase()) continue;
    const parsed = parseTag(t.name);
    if (!parsed.numeric) continue; // other channels / opaque tags
    if (floating.numeric) {
      // Stay inside the floating tag's line: `4.39` → 4.39.x only.
      const prefix = floating.numeric;
      if (parsed.numeric.length <= prefix.length) continue;
      if (!prefix.every((n, i) => parsed.numeric![i] === n)) continue;
    }
    candidates.push({
      name: t.name,
      numeric: parsed.numeric,
      suffixMatch: variantSuffix(parsed.suffix) === floatingSuffix,
      digest: t.digest,
    });
  }
  candidates.sort((a, b) => {
    if (a.suffixMatch !== b.suffixMatch) return a.suffixMatch ? -1 : 1;
    if (a.numeric.length !== b.numeric.length) return b.numeric.length - a.numeric.length;
    const len = Math.max(a.numeric.length, b.numeric.length);
    for (let i = 0; i < len; i++) {
      const d = (b.numeric[i] ?? 0) - (a.numeric[i] ?? 0);
      if (d !== 0) return d;
    }
    return b.name.localeCompare(a.name);
  });

  for (const c of candidates) {
    if (c.digest && c.digest === digest) return c.name;
  }

  const MAX_PROBES = 30;
  let probed = 0;
  for (const c of candidates) {
    if (c.digest !== undefined) continue;
    if (probed >= MAX_PROBES) break;
    probed += 1;
    try {
      if ((await fetchFn(ref, c.name)) === digest) return c.name;
    } catch {
      // ignore a failed probe, keep trying others
    }
  }
  return undefined;
}

/** The variant part of a tag suffix (`-alpine`), without build counters. For
 *  a channel suffix like `-latest` there is no variant. */
function variantSuffix(suffix: string | undefined): string {
  const s = (suffix ?? "")
    .toLowerCase()
    .replace(/-(latest|stable)$/, "")
    .replace(/-r\d+|-ls\d+|-build\.\d+/g, "");
  return s;
}

/**
 * Digest of the local image for `ref` (its RepoDigest), via `docker image
 * inspect`. This is what a bare floating tag is actually running — or at
 * least what the next recreate would run. Undefined when the image is not
 * present locally or docker is unreachable.
 */
export async function localRepoDigest(
  ref: ImageRef,
  runner: CommandRunner,
): Promise<string | undefined> {
  const atIdx = ref.raw.indexOf("@");
  const name = atIdx >= 0 ? ref.raw.slice(0, atIdx) : ref.raw;
  let out: string;
  try {
    const r = await runner(
      "docker",
      ["image", "inspect", "--format", "{{json .RepoDigests}}", name],
      { timeoutMs: 30_000 },
    );
    if (r.exitCode !== 0) return undefined;
    out = r.combinedOutput.trim();
  } catch {
    return undefined;
  }
  let entries: unknown;
  try {
    entries = JSON.parse(out);
  } catch {
    return undefined;
  }
  if (!Array.isArray(entries)) return undefined;
  const wanted = normalizeRepo(stripTag(name));
  const pairs = entries
    .filter((e): e is string => typeof e === "string" && e.includes("@"))
    .map((e) => {
      const i = e.indexOf("@");
      return { repo: normalizeRepo(e.slice(0, i)), digest: e.slice(i + 1) };
    });
  const match = pairs.find((p) => p.repo === wanted);
  if (match) return match.digest;
  const distinct = new Set(pairs.map((p) => p.digest));
  return distinct.size === 1 ? [...distinct][0] : undefined;
}

function stripTag(ref: string): string {
  const lastSlash = ref.lastIndexOf("/");
  const lastColon = ref.lastIndexOf(":");
  return lastColon > lastSlash ? ref.slice(0, lastColon) : ref;
}

function normalizeRepo(repo: string): string {
  return repo
    .replace(/^(docker\.io|index\.docker\.io)\//, "")
    .replace(/^library\//, "");
}
