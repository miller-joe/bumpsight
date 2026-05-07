/**
 * v0.5.0 paired-dep-recommendation lookup.
 *
 * When the daemon advises on a held app-major bump, this module checks
 * whether the new parent app version's upstream compose pins different
 * dep images than the local stack does. The result is surfaced in the
 * advise email so the operator can decide whether to apply paired bumps
 * alongside the app major.
 *
 * Scope of v0.5.0: report-only. The output is rendered into the advise
 * text body — no apply-time bundling. Bundling deps into the same apply
 * step is a more invasive change (atomic multi-image rewrite) and is
 * deferred to a later release once the report-only flow is proven.
 *
 * Inputs:
 *   - `coords`: the upstream GitHub repo (already resolved by advise.ts)
 *   - `version`: the new tag the operator is considering approving
 *   - `localComposePath`: the local stack's compose file, used as the
 *     "current dep pin" baseline
 *
 * Output: a list of `DepRecommendation` entries, one per dep service in the
 * upstream compose whose pin differs from the local pin (or that the local
 * stack is missing entirely — possible when a major upgrade introduces a
 * new dep, e.g. adding a redis cache).
 */

import { loadComposeFile, parseComposeString, parseImageRef } from "../compose/parse.js";
import { isDependencyImage } from "../daemon/rules.js";
import { fetchUpstreamCompose } from "../registry/upstream-compose.js";
import type { RepoCoords } from "../releases/github.js";

export interface DepRecommendation {
  /** Service name in the upstream compose that owns this dep. */
  upstreamService: string;
  /** Image ref used by the upstream service (e.g. `postgres:17-alpine`). */
  upstreamImage: string;
  /** Image ref currently in the local compose (if any). */
  localImage: string | null;
  /** Local compose service name carrying the dep, if matched. */
  localService: string | null;
  /** Reason the row exists: `bump` (different tag), `add` (new dep), or
   *  `image-change` (the image-name itself changed, e.g. redis → valkey). */
  kind: "bump" | "add" | "image-change";
}

export interface FindPairedDepBumpsOptions {
  signal?: AbortSignal;
  token?: string;
}

export interface PairedDepLookupResult {
  /** Source URL the upstream compose was fetched from, when one resolved. */
  sourceUrl?: string;
  /** Recommendations to surface in the advise email. */
  recommendations: DepRecommendation[];
}

/**
 * Resolve paired-dep recommendations for a held app-major bump.
 *
 * Returns an empty `recommendations` array (and undefined `sourceUrl`) when:
 *   - the upstream compose can't be fetched at the target version,
 *   - the upstream compose has no dep services we recognize,
 *   - or no dep pin differs from the local stack.
 *
 * Never throws — paired-dep lookup is best-effort enhancement, and the
 * advise email still ships even if every code path here fails silently.
 */
export async function findPairedDepBumps(
  coords: RepoCoords,
  version: string,
  localComposePath: string,
  opts: FindPairedDepBumpsOptions = {},
): Promise<PairedDepLookupResult> {
  const empty: PairedDepLookupResult = { recommendations: [] };

  let hit;
  try {
    hit = await fetchUpstreamCompose(coords, version, opts);
  } catch {
    return empty;
  }
  if (!hit) return empty;

  let upstream;
  try {
    upstream = parseComposeString(hit.content, hit.url);
  } catch {
    return empty;
  }

  let local;
  try {
    local = loadComposeFile(localComposePath);
  } catch {
    return empty;
  }

  const upstreamDeps = collectDepServices(upstream.services);
  if (upstreamDeps.length === 0) return empty;
  const localServices = local.services ?? {};

  const recommendations: DepRecommendation[] = [];
  for (const dep of upstreamDeps) {
    const localMatch = findLocalMatch(dep, localServices);
    if (!localMatch) {
      recommendations.push({
        upstreamService: dep.serviceName,
        upstreamImage: dep.image,
        localImage: null,
        localService: null,
        kind: "add",
      });
      continue;
    }
    if (localMatch.image === dep.image) continue;

    const localRef = parseImageRef(localMatch.image);
    const upstreamRef = parseImageRef(dep.image);
    const sameImage =
      localRef.name === upstreamRef.name &&
      (localRef.namespace ?? null) === (upstreamRef.namespace ?? null);
    recommendations.push({
      upstreamService: dep.serviceName,
      upstreamImage: dep.image,
      localImage: localMatch.image,
      localService: localMatch.serviceName,
      kind: sameImage ? "bump" : "image-change",
    });
  }

  return {
    sourceUrl: hit.url,
    recommendations,
  };
}

interface DepServiceEntry {
  serviceName: string;
  image: string;
  imageName: string;
  imageNamespace: string | null;
}

function collectDepServices(
  services: Record<string, { image?: string }> | undefined,
): DepServiceEntry[] {
  if (!services) return [];
  const out: DepServiceEntry[] = [];
  for (const [name, def] of Object.entries(services)) {
    const image = def?.image;
    if (typeof image !== "string" || image.length === 0) continue;
    const ref = parseImageRef(image);
    const repoForCheck = ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
    if (!isDependencyImage(repoForCheck)) continue;
    out.push({
      serviceName: name,
      image,
      imageName: ref.name,
      imageNamespace: ref.namespace ?? null,
    });
  }
  return out;
}

interface LocalMatch {
  serviceName: string;
  image: string;
}

/**
 * Find the local service that carries the same dep family as `upstreamDep`.
 * Match priority:
 *   1. Same service NAME in the local compose, regardless of image.
 *   2. Any service whose image has the same name+namespace.
 *
 * Service-name match wins because operators often rename the upstream
 * service (e.g. `postgresql` → `db`) but keep the role.
 */
function findLocalMatch(
  upstreamDep: DepServiceEntry,
  localServices: Record<string, { image?: string }>,
): LocalMatch | null {
  // Service-name match first.
  const sameName = localServices[upstreamDep.serviceName];
  if (sameName?.image) {
    return { serviceName: upstreamDep.serviceName, image: sameName.image };
  }

  // Then image-family match anywhere in the local compose.
  for (const [name, def] of Object.entries(localServices)) {
    const img = def?.image;
    if (typeof img !== "string") continue;
    const ref = parseImageRef(img);
    if (
      ref.name === upstreamDep.imageName &&
      (ref.namespace ?? null) === upstreamDep.imageNamespace
    ) {
      return { serviceName: name, image: img };
    }
  }
  return null;
}

/**
 * Format the lookup result for inclusion in advise text. Returns an empty
 * string when there's nothing to surface — the caller can append unconditionally.
 */
export function formatPairedDepReport(result: PairedDepLookupResult): string {
  if (result.recommendations.length === 0) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push("Paired dependency recommendations:");
  if (result.sourceUrl) {
    lines.push(`(from ${result.sourceUrl})`);
  }
  for (const rec of result.recommendations) {
    if (rec.kind === "bump") {
      lines.push(
        `- ${rec.localService ?? rec.upstreamService}: ${rec.localImage} → ${rec.upstreamImage}`,
      );
    } else if (rec.kind === "image-change") {
      lines.push(
        `- ${rec.localService ?? rec.upstreamService}: image changed (${rec.localImage} → ${rec.upstreamImage})`,
      );
    } else {
      lines.push(
        `- ${rec.upstreamService}: new dependency in this version (${rec.upstreamImage})`,
      );
    }
  }
  return lines.join("\n");
}
