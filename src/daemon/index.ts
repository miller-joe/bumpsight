import { dirname, basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import { loadComposeFile, parseImageRef } from "../compose/parse.js";
import { isSupportedRegistry, listTags } from "../registry/index.js";
import { findLatestInFamily } from "../util/semver.js";
import { classifyBump, decideAction } from "./rules.js";
import type { BumpKind, RulesConfig } from "./rules.js";
import type { DaemonConfig } from "./config.js";
import {
  recordUpdate,
  setNotified,
  findUpdate,
  type UpdateRow,
} from "../state/db.js";
import { notifyAll } from "../notify/index.js";
import type { Notifier, NotifyMessage, NotifyLink } from "../notify/types.js";
import { applyOne } from "../apply/index.js";
import type { CommandRunner } from "../apply/docker.js";
import { getAdviseSummary, type AdviseSummary } from "../commands/advise.js";

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
  /** Test seam — defaults to the real registry client. */
  listTagsFn?: typeof listTags;
  /** Test seam — defaults to the real spawn-based docker runner. */
  runner?: CommandRunner;
  /** Test seam — override advise. Returns null to skip the LLM section. */
  adviseFn?: typeof getAdviseSummary;
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

      let latest: string | null;
      try {
        const tags = await lister(ref, {});
        latest = findLatestInFamily(
          ref.tag,
          tags.map((t) => t.name),
        );
      } catch (err) {
        result.errors[ref.raw] = (err as Error).message;
        continue;
      }
      if (!latest || latest === ref.tag) continue;

      const bump: BumpKind = classifyBump(ref.tag, latest);
      const decision = decideAction(deps.rules, stack, bump);
      if (decision === "skip") continue;

      const token = randomBytes(18).toString("base64url");
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
          },
          row.id,
        );
        if (after.status === "applied") result.autoAppliedOk += 1;
        await dispatchAppliedNotification(deps.notifiers, after);
      } else {
        result.held += 1;
        const advise = deps.llmUrl
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
        await dispatchHoldNotification(
          deps.notifiers,
          row,
          deps.publicUrl,
          advise,
        );
        setNotified(deps.db, row.id);
      }
    }
  }
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

async function dispatchHoldNotification(
  notifiers: Notifier[],
  row: UpdateRow,
  publicUrl?: string,
  advise?: AdviseSummary | null,
): Promise<void> {
  if (notifiers.length === 0) return;
  const subject = `${row.stack}/${row.service}: ${row.image} → ${row.target_tag}`;
  const lines: string[] = [
    `Stack:   ${row.stack}`,
    `Service: ${row.service}`,
    `Image:   ${row.image}`,
    `From:    ${row.current_tag}`,
    `To:      ${row.target_tag}`,
    `Kind:    ${row.bump} bump`,
  ];
  if (advise) {
    lines.push("");
    lines.push("───── Upstream release-note summary ─────");
    if (advise.ok && advise.summary) {
      lines.push(
        `Source: github.com/${advise.repo} · ${advise.releaseCount} release(s) in range`,
      );
      lines.push("");
      lines.push(advise.summary);
    } else {
      lines.push(
        `(advise skipped: ${advise.error ?? "unknown reason"}` +
          (advise.repo ? ` · upstream: ${advise.repo}` : "") +
          `)`,
      );
    }
  }
  lines.push("");
  lines.push(
    publicUrl
      ? `Click Approve to pull + restart, or Deny to leave the stack on its current tag.`
      : `Approval URLs are not configured (set BUMPSIGHT_PUBLIC_URL).`,
  );
  await notifyAll(notifiers, {
    subject,
    body: lines.join("\n"),
    links: buildLinks(row, publicUrl),
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

async function dispatchAppliedNotification(
  notifiers: Notifier[],
  row: UpdateRow,
): Promise<void> {
  if (notifiers.length === 0) return;
  const subject = `${row.stack}/${row.service}: ${row.image} → ${row.target_tag}`;
  const body = [
    `Stack:   ${row.stack}`,
    `Service: ${row.service}`,
    `From:    ${row.current_tag}`,
    `To:      ${row.target_tag}`,
    `Kind:    ${row.bump} bump`,
    `Status:  ${row.status}`,
    ``,
    row.apply_log ? `Last log:\n${row.apply_log}` : ``,
  ]
    .filter(Boolean)
    .join("\n");
  await notifyAll(notifiers, { subject, body });
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
  log: (msg: string) => void;
  /** Test seams. */
  listTagsFn?: typeof listTags;
  runner?: CommandRunner;
  adviseFn?: typeof getAdviseSummary;
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
          listTagsFn: deps.listTagsFn,
          runner: deps.runner,
          adviseFn: deps.adviseFn,
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
