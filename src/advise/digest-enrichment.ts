/**
 * v0.5.5 digest-bump enrichment via OCI labels.
 *
 * For digest-class bumps (moving tags like `:latest` where the resolved
 * semver pair is unavailable), the daemon today shows
 *   `digest sha256:abc… → sha256:def…`
 * in the daily digest with no LLM context. This module decodes that pair
 * into a real "what changed" summary:
 *
 *   1. Fetch the OCI config blob for each digest.
 *   2. Extract `org.opencontainers.image.revision` (upstream git SHA)
 *      and `org.opencontainers.image.source` (upstream repo URL) from each.
 *   3. Call GitHub's compare API for the SHA range.
 *   4. Feed commit subjects to the LLM to produce a short summary.
 *
 * Falls back gracefully:
 *   - Labels absent on either side → `{ ok: false, error: "no revision labels" }`.
 *   - Source label points anywhere but github.com → unsupported, skip.
 *   - GitHub compare API errors → unsupported, skip.
 *   - LLM unavailable → returns the structured commit list without a
 *     summary so the daily digest can still render commit headers.
 *
 * Never throws.
 */

import { parseImageRef, type ImageRef } from "../compose/parse.js";
import {
  fetchOciLabels,
  extractRevision,
  extractSourceUrl,
  parseGithubUrl,
} from "../registry/oci-config.js";
import {
  fetchCommitsBetween,
  type GithubCommit,
  type RepoCoords,
} from "../releases/github.js";
import { chat, type ChatMessage } from "../llm/chat.js";

export interface DigestEnrichmentOptions {
  image: string;
  prevDigest: string;
  newDigest: string;
  /** OpenAI-compat base URL ending in /v1. */
  llmUrl?: string;
  llmKey?: string;
  model?: string;
  githubToken?: string;
  signal?: AbortSignal;
  /** Test seam — defaults to the real fetcher. */
  fetchLabels?: typeof fetchOciLabels;
  /** Test seam — defaults to the real compare-API fetcher. */
  fetchCompare?: typeof fetchCommitsBetween;
  /** Test seam — defaults to the real chat client. */
  chatFn?: typeof chat;
}

export interface DigestEnrichmentResult {
  ok: boolean;
  /** Final text block ready for `advise_text` / digest-email rendering.
   *  Includes commit-range header + LLM summary, or just commit-range
   *  header when LLM is unavailable. */
  summary?: string;
  /** Short failure reason for logs (never user-facing). */
  error?: string;
  /** Upstream git SHA from the previous digest. */
  prevRevision?: string;
  /** Upstream git SHA from the new digest. */
  newRevision?: string;
  /** owner/repo of the upstream repo on github.com. */
  repo?: string;
  /** Compare HTML URL on github.com. */
  compareUrl?: string;
  /** Commits captured from the compare API (capped client-side at 30 to
   *  keep the LLM prompt small). */
  commits?: GithubCommit[];
  /** Total commits per GitHub (commits[] may be truncated). */
  totalCommits?: number;
}

const MAX_COMMITS_FOR_PROMPT = 30;

