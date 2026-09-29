/**
 * v0.6.4 dependency-drift scan.
 *
 * The policy docblock in `rules.ts` says the canonical answer to an
 * independent dep bump is "wait for the parent app to bump it." Nothing in
 * bumpsight ever watched for the parent app bumping it.
 *
 * The v0.5.0 paired-dep lookup came close, but it lives inside `advise`, which
 * only runs for rows that are HELD for approval and only when an LLM is
 * configured. Under an `app: minor` policy most bumps auto-apply and are never
 * held, and a stack sitting on a stable version with no new tag is never
 * examined at all — so in practice a fleet could run for months against dep
 * pins its own app maintainers had already moved away from.
 *
 * This module closes that: an independent pass, on its own schedule, over
 * EVERY stack, that asks a different question from the registry scan.
 *
 *   registry scan  →  "is there a newer tag of this image?"
 *   drift scan     →  "at the app version we ALREADY run, what deps does the
 *                      maintainer's own compose pin?"
 *
 * Findings are recorded as ordinary `updates` rows with `origin='paired'`, so
 * they inherit the whole existing pipeline — dedup, notify, approve/deny links,
 * apply, reconcile — and are governed by the `paired` policy axis rather than
 * `dependencies`.
 *
 * Best-effort throughout: any stack that fails to resolve is skipped silently.
 * A drift scan must never be able to break a registry scan.
 */
import { loadComposeFile, parseImageRef } from "../compose/parse.js";
import { resolveUpstreamRepo } from "../releases/github.js";
import { findPairedDepBumps } from "../advise/paired-deps.js";
import { isDependencyImage, classifyBump } from "./rules.js";
import type { BumpKind } from "./rules.js";

export interface DepDriftFinding {
  stack: string;
  /** Local compose service carrying the dep (the row's service). */
  service: string;
  /** Local image ref, e.g. `postgres:16-alpine`. */
  localImage: string;
  localTag: string;
  /** Tag the upstream compose pins at our current app version. */
  upstreamTag: string;
  bump: BumpKind;
  /** The app service whose upstream compose produced this recommendation. */
  viaService: string;
  /** URL the upstream compose came from — shown in the notification. */
  sourceUrl: string;
}

/**
 * An upstream recommendation we deliberately refuse to turn into an apply-able
 * row: `image-change` (redis → valkey) and `add` (upstream grew a new dep).
 *
 * Neither is a tag rewrite. Approving an `image-change` as one would rewrite
 * only the tag and leave the image name alone — turning `redis:8` into
 * `redis:9-alpine` when the recommendation was `valkey:9-alpine`. That is a
 * worse outcome than doing nothing, so these stay advisory.
 *
 * They still have to be SEEN, though. Excluding them from rows and then never
 * reporting them is how the paired-dep feature managed to look healthy while
 * producing nothing for its entire existence.
 */
export interface DepDriftAdvisory {
  stack: string;
  kind: "add" | "image-change";
  upstreamService: string;
  upstreamImage: string;
  localImage: string | null;
  sourceUrl: string;
}

export interface DepDriftResult {
  findings: DepDriftFinding[];
  advisories: DepDriftAdvisory[];
  /** `image-change` recommendations, which DO get a row (the image name moves,
   *  so there is a concrete thing to approve) but are classified `unknown` so
   *  `decideAction` holds them under every policy — an image swap is never
   *  auto-applied, it is only ever brought up as an ask. */
  imageChanges: DepDriftImageChange[];
}

export interface DepDriftImageChange {
  stack: string;
  /** Local compose service carrying the dep. */
  service: string;
  /** Full local ref, used as the race guard at apply time. */
  localImage: string;
  localTag: string;
  /** Full ref upstream recommends. */
  upstreamImage: string;
  upstreamTag: string;
  viaService: string;
  sourceUrl: string;
}

