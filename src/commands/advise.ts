import { parseImageRef, loadComposeFile } from "../compose/parse.js";
import type { ServiceDef } from "../compose/parse.js";
import {
  fetchReleases,
  releasesBetween,
  resolveUpstreamRepo,
  type GithubRelease,
} from "../releases/github.js";
import { chat, type ChatMessage } from "../llm/chat.js";

export interface AdviseOptions {
  image: string;
  from?: string;
  to?: string;
  repo?: string;
  composeFile?: string;
  serviceName?: string;
  /** Legacy: Ollama base URL. Prefer llmUrl for OpenAI-compat endpoints. */
  ollamaHost?: string;
  /** OpenAI-compatible base URL (ends in /v1). Used by Ollama, LiteLLM, etc. */
  llmUrl?: string;
  /** Optional bearer token for the LLM endpoint. */
  llmKey?: string;
  model?: string;
  githubToken?: string;
  format?: "text" | "json";
  timeoutMs?: number;
}

export interface AdviseSummary {
  ok: boolean;
  /** The structured LLM-generated text body. */
  summary?: string;
  /** owner/repo of the resolved upstream, when found. */
  repo?: string;
  /** Number of GitHub releases the LLM was given. */
  releaseCount?: number;
  /** When the LLM generated an opinion-only read (no release notes were
   *  available), the body explains why and labels itself as such. */
  source?: "release-notes" | "general-knowledge";
  /** Short reason on failure — for the daemon log, not for users. */
  error?: string;
}

/**
 * Programmatic entry point — same logic as runAdvise but returns a structured
 * result instead of CLI-formatted text. Used by the daemon to embed the LLM
 * read of breaking changes inline in held-bump notification emails. Never
 * throws — returns {ok:false, error} so callers can fall through gracefully
 * when Ollama is down or the upstream repo can't be resolved.
 */
export async function getAdviseSummary(
  opts: AdviseOptions,
): Promise<AdviseSummary> {
  if (!opts.to) return { ok: false, error: "missing target tag" };
  const ref = parseImageRef(opts.image);
  const from = opts.from ?? ref.tag;

  const serviceConfig =
    opts.composeFile && opts.serviceName
      ? extractServiceConfig(opts.composeFile, opts.serviceName)
      : null;
  const baseUrl =
    opts.llmUrl ??
    (opts.ollamaHost ? `${opts.ollamaHost.replace(/\/+$/, "")}/v1` : undefined);

  // Try to resolve an upstream repo + fetch releases. If anything along
  // that path comes up empty, fall through to opinion-only mode below.
  let coords: Awaited<ReturnType<typeof resolveUpstreamRepo>> = null;
  try {
    coords = await resolveUpstreamRepo(ref, opts.repo);
  } catch {
    coords = null;
  }

  let allBetween: GithubRelease[] = [];
  if (coords) {
    try {
      const releases = await fetchReleases(coords, {
        token: opts.githubToken ?? process.env.GITHUB_TOKEN,
      });
      allBetween = releasesBetween(releases, from, opts.to).filter(
        (r) => !r.draft,
      );
    } catch {
      // fetch failure → fall through to opinion-only
      allBetween = [];
    }
  }

  if (allBetween.length === 0) {
    // Opinion-only fallback. The LLM is good at general guidance for
    // well-known images even without per-release notes.
    try {
      const prompt = buildOpinionPrompt(opts.image, from, opts.to, serviceConfig);
      const summary = await chat(prompt, {
        baseUrl,
        apiKey: opts.llmKey,
        model: opts.model,
        timeoutMs: opts.timeoutMs,
      });
      return {
        ok: true,
        summary: summary.trim(),
        repo: coords ? `${coords.owner}/${coords.repo}` : undefined,
        releaseCount: 0,
        source: "general-knowledge",
      };
    } catch (err) {
      return {
        ok: false,
        repo: coords ? `${coords.owner}/${coords.repo}` : undefined,
        releaseCount: 0,
        error: `llm (opinion-only): ${(err as Error).message}`,
      };
    }
  }

  // Cap the prompt size: take the most-recent N releases. Repos like
  // hashicorp/vault publish dozens of releases between major versions and
  // sending them all to the LLM blows context and triggers timeouts.
  const MAX_RELEASES_IN_PROMPT = 25;
  const between =
    allBetween.length > MAX_RELEASES_IN_PROMPT
      ? allBetween.slice(0, MAX_RELEASES_IN_PROMPT)
      : allBetween;
  const prompt = buildPrompt(opts.image, from, opts.to, between, serviceConfig);

  try {
    const summary = await chat(prompt, {
      baseUrl,
      apiKey: opts.llmKey,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
    });
    return {
      ok: true,
      summary: summary.trim(),
      repo: `${coords!.owner}/${coords!.repo}`,
      releaseCount: allBetween.length,
      source: "release-notes",
    };
  } catch (err) {
    return {
      ok: false,
      repo: `${coords!.owner}/${coords!.repo}`,
      releaseCount: allBetween.length,
      error: `llm: ${(err as Error).message}`,
    };
  }
}

