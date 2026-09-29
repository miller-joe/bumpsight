import type { ImageRef } from "../compose/parse.js";
import { dockerHubCredentials, fetchWithRetry, type DockerHubCredentials } from "./http.js";
import { RegistrySession, listAllTags, registryTarget } from "./v2.js";

const HUB_BASE = "https://hub.docker.com/v2";

interface DockerHubTagsResponse {
  count: number;
  next: string | null;
  results: Array<{
    name: string;
    last_updated: string | null;
    digest?: string | null;
  }>;
}

export interface RemoteTag {
  name: string;
  lastUpdated?: string;
  digest?: string;
}

export interface FetchTagsOptions {
  /** Maximum number of tags to return. Defaults to 200. */
  maxTags?: number;
  /** Abort signal for the caller. */
  signal?: AbortSignal;
}

/**
 * List tags for a Docker Hub image. Handles the `library/` default namespace
 * for official images (e.g. `nginx` → `library/nginx`).
 */
export async function listDockerHubTags(
  ref: ImageRef,
  opts: FetchTagsOptions = {},
): Promise<RemoteTag[]> {
  if (ref.registry && ref.registry !== "docker.io" && ref.registry !== "index.docker.io") {
    throw new Error(`listDockerHubTags: not a Docker Hub image (${ref.raw})`);
  }
  const namespace = ref.namespace ?? "library";
  const maxTags = opts.maxTags ?? 200;

  const tags: RemoteTag[] = [];
  // Docker Hub's `ordering` parameter has reversed semantics from the DRF
  // convention: `last_updated` (no minus) returns most-recent first,
  // `-last_updated` returns oldest first. Confirmed empirically against
  // hub.docker.com on 2026-04-26. We want newest first so that the most
  // relevant tags arrive within the first `maxTags` cap on heavily-tagged
  // repos like linuxserver/jellyfin (12k+ tags).
  let url: string | null =
    `${HUB_BASE}/repositories/${encodeURIComponent(namespace)}/${encodeURIComponent(ref.name)}/tags/?page_size=100&ordering=last_updated`;

  const auth = await hubApiAuthHeader(opts.signal);
  while (url && tags.length < maxTags) {
    const res = await fetchWithRetry(
      url,
      { headers: { Accept: "application/json", ...auth } },
      { signal: opts.signal },
    );
    if (res.status === 429 && tags.length === 0) {
      // Still rate-limited after back-off. The Hub web API and the registry
      // API are limited separately, so fall back to the registry's own tag
      // list rather than dropping the image from the scan. It lacks inline
      // digests and newest-first ordering, but it is the complete list.
      await res.arrayBuffer().catch(() => undefined);
      return listDockerHubTagsViaRegistry(ref, opts);
    }
    if (!res.ok) {
      throw new Error(`Docker Hub: ${res.status} ${res.statusText} fetching ${url}`);
    }
    const body = (await res.json()) as DockerHubTagsResponse;
    for (const r of body.results) {
      tags.push({
        name: r.name,
        lastUpdated: r.last_updated ?? undefined,
        digest: r.digest ?? undefined,
      });
      if (tags.length >= maxTags) break;
    }
    url = body.next;
  }
  return tags;
}

/**
 * Registry v2 tag listing for a Docker Hub repo. Used as the fallback when
 * the Hub web API keeps answering 429.
 */
async function listDockerHubTagsViaRegistry(
  ref: ImageRef,
  opts: FetchTagsOptions,
): Promise<RemoteTag[]> {
  const session = new RegistrySession(registryTarget(ref), opts.signal);
  const names = await listAllTags(session);
  return names.map((name) => ({ name }));
}

interface HubJwt {
  key: string;
  header: Record<string, string>;
  expiresAt: number;
}
let hubJwt: HubJwt | undefined;

/**
 * Authorization header for the Hub web API when credentials are configured,
 * else `{}` (anonymous). Exchanges the username + personal access token for a
 * short-lived JWT and caches it. A failed login falls back to anonymous — a
 * bad credential must degrade to the old behavior, never break the scan.
 */
async function hubApiAuthHeader(signal?: AbortSignal): Promise<Record<string, string>> {
  const creds = dockerHubCredentials();
  if (!creds) return {};
  const key = `${creds.user}:${creds.token}`;
  if (hubJwt && hubJwt.key === key && hubJwt.expiresAt > Date.now()) return hubJwt.header;
  const token = await hubLogin(creds, signal);
  if (!token) return {};
  // Hub JWTs last longer than this; refreshing early is cheap.
  hubJwt = { key, header: { Authorization: `Bearer ${token}` }, expiresAt: Date.now() + 10 * 60_000 };
  return hubJwt.header;
}

async function hubLogin(
  creds: DockerHubCredentials,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const attempts: Array<{ url: string; body: Record<string, string> }> = [
    { url: `${HUB_BASE}/auth/token`, body: { identifier: creds.user, secret: creds.token } },
    { url: `${HUB_BASE}/users/login`, body: { username: creds.user, password: creds.token } },
  ];
  for (const a of attempts) {
    try {
      const res = await fetchWithRetry(
        a.url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(a.body),
        },
        { signal },
      );
      if (!res.ok) continue;
      const body = (await res.json()) as { access_token?: string; token?: string };
      const t = body.access_token ?? body.token;
      if (t) return t;
    } catch {
      // try the next endpoint
    }
  }
  return undefined;
}

/** Test seam: forget the cached Hub JWT. */
export function _resetDockerHubAuth(): void {
  hubJwt = undefined;
}
