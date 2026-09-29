import type { ImageRef } from "../compose/parse.js";
import { RegistrySession, headManifestDigest, registryTarget } from "./v2.js";

export interface FetchManifestOptions {
  signal?: AbortSignal;
}

/**
 * Fetch the digest (Docker-Content-Digest header) for a single (image, tag)
 * via the Docker Registry v2 protocol. Returns undefined when the manifest
 * is missing, the registry doesn't expose a digest header, or auth fails.
 *
 * Works for any registry: Docker Hub (and its mirrors, see `mirrors.ts`) and
 * GHCR use their known token realms; everything else goes through the
 * generic challenge flow in `v2.ts`.
 */
export async function fetchManifestDigest(
  ref: ImageRef,
  tag: string,
  opts: FetchManifestOptions = {},
): Promise<string | undefined> {
  const session = new RegistrySession(registryTarget(ref), opts.signal);
  try {
    if (!(await session.authenticate())) return undefined;
    return await headManifestDigest(session, tag);
  } catch {
    return undefined;
  }
}
