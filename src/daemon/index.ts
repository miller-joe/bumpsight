import { dirname, basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import {
  interpolateImage,
  loadComposeFile,
  parseImageRef,
  type ImageRef,
  type ServiceDef,
} from "../compose/parse.js";
import {
  isSupportedRegistry,
  listTags,
  fetchManifestDigest,
  type RemoteTag,
} from "../registry/index.js";
import { findLatestInFamily, parseTag } from "../util/semver.js";
import {
  applyStackPolicyOverrides,
  classifyBump,
  decideAction,
  isDependencyImage,
  isFloatingTag,
  isMovingTag,
} from "./rules.js";
import type { BumpKind, RulesConfig } from "./rules.js";
import type { DaemonConfig } from "./config.js";
import {
  recordUpdate,
  setNotified,
  findUpdate,
  getStoredDigest,
  saveDigest,
  getAllStackPolicies,
  setDisplayTags,
  supersedeOlderDigestRows,
  dismissRow,
  deleteUpdate,
  getMutedServices,
  recordImageCheck,
  supersedeOlderFamilyRows,
  type UpdateRow,
} from "../state/db.js";
import { extractVersion, fetchOciLabels } from "../registry/oci-config.js";
import {
  checkFloatingTag,
  localRepoDigest,
  resolveDigestToTag,
} from "./floating.js";
import { realRunner } from "../apply/docker.js";
import {
  looksLikeVersion,
  movingTagInfo,
  resolveMovingDelta,
  type MovingDelta,
} from "../registry/moving-tag-label.js";
import { floatingTagOf, fromDisplay, toDisplay } from "../util/display.js";
import { notifyAll } from "../notify/index.js";
import { archiveMessage } from "../notify/outbox.js";
import type { Notifier, NotifyMessage, NotifyLink } from "../notify/types.js";
import { applyOne } from "../apply/index.js";
import { scanDepDrift } from "./dep-drift.js";
import type { CommandRunner } from "../apply/docker.js";
import { getAdviseSummary, type AdviseSummary } from "../commands/advise.js";
import {
  setAdviseText,
  setPairedDeps,
  findUpdateByDelta,
} from "../state/db.js";
import type { ApplyPairedDepsConfig } from "./config.js";
import { isPairedDepBundlingEnabled } from "./config.js";
import {
  enrichDigestBump,
  type DigestEnrichmentResult,
} from "../advise/digest-enrichment.js";

const BRAND_LOGO_INLINE = `<svg viewBox="0 0 96 96" width="36" height="36" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;flex:0 0 auto;" role="img" aria-label="bumpsight"><ellipse cx="20" cy="48" rx="6" ry="14" fill="#2563eb" fill-opacity="0.08"/><ellipse cx="20" cy="48" rx="6" ry="14"/><ellipse cx="48" cy="48" rx="5" ry="11"/><ellipse cx="76" cy="48" rx="4" ry="8"/><path d="M20 34 L48 37 L76 40"/><path d="M20 62 L48 59 L76 56"/><circle cx="20" cy="48" r="2.5" fill="#2563eb" stroke="none"/></svg>`;

export interface ScanRunResult {
  /** Number of services examined across all compose files. */
  scanned: number;
  /** Number of new bumps discovered (not seen in DB before). */
  discovered: number;
  /** Number of bumps that auto-apply ran on. */
  autoApplied: number;
  /** Number of auto-applies that succeeded. */
  autoAppliedOk: number;
  /** Number of bumps held for human approval. */
  held: number;
  /** Errors encountered, keyed by image ref. */
  errors: Record<string, string>;
  /**
   * v0.6.1: services dropped because their registry has no client. Counted
   * separately from `scanned` and always logged — an unsupported registry
   * used to be a bare `continue`, so a whole registry could go unevaluated
   * while the scan line still reported it as covered.
   */
  skipped: number;
  /** Image refs skipped, grouped by registry. */
  skippedByRegistry: Record<string, string[]>;
  /** Services whose image was checked against its registry successfully. */
  checked: number;
  /** Services whose check FAILED (registry error, rate limit, …). These
   *  are not "up to date" — nothing is known about them this pass. Details
   *  in `errors`. */
  unchecked: number;
  /** Services running a locally built image (a `build:` key, or a bare name
   *  no registry knows). Nothing to check. */
  localBuilds: number;
}

export interface ScanRunDeps {
  db: DB;
  notifiers: Notifier[];
  rules: RulesConfig;
  /** Stack → compose file path. */
  composeFiles: Record<string, string>;
  /** Optional base URL for approve/deny links inside notifications. */
  publicUrl?: string;
  /** Optional OpenAI-compat LLM URL (Ollama /v1 or LiteLLM). When set, held-bump emails get LLM advise. */
  llmUrl?: string;
  /** Optional bearer token for the LLM endpoint. */
  llmKey?: string;
  /** Model name for the LLM call. */
  llmModel?: string;
  /** GitHub token for advise's release-notes fetch. */
  githubToken?: string;
  /** Minimum gap in ms between dispatched notifications. Default 0 (no rate limit). */
  notifyIntervalMs?: number;
  /** Optional outbox directory for archiving every dispatched email.
   *  When set, each notifyAll call also writes a JSON record under
   *  this dir so a human / Claude can audit what was actually sent.
   *  Best-effort — write failures never abort delivery. */
  outboxDir?: string;
  /** Most recent N outbox files to keep. Defaults to 200. */
  outboxKeepCount?: number;
  /** Test seam — defaults to the real registry client. */
  listTagsFn?: typeof listTags;
  /** Test seam — defaults to the real per-tag manifest digest fetcher. */
  fetchManifestDigestFn?: typeof fetchManifestDigest;
  /** Test seam — defaults to the real spawn-based docker runner. */
  runner?: CommandRunner;
  /** v0.4.2: forwarded to applyOne. When false, skip the post-apply
   *  targeted prune. Default true. Tests usually pass false. */
  pruneAfterApply?: boolean;
  /** v0.5.4: per-stack opt-in for apply-time paired-dep bundling. Off when
   *  missing. Forwarded to applyOne after the stack lookup. */
  applyPairedDeps?: ApplyPairedDepsConfig;
  /** Test seam — override advise. Returns null to skip the LLM section. */
  adviseFn?: typeof getAdviseSummary;
  /** v0.5.5: test seam — override digest-class enrichment. */
  enrichDigestFn?: typeof enrichDigestBump;
  /** v0.6.0: test seam — override the OCI version/date decode for digest bumps.
   *  Defaults to the real safeMovingDelta (two registry fetches). */
  movingDeltaFn?: (
    ref: ImageRef,
    oldDigest: string,
    newDigest: string,
  ) => Promise<MovingDelta>;
  /** Test seam — sleep helper for the rate limiter. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Test seam — digest of the local image for a floating tag. Defaults to
   *  `docker image inspect` through `runner`. */
  localDigestFn?: (ref: ImageRef) => Promise<string | undefined>;
  /** Test seam — version from OCI labels at a digest. Defaults to a registry
   *  config-blob fetch. */
  labelVersionFn?: (ref: ImageRef, digest: string) => Promise<string | undefined>;
}

/**
 * One pass of the daemon: scan every configured compose file, record
 * any new bumps, dispatch hold-for-approval notifications with embedded
 * approve/deny links, and run apply inline for matches that fall under
 * the auto-apply policy.
 */
export async function runScanOnce(
  deps: ScanRunDeps,
): Promise<ScanRunResult> {
  const result: ScanRunResult = {
    scanned: 0,
    discovered: 0,
    autoApplied: 0,
    autoAppliedOk: 0,
    held: 0,
    errors: {},
    skipped: 0,
    skippedByRegistry: {},
    checked: 0,
    unchecked: 0,
    localBuilds: 0,
  };
  const lister = deps.listTagsFn ?? listTags;
  const manifestFetcher = deps.fetchManifestDigestFn ?? fetchManifestDigest;
  const localDigest =
    deps.localDigestFn ??
    ((ref: ImageRef) => localRepoDigest(ref, deps.runner ?? realRunner));
  const labelVersion = deps.labelVersionFn ?? ociLabelVersion;
  const sleep =
    deps.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const notifyIntervalMs = deps.notifyIntervalMs ?? 0;
  let lastDispatchAt = 0;
  const heldRows: { row: UpdateRow; composePath: string; serviceName: string }[] =
    [];
  // v0.6.0: muted (stack, service) pairs are skipped entirely — no new bumps
  // surface for an app the operator muted, until they un-mute it.
  const mutedSet = new Set(
    getMutedServices(deps.db).map((m) => `${m.stack}::${m.service}`),
  );

  // Per-image check outcome, written to image_checks after the pass. An
  // image used by several services is checked once per service; any failure
  // wins so a flaky check is not masked by a later success.
  const checks = new Map<string, { usedBy: string[]; error?: string }>();
  const noteCheck = (image: string, usedBy: string, error?: string) => {
    const c = checks.get(image) ?? { usedBy: [] };
    if (!c.usedBy.includes(usedBy)) c.usedBy.push(usedBy);
    if (error !== undefined && c.error === undefined) c.error = error;
    checks.set(image, c);
  };

  type ServiceList = [string, ServiceDef][];

  const scanService = async (
    stack: string,
    composePath: string,
    services: ServiceList,
    serviceName: string,
    ref: ImageRef,
  ): Promise<void> => {
    const tags = await lister(ref, {});

    // Path A: moving tag (latest / stable / edge / etc.) — track digest
    // changes. Phase 2: try to resolve the digest to the most-precise
    // semver tag sharing it. When both prior and new digests resolve, we
    // classify the change as a normal patch / minor / major and let the
    // stack's policy decide auto-apply vs hold. When resolution fails on
    // either side, we fall back to Phase 1 behavior (always hold, with
    // digest prefixes shown in the email).
    // A moving tag pinned to a digest (`latest@sha256:…`) is not tracked here:
    // the pin, not the last-seen digest, is what runs. Path C handles it.
    if (isMovingTag(ref.tag) && !ref.digest) {
      // Get the current digest of the moving tag. Docker Hub returns it
      // inline in the tag list; GHCR doesn't, so fall back to a manifest
      // probe.
      const matching = tags.find((t) => t.name === ref.tag);
      let newDigest = matching?.digest;
      if (!newDigest) {
        try {
          newDigest = await manifestFetcher(ref, ref.tag);
        } catch {
          newDigest = undefined;
        }
      }
      if (!newDigest) {
      throw new Error(`registry returned no digest for :${ref.tag}`);
    }

      const prev = getStoredDigest(deps.db, ref.raw, ref.tag);

      if (!prev) {
        // First observation — resolve and record silently for the next scan.
        const resolved = await resolveDigestToTag(
          ref,
          tags,
          newDigest,
          ref.tag,
          manifestFetcher,
        );
        saveDigest(deps.db, ref.raw, ref.tag, newDigest, resolved ?? null);
        return;
      }
      if (prev.digest === newDigest) return;

      // Digest changed. Try to resolve it to a semver tag.
      const newResolved = await resolveDigestToTag(
        ref,
        tags,
        newDigest,
        ref.tag,
        manifestFetcher,
      );

      let bump: BumpKind = "digest";
      let currentTagForRow = prev.digest.replace(/^sha256:/, "").slice(0, 12);
      let targetTagForRow = newDigest.replace(/^sha256:/, "").slice(0, 12);
      // v0.4.2: For digest-class bumps where the source compose tag is a
      // recognized moving tag (`:latest`, `:nightly`, etc.), mark the row
      // as moving even when semver resolution fails. This is what tells
      // applyOne to skip the compose-rewrite step (the file still says
      // `:latest`); without this, the apply path tries to rewrite a 12-char
      // digest prefix into a compose entry that says `latest` and fails
      // with "image tag drift: expected <sha>, found latest".
      let familyForRow: string | undefined = isMovingTag(ref.tag)
        ? `moving:${ref.tag}`
        : undefined;

      // Phase 2 happy path: both sides resolve to a semver tag we can
      // classify. Use the resolved pair as the row's current/target so the
      // email shows "1.27.4 → 1.27.5" instead of digest prefixes, and so
      // policy can auto-apply.
      // Equal names are not a bump: `v1 -> v1` classified as `patch` and was
      // "applied" as a no-op while the pinned image stayed put.
      if (prev.resolvedTag && newResolved && prev.resolvedTag !== newResolved) {
        const semverBump = classifyBump(prev.resolvedTag, newResolved);
        if (semverBump !== "unknown") {
          bump = semverBump;
          currentTagForRow = prev.resolvedTag;
          targetTagForRow = newResolved;
          familyForRow = `moving:${ref.tag}`;
        }
      }

      const isDep = isDependencyImage(
        ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name,
        {
          stack,
          service: serviceName,
          siblingServices: services.map(([n]) => n),
        },
      );
      const decision = decideAction(deps.rules, stack, bump, isDep);
      // v0.6.0: dependency bumps are always surfaced in the GUI (see the
      // semver-path note). Only a non-dependency skip stays invisible.
      if (decision === "skip" && !isDep) {
        // Still advance stored digest so we don't refire on every scan.
        saveDigest(
          deps.db,
          ref.raw,
          ref.tag,
          newDigest,
          newResolved ?? null,
        );
        return;
      }

      // v0.6.0: mint a token for every discovered row (not just holds) so the
      // dashboard can act on any row through the capability-token routes.
      // Auto-apply rows getting a token is harmless (no approval link is
      // embedded in their applied-emails) and lets the GUI re-apply/retry.
      const token = randomBytes(18).toString("base64url");
      const id = recordUpdate(deps.db, {
        stack,
        service: serviceName,
        image: ref.raw,
        currentTag: currentTagForRow,
        targetTag: targetTagForRow,
        family: familyForRow,
        bump,
        approvalToken: token,
      });
      const row = findUpdate(deps.db, id);
      if (!row || row.status !== "pending") return;
      result.discovered += 1;

      // v0.6.0: retire any older still-open digest rows for this service so
      // the moving-tag app shows one current card, not a pile of stale ones.
      supersedeOlderDigestRows(deps.db, stack, serviceName, row.id);

      // Advance the stored digest now so a re-scan before the user acts
      // doesn't keep refiring the same bump.
      saveDigest(deps.db, ref.raw, ref.tag, newDigest, newResolved ?? null);

      // v0.6.0: for true digest-class bumps (no semver pair resolved), decode
      // the old + new digests into a version / build-date delta via OCI
      // labels so the row shows `2.20.14 → 2.20.15` (or a date) instead of two
      // opaque hashes. Display-only; independent of the LLM enrichment below.
      if (bump === "digest") {
        const delta = await (deps.movingDeltaFn ?? safeMovingDelta)(
          ref,
          prev.digest,
          newDigest,
        );
        if (delta.sameVersion) {
          // Phantom: the digest moved but the decoded version is unchanged
          // (a rebuild of the same version). Not a real update — retire it so
          // it never reaches the queue. The stored digest is already advanced.
          dismissRow(deps.db, row.id, "unchanged");
          return;
        }
        if (delta.from || delta.to) {
          setDisplayTags(deps.db, row.id, delta.from ?? null, delta.to ?? null);
        }
      }

      // v0.5.5: for true digest-class bumps (no semver resolved), enrich
      // the row with an OCI-label-driven commit-range summary. Falls back
      // silently when labels are absent. The daily-digest renderer picks
      // up `advise_text` automatically.
      if (bump === "digest" && deps.llmUrl) {
        const enrichment = await safeEnrichDigest(
          {
            image: ref.raw,
            prevDigest: prev.digest,
            newDigest,
            llmUrl: deps.llmUrl,
            llmKey: deps.llmKey,
            model: deps.llmModel,
            githubToken: deps.githubToken,
          },
          deps.enrichDigestFn,
        );
        if (enrichment.ok && enrichment.summary) {
          setAdviseText(deps.db, row.id, enrichment.summary);
        }
      }

      if (decision === "auto-apply") {
        // applyOne sees row.family === `moving:${tag}` and skips the
        // compose-file rewrite (the file still says `:latest`); it just
        // pulls + restarts so the new digest gets picked up.
        result.autoApplied += 1;
        const after = await applyOne(
          {
            db: deps.db,
            composeFiles: deps.composeFiles,
            runner: deps.runner,
            pruneAfterApply: deps.pruneAfterApply,
            bundlePairedDeps:
              deps.applyPairedDeps !== undefined &&
              isPairedDepBundlingEnabled(deps.applyPairedDeps, stack),
          },
          row.id,
        );
        if (after.status === "applied") result.autoAppliedOk += 1;
        await dispatchAppliedNotification(
          deps.notifiers,
          after,
          deps.llmUrl
            ? await safeAdvise(
                {
                  image: ref.raw,
                  from: currentTagForRow,
                  to: targetTagForRow,
                  composeFile: composePath,
                  serviceName,
                  stackName: stack,
                  llmUrl: deps.llmUrl,
                  llmKey: deps.llmKey,
                  model: deps.llmModel,
                  githubToken: deps.githubToken,
                },
                deps.adviseFn,
              )
            : null,
          deps.outboxDir
            ? { dir: deps.outboxDir, keepCount: deps.outboxKeepCount }
            : undefined,
        );
      } else if (isDep) {
        // Dependency held → GUI-visible, never emailed.
        result.held += 1;
        setNotified(deps.db, row.id);
      } else {
        result.held += 1;
        heldRows.push({ row, composePath, serviceName });
      }
      return;
    }

    // Path B: semver tag — existing behavior
    const latest = findLatestInFamily(
      ref.tag,
      tags.map((t) => t.name),
    );
    if (!latest || latest === ref.tag) {
      // Path C: nothing newer by NAME. For a floating tag that says nothing
      // about whether the image under the tag moved — check the digest.
      if (isFloatingTag(ref.tag)) {
        await scanFloating(stack, composePath, services, serviceName, ref, tags);
      }
      return;
    }

    const bump: BumpKind = classifyBump(ref.tag, latest);
    const isDep = isDependencyImage(
      ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name,
      {
        stack,
        service: serviceName,
        siblingServices: services.map(([n]) => n),
      },
    );
    const decision = decideAction(deps.rules, stack, bump, isDep);
    // v0.6.0 dependency special case: dependency bumps are ALWAYS surfaced in
    // the GUI for individual review/ignore, but stay out of email. So
    // `deps: none` means "quiet + never auto-apply", not "invisible". A
    // non-dependency `app: none` stays hidden as before.
    if (decision === "skip" && !isDep) return;

    // v0.6.0: every discovered row gets a token (see the digest-path note
    // above) — the dashboard is now token-addressed for all actions.
    const token = randomBytes(18).toString("base64url");
    // A `tag@sha256:…` ref must have its digest rewritten with the tag, or
    // the old digest keeps winning and the "bump" pulls the old image.
    const targetImage = ref.digest
      ? await pinnedTargetRef(ref, latest, tags, manifestFetcher)
      : undefined;
    const id = recordUpdate(deps.db, {
      stack,
      service: serviceName,
      image: ref.raw,
      currentTag: ref.tag,
      targetTag: latest,
      bump,
      approvalToken: token,
      targetImage,
    });

    const row = findUpdate(deps.db, id);
    if (!row || row.status !== "pending") return;
    result.discovered += 1;

    if (decision === "auto-apply") {
      result.autoApplied += 1;
      const after = await applyOne(
        {
          db: deps.db,
          composeFiles: deps.composeFiles,
          runner: deps.runner,
          pruneAfterApply: deps.pruneAfterApply,
          bundlePairedDeps:
            deps.applyPairedDeps !== undefined &&
            isPairedDepBundlingEnabled(deps.applyPairedDeps, stack),
        },
        row.id,
      );
      if (after.status === "applied") result.autoAppliedOk += 1;
      const adviseForApplied = deps.llmUrl
        ? await safeAdvise(
            {
              image: ref.raw,
              from: ref.tag,
              to: latest,
              composeFile: composePath,
              serviceName,
              stackName: stack,
              llmUrl: deps.llmUrl,
              llmKey: deps.llmKey,
              model: deps.llmModel,
              githubToken: deps.githubToken,
            },
            deps.adviseFn,
          )
        : null;
      await dispatchAppliedNotification(
        deps.notifiers,
        after,
        adviseForApplied,
        deps.outboxDir
          ? { dir: deps.outboxDir, keepCount: deps.outboxKeepCount }
          : undefined,
      );
    } else if (isDep) {
      // Dependency held → GUI-visible for individual review, never emailed
      // (not added to heldRows, so it skips the email dispatch entirely).
      result.held += 1;
      setNotified(deps.db, row.id);
    } else {
      result.held += 1;
      heldRows.push({ row, composePath, serviceName });
    }
  };

  /**
   * Path C: a floating tag (`4.39`, `6-alpine`, `release`, or anything pinned
   * as `tag@sha256:…`). Compare the digest the registry serves for the tag
   * with the digest we run, decode both to versions, and record a bump that
   * carries the real versions. See `floating.ts`.
   */
  const scanFloating = async (
    stack: string,
    composePath: string,
    services: ServiceList,
    serviceName: string,
    ref: ImageRef,
    tags: RemoteTag[],
  ): Promise<void> => {
    const outcome = await checkFloatingTag(ref, tags, {
      db: deps.db,
      fetchDigest: manifestFetcher,
      localDigest,
      labelVersion,
    });
    if (outcome.kind !== "bump") return;

    const short = (d: string) => d.replace(/^sha256:/, "").slice(0, 12);
    const currentTag = outcome.fromVersion ?? short(outcome.fromDigest);
    const targetTag = outcome.toVersion ?? short(outcome.toDigest);
    // `pinned:` rows rewrite the digest in the compose file; `moving:` rows
    // keep the compose line and pull + recreate (see applyOne).
    const family = ref.digest ? `pinned:${ref.tag}` : `moving:${ref.tag}`;
    const targetImage = ref.digest
      ? `${ref.raw.slice(0, ref.raw.indexOf("@"))}@${outcome.toDigest}`
      : undefined;

    const isDep = isDependencyImage(
      ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name,
      {
        stack,
        service: serviceName,
        siblingServices: services.map(([n]) => n),
      },
    );
    const decision = decideAction(deps.rules, stack, outcome.bump, isDep);
    const advanceStored = () => {
      if (!ref.digest) saveDigest(deps.db, ref.raw, ref.tag, outcome.toDigest, null);
    };
    if (decision === "skip" && !isDep) {
      advanceStored();
      return;
    }

    const id = recordUpdate(deps.db, {
      stack,
      service: serviceName,
      image: ref.raw,
      currentTag,
      targetTag,
      family,
      bump: outcome.bump,
      approvalToken: randomBytes(18).toString("base64url"),
      targetImage,
    });
    const row = findUpdate(deps.db, id);
    if (!row || row.status !== "pending") return;
    result.discovered += 1;
    supersedeOlderFamilyRows(deps.db, stack, serviceName, family, row.id);
    advanceStored();

    // A side we could not decode to a version still gets a readable build
    // date instead of a bare hash prefix.
    if (!outcome.fromVersion || !outcome.toVersion) {
      const delta = await (deps.movingDeltaFn ?? safeMovingDelta)(
        ref,
        outcome.fromDigest,
        outcome.toDigest,
      );
      const from = outcome.fromVersion ?? delta.from ?? null;
      const to = outcome.toVersion ?? delta.to ?? null;
      if (from || to) setDisplayTags(deps.db, row.id, from, to);
    }

    if (decision === "auto-apply") {
      result.autoApplied += 1;
      const after = await applyOne(
        {
          db: deps.db,
          composeFiles: deps.composeFiles,
          runner: deps.runner,
          pruneAfterApply: deps.pruneAfterApply,
          bundlePairedDeps:
            deps.applyPairedDeps !== undefined &&
            isPairedDepBundlingEnabled(deps.applyPairedDeps, stack),
        },
        row.id,
      );
      if (after.status === "applied") result.autoAppliedOk += 1;
      await dispatchAppliedNotification(
        deps.notifiers,
        after,
        deps.llmUrl && outcome.fromVersion && outcome.toVersion
          ? await safeAdvise(
              {
                image: ref.raw,
                from: outcome.fromVersion,
                to: outcome.toVersion,
                composeFile: composePath,
                serviceName,
                stackName: stack,
                llmUrl: deps.llmUrl,
                llmKey: deps.llmKey,
                model: deps.llmModel,
                githubToken: deps.githubToken,
              },
              deps.adviseFn,
            )
          : null,
        deps.outboxDir
          ? { dir: deps.outboxDir, keepCount: deps.outboxKeepCount }
          : undefined,
      );
    } else if (isDep) {
      result.held += 1;
      setNotified(deps.db, row.id);
    } else {
      result.held += 1;
      // Re-read so the hold email sees the display override set above.
      heldRows.push({ row: findUpdate(deps.db, row.id) ?? row, composePath, serviceName });
    }
  };

  for (const [stack, composePath] of Object.entries(deps.composeFiles)) {
    let compose: ReturnType<typeof loadComposeFile>;
    try {
      compose = loadComposeFile(composePath);
    } catch (err) {
      result.errors[composePath] = (err as Error).message;
      continue;
    }
    const services = Object.entries(compose.services ?? {}).filter(
      ([, svc]) => svc.image,
    ) as ServiceList;

    for (const [serviceName, svc] of services) {
      if (mutedSet.has(`${stack}::${serviceName}`)) continue; // muted app — skip
      result.scanned += 1;
      // A service with `build:` is built from local source; there is no
      // registry copy to compare against.
      if (svc.build !== undefined) {
        result.localBuilds += 1;
        continue;
      }
      const ref = parseImageRef(interpolateImage(svc.image!, composePath));
      const usedBy = `${stack}/${serviceName}`;
      if (!isSupportedRegistry(ref)) {
        // Never a silent drop: an unsupported registry means this image is
        // not being watched at all, which is strictly worse than an error.
        const reg = ref.registry ?? "(none)";
        result.skipped += 1;
        (result.skippedByRegistry[reg] ??= []).push(ref.raw);
        noteCheck(ref.raw, usedBy, `skipped: registry ${reg} has no client`);
        continue;
      }
      try {
        await scanService(stack, composePath, services, serviceName, ref);
        result.checked += 1;
        noteCheck(ref.raw, usedBy);
      } catch (err) {
        const msg = (err as Error).message;
        if (isLocalOnlyImage(ref, msg)) {
          // A bare name Docker Hub has never heard of (`myapp:local`) is an
          // image built on this host — not a failed check.
          result.localBuilds += 1;
          continue;
        }
        result.unchecked += 1;
        result.errors[ref.raw] = msg;
        noteCheck(ref.raw, usedBy, msg);
      }
    }
  }

  for (const [image, c] of checks) {
    try {
      recordImageCheck(deps.db, image, c.usedBy, c.error);
    } catch {
      // bookkeeping must never fail a scan
    }
  }

  // Group rows by (image, current_tag, target_tag) so multiple stacks running
  // the same image get one notification, not N. Approval applies to all rows
  // in a hold group (see handleApprove → findSiblings).
  const groupBy = (
    rows: { row: UpdateRow; composePath: string; serviceName: string }[],
  ) => {
    const groups = new Map<
      string,
      { row: UpdateRow; composePath: string; serviceName: string }[]
    >();
    for (const entry of rows) {
      const key = `${entry.row.image}|${entry.row.current_tag}|${entry.row.target_tag}`;
      const existing = groups.get(key);
      if (existing) existing.push(entry);
      else groups.set(key, [entry]);
    }
    return groups;
  };

  const dispatchGroup = async (
    group: { row: UpdateRow; composePath: string; serviceName: string }[],
  ) => {
    const canonical = group[0]!;

    // v0.4.1: digest-class bumps are noise on a per-event email channel —
    // rolling tags (`:latest`, `:nightly`) cycle constantly without any
    // semver delta to summarise. We still record + mark notified so /queue
    // shows them and the daily digest (v0.4.2+) can roll them up; we just
    // don't dispatch an immediate email asking the operator to act.
    if (canonical.row.bump === "digest") {
      for (const entry of group) {
        setNotified(deps.db, entry.row.id);
      }
      return;
    }

    const advise = deps.llmUrl
      ? await safeAdvise(
          {
            image: canonical.row.image,
            from: canonical.row.current_tag,
            to: canonical.row.target_tag,
            composeFile: canonical.composePath,
            serviceName: canonical.serviceName,
            stackName: canonical.row.stack,
            llmUrl: deps.llmUrl,
            llmKey: deps.llmKey,
            model: deps.llmModel,
            githubToken: deps.githubToken,
          },
          deps.adviseFn,
        )
      : null;

    if (notifyIntervalMs > 0 && lastDispatchAt > 0) {
      const wait = notifyIntervalMs - (Date.now() - lastDispatchAt);
      if (wait > 0) await sleep(wait);
    }

    const delivered = await dispatchBumpNotification(
      deps.notifiers,
      group.map((g) => g.row),
      deps.publicUrl,
      advise,
      deps.outboxDir
        ? { dir: deps.outboxDir, keepCount: deps.outboxKeepCount }
        : undefined,
    );
    lastDispatchAt = Date.now();

    // Only mark notified when the message actually went out. Otherwise
    // a transient SMTP rejection (e.g. MXroute throttle) would leave the
    // bump silently buried — the row would never re-fire on later scans.
    if (delivered) {
      for (const entry of group) {
        setNotified(deps.db, entry.row.id);
        // v0.4.1: persist the LLM advise body so we can audit later what
        // the operator actually saw without re-rolling the dice on the LLM.
        if (advise?.ok && advise.summary) {
          setAdviseText(deps.db, entry.row.id, advise.summary);
        }
        // v0.5.4: persist the structured paired-dep recommendations so a
        // later Approve click can bundle the dep rewrites atomically with
        // the app rewrite when bundling is opted-in for this stack.
        if (advise?.ok && advise.pairedDeps && advise.pairedDeps.length > 0) {
          setPairedDeps(
            deps.db,
            entry.row.id,
            JSON.stringify(advise.pairedDeps),
          );
        }
      }
    }
  };

  for (const group of groupBy(heldRows).values()) await dispatchGroup(group);
  return result;
}

function buildLinks(row: UpdateRow, publicUrl?: string): NotifyLink[] {
  if (!publicUrl || !row.approval_token) return [];
  const base = publicUrl.replace(/\/+$/, "");
  return [
    { label: "Approve", url: `${base}/approve/${row.approval_token}` },
    { label: "Deny", url: `${base}/deny/${row.approval_token}` },
  ];
}

async function dispatchBumpNotification(
  notifiers: Notifier[],
  rows: UpdateRow[],
  publicUrl?: string,
  advise?: AdviseSummary | null,
  outbox?: { dir: string; keepCount?: number },
): Promise<boolean> {
  if (rows.length === 0) return false;
  // No notifiers configured → treat as a successful no-op so the row's
  // state machine still advances (otherwise we'd retry every scan forever).
  if (notifiers.length === 0) return true;
  const canonical = rows[0]!;
  const others = rows.slice(1);
  const row = canonical;
  const stacksLabel =
    rows.length === 1
      ? row.stack
      : `${rows.length} stacks (${rows.map((r) => r.stack).join(", ")})`;
  const isDigest = row.bump === "digest";
  const subject = isDigest
    ? rows.length === 1
      ? `${row.stack}/${row.service}: ${row.image} digest changed`
      : `${rows.length} stacks: ${row.image} digest changed`
    : rows.length === 1
      ? `${row.stack}/${row.service}: ${row.image} → ${row.target_tag}`
      : `${rows.length} stacks: ${row.image} → ${row.target_tag}`;
  const links = buildLinks(canonical, publicUrl);
  const approveUrl = links.find((l) => l.label === "Approve")?.url;
  const denyUrl = links.find((l) => l.label === "Deny")?.url;

  // Plain-text body: action card at top (instruction + URLs), then metadata,
  // then LLM summary. Both Apprise and email-clients-without-HTML see this.
  const text: string[] = [];
  if (publicUrl && approveUrl && denyUrl) {
    text.push(
      "Click Approve to pull + restart, or Deny to leave the stack on its current tag.",
    );
    text.push("");
    text.push(`Approve: ${approveUrl}`);
    text.push(`Deny:    ${denyUrl}`);
  } else {
    text.push("Approval URLs are not configured (set BUMPSIGHT_PUBLIC_URL).");
  }
  text.push("");
  if (rows.length === 1) {
    text.push(`Stack:   ${row.stack}`);
    text.push(`Service: ${row.service}`);
  } else {
    text.push(`Stacks:  ${stacksLabel}`);
    text.push(
      `Services: ${rows.map((r) => `${r.stack}/${r.service}`).join(", ")}`,
    );
  }
  text.push(`Image:   ${row.image}`);
  if (isDigest) {
    text.push(`Digest:  sha256:${row.current_tag}… → sha256:${row.target_tag}…`);
    text.push(`Kind:    digest change (no semver classification — fallback)`);
  } else {
    text.push(`From:    ${fromDisplay(row)}`);
    text.push(`To:      ${toDisplay(row)}`);
    text.push(`Kind:    ${row.bump} bump`);
  }
  const movingTag = floatingTagOf(row.family);
  if (row.bump !== "digest" && movingTag) {
    text.push(`Origin:  digest change on :${movingTag}`);
  }
  if (others.length > 0) {
    text.push("");
    text.push(`Approval applies to all ${rows.length} stacks listed above.`);
  }
  if (advise) {
    text.push("");
    if (advise.ok && advise.summary) {
      const heading =
        advise.source === "general-knowledge"
          ? "───── LLM opinion (no upstream release notes) ─────"
          : "───── Upstream release-note summary ─────";
      text.push(heading);
      const sourceLine =
        advise.source === "general-knowledge"
          ? `Source: model general knowledge${advise.repo ? ` · upstream checked: github.com/${advise.repo}` : ""}`
          : `Source: github.com/${advise.repo} · ${advise.releaseCount} release(s) in range`;
      text.push(sourceLine);
      text.push("");
      text.push(advise.summary);
    } else {
      text.push("───── Advice ─────");
      text.push(
        `(skipped: ${advise.error ?? "unknown reason"}` +
          (advise.repo ? ` · upstream: ${advise.repo}` : "") +
          `)`,
      );
    }
  }

  const htmlBody = buildHoldHtml({
    rows,
    approveUrl,
    denyUrl,
    advise: advise ?? undefined,
  });

  const msg = {
    subject,
    body: text.join("\n"),
    htmlBody,
    // Links already rendered inline at the top of the body and as buttons in
    // the HTML — no need for the formatter to append a duplicate list.
    links: undefined,
  };
  const result = await notifyAll(notifiers, msg);
  if (outbox) {
    archiveMessage(
      outbox,
      msg,
      {
        kind: "hold",
        rowIds: rows.map((r) => r.id),
        adviseText: advise?.ok ? advise.summary : undefined,
        delivered: result.delivered,
        deliveryErrors: result.failed.length > 0 ? result.failed : undefined,
      },
    );
  }
  return result.delivered > 0;
}

interface HoldHtmlOpts {
  rows: UpdateRow[];
  approveUrl?: string;
  denyUrl?: string;
  advise?: AdviseSummary;
}

function buildHoldHtml(opts: HoldHtmlOpts): string {
  const { rows, approveUrl, denyUrl, advise } = opts;
  const row = rows[0]!;
  const e = escapeHtml;

  const buttons =
    approveUrl && denyUrl
      ? `
      <table role="presentation" cellspacing="0" cellpadding="0" border="0">
        <tr>
          <td style="padding-right:8px;">
            <a href="${e(approveUrl)}" style="display:inline-block;background:#16a34a;color:#ffffff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Approve</a>
          </td>
          <td>
            <a href="${e(denyUrl)}" style="display:inline-block;background:#475569;color:#ffffff;padding:10px 22px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">Deny</a>
          </td>
        </tr>
      </table>${
        rows.length > 1
          ? `<p style="margin:10px 0 0;font-size:12px;color:#1e3a8a;">Approval applies to all ${rows.length} stacks listed below.</p>`
          : ""
      }`
      : `<p style="margin:0;color:#7f1d1d;font-size:13px;">Approval URLs are not configured (set <code>BUMPSIGHT_PUBLIC_URL</code>).</p>`;

  const adviseSection = advise
    ? advise.ok && advise.summary
      ? (() => {
          const isOpinion = advise.source === "general-knowledge";
          const heading = isOpinion
            ? "LLM opinion (no upstream release notes)"
            : "Upstream release-note summary";
          const sourceLine = isOpinion
            ? `Source: model general knowledge${advise.repo ? ` · upstream checked: github.com/${e(advise.repo)}` : ""}`
            : `Source: github.com/${e(advise.repo ?? "")} · ${advise.releaseCount ?? 0} release(s) in range`;
          return `
      <div style="margin-top:24px;">
        <h3 style="margin:0 0 4px 0;font-size:14px;color:#1e293b;">${heading}</h3>
        <div style="font-size:12px;color:#64748b;margin-bottom:12px;">${sourceLine}</div>
        <div style="font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:13px;line-height:1.5;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:14px 16px;white-space:pre-wrap;">${e(advise.summary)}</div>
      </div>`;
        })()
      : `
      <div style="margin-top:24px;font-size:13px;color:#94a3b8;font-style:italic;">
        Advice skipped: ${e(advise.error ?? "unknown reason")}${advise.repo ? ` · upstream: github.com/${e(advise.repo)}` : ""}
      </div>`
    : "";

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f1f5f9;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f1f5f9;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a;">
<tr><td style="padding:24px;">

  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 18px 0;">
    <tr>
      <td style="padding-right:10px;vertical-align:middle;">${BRAND_LOGO_INLINE}</td>
      <td style="vertical-align:middle;"><div style="font-size:18px;font-weight:600;color:#0f172a;">bumpsight</div></td>
    </tr>
  </table>

  <!-- Action card -->
  <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
    <p style="margin:0 0 14px 0;font-size:14px;line-height:1.5;color:#1e3a8a;">
      Click <strong>Approve</strong> to pull + restart, or <strong>Deny</strong> to leave the stack on its current tag.
    </p>${buttons}
  </div>

  <!-- Metadata -->
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="font-size:14px;line-height:1.6;">
    ${
      rows.length === 1
        ? `<tr><td style="padding:2px 14px 2px 0;color:#64748b;">Stack</td>   <td><strong>${e(row.stack)}</strong></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Service</td> <td>${e(row.service)}</td></tr>`
        : `<tr><td style="padding:2px 14px 2px 0;color:#64748b;vertical-align:top;">Stacks</td><td>${rows
            .map(
              (r) =>
                `<strong>${e(r.stack)}</strong> <span style="color:#94a3b8;">/ ${e(r.service)}</span>`,
            )
            .join("<br>")}</td></tr>`
    }
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Image</td>   <td><code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">${e(row.image)}</code></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">From</td>    <td><code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">${e(fromDisplay(row))}</code></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">To</td>      <td><code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">${e(toDisplay(row))}</code></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Bump</td>    <td>${e(row.bump)}</td></tr>
    ${
      row.bump !== "digest" && floatingTagOf(row.family)
        ? `<tr><td style="padding:2px 14px 2px 0;color:#64748b;">Origin</td>  <td>digest change on <code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">:${e(floatingTagOf(row.family)!)}</code></td></tr>`
        : ""
    }
  </table>

  ${adviseSection}

</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

async function safeAdvise(
  opts: Parameters<typeof getAdviseSummary>[0],
  fn?: typeof getAdviseSummary,
): Promise<AdviseSummary> {
  try {
    return await (fn ?? getAdviseSummary)(opts);
  } catch (err) {
    return { ok: false, error: `advise threw: ${(err as Error).message}` };
  }
}

async function safeEnrichDigest(
  opts: Parameters<typeof enrichDigestBump>[0],
  fn?: typeof enrichDigestBump,
): Promise<DigestEnrichmentResult> {
  try {
    return await (fn ?? enrichDigestBump)(opts);
  } catch (err) {
    return { ok: false, error: `enrich threw: ${(err as Error).message}` };
  }
}

/**
 * v0.6.0: fetch OCI labels for the old + new digest of a moving-tag bump and
 * reduce them to a display delta (version or build date). Best-effort — any
 * fetch failure (unsupported registry, GC'd old blob, network) collapses to an
 * empty delta and the caller keeps the raw hash display. Two extra registry
 * round-trips, only on an actual digest change (infrequent).
 */
async function safeMovingDelta(
  ref: ImageRef,
  oldDigest: string,
  newDigest: string,
): Promise<MovingDelta> {
  try {
    const [oldOci, newOci] = await Promise.all([
      fetchOciLabels(ref, oldDigest).catch(() => ({ labels: {} })),
      fetchOciLabels(ref, newDigest).catch(() => ({ labels: {} })),
    ]);
    return resolveMovingDelta(movingTagInfo(oldOci), movingTagInfo(newOci));
  } catch {
    return {};
  }
}

/** Version from an image's OCI labels at `digest`, when it reads like one. */
async function ociLabelVersion(
  ref: ImageRef,
  digest: string,
): Promise<string | undefined> {
  const oci = await fetchOciLabels(ref, digest);
  const v = extractVersion(oci.labels);
  return looksLikeVersion(v) ? v!.trim() : undefined;
}

/**
 * Full target ref for a tag bump on a `tag@sha256:…` pin: the new tag plus
 * the digest it points at, so the pin stays a pin. Falls back to the bare
 * new tag when the registry won't say (a stale digest must never survive a
 * tag rewrite — Docker resolves the digest and would silently pull the old
 * image).
 */
async function pinnedTargetRef(
  ref: ImageRef,
  newTag: string,
  tags: RemoteTag[],
  fetchFn: typeof fetchManifestDigest,
): Promise<string> {
  const head = ref.raw.slice(0, ref.raw.indexOf("@"));
  const lastSlash = head.lastIndexOf("/");
  const lastColon = head.lastIndexOf(":");
  const base = lastColon > lastSlash ? head.slice(0, lastColon) : head;
  let digest = tags.find((t) => t.name === newTag)?.digest;
  if (!digest) {
    try {
      digest = await fetchFn(ref, newTag);
    } catch {
      digest = undefined;
    }
  }
  return digest ? `${base}:${newTag}@${digest}` : `${base}:${newTag}`;
}

/**
 * True when a failed lookup means "this image only exists on this host": a
 * bare name (no registry, no namespace) that Docker Hub's official-image
 * namespace does not have.
 */
export function isLocalOnlyImage(ref: ImageRef, error: string): boolean {
  return !ref.registry && !ref.namespace && /Docker Hub: 404\b/.test(error);
}

export async function dispatchAppliedNotification(
  notifiers: Notifier[],
  row: UpdateRow,
  advise?: AdviseSummary | null,
  outbox?: { dir: string; keepCount?: number },
): Promise<void> {
  if (notifiers.length === 0) return;
  const subject = `${row.stack}/${row.service}: ${row.image} → ${row.target_tag}`;
  const ok = row.status === "applied";
  // v0.4.1: this function now serves both auto-apply (decided_by='auto')
  // and human-approve (decided_by='http-link'). Phrase the message based
  // on which flow ran so the email reads correctly in both contexts.
  const isHumanApproved =
    row.decided_by === "http-link" || row.decided_by === "manual-audit";
  const verbApplied = isHumanApproved ? "Approved & applied" : "Auto-applied";
  const verbApplyFailed = isHumanApproved
    ? "Approved but apply failed"
    : "Auto-apply failed";

  const text: string[] = [];
  text.push(
    ok
      ? `${verbApplied} per policy. The stack is now on ${row.target_tag}.`
      : `${verbApplyFailed}. The stack is still on ${row.current_tag}; check the daemon log + apply_log below.`,
  );
  text.push("");
  text.push(`Stack:   ${row.stack}`);
  text.push(`Service: ${row.service}`);
  text.push(`Image:   ${row.image}`);
  text.push(`From:    ${fromDisplay(row)}`);
  text.push(`To:      ${toDisplay(row)}`);
  text.push(`Kind:    ${row.bump} bump`);
  if (row.bump !== "digest" && floatingTagOf(row.family)) {
    text.push(`Origin:  digest change on :${floatingTagOf(row.family)}`);
  }
  text.push(`Status:  ${row.status}`);
  if (row.apply_log) {
    text.push("");
    text.push("───── apply log ─────");
    text.push(row.apply_log);
  }
  if (advise) {
    text.push("");
    if (advise.ok && advise.summary) {
      const heading =
        advise.source === "general-knowledge"
          ? "───── LLM opinion (no upstream release notes) ─────"
          : "───── Upstream release-note summary ─────";
      text.push(heading);
      text.push(advise.summary);
    }
  }

  const htmlBody = buildAppliedHtml({ row, advise: advise ?? undefined });

  const msg = {
    subject,
    body: text.join("\n"),
    htmlBody,
    links: undefined,
  };
  const result = await notifyAll(notifiers, msg);
  if (outbox) {
    archiveMessage(
      outbox,
      msg,
      {
        kind: ok ? "applied" : "apply-failure",
        rowIds: [row.id],
        adviseText: advise?.ok ? advise.summary : undefined,
        delivered: result.delivered,
        deliveryErrors: result.failed.length > 0 ? result.failed : undefined,
      },
    );
  }
}

interface AppliedHtmlOpts {
  row: UpdateRow;
  advise?: AdviseSummary;
}

function buildAppliedHtml(opts: AppliedHtmlOpts): string {
  const { row, advise } = opts;
  const e = escapeHtml;
  const ok = row.status === "applied";
  const isHumanApproved =
    row.decided_by === "http-link" || row.decided_by === "manual-audit";
  const verbOk = isHumanApproved ? "Approved & applied" : "Auto-applied";
  const verbFail = isHumanApproved
    ? "Approved but apply failed"
    : "Auto-apply failed";

  const banner = ok
    ? `<div style="background:#dcfce7;border:1px solid #86efac;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
        <p style="margin:0;font-size:14px;line-height:1.5;color:#14532d;">
          <strong>${verbOk}.</strong> The stack is now on <code style="background:#bbf7d0;padding:1px 6px;border-radius:3px;">${e(row.target_tag)}</code>. No action needed from you.
        </p>
      </div>`
    : `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
        <p style="margin:0;font-size:14px;line-height:1.5;color:#7f1d1d;">
          <strong>${verbFail}.</strong> The stack is still on <code style="background:#fecaca;padding:1px 6px;border-radius:3px;">${e(row.current_tag)}</code>. See apply log below.
        </p>
      </div>`;

  const adviseSection =
    advise && advise.ok && advise.summary
      ? (() => {
          const isOpinion = advise.source === "general-knowledge";
          const heading = isOpinion
            ? "LLM opinion (no upstream release notes)"
            : "Upstream release-note summary";
          const sourceLine = isOpinion
            ? `Source: model general knowledge${advise.repo ? ` · upstream checked: github.com/${e(advise.repo)}` : ""}`
            : `Source: github.com/${e(advise.repo ?? "")} · ${advise.releaseCount ?? 0} release(s) in range`;
          return `
      <div style="margin-top:24px;">
        <h3 style="margin:0 0 4px 0;font-size:14px;color:#1e293b;">${heading}</h3>
        <div style="font-size:12px;color:#64748b;margin-bottom:12px;">${sourceLine}</div>
        <div style="font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:13px;line-height:1.5;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:14px 16px;white-space:pre-wrap;">${e(advise.summary)}</div>
      </div>`;
        })()
      : "";

  const applyLogSection = row.apply_log
    ? (() => {
        const lines = row.apply_log.split("\n").length;
        const kb = (row.apply_log.length / 1024).toFixed(1);
        return `
      <div style="margin-top:24px;">
        <details style="margin:0;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;">
          <summary style="cursor:pointer;padding:10px 14px;font-size:14px;color:#1e293b;font-weight:600;list-style:none;">Apply log <span style="color:#64748b;font-weight:400;font-size:12px;">(${lines} line${lines === 1 ? "" : "s"} · ${kb} KB)</span></summary>
          <pre style="font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12px;line-height:1.4;background:#f8fafc;border-top:1px solid #e2e8f0;border-radius:0 0 6px 6px;padding:14px 16px;white-space:pre-wrap;margin:0;">${e(row.apply_log)}</pre>
        </details>
      </div>`;
      })()
    : "";

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f1f5f9;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f1f5f9;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a;">
<tr><td style="padding:24px;">

  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 18px 0;">
    <tr>
      <td style="padding-right:10px;vertical-align:middle;">${BRAND_LOGO_INLINE}</td>
      <td style="vertical-align:middle;"><div style="font-size:18px;font-weight:600;color:#0f172a;">bumpsight</div></td>
    </tr>
  </table>

  ${banner}

  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="font-size:14px;line-height:1.6;">
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Stack</td>   <td><strong>${e(row.stack)}</strong></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Service</td> <td>${e(row.service)}</td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Image</td>   <td><code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">${e(row.image)}</code></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">From</td>    <td><code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">${e(fromDisplay(row))}</code></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">To</td>      <td><code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">${e(toDisplay(row))}</code></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Bump</td>    <td>${e(row.bump)}</td></tr>
    ${
      row.bump !== "digest" && floatingTagOf(row.family)
        ? `<tr><td style="padding:2px 14px 2px 0;color:#64748b;">Origin</td>  <td>digest change on <code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">:${e(floatingTagOf(row.family)!)}</code></td></tr>`
        : ""
    }
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Status</td>  <td>${e(row.status)}</td></tr>
  </table>

  ${adviseSection}
  ${applyLogSection}

</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

export interface DaemonRuntime {
  /** Stop the scheduler. Resolves when the in-flight scan finishes. */
  stop(): Promise<void>;
}

export interface StartDaemonDeps {
  db: DB;
  notifiers: Notifier[];
  composeFiles: Record<string, string>;
  publicUrl?: string;
  llmUrl?: string;
  llmKey?: string;
  llmModel?: string;
  githubToken?: string;
  outboxDir?: string;
  outboxKeepCount?: number;
  log: (msg: string) => void;
  /** Test seams. */
  listTagsFn?: typeof listTags;
  fetchManifestDigestFn?: typeof fetchManifestDigest;
  runner?: CommandRunner;
  adviseFn?: typeof getAdviseSummary;
  /** v0.5.4: per-stack opt-in for paired-dep bundling. Forwarded to scans. */
  applyPairedDeps?: ApplyPairedDepsConfig;
  /** v0.5.5: test seam — override digest-class enrichment. */
  enrichDigestFn?: typeof enrichDigestBump;
}

/**
 * Start the daemon scheduler. Invokes runScanOnce immediately and then
 * every `intervalMs`. Reports progress via the `log` callback.
 */
export function startDaemon(
  cfg: DaemonConfig,
  deps: StartDaemonDeps,
): DaemonRuntime {
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  // v0.6.4: the drift pass runs on its own (much slower) cadence than the
  // registry scan — it costs one upstream compose fetch per stack, and
  // maintainers do not re-pin their deps every six hours.
  let lastDepDriftAt = 0;

  const tick = async () => {
    if (stopping) return;
    inFlight = (async () => {
      const started = Date.now();
      try {
        // v0.6.0: recompute effective rules each tick so UI-set per-stack
        // policy overrides (stack_policies table) take effect on the next scan
        // without a daemon restart. DB overrides win over the file/env policy.
        const effectiveRules = applyStackPolicyOverrides(
          cfg.rules,
          getAllStackPolicies(deps.db),
        );
        // v0.6.0: retire queue rows the current policy no longer holds before
        // scanning (self-healing queue). auto-apply-eligible rows are requeued
        // (deleted here, re-discovered + applied by the scan below).
        const rec = reconcileOpenRows(
          deps.db,
          effectiveRules,
          deps.composeFiles,
        );
        if (rec.dismissed + rec.requeued + rec.stale > 0)
          deps.log(
            `reconcile: ${rec.dismissed} dismissed, ${rec.requeued} requeued for auto-apply, ` +
              `${rec.stale} retired as out-of-band`,
          );
        const result = await runScanOnce({
          db: deps.db,
          notifiers: deps.notifiers,
          rules: effectiveRules,
          composeFiles: deps.composeFiles,
          publicUrl: deps.publicUrl,
          llmUrl: deps.llmUrl,
          llmKey: deps.llmKey,
          llmModel: deps.llmModel,
          githubToken: deps.githubToken,
          outboxDir: deps.outboxDir,
          outboxKeepCount: deps.outboxKeepCount,
          notifyIntervalMs: cfg.notifyIntervalMs,
          listTagsFn: deps.listTagsFn,
          fetchManifestDigestFn: deps.fetchManifestDigestFn,
          runner: deps.runner,
          adviseFn: deps.adviseFn,
          applyPairedDeps: deps.applyPairedDeps,
          enrichDigestFn: deps.enrichDigestFn,
        });
        const ms = Date.now() - started;
        deps.log(
          `scan: ${result.scanned} services` +
            (result.skipped > 0 ? ` (${result.skipped} skipped)` : "") +
            `, ${result.discovered} new ` +
            `(${result.autoApplied} auto, ${result.autoAppliedOk} applied ok, ${result.held} held), ${ms}ms`,
        );
        for (const [reg, refs] of Object.entries(result.skippedByRegistry)) {
          deps.log(
            `scan-skip: registry ${reg} has no client — ${refs.length} image(s) NOT checked: ${refs.join(", ")}`,
          );
        }
        for (const [k, v] of Object.entries(result.errors)) {
          deps.log(`scan-error: ${k}: ${v}`);
        }

        // v0.6.4: dependency-drift pass. Asks what the parent app's own
        // upstream compose pins at the version we ALREADY run — the question
        // the registry scan structurally cannot answer. Findings become
        // ordinary rows with origin='paired', so notify/approve/apply and
        // reconcile all work on them unchanged.
        if (
          cfg.depDriftIntervalMs > 0 &&
          Date.now() - lastDepDriftAt >= cfg.depDriftIntervalMs
        ) {
          lastDepDriftAt = Date.now();
          try {
            const { findings, imageChanges } = await scanDepDrift({
              composeFiles: deps.composeFiles,
              githubToken: deps.githubToken,
              log: deps.log,
            });

            // v0.6.4: image changes get a row so they are ASKED about rather
            // than only logged, but they are classified `unknown`, which
            // `decideAction` holds under every policy. An image swap is never
            // auto-applied — the operator decides, and Approve then rewrites
            // the full ref (not just the tag) via `target_image`.
            for (const ic of imageChanges) {
              const existed = findUpdateByDelta(
                deps.db,
                ic.stack,
                ic.service,
                ic.localTag,
                ic.upstreamTag,
              );
              const id = recordUpdate(deps.db, {
                stack: ic.stack,
                service: ic.service,
                image: ic.localImage,
                currentTag: ic.localTag,
                targetTag: ic.upstreamTag,
                bump: "unknown",
                approvalToken: randomBytes(16).toString("hex"),
                origin: "paired",
                targetImage: ic.upstreamImage,
              });
              // The tags alone read as "8 -> 9-alpine", which hides the fact
              // that the IMAGE moved. Show the full refs instead.
              setDisplayTags(deps.db, id, ic.localImage, ic.upstreamImage);
              if (!existed)
                deps.log(
                  `dep-drift: ${ic.stack}/${ic.service} needs a decision — ` +
                    `${ic.localImage} -> ${ic.upstreamImage} (row ${id})`,
                );
            }
            let recorded = 0;
            for (const f of findings) {
              const before = findUpdateByDelta(
                deps.db,
                f.stack,
                f.service,
                f.localTag,
                f.upstreamTag,
              );
              const id = recordUpdate(deps.db, {
                stack: f.stack,
                service: f.service,
                image: f.localImage,
                currentTag: f.localTag,
                targetTag: f.upstreamTag,
                bump: f.bump,
                approvalToken: randomBytes(16).toString("hex"),
                origin: "paired",
              });
              if (!before) {
                recorded += 1;
                deps.log(
                  `dep-drift: ${f.stack}/${f.service} ${f.localTag} -> ${f.upstreamTag} ` +
                    `(recommended by ${f.viaService} upstream, row ${id})`,
                );
              }
            }
            if (findings.length > 0)
              deps.log(
                `dep-drift: ${recorded} new row(s) from ${findings.length} finding(s)`,
              );
          } catch (err) {
            deps.log(`dep-drift-failed: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        deps.log(`scan-failed: ${(err as Error).message}`);
      }
    })();
    await inFlight;
    if (!stopping) {
      timer = setTimeout(tick, cfg.intervalMs);
    }
  };

  tick();

  return {
    stop: async () => {
      stopping = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}

/**
 * v0.6.0: reconcile the open queue against the current policy. A row created
 * under an earlier policy (or bumpsight version) can be left in "needs
 * decision" even though the current policy would auto-apply or skip it — the
 * decision was effectively already made. This re-runs `decideAction` on every
 * still-open row and retires the ones the current policy no longer holds:
 *   - `skip` (e.g. a dep bump under `dependencies: none`) → dismissed (kept in
 *     history; nothing to apply, policy says don't touch it).
 *   - `auto-apply` (e.g. an app patch/minor) → the stale record is DELETED so
 *     the very next scan re-discovers the *current* delta and applies it. This
 *     never drops a genuinely-pending update (the scan re-derives current
 *     state), and never applies a stale target.
 *   - `hold` → left in the queue (majors, unclassifiable digests, notify).
 *
 * v0.6.4 adds a second axis, checked first: a row whose stack's compose no
 * longer pins the row's `current_tag` is retired as `out-of-band`, because the
 * delta it describes no longer exists. This is what reconciles updates applied
 * outside bumpsight (a hand-edited pin, another operator, a manual upgrade).
 *
 * Runs before each scan so the queue self-heals as policy and compose change.
 * Returns {dismissed, requeued, stale} counts.
 */
export function reconcileOpenRows(
  db: DB,
  rules: RulesConfig,
  composeFiles?: Record<string, string>,
): { dismissed: number; requeued: number; stale: number } {
  const rows = db
    .prepare(
      `SELECT id, stack, service, image, bump, current_tag, origin, family FROM updates
       WHERE status IN ('pending','notified')
         AND (superseded IS NULL OR superseded = 0)`,
    )
    .all() as Pick<
    UpdateRow,
    | "id"
    | "stack"
    | "service"
    | "image"
    | "bump"
    | "current_tag"
    | "origin"
    | "family"
  >[];
  let dismissed = 0;
  let requeued = 0;
  let stale = 0;

  // v0.6.4: one compose parse per stack, shared across that stack's rows.
  // `null` means "could not read it" — treated as no signal, never as drift.
  const composeCache = new Map<string, ReturnType<typeof loadComposeFile> | null>();
  const liveImage = (stack: string, service: string): string | null => {
    const path = composeFiles?.[stack];
    if (!path) return null;
    if (!composeCache.has(stack)) {
      try {
        composeCache.set(stack, loadComposeFile(path));
      } catch {
        composeCache.set(stack, null);
      }
    }
    const image = composeCache.get(stack)?.services?.[service]?.image;
    if (typeof image !== "string") return null;
    return interpolateImage(image, path).trim();
  };
  const livePinnedTag = (stack: string, service: string): string | null => {
    const image = liveImage(stack, service);
    return image === null ? null : (parseImageRef(image).tag ?? null);
  };

  for (const r of rows) {
    // v0.6.4: retire rows whose compose pin moved out from under us — an
    // operator edit, or an apply this daemon did not perform. A row's
    // `current_tag` is the "from" side of its bump; once the compose no
    // longer carries that tag, the row describes a delta that no longer
    // exists and can never be honestly approved or denied.
    //
    // Deliberately checked BEFORE the dependency guard below: a stale dep
    // row is exactly as undecidable as a stale app row, and dependency rows
    // are the ones that sit open longest. The vault server stack held two
    // (2.0.0 -> 2.0.3 and 2.0.0 -> 2.0.4) for a month after it had already
    // been upgraded to 2.0.4 by hand.
    //
    // A missing service (renamed/removed) is NOT treated as drift — the tag
    // lookup returns null and the row is left for policy to decide.
    // A row tracking a floating tag by digest carries VERSIONS (or digest
    // prefixes) in current_tag, never the tag the compose file holds — so
    // compare the tag it tracks instead, and for a `tag@digest` pin the whole
    // ref (the pin moving is exactly what an out-of-band upgrade looks like).
    // Comparing current_tag here used to retire every such row on the next
    // pass, because `1.7.1` is never equal to `latest`.
    const floatTag = floatingTagOf(r.family);
    let drifted: boolean;
    if (floatTag !== undefined) {
      const live = liveImage(r.stack, r.service);
      drifted =
        live !== null &&
        (r.family!.startsWith("pinned:")
          ? live !== r.image.trim()
          : parseImageRef(live).tag !== floatTag);
    } else {
      const livePin = livePinnedTag(r.stack, r.service);
      drifted = livePin !== null && r.current_tag !== null && livePin !== r.current_tag;
    }
    if (drifted) {
      dismissRow(db, r.id, "out-of-band");
      stale += 1;
      continue;
    }
    const ref = parseImageRef(r.image);
    // No compose file in scope here (we reconcile from stored rows), so only
    // the service-named-after-its-stack signal is available. That is enough for
    // the case this guards: the stack whose app IS a dependency-listed image.
    const isDep = isDependencyImage(
      ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name,
      { stack: r.stack, service: r.service },
    );
    // v0.6.0: dependencies are always kept in the GUI for individual review —
    // never reconciled away (that's the documented dependency special case).
    // v0.6.4: paired rows are exempt from that exemption. They are dep images
    // by construction, so the guard would make them permanently unreconcilable.
    if (isDep && r.origin !== "paired") continue;
    const decision = decideAction(
      rules,
      r.stack,
      r.bump as BumpKind,
      isDep,
      r.origin,
    );
    if (decision === "skip") {
      dismissRow(db, r.id, "skip");
      dismissed += 1;
    } else if (decision === "auto-apply") {
      // v0.6.4: `deleteUpdate` is only safe for rows the registry scan will
      // re-derive on its next pass. A paired row comes from the drift pass,
      // which runs daily — deleting it here would drop it until the next drift
      // scan re-created it, and reconcile would delete it again, so it could
      // loop indefinitely without ever applying. Hold it instead.
      if (r.origin === "paired") continue;
      deleteUpdate(db, r.id); // scan re-discovers + applies the current delta
      requeued += 1;
    }
  }
  return { dismissed, requeued, stale };
}

export function buildComposeFileMap(paths: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of paths) {
    const stack = basename(dirname(resolve(p)));
    map[stack] = resolve(p);
  }
  return map;
}
