/**
 * v0.5.0 paired-dep-recommendation support: fetch a canonical compose file
 * from a project's upstream GitHub repo at a specific version tag.
 *
 * Many homelab apps publish a reference `compose.yaml` (or `docker-compose.yml`)
 * at the repo root or under `examples/`. When a major bump of the parent app
 * also moves a dep pin (e.g. Authentik 2025.x recommending postgres 17 instead
 * of 16), reading that file at the new tag is the most reliable signal we
 * have for "what does the maintainer actually recommend right now."
 *
 * This is intentionally best-effort: it tries a small set of common paths +
 * ref formats, returns the first that fetches, and gives up silently if none
 * do. Paired-dep recommendations are an enhancement to the advise email; if
 * the lookup fails, the LLM advice still ships unchanged.
 */
import type { RepoCoords } from "../releases/github.js";

const COMPOSE_PATHS = [
  "docker-compose.yml",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "examples/docker-compose.yml",
  "examples/docker-compose.yaml",
  "examples/compose.yaml",
  "examples/compose.yml",
  "deploy/docker-compose.yml",
  "deploy/compose.yaml",
];

export interface FetchUpstreamComposeOptions {
  signal?: AbortSignal;
  /** Optional GitHub token — extends rate limits and unlocks private repos.
   *  Same token used for the releases fetch. */
  token?: string;
}

export interface UpstreamComposeHit {
  /** The compose YAML content. */
  content: string;
  /** The source URL (raw.githubusercontent) the content was fetched from. */
  url: string;
  /** The git ref that resolved (e.g. "v2025.4.0"). */
  ref: string;
}

/**
 * Try common compose paths at common ref formats. Returns the first hit, or
 * null when nothing resolves.
 */
export async function fetchUpstreamCompose(
  coords: RepoCoords,
  version: string,
  opts: FetchUpstreamComposeOptions = {},
): Promise<UpstreamComposeHit | null> {
  // Derive ref candidates from the version string. Most repos tag releases as
  // either `v1.2.3` or `1.2.3`; some prefix-tag (e.g. `release-1.2`). We try
  // the most common forms first.
  const refs = candidateRefs(version);
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  for (const ref of refs) {
    for (const path of COMPOSE_PATHS) {
      const url = `https://raw.githubusercontent.com/${encodeURIComponent(coords.owner)}/${encodeURIComponent(coords.repo)}/${encodeURIComponent(ref)}/${path}`;
      try {
        const res = await fetch(url, { headers, signal: opts.signal });
        if (!res.ok) continue;
        const content = await res.text();
        if (!content.trim()) continue;
        // Sanity check: a compose file should mention 'services:'. Avoids
        // false hits on README placeholders or templated files.
        if (!/^services\s*:/m.test(content)) continue;
        return { content, url, ref };
      } catch {
        // ignore and try the next combination
      }
    }
  }
  return null;
}

function candidateRefs(version: string): string[] {
  const v = version.replace(/^v/i, "");
  // Order matters — try the most-likely-correct first to keep the fetch
  // count down.
  return Array.from(
    new Set([
      `v${v}`,
      v,
      version,
      `release-${v}`,
      `release/${v}`,
    ]),
  );
}