export async function enrichDigestBump(
  opts: DigestEnrichmentOptions,
): Promise<DigestEnrichmentResult> {
  if (!opts.prevDigest || !opts.newDigest) {
    return { ok: false, error: "missing digests" };
  }
  if (opts.prevDigest === opts.newDigest) {
    return { ok: false, error: "digests identical" };
  }

  let ref: ImageRef;
  try {
    ref = parseImageRef(opts.image);
  } catch (err) {
    return { ok: false, error: `parse image: ${(err as Error).message}` };
  }

  const fetchLabels = opts.fetchLabels ?? fetchOciLabels;
  const [prevLabels, newLabels] = await Promise.all([
    fetchLabels(ref, opts.prevDigest, { signal: opts.signal }),
    fetchLabels(ref, opts.newDigest, { signal: opts.signal }),
  ]);

  const prevRevision = extractRevision(prevLabels.labels);
  const newRevision = extractRevision(newLabels.labels);
  if (!prevRevision || !newRevision) {
    return { ok: false, error: "no revision labels" };
  }

  // Source URL: prefer the new image's label (more current), fall back to prev.
  const sourceUrl =
    extractSourceUrl(newLabels.labels) ?? extractSourceUrl(prevLabels.labels);
  if (!sourceUrl) {
    return {
      ok: false,
      error: "no source label",
      prevRevision,
      newRevision,
    };
  }

  const coords = parseGithubUrl(sourceUrl);
  if (!coords) {
    return {
      ok: false,
      error: `non-github source: ${sourceUrl}`,
      prevRevision,
      newRevision,
    };
  }

  const repoCoords: RepoCoords = {
    owner: coords.owner,
    repo: coords.repo,
    source: "override",
  };

  const fetchCompare = opts.fetchCompare ?? fetchCommitsBetween;
  let compare;
  try {
    compare = await fetchCompare(repoCoords, prevRevision, newRevision, {
      token: opts.githubToken,
      signal: opts.signal,
    });
  } catch (err) {
    return {
      ok: false,
      error: `compare api: ${(err as Error).message}`,
      prevRevision,
      newRevision,
      repo: `${coords.owner}/${coords.repo}`,
    };
  }

  const cappedCommits = compare.commits.slice(0, MAX_COMMITS_FOR_PROMPT);
  const repoSlug = `${coords.owner}/${coords.repo}`;

  let llmSummary: string | undefined;
  if (opts.llmUrl && cappedCommits.length > 0) {
    try {
      llmSummary = await summarizeCommits({
        image: opts.image,
        repoSlug,
        commits: cappedCommits,
        totalCommits: compare.totalCommits,
        baseUrl: opts.llmUrl,
        apiKey: opts.llmKey,
        model: opts.model,
        chatFn: opts.chatFn,
      });
    } catch {
      // LLM unreachable — fall through; structured commit list still ships.
      llmSummary = undefined;
    }
  }

  const summary = renderSummary({
    image: opts.image,
    repoSlug,
    prevRevision,
    newRevision,
    compareUrl: compare.htmlUrl,
    commits: cappedCommits,
    totalCommits: compare.totalCommits,
    llmSummary,
  });

  return {
    ok: true,
    summary,
    prevRevision,
    newRevision,
    repo: repoSlug,
    compareUrl: compare.htmlUrl,
    commits: cappedCommits,
    totalCommits: compare.totalCommits,
  };
}

interface SummarizeCommitsArgs {
  image: string;
  repoSlug: string;
  commits: GithubCommit[];
  totalCommits: number;
  baseUrl: string;
  apiKey?: string;
  model?: string;
  chatFn?: typeof chat;
}

async function summarizeCommits(args: SummarizeCommitsArgs): Promise<string> {
  const commitLines = args.commits
    .map((c) => `- ${c.shortSha} ${firstLine(c.message)}`)
    .join("\n");
  const truncationNote =
    args.totalCommits > args.commits.length
      ? `\n(${args.totalCommits - args.commits.length} additional commits omitted)`
      : "";

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are summarising a digest-only docker image bump for a self-hosted homelab operator.",
        "The operator can't see semver tags here — only a SHA range of upstream commits.",
        "Read the commit subjects and produce a tight summary that helps the operator decide whether to redeploy.",
        "Hard rules:",
        "- Do NOT say 'check the changelog', 'review the diff', 'consult docs', or similar punts.",
        "- Lead with what changed (features, fixes, breaks). Group by theme when commits cluster.",
        "- Call out anything that looks like a breaking change, migration, or schema/config change explicitly.",
        "- Plain text. No markdown headers. 4-8 short lines maximum.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Image: ${args.image}`,
        `Repo: github.com/${args.repoSlug}`,
        `Commits (${args.commits.length} shown of ${args.totalCommits} total):`,
        commitLines + truncationNote,
      ].join("\n"),
    },
  ];

  const fn = args.chatFn ?? chat;
  const out = await fn(messages, {
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    retryOnAbort: true,
  });
  return out.trim();
}

function firstLine(s: string): string {
  return (s.split("\n", 1)[0] ?? "").slice(0, 200);
}

interface RenderSummaryArgs {
  image: string;
  repoSlug: string;
  prevRevision: string;
  newRevision: string;
  compareUrl: string;
  commits: GithubCommit[];
  totalCommits: number;
  llmSummary?: string;
}

function renderSummary(args: RenderSummaryArgs): string {
  const head: string[] = [];
  head.push(
    `Digest range: ${args.prevRevision.slice(0, 7)}…${args.newRevision.slice(0, 7)} on github.com/${args.repoSlug} (${args.totalCommits} commit${args.totalCommits === 1 ? "" : "s"})`,
  );
  head.push(`Compare: ${args.compareUrl}`);
  if (args.llmSummary) {
    head.push("");
    head.push(args.llmSummary);
  } else if (args.commits.length > 0) {
    head.push("");
    head.push("Commit subjects:");
    for (const c of args.commits) {
      head.push(`- ${c.shortSha} ${firstLine(c.message)}`);
    }
    if (args.totalCommits > args.commits.length) {
      head.push(`(${args.totalCommits - args.commits.length} more)`);
    }
  }
  return head.join("\n");
}