export async function runAdvise(
  opts: AdviseOptions,
): Promise<{ exitCode: number; output: string }> {
  const from = opts.from ?? parseImageRef(opts.image).tag;
  if (!opts.to) {
    return {
      exitCode: 2,
      output:
        "bumpsight advise: --to <tag> is required so we know which version you're moving to.\n",
    };
  }

  // Reuse the daemon's path so the CLI gets opinion-fallback for free when
  // there's no upstream repo or no releases between tags.
  const result = await getAdviseSummary(opts);

  if (opts.format === "json") {
    return {
      exitCode: result.ok ? 0 : 1,
      output: JSON.stringify(result, null, 2) + "\n",
    };
  }

  if (result.ok && result.summary) {
    const heading =
      result.source === "general-knowledge"
        ? `${opts.image}  ${from} → ${opts.to}\n(LLM general-knowledge opinion — no upstream release notes available${result.repo ? `; checked github.com/${result.repo}` : ""})`
        : `${opts.image}  ${from} → ${opts.to}\nupstream: https://github.com/${result.repo}\nreleases in range: ${result.releaseCount}`;
    return {
      exitCode: 0,
      output: `${heading}\n\n${result.summary}\n`,
    };
  }

  return {
    exitCode: 1,
    output: `bumpsight advise: ${result.error ?? "no summary produced"}\n`,
  };
}

function extractServiceConfig(composePath: string, serviceName: string): ServiceDef | null {
  try {
    const compose = loadComposeFile(composePath);
    return compose.services?.[serviceName] ?? null;
  } catch {
    return null;
  }
}

function buildPrompt(
  image: string,
  from: string,
  to: string,
  releases: GithubRelease[],
  serviceConfig: ServiceDef | null,
): ChatMessage[] {
  const systemMessage: ChatMessage = {
    role: "system",
    content: [
      "You are a docker image upgrade advisor for self-hosted services.",
      "Given release notes between two versions and optionally the user's compose service config,",
      "produce a concise summary with these exact sections in this order:",
      "",
      "Breaking changes:",
      "- one line per change, referencing the release it came from.",
      "- if the user's config references a removed env var, path, or port, explicitly call it out.",
      "",
      "Notable new features:",
      "- up to 5 bullet points, most important first.",
      "",
      "Required actions:",
      "- concrete steps the user should take before pulling, if any. If none, say 'None.'",
      "",
      "Rules:",
      "- No fluff. No greetings. No sign-offs.",
      "- Only claim a breaking change if the release notes say so.",
      "- If the release notes are thin, say 'Release notes are minimal.' and stop.",
    ].join("\n"),
  };

  const releasesBlock = releases
    .map(
      (r) =>
        `## ${r.tagName}${r.name && r.name !== r.tagName ? ` (${r.name})` : ""}${
          r.prerelease ? " [prerelease]" : ""
        }\n${r.body ?? "(no body)"}`,
    )
    .join("\n\n");

  const configBlock = serviceConfig
    ? `User's compose service config for this image:\n\`\`\`yaml\n${yamlishStringify(serviceConfig)}\n\`\`\`\n\n`
    : "";

  const userMessage: ChatMessage = {
    role: "user",
    content: [
      `Image: ${image}`,
      `Current version: ${from}`,
      `Target version: ${to}`,
      "",
      configBlock,
      `Release notes between ${from} (exclusive) and ${to} (inclusive):`,
      "",
      releasesBlock,
    ].join("\n"),
  };

  return [systemMessage, userMessage];
}

/**
 * Build a prompt that asks the LLM for an opinion-only read when no per-release
 * notes are available. The model has general knowledge of well-known Docker
 * images and version-bump conventions; even without specific release notes it
 * can produce a useful "is this generally safe to update?" read.
 */
function buildOpinionPrompt(
  image: string,
  from: string,
  to: string,
  serviceConfig: ServiceDef | null,
): ChatMessage[] {
  const systemMessage: ChatMessage = {
    role: "system",
    content: [
      "You are a docker image upgrade advisor for self-hosted services.",
      "You are being asked about a specific image bump WITHOUT access to the",
      "upstream's release notes. Answer based on your general knowledge of the",
      "image, the version-bump convention it appears to use, and any of the",
      "user's compose service config provided. If you don't recognize the",
      "image at all, say so explicitly and stop.",
      "",
      "Produce these exact sections in this order:",
      "",
      "Likely risk level:",
      "- one of: low / moderate / high / unknown",
      "- one short clause explaining why (e.g. 'major version of a database — historical migration risk', 'patch within a stable LTS line').",
      "",
      "What this typically changes:",
      "- 1-3 bullets on what bumps of this kind usually bring for this image.",
      "- if the user's service config references something likely to change (e.g. a known-deprecated env var), call it out.",
      "",
      "Recommended action:",
      "- one short, opinionated recommendation: approve / approve-after-quick-check / hold-for-review / hold-for-thorough-review.",
      "- one sentence justifying the recommendation.",
      "",
      "Rules:",
      "- No fluff. No greetings. No sign-offs.",
      "- Be honest about uncertainty — if you don't know the image, say 'risk: unknown'.",
      "- Do not invent breaking changes you can't substantiate.",
    ].join("\n"),
  };

  const configBlock = serviceConfig
    ? `\nUser's compose service config for this image:\n\`\`\`yaml\n${yamlishStringify(serviceConfig)}\n\`\`\`\n`
    : "";

  const userMessage: ChatMessage = {
    role: "user",
    content: [
      `Image: ${image}`,
      `Current version: ${from}`,
      `Target version: ${to}`,
      "",
      "Note: I could not retrieve upstream release notes for this bump.",
      "Give me your best general-knowledge read.",
      configBlock,
    ].join("\n"),
  };

  return [systemMessage, userMessage];
}

function yamlishStringify(svc: ServiceDef): string {
  // Tiny YAML-ish dump to avoid a dependency on a separate writer. Good
  // enough for including the service config in an LLM prompt; not valid
  // output for anything that round-trips.
  const lines: string[] = [];
  for (const [k, v] of Object.entries(svc)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) {
        lines.push(`  - ${typeof item === "string" ? item : JSON.stringify(item)}`);
      }
    } else if (v !== null && typeof v === "object") {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${String(v)}`);
    }
  }
  return lines.join("\n");
}
