import { parseImageRef, loadComposeFile } from "../compose/parse.js";
import type { ServiceDef } from "../compose/parse.js";
import {
  fetchReleases,
  releasesBetween,
  resolveUpstreamRepo,
  type GithubRelease,
} from "../releases/github.js";
import { chat, type ChatMessage } from "../llm/ollama.js";

export interface AdviseOptions {
  image: string;
  from?: string;
  to?: string;
  repo?: string;
  composeFile?: string;
  serviceName?: string;
  ollamaHost?: string;
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

  let coords: Awaited<ReturnType<typeof resolveUpstreamRepo>>;
  try {
    coords = await resolveUpstreamRepo(ref, opts.repo);
  } catch (err) {
    return { ok: false, error: `repo resolve: ${(err as Error).message}` };
  }
  if (!coords) {
    return { ok: false, error: "no upstream repo mapping" };
  }

  let releases: GithubRelease[];
  try {
    releases = await fetchReleases(coords, {
      token: opts.githubToken ?? process.env.GITHUB_TOKEN,
    });
  } catch (err) {
    return {
      ok: false,
      repo: `${coords.owner}/${coords.repo}`,
      error: `github releases: ${(err as Error).message}`,
    };
  }
  const between = releasesBetween(releases, from, opts.to).filter(
    (r) => !r.draft,
  );
  if (between.length === 0) {
    return {
      ok: false,
      repo: `${coords.owner}/${coords.repo}`,
      releaseCount: 0,
      error: "no releases between tags",
    };
  }

  const serviceConfig =
    opts.composeFile && opts.serviceName
      ? extractServiceConfig(opts.composeFile, opts.serviceName)
      : null;
  const prompt = buildPrompt(opts.image, from, opts.to, between, serviceConfig);

  try {
    const summary = await chat(prompt, {
      host: opts.ollamaHost,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
    });
    return {
      ok: true,
      summary: summary.trim(),
      repo: `${coords.owner}/${coords.repo}`,
      releaseCount: between.length,
    };
  } catch (err) {
    return {
      ok: false,
      repo: `${coords.owner}/${coords.repo}`,
      releaseCount: between.length,
      error: `llm: ${(err as Error).message}`,
    };
  }
}

export async function runAdvise(
  opts: AdviseOptions,
): Promise<{ exitCode: number; output: string }> {
  const ref = parseImageRef(opts.image);
  const from = opts.from ?? ref.tag;
  if (!opts.to) {
    return {
      exitCode: 2,
      output:
        "bumpsight advise: --to <tag> is required so we know which version you're moving to.\n",
    };
  }

  const coords = await resolveUpstreamRepo(ref, opts.repo);
  if (!coords) {
    return {
      exitCode: 2,
      output: [
        `bumpsight advise: couldn't map ${opts.image} to an upstream GitHub repo.`,
        "Pass --repo <owner>/<name> explicitly.",
        "",
      ].join("\n"),
    };
  }

  let releases: GithubRelease[];
  try {
    releases = await fetchReleases(coords, {
      token: opts.githubToken ?? process.env.GITHUB_TOKEN,
    });
  } catch (err) {
    return {
      exitCode: 1,
      output: `bumpsight advise: ${(err as Error).message}\n`,
    };
  }

  const between = releasesBetween(releases, from, opts.to).filter(
    (r) => !r.draft,
  );
  if (between.length === 0) {
    return {
      exitCode: 0,
      output: `${coords.owner}/${coords.repo}: no releases found between ${from} and ${opts.to}. Either the tag names don't match GitHub releases, or nothing was released.\n`,
    };
  }

  const serviceConfig = opts.composeFile && opts.serviceName
    ? extractServiceConfig(opts.composeFile, opts.serviceName)
    : null;

  const prompt = buildPrompt(opts.image, from, opts.to, between, serviceConfig);
  let summary: string;
  try {
    summary = await chat(prompt, {
      host: opts.ollamaHost,
      model: opts.model,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    return {
      exitCode: 1,
      output: `bumpsight advise: LLM call failed: ${(err as Error).message}\n`,
    };
  }

  if (opts.format === "json") {
    return {
      exitCode: 0,
      output: JSON.stringify(
        {
          image: opts.image,
          from,
          to: opts.to,
          repo: `${coords.owner}/${coords.repo}`,
          releases: between.map((r) => ({
            tag: r.tagName,
            publishedAt: r.publishedAt,
            url: r.url,
          })),
          summary,
        },
        null,
        2,
      ),
    };
  }

  const lines: string[] = [
    `${opts.image}  ${from} → ${opts.to}`,
    `upstream: https://github.com/${coords.owner}/${coords.repo} (${coords.source})`,
    `releases in range: ${between.length}`,
    "",
    summary.trim(),
    "",
  ];
  return { exitCode: 0, output: lines.join("\n") };
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
