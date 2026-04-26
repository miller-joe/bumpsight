/**
 * GitHub Releases fetcher for a given image's upstream repository.
 *
 * Heuristics (first match wins):
 *   1. A user-supplied {owner}/{repo} override.
 *   2. linuxserver/<name> → github.com/linuxserver/docker-<name>.
 *   3. Curated mapping for Docker official images (`library/*`).
 *      Required because Docker Hub's description for these usually points
 *      at the docker wrapper repo, which has no semantic releases.
 *   4. ghcr.io/<owner>/<name> → github.com/<owner>/<name>.
 *   5. Docker Hub metadata lookup (best-effort, reads the image description).
 *
 * If none of those produce a repo, the caller should fall back to asking the
 * user for `--repo`.
 */

/**
 * Curated mapping for Docker Official images that need explicit upstream
 * mapping because the Docker Hub description points at a wrapper repo
 * (which doesn't have releases) or a different repo than the actual
 * project.
 *
 * Keyed by the image name (no namespace — Docker official images live
 * in the `library` namespace). Values: { owner, repo } on GitHub.
 *
 * When an entry maps to `null`, it means "we know there's no useful
 * GitHub-Releases-shaped upstream for this image" — bumpsight will
 * report 'no upstream' rather than wandering into the wrapper repo.
 */
const DOCKER_OFFICIAL_UPSTREAMS: Record<string, { owner: string; repo: string } | null> = {
  // Real upstreams with semantic releases:
  node: { owner: "nodejs", repo: "node" },
  python: { owner: "python", repo: "cpython" },
  ruby: { owner: "ruby", repo: "ruby" },
  golang: { owner: "golang", repo: "go" },
  postgres: { owner: "postgres", repo: "postgres" },
  redis: { owner: "redis", repo: "redis" },
  nginx: { owner: "nginx", repo: "nginx" },
  caddy: { owner: "caddyserver", repo: "caddy" },
  traefik: { owner: "traefik", repo: "traefik" },
  mongo: { owner: "mongodb", repo: "mongo" },
  mariadb: { owner: "MariaDB", repo: "server" },
  rabbitmq: { owner: "rabbitmq", repo: "rabbitmq-server" },
  memcached: { owner: "memcached", repo: "memcached" },
  haproxy: { owner: "haproxy", repo: "haproxy" },
  httpd: { owner: "apache", repo: "httpd" },
  tomcat: { owner: "apache", repo: "tomcat" },
  consul: { owner: "hashicorp", repo: "consul" },
  vault: { owner: "hashicorp", repo: "vault" },
  nomad: { owner: "hashicorp", repo: "nomad" },
  // Known to not have meaningful GitHub Releases:
  mysql: null, // ships via blog posts and tarballs, not GitHub Releases
  alpine: null,
  ubuntu: null,
  debian: null,
  busybox: null,
};

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
  source: "override" | "linuxserver" | "official" | "ghcr" | "dockerhub";
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

  // Docker Official images live in the `library` namespace (or are
  // referenced bare like `nginx`). Use the curated table — Docker Hub's
  // description usually points at a wrapper repo with no releases.
  if (ns === "library") {
    if (ref.name in DOCKER_OFFICIAL_UPSTREAMS) {
      const entry = DOCKER_OFFICIAL_UPSTREAMS[ref.name];
      if (!entry) return null; // explicitly known to have no upstream
      return { owner: entry.owner, repo: entry.repo, source: "official" };
    }
    // fall through to the docker hub heuristic for unmapped official images
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
 * because Docker image tags don't always match GitHub tag names one-to-one
 * (e.g. image tag `8.0` ↔ release `mysql-8.0.40`, image tag `25-alpine` ↔
 * release `v25.9.0`).
 *
 * Match strategy, exact-first then progressively looser:
 *   1. Exact (after `v` strip + lowercase)
 *   2. Prefix on numeric components (image `8.0` matches release `8.0.40`)
 *   3. Substring on numeric components (image `8` matches `8.0.40`)
 */
export function releasesBetween(
  releases: GithubRelease[],
  from: string,
  to: string,
): GithubRelease[] {
  const fromIdx = findReleaseIndex(releases, from);
  const toIdx = findReleaseIndex(releases, to);
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

function findReleaseIndex(releases: GithubRelease[], target: string): number {
  // Pass 1: exact
  let idx = releases.findIndex((r) => tagMatches(r.tagName, target, "exact"));
  if (idx !== -1) return idx;
  // Pass 2: prefix on the numeric portion
  idx = releases.findIndex((r) => tagMatches(r.tagName, target, "prefix"));
  if (idx !== -1) return idx;
  // Pass 3: substring on the numeric portion
  idx = releases.findIndex((r) => tagMatches(r.tagName, target, "substring"));
  return idx;
}

function tagMatches(
  releaseTag: string,
  target: string,
  mode: "exact" | "prefix" | "substring",
): boolean {
  const a = normalize(releaseTag);
  const b = normalize(target);
  if (mode === "exact") return a === b;
  // For looser modes, extract just the numeric/dotted portion.
  const num = (s: string): string => {
    const m = s.match(/(\d+(?:\.\d+)*)/);
    return m ? m[1]! : s;
  };
  const aNum = num(a);
  const bNum = num(b);
  if (!aNum || !bNum) return false;
  if (mode === "prefix") {
    // Match when the release's numeric prefix exactly is or extends the
    // target's numeric prefix at a component boundary, e.g. release "8.0.40"
    // matches target "8.0" but not "8".
    return aNum === bNum || aNum.startsWith(bNum + ".");
  }
  // substring
  return aNum.includes(bNum);
}

function normalize(s: string): string {
  return s.replace(/^v/i, "").toLowerCase();
}
