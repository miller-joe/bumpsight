/**
 * v0.5.4 apply-time paired-dep bundling.
 *
 * At hold-time, the v0.5.0 paired-dep lookup writes a JSON snapshot of
 * `DepRecommendation[]` onto the row (`paired_deps_json`). At apply-time, if
 * bundling is enabled for the stack, this module turns that snapshot into a
 * concrete plan of `rewriteImageTag` calls — only for recommendations of kind
 * `"bump"` whose local service is still present in the current compose file
 * with the originally-observed tag. Anything else (`"add"` for a brand-new
 * dep, `"image-change"` for redis → valkey, drift between hold and apply) is
 * skipped from the bundle and surfaced in the apply log so the operator knows
 * it was left for them to handle.
 */
import { loadComposeFile, parseImageRef } from "../compose/parse.js";
import type { DepRecommendation } from "../advise/paired-deps.js";

export interface BundleRewrite {
  /** Service name in the local compose file. */
  serviceName: string;
  /** Tag currently in the compose file. Used as the drift guard. */
  currentTag: string;
  /** New tag (the parent app's recommended pin). */
  newTag: string;
  /** Human-readable label for the apply log. */
  label: string;
}

export interface BundlePlanResult {
  /** Rewrites we'll apply atomically alongside the primary. */
  rewrites: BundleRewrite[];
  /** Recommendations intentionally skipped (with reasons), surfaced in log. */
  skipped: SkippedRecommendation[];
}

export interface SkippedRecommendation {
  upstreamService: string;
  upstreamImage: string;
  reason: string;
}

/**
 * Parse the persisted JSON snapshot. Returns an empty array (and never throws)
 * on malformed input — paired-dep bundling is best-effort.
 */
export function parsePairedDepsJson(
  json: string | null,
): DepRecommendation[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed as DepRecommendation[];
  } catch {
    return [];
  }
}

/**
 * Build the rewrite plan for a single Approve click. Reads the current local
 * compose to verify each `kind: "bump"` recommendation still matches what we
 * saw at hold time. Returns `rewrites` for the apply step and `skipped` for
 * the apply log (so we don't silently drop recommendations).
 *
 * Never throws: a load failure or shape mismatch returns an empty plan, and
 * the primary apply still goes ahead.
 */
export function buildBundlePlan(
  composePath: string,
  recommendations: DepRecommendation[],
): BundlePlanResult {
  const empty: BundlePlanResult = { rewrites: [], skipped: [] };
  if (recommendations.length === 0) return empty;

  let local;
  try {
    local = loadComposeFile(composePath);
  } catch {
    return {
      rewrites: [],
      skipped: recommendations.map((r) => ({
        upstreamService: r.upstreamService,
        upstreamImage: r.upstreamImage,
        reason: "could not load local compose",
      })),
    };
  }
  const services = local.services ?? {};

  const rewrites: BundleRewrite[] = [];
  const skipped: SkippedRecommendation[] = [];
  for (const rec of recommendations) {
    if (rec.kind === "add") {
      skipped.push({
        upstreamService: rec.upstreamService,
        upstreamImage: rec.upstreamImage,
        reason: "new dep introduced upstream (manual review)",
      });
      continue;
    }
    if (rec.kind === "image-change") {
      skipped.push({
        upstreamService: rec.upstreamService,
        upstreamImage: rec.upstreamImage,
        reason: "image name changed (manual review)",
      });
      continue;
    }
    // kind === "bump": same image family, different tag.
    if (!rec.localService || !rec.localImage) {
      skipped.push({
        upstreamService: rec.upstreamService,
        upstreamImage: rec.upstreamImage,
        reason: "no local service mapped at hold time",
      });
      continue;
    }
    const svc = services[rec.localService];
    if (!svc?.image) {
      skipped.push({
        upstreamService: rec.upstreamService,
        upstreamImage: rec.upstreamImage,
        reason: `local service ${rec.localService} not present in compose at apply time`,
      });
      continue;
    }

    const localNow = parseImageRef(svc.image);
    const localAtHold = parseImageRef(rec.localImage);
    if (
      localNow.name !== localAtHold.name ||
      (localNow.namespace ?? null) !== (localAtHold.namespace ?? null)
    ) {
      skipped.push({
        upstreamService: rec.upstreamService,
        upstreamImage: rec.upstreamImage,
        reason: `local image changed since hold (was ${rec.localImage}, now ${svc.image})`,
      });
      continue;
    }
    if (localNow.tag !== localAtHold.tag) {
      skipped.push({
        upstreamService: rec.upstreamService,
        upstreamImage: rec.upstreamImage,
        reason: `local tag drifted since hold (was ${localAtHold.tag}, now ${localNow.tag})`,
      });
      continue;
    }

    const upstreamRef = parseImageRef(rec.upstreamImage);
    rewrites.push({
      serviceName: rec.localService,
      currentTag: localNow.tag,
      newTag: upstreamRef.tag,
      label: `${rec.localService} (${localNow.tag} → ${upstreamRef.tag})`,
    });
  }
  return { rewrites, skipped };
}

/**
 * Format the bundle result for inclusion in the apply log. Returns a
 * single-line summary block (or empty string when there's nothing to report).
 */
export function formatBundleLog(plan: BundlePlanResult): string {
  if (plan.rewrites.length === 0 && plan.skipped.length === 0) return "";
  const lines: string[] = [];
  if (plan.rewrites.length > 0) {
    lines.push(
      `bundled paired deps: ${plan.rewrites.map((r) => r.label).join(", ")}`,
    );
  }
  for (const s of plan.skipped) {
    lines.push(
      `paired-dep skipped: ${s.upstreamService} (${s.upstreamImage}) — ${s.reason}`,
    );
  }
  return `==== ${lines.join(" | ")} ====`;
}
