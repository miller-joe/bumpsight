/**
 * v0.5.7: watched-releases poll.
 *
 * Bumpsight's scan loop only sees Docker images referenced by an `image:` key
 * in a discovered compose file. Some homelab versions live elsewhere — a binary
 * baked into a Dockerfile by a hardcoded version pin (e.g. git-lfs on the
 * claude-dev image), a tool installed into a `build:`-only container, etc. Those
 * never produce a compose image tag, so the scan loop is structurally blind to
 * them (this is the gap that let a git-lfs 3.3.0 → 3.6.1 bump go unflagged).
 *
 * `watched_releases` closes that gap as an opt-in capability: the operator
 * declares the upstream GitHub repo + the version they currently have
 * installed, and bumpsight polls GitHub Releases and emails when a newer one
 * appears. It is **notify-only** — bumpsight has no way to install a host
 * binary, so there are no Approve/Deny links; the email tells the operator to
 * update the pin themselves and bump `current:` afterward.
 *
 * Dedup mirrors the image path: one email per newer release, tracked by
 * `notified_tag`, only marked once the message actually delivered.
 */
import type { Database as DB } from "better-sqlite3";
import {
  fetchReleases,
  type GithubRelease,
  type RepoCoords,
} from "../releases/github.js";
import { findLatestInFamily } from "../util/semver.js";
import { classifyBump } from "./rules.js";
import { notifyAll } from "../notify/index.js";
import { archiveMessage } from "../notify/outbox.js";
import { getAdviseSummary, type AdviseSummary } from "../commands/advise.js";
import {
  getWatchedReleaseState,
  recordWatchedCheck,
  recordWatchedNotified,
} from "../state/db.js";
import type { Notifier, NotifyMessage } from "../notify/types.js";
import type { WatchedReleaseSpec } from "./config.js";