export interface DepDriftDeps {
  composeFiles: Record<string, string>;
  githubToken?: string;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

/** Tags that carry no version information to compare against. */
const UNCOMPARABLE = /^(latest|stable|main|master|dev|edge|nightly|rolling)$/i;

/**
 * Scan every known stack for dep pins that differ from what the parent app's
 * upstream compose recommends at the app version currently pinned locally.
 *
 * Only `kind: "bump"` recommendations become findings. `add` (upstream grew a
 * new dep) and `image-change` (redis → valkey) are deliberately excluded: both
 * need a human to decide, and neither can be expressed as a tag rewrite, so
 * emitting them as apply-able rows would produce rows that can only ever fail.
 */
export async function scanDepDrift(
  deps: DepDriftDeps,
): Promise<DepDriftResult> {
  const findings: DepDriftFinding[] = [];
  const advisories: DepDriftAdvisory[] = [];
  const imageChanges: DepDriftImageChange[] = [];

  for (const [stack, composePath] of Object.entries(deps.composeFiles)) {
    let file;
    try {
      file = loadComposeFile(composePath);
    } catch {
      continue;
    }
    const services = Object.entries(file.services ?? {});

    for (const [svcName, def] of services) {
      const image = (def as { image?: string }).image;
      if (typeof image !== "string") continue;
      const ref = parseImageRef(image);
      const name = ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
      // Only the stack's own app can have an upstream compose to consult.
      if (isDependencyImage(name, { stack, service: svcName })) continue;
      if (!ref.tag || UNCOMPARABLE.test(ref.tag)) continue;

      let coords = null;
      try {
        coords = await resolveUpstreamRepo(ref, undefined, deps.signal);
      } catch {
        continue;
      }
      if (!coords) continue;

      let result;
      try {
        result = await findPairedDepBumps(coords, ref.tag, composePath, {
          token: deps.githubToken,
          signal: deps.signal,
        });
      } catch {
        continue;
      }
      if (!result.sourceUrl) continue;

      for (const rec of result.recommendations) {
        if (rec.kind === "image-change" && rec.localService && rec.localImage) {
          const lr = parseImageRef(rec.localImage);
          const ur = parseImageRef(rec.upstreamImage);
          if (lr.tag && ur.tag) {
            imageChanges.push({
              stack,
              service: rec.localService,
              localImage: rec.localImage,
              localTag: lr.tag,
              upstreamImage: rec.upstreamImage,
              upstreamTag: ur.tag,
              viaService: svcName,
              sourceUrl: result.sourceUrl,
            });
            continue;
          }
        }
        if (rec.kind !== "bump") {
          advisories.push({
            stack,
            kind: rec.kind,
            upstreamService: rec.upstreamService,
            upstreamImage: rec.upstreamImage,
            localImage: rec.localImage,
            sourceUrl: result.sourceUrl,
          });
          continue;
        }
        if (!rec.localService || !rec.localImage) continue;
        const localRef = parseImageRef(rec.localImage);
        const upstreamRef = parseImageRef(rec.upstreamImage);
        if (!localRef.tag || !upstreamRef.tag) continue;
        if (localRef.tag === upstreamRef.tag) continue;
        // A digest-only difference is not a version recommendation — upstream
        // pinning `valkey:9@sha256:...` against our `valkey:9` is the same pin.
        if (UNCOMPARABLE.test(localRef.tag)) continue;

        findings.push({
          stack,
          service: rec.localService,
          localImage: rec.localImage,
          localTag: localRef.tag,
          upstreamTag: upstreamRef.tag,
          bump: classifyBump(localRef.tag, upstreamRef.tag),
          viaService: svcName,
          sourceUrl: result.sourceUrl,
        });
      }
    }
  }

  for (const a of advisories) {
    deps.log?.(
      `dep-drift-advisory: ${a.stack}/${a.upstreamService} — upstream now uses ` +
        `${a.upstreamImage}, we run ${a.localImage ?? "(nothing)"} ` +
        `[${a.kind}; needs a hands-on migration, not a tag bump] ${a.sourceUrl}`,
    );
  }
  for (const ic of imageChanges) {
    deps.log?.(
      `dep-drift-image-change: ${ic.stack}/${ic.service} ${ic.localImage} -> ` +
        `${ic.upstreamImage} (recommended by ${ic.viaService}; held for approval, ` +
        `never auto-applied) ${ic.sourceUrl}`,
    );
  }
  deps.log?.(
    `dep-drift: ${findings.length} pin(s) differ from upstream's recommendation` +
      (imageChanges.length
        ? `, ${imageChanges.length} image change(s) awaiting a decision`
        : "") +
      (advisories.length
        ? `, ${advisories.length} advisory finding(s) with nothing to apply`
        : ""),
  );
  return { findings, advisories, imageChanges };
}
