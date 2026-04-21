import type { ImageRef } from "../compose/parse.js";
import type { RemoteTag, FetchTagsOptions } from "./dockerhub.js";

const GHCR_HOST = "ghcr.io";

interface GhcrTagList {
  name: string;
  tags: string[] | null;
}

/**
 * List tags for a GitHub Container Registry image via the Docker Registry
 * v2 protocol. Uses anonymous token auth, which works for public repos.
 * Private repos need a GitHub token (not supported in v0.1).
 */
export async function listGhcrTags(
  ref: ImageRef,
  opts: FetchTagsOptions = {},
): Promise<RemoteTag[]> {
  if (ref.registry !== GHCR_HOST) {
    throw new Error(`listGhcrTags: not a ghcr.io image (${ref.raw})`);
  }
  const repoPath = ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;

  // 1. Get anonymous pull token.
  const tokenUrl = `https://${GHCR_HOST}/token?scope=repository:${encodeURIComponent(repoPath)}:pull&service=${GHCR_HOST}`;
  const tokenRes = await fetch(tokenUrl, { signal: opts.signal });
  if (!tokenRes.ok) {
    throw new Error(`GHCR token: ${tokenRes.status} ${tokenRes.statusText}`);
  }
  const tokenBody = (await tokenRes.json()) as { token?: string; access_token?: string };
  const token = tokenBody.token ?? tokenBody.access_token;
  if (!token) {
    throw new Error("GHCR token: missing token in response");
  }

  // 2. List tags.
  const listUrl = `https://${GHCR_HOST}/v2/${repoPath}/tags/list?n=${opts.maxTags ?? 200}`;
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: opts.signal,
  });
  if (!listRes.ok) {
    throw new Error(`GHCR tags: ${listRes.status} ${listRes.statusText} for ${repoPath}`);
  }
  const body = (await listRes.json()) as GhcrTagList;
  return (body.tags ?? []).map((name) => ({ name }));
}
