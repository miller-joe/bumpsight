import { dirname, basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import { loadComposeFile, parseImageRef, type ImageRef } from "../compose/parse.js";
import {
  isSupportedRegistry,
  listTags,
  fetchManifestDigest,
  type RemoteTag,
} from "../registry/index.js";
import { findLatestInFamily, parseTag } from "../util/semver.js";
import { classifyBump, decideAction, isDependencyImage, isMovingTag } from "./rules.js";
import type { BumpKind, RulesConfig } from "./rules.js";
import type { DaemonConfig } from "./config.js";
import {
  recordUpdate,
  setNotified,
  findUpdate,
  getStoredDigest,
  saveDigest,
  type UpdateRow,
} from "../state/db.js";
import { notifyAll } from "../notify/index.js";
import { archiveMessage } from "../notify/outbox.js";
import type { Notifier, NotifyMessage, NotifyLink } from "../notify/types.js";
import { applyOne } from "../apply/index.js";
import type { CommandRunner } from "../apply/docker.js";
import { getAdviseSummary, type AdviseSummary } from "../commands/advise.js";
import { setAdviseText, setPairedDeps } from "../state/db.js";
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
  /** Test seam — sleep helper for the rate limiter. */
  sleepFn?: (ms: number) => Promise<void>;
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
  };
  const lister = deps.listTagsFn ?? listTags;
  const manifestFetcher = deps.fetchManifestDigestFn ?? fetchManifestDigest;
  const sleep =
    deps.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const notifyIntervalMs = deps.notifyIntervalMs ?? 0;
  let lastDispatchAt = 0;
  const heldRows: { row: UpdateRow; composePath: string; serviceName: string }[] =
    [];

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
    );

    for (const [serviceName, svc] of services) {
      result.scanned += 1;
      const ref = parseImageRef(svc.image!);
      if (!isSupportedRegistry(ref)) continue;

      let tags: Awaited<ReturnType<typeof lister>>;
      try {
        tags = await lister(ref, {});
      } catch (err) {
        result.errors[ref.raw] = (err as Error).message;
        continue;
      }

      // Path A: moving tag (latest / stable / edge / etc.) — track digest
      // changes. Phase 2: try to resolve the digest to the most-precise
      // semver tag sharing it. When both prior and new digests resolve, we
      // classify the change as a normal patch / minor / major and let the
      // stack's policy decide auto-apply vs hold. When resolution fails on
      // either side, we fall back to Phase 1 behavior (always hold, with
      // digest prefixes shown in the email).
      if (isMovingTag(ref.tag)) {
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
        if (!newDigest) continue;

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
          continue;
        }
        if (prev.digest === newDigest) continue;

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
        if (prev.resolvedTag && newResolved) {
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
        );
        const decision = decideAction(deps.rules, stack, bump, isDep);
        if (decision === "skip") {
          // Still advance stored digest so we don't refire on every scan.
          saveDigest(
            deps.db,
            ref.raw,
            ref.tag,
            newDigest,
            newResolved ?? null,
          );
          continue;
        }

        const token =
          decision === "hold"
            ? randomBytes(18).toString("base64url")
            : undefined;
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
        if (!row || row.status !== "pending") continue;
        result.discovered += 1;

        // Advance the stored digest now so a re-scan before the user acts
        // doesn't keep refiring the same bump.
        saveDigest(deps.db, ref.raw, ref.tag, newDigest, newResolved ?? null);

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
        } else {
          result.held += 1;
          heldRows.push({ row, composePath, serviceName });
        }
        continue;
      }

      // Path B: semver tag — existing behavior
      const latest = findLatestInFamily(
        ref.tag,
        tags.map((t) => t.name),
      );
      if (!latest || latest === ref.tag) continue;

      const bump: BumpKind = classifyBump(ref.tag, latest);
      const isDep = isDependencyImage(
        ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name,
      );
      const decision = decideAction(deps.rules, stack, bump, isDep);
      if (decision === "skip") continue;

      // Only generate an approval token for `hold` decisions.
      const token =
        decision === "hold" ? randomBytes(18).toString("base64url") : undefined;
      const id = recordUpdate(deps.db, {
        stack,
        service: serviceName,
        image: ref.raw,
        currentTag: ref.tag,
        targetTag: latest,
        bump,
        approvalToken: token,
      });

      const row = findUpdate(deps.db, id);
      if (!row || row.status !== "pending") continue;
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
      } else {
        result.held += 1;
        heldRows.push({ row, composePath, serviceName });
      }
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
    text.push(`From:    ${row.current_tag}`);
    text.push(`To:      ${row.target_tag}`);
    text.push(`Kind:    ${row.bump} bump`);
  }
  if (row.bump !== "digest" && row.family?.startsWith("moving:")) {
    const movingTag = row.family.slice("moving:".length);
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
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">From</td>    <td><code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">${e(row.current_tag)}</code></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">To</td>      <td><code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">${e(row.target_tag)}</code></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Bump</td>    <td>${e(row.bump)}</td></tr>
    ${
      row.bump !== "digest" && row.family?.startsWith("moving:")
        ? `<tr><td style="padding:2px 14px 2px 0;color:#64748b;">Origin</td>  <td>digest change on <code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">:${e(row.family.slice("moving:".length))}</code></td></tr>`
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
 * Given a digest from a moving tag (e.g. `:latest`), return the most-precise
 * semver-shaped tag in the registry that shares it. Used to classify
 * digest changes as a normal patch / minor / major bump.
 *
 * Strategy:
 *   - Take all semver-shaped candidate tags (skip the moving tag itself and
 *     any other moving channels — those have no `numeric` part).
 *   - Sort by descending precision (most-specific first), then alphabetically
 *     so within the same precision the higher-version name wins.
 *   - Fast path: if the registry returned digests inline (Docker Hub), match
 *     directly.
 *   - Slow path: probe candidate manifests one by one, capped at MAX_PROBES
 *     to avoid runaway requests on a registry without inline digests (GHCR).
 *
 * Returns undefined when nothing matches — callers fall back to the
 * Phase 1 digest-only behavior (always hold).
 */
async function resolveDigestToTag(
  ref: ImageRef,
  tags: RemoteTag[],
  digest: string,
  movingTag: string,
  fetchFn: typeof fetchManifestDigest,
): Promise<string | undefined> {
  interface Candidate {
    name: string;
    precision: number;
    digest?: string;
  }
  const candidates: Candidate[] = [];
  for (const t of tags) {
    if (t.name.toLowerCase() === movingTag.toLowerCase()) continue;
    const parsed = parseTag(t.name);
    if (!parsed.numeric) continue; // skip other moving / opaque tags
    candidates.push({
      name: t.name,
      precision: parsed.numeric.length,
      digest: t.digest,
    });
  }
  candidates.sort((a, b) => {
    if (a.precision !== b.precision) return b.precision - a.precision;
    return b.name.localeCompare(a.name);
  });

  // Fast path: inline digests (Docker Hub).
  for (const c of candidates) {
    if (c.digest && c.digest === digest) return c.name;
  }

  // Slow path: probe manifests for tags without inline digests (GHCR).
  const MAX_PROBES = 30;
  let probed = 0;
  for (const c of candidates) {
    if (c.digest !== undefined) continue;
    if (probed >= MAX_PROBES) break;
    probed += 1;
    try {
      const probed_digest = await fetchFn(ref, c.name);
      if (probed_digest === digest) return c.name;
    } catch {
      // ignore probe failure, keep trying others
    }
  }
  return undefined;
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
  text.push(`From:    ${row.current_tag}`);
  text.push(`To:      ${row.target_tag}`);
  text.push(`Kind:    ${row.bump} bump`);
  if (row.bump !== "digest" && row.family?.startsWith("moving:")) {
    text.push(`Origin:  digest change on :${row.family.slice("moving:".length)}`);
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
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">From</td>    <td><code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">${e(row.current_tag)}</code></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">To</td>      <td><code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">${e(row.target_tag)}</code></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Bump</td>    <td>${e(row.bump)}</td></tr>
    ${
      row.bump !== "digest" && row.family?.startsWith("moving:")
        ? `<tr><td style="padding:2px 14px 2px 0;color:#64748b;">Origin</td>  <td>digest change on <code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">:${e(row.family.slice("moving:".length))}</code></td></tr>`
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

  const tick = async () => {
    if (stopping) return;
    inFlight = (async () => {
      const started = Date.now();
      try {
        const result = await runScanOnce({
          db: deps.db,
          notifiers: deps.notifiers,
          rules: cfg.rules,
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
          `scan: ${result.scanned} services, ${result.discovered} new ` +
            `(${result.autoApplied} auto, ${result.autoAppliedOk} applied ok, ${result.held} held), ${ms}ms`,
        );
        for (const [k, v] of Object.entries(result.errors)) {
          deps.log(`scan-error: ${k}: ${v}`);
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

export function buildComposeFileMap(paths: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of paths) {
    const stack = basename(dirname(resolve(p)));
    map[stack] = resolve(p);
  }
  return map;
}