export interface WatchedReleasesRunDeps {
  db: DB;
  specs: WatchedReleaseSpec[];
  notifiers: Notifier[];
  llmUrl?: string;
  llmKey?: string;
  llmModel?: string;
  githubToken?: string;
  /** Minimum gap in ms between dispatched notifications. Default 0. */
  notifyIntervalMs?: number;
  outboxDir?: string;
  outboxKeepCount?: number;
  log?: (msg: string) => void;
  /** Test seam — defaults to the real GitHub releases client. */
  fetchReleasesFn?: typeof fetchReleases;
  /** Test seam — override advise. */
  adviseFn?: typeof getAdviseSummary;
  /** Test seam — sleep helper for the rate limiter. */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface WatchedReleasesRunResult {
  /** Repos polled (excludes `policy: none`). */
  checked: number;
  /** Repos found with a newer-than-current upstream release. */
  behind: number;
  /** Notifications actually dispatched this pass. */
  notified: number;
  /** Errors per repo. */
  errors: Record<string, string>;
}

/**
 * One poll pass over every configured watched release.
 */
export async function runWatchedReleasesOnce(
  deps: WatchedReleasesRunDeps,
): Promise<WatchedReleasesRunResult> {
  const result: WatchedReleasesRunResult = {
    checked: 0,
    behind: 0,
    notified: 0,
    errors: {},
  };
  const fetchFn = deps.fetchReleasesFn ?? fetchReleases;
  const sleep =
    deps.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const notifyIntervalMs = deps.notifyIntervalMs ?? 0;
  let lastDispatchAt = 0;

  for (const spec of deps.specs) {
    if (spec.policy === "none") continue;
    result.checked += 1;

    const coords: RepoCoords = {
      owner: spec.owner,
      repo: spec.repoName,
      source: "override",
    };

    let releases: GithubRelease[];
    try {
      releases = await fetchFn(coords, {
        token: deps.githubToken,
        maxReleases: 50,
      });
    } catch (err) {
      result.errors[spec.repo] = (err as Error).message;
      continue;
    }

    const candidates = releases.filter(
      (r) => !r.draft && (spec.includePrerelease || !r.prerelease),
    );
    const latestTag = findLatestInFamily(
      spec.current,
      candidates.map((r) => r.tagName),
    );

    // Record the poll regardless of outcome (advances checked_at, keeps
    // current/latest_seen fresh). latest_seen reflects the newest version we
    // know about that is at-or-above current — purely informational.
    recordWatchedCheck(deps.db, spec.repo, spec.current, latestTag ?? spec.current);

    if (!latestTag) continue; // up to date (or nothing comparable + newer)
    result.behind += 1;

    const state = getWatchedReleaseState(deps.db, spec.repo);
    if (state?.notified_tag === latestTag) continue; // already emailed this one

    const release = candidates.find((r) => r.tagName === latestTag);
    const releaseUrl =
      release?.url ??
      `https://github.com/${spec.owner}/${spec.repoName}/releases/tag/${latestTag}`;
    const bump = classifyBump(spec.current, latestTag);

    const advise = deps.llmUrl
      ? await safeAdvise(
          {
            image: spec.name,
            from: spec.current,
            to: latestTag,
            repo: spec.repo,
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

    const msg = buildWatchedMessage({
      spec,
      latestTag,
      bump,
      releaseUrl,
      advise,
    });
    const delivery = await notifyAll(deps.notifiers, msg);
    lastDispatchAt = Date.now();

    if (deps.outboxDir) {
      archiveMessage(
        { dir: deps.outboxDir, keepCount: deps.outboxKeepCount },
        msg,
        {
          kind: "watched-release",
          adviseText: advise?.ok ? advise.summary : undefined,
          delivered: delivery.delivered,
          deliveryErrors:
            delivery.failed.length > 0 ? delivery.failed : undefined,
        },
      );
    }

    // No notifiers configured → notifyAll reports delivered=0. Treat that as a
    // successful no-op (mark notified) so we don't re-poll-and-skip forever
    // and so the state row reflects what we'd have sent.
    const delivered = deps.notifiers.length === 0 || delivery.delivered > 0;
    if (delivered) {
      recordWatchedNotified(
        deps.db,
        spec.repo,
        latestTag,
        advise?.ok ? (advise.summary ?? null) : null,
      );
      result.notified += 1;
    } else {
      deps.log?.(
        `watch: ${spec.repo} ${spec.current}→${latestTag} notify failed (${delivery.failed
          .map((f) => f.name)
          .join(", ")}); will retry next poll`,
      );
    }
  }

  return result;
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

interface WatchedMessageOpts {
  spec: WatchedReleaseSpec;
  latestTag: string;
  bump: ReturnType<typeof classifyBump>;
  releaseUrl: string;
  advise: AdviseSummary | null;
}

export function buildWatchedMessage(opts: WatchedMessageOpts): NotifyMessage {
  const { spec, latestTag, bump, releaseUrl, advise } = opts;
  const bumpLabel = bump === "unknown" ? "update" : `${bump} update`;
  const subject = `${spec.name}: ${spec.current} → ${latestTag} (GitHub release)`;

  const text: string[] = [];
  text.push(`A newer release of ${spec.name} is available upstream.`);
  text.push("");
  text.push(
    "This is a watched non-Docker upstream (tracked via GitHub Releases, not a",
  );
  text.push(
    "compose image). bumpsight does NOT apply it — update the binary / pin",
  );
  text.push(
    `yourself, then set "current: ${latestTag}" for this entry in watched_releases.`,
  );
  text.push("");
  text.push(`Repo:      github.com/${spec.repo}`);
  text.push(`Installed: ${spec.current}`);
  text.push(`Latest:    ${latestTag}  (${bumpLabel})`);
  text.push(`Release:   ${releaseUrl}`);
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
      text.push(`(skipped: ${advise.error ?? "unknown reason"})`);
    }
  }

  return {
    subject,
    body: text.join("\n"),
    htmlBody: buildWatchedHtml(opts, bumpLabel),
    links: undefined,
  };
}

function buildWatchedHtml(opts: WatchedMessageOpts, bumpLabel: string): string {
  const { spec, latestTag, releaseUrl, advise } = opts;
  const e = escapeHtml;

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

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f1f5f9;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f1f5f9;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a;">
<tr><td style="padding:24px;">

  <div style="font-size:18px;font-weight:600;color:#0f172a;margin:0 0 18px 0;">bumpsight · watched release</div>

  <!-- Info card: notify-only, manual action -->
  <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
    <p style="margin:0;font-size:14px;line-height:1.5;color:#78350f;">
      A newer release of <strong>${e(spec.name)}</strong> is available. This is a
      watched non-Docker upstream — bumpsight <strong>does not apply</strong> it.
      Update the binary / pin yourself, then set
      <code style="background:#fef3c7;padding:1px 6px;border-radius:3px;">current: ${e(latestTag)}</code>
      for this entry in <code>watched_releases</code>.
    </p>
  </div>

  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="font-size:14px;line-height:1.6;">
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Repo</td>      <td><a href="${e(`https://github.com/${spec.repo}`)}" style="color:#2563eb;text-decoration:none;"><code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">${e(spec.repo)}</code></a></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Installed</td> <td><code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">${e(spec.current)}</code></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Latest</td>    <td><code style="background:#f1f5f9;padding:1px 6px;border-radius:3px;">${e(latestTag)}</code> <span style="color:#94a3b8;">(${e(bumpLabel)})</span></td></tr>
    <tr><td style="padding:2px 14px 2px 0;color:#64748b;">Release</td>   <td><a href="${e(releaseUrl)}" style="color:#2563eb;text-decoration:none;">${e(releaseUrl)}</a></td></tr>
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

export interface WatchedReleasesSchedulerDeps extends WatchedReleasesRunDeps {
  intervalMs: number;
  log: (msg: string) => void;
  /** Initial delay before the first poll. Defaults to 30s; 0 for tests. */
  startupDelayMs?: number;
}

export interface WatchedReleasesRuntime {
  stop(): Promise<void>;
  runOnce(): Promise<WatchedReleasesRunResult>;
}

/**
 * Start the watched-releases poll scheduler. Mirrors the deep-prune / digest
 * schedulers: first run after `startupDelayMs`, then every `intervalMs`.
 * Failures inside a poll are caught + logged and never stop the loop.
 */
export function startWatchedReleasesScheduler(
  deps: WatchedReleasesSchedulerDeps,
): WatchedReleasesRuntime {
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;

  const runOnce = async (): Promise<WatchedReleasesRunResult> => {
    const started = Date.now();
    const res = await runWatchedReleasesOnce(deps);
    const ms = Date.now() - started;
    deps.log(
      `watch: ${res.checked} repo(s), ${res.behind} behind, ${res.notified} notified, ${ms}ms`,
    );
    for (const [repo, err] of Object.entries(res.errors)) {
      deps.log(`watch-error: ${repo}: ${err}`);
    }
    return res;
  };

  const tick = async () => {
    if (stopping) return;
    inFlight = (async () => {
      try {
        await runOnce();
      } catch (err) {
        deps.log(`watch-failed: ${(err as Error).message}`);
      }
    })();
    await inFlight;
    if (!stopping) {
      timer = setTimeout(tick, deps.intervalMs);
    }
  };

  const startupDelay = deps.startupDelayMs ?? 30_000;
  timer = setTimeout(tick, startupDelay);

  return {
    stop: async () => {
      stopping = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
    runOnce,
  };
}
