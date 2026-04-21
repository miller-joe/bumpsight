import type { ImageRef } from "../compose/parse.js";

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
  let url: string | null =
    `${HUB_BASE}/repositories/${encodeURIComponent(namespace)}/${encodeURIComponent(ref.name)}/tags/?page_size=100&ordering=-last_updated`;

  while (url && tags.length < maxTags) {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: opts.signal,
    });
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
