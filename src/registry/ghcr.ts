import type { ImageRef } from "../compose/parse.js";
import type { RemoteTag, FetchTagsOptions } from "./dockerhub.js";
import { RegistrySession, listAllTags, registryTarget } from "./v2.js";

const GHCR_HOST = "ghcr.io";

/**
 * List tags for a GitHub Container Registry image via the Docker Registry
 * v2 protocol. Uses anonymous token auth, which works for public repos.
 *
 * GHCR returns tags in lexical order, so the listing follows pagination to
 * the end: a single capped page used to stop partway through the version
 * range, which hid the newest releases of any repo with a long tag history.
 */
export async function listGhcrTags(
  ref: ImageRef,
  opts: FetchTagsOptions = {},
): Promise<RemoteTag[]> {
  if (ref.registry !== GHCR_HOST) {
    throw new Error(`listGhcrTags: not a ghcr.io image (${ref.raw})`);
  }
  const session = new RegistrySession(registryTarget(ref), opts.signal);
  const names = await listAllTags(session, { maxTags: opts.maxTags });
  return names.map((name) => ({ name }));
}
