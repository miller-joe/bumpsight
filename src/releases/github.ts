/**
 * GitHub Releases fetcher for a given image's upstream repository.
 *
 * v0.1 uses a small set of heuristics to map Docker images to GitHub repos:
 *   1. A user-supplied {owner}/{repo} override.
 *   2. linuxserver/<name> → github.com/linuxserver/docker-<name>.
 *   3. ghcr.io/<owner>/<name> → github.com/<owner>/<name>.
 *   4. Docker Hub metadata lookup (best-effort, reads the image description).
 *
 * If none of those produce a repo, the caller should fall back to asking the
 * user for `--repo`.
 */

import type { ImageRef } from "../compose/parse.js";

export interface GithubRelease {
  tagName: string;
  name: string | null;
  publishedAt: string | null;
  body: string | null;
  prerelease: boolean;
  draft: boolean;
  url: string;
}

export interface RepoCoords {
  owner: string;
  repo: string;
  source: "override" | "linuxserver" | "ghcr" | "dockerhub";
}

export async function resolveUpstreamRepo(
  ref: ImageRef,
  override?: string,
  signal?: AbortSignal,
): Promise<RepoCoords | null> {
  if (override) {
    const [owner, repo] = override.split("/");
    if (owner && repo) {
      return { owner, repo, source: "override" };
    }
  }

  const ns = ref.namespace ?? "library";

  if (ns === "linuxserver") {
    return { owner: "linuxserver", repo: `docker-${ref.name}`, source: "linuxserver" };
  }

  if (ref.registry === "ghcr.io") {
    return { owner: ns, repo: ref.name, source: "ghcr" };
  }

  // Docker Hub metadata fallback: the `full_description` often includes a
  // GitHub link. We look up the description and pattern-match.
  if (!ref.registry || ref.registry === "docker.io" || ref.registry === "index.docker.io") {
    const url = `https://hub.docker.com/v2/repositories/${encodeURIComponent(ns)}/${encodeURIComponent(ref.name)}/`;
    try {
      const res = await fetch(url, { signal });
      if (res.ok) {
        const body = (await res.json()) as {
          full_description?: string | null;
          description?: string | null;
        };
        const text = (body.full_description ?? "") + "\n" + (body.description ?? "");
        const m = text.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
        if (m) {
          return { owner: m[1]!, repo: m[2]!.replace(/\.git$/, ""), source: "dockerhub" };
        }
      }
    } catch {
      // ignore, fall through
    }
  }

  return null;
}

export interface FetchReleasesOptions {
  /** Maximum releases to return. Defaults to 40. */
  maxReleases?: number;
  /** GitHub token (optional; anonymous is fine but rate-limited). */
  token?: string;
  signal?: AbortSignal;
}

export async function fetchReleases(
  coords: RepoCoords,
  opts: FetchReleasesOptions = {},
): Promise<GithubRelease[]> {
  const perPage = Math.min(100, opts.maxReleases ?? 40);
  const url = `https://api.github.com/repos/${encodeURIComponent(coords.owner)}/${encodeURIComponent(coords.repo)}/releases?per_page=${perPage}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, { headers, signal: opts.signal });
  if (!res.ok) {
    throw new Error(
      `GitHub releases: ${res.status} ${res.statusText} for ${coords.owner}/${coords.repo}`,
    );
  }
  const body = (await res.json()) as Array<{
    tag_name: string;
    name: string | null;
    published_at: string | null;
    body: string | null;
    prerelease: boolean;
    draft: boolean;
    html_url: string;
  }>;
  return body.map((r) => ({
    tagName: r.tag_name,
    name: r.name,
    publishedAt: r.published_at,
    body: r.body,
    prerelease: r.prerelease,
    draft: r.draft,
    url: r.html_url,
  }));
}

/**
 * Filter releases to the set that sit strictly between `from` and `to`
 * (exclusive of `from`, inclusive of `to`). Uses loose string comparison
 * falling back to release date, because Docker image tags don't always
 * match GitHub tag names one-to-one.
 */
export function releasesBetween(
  releases: GithubRelease[],
  from: string,
  to: string,
): GithubRelease[] {
  const fromIdx = releases.findIndex((r) => tagMatches(r.tagName, from));
  const toIdx = releases.findIndex((r) => tagMatches(r.tagName, to));
  if (toIdx === -1) return releases;
  if (fromIdx === -1) {
    // From-tag is older than everything in the release list (or just
    // doesn't match any tag name). Return every release from `to` through
    // the oldest in the list — they're all newer than `from`.
    return releases.slice(toIdx);
  }
  const [hi, lo] = fromIdx < toIdx ? [toIdx, fromIdx] : [fromIdx, toIdx];
  // GitHub returns newest first. Slice from lo (newer) up to hi (older exclusive).
  return releases.slice(lo, hi);
}

function tagMatches(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^v/, "").toLowerCase();
  return norm(a) === norm(b);
}
