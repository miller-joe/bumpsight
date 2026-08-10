import type { ImageRef } from "../compose/parse.js";
import { listDockerHubTags, type RemoteTag, type FetchTagsOptions } from "./dockerhub.js";
import { listGhcrTags } from "./ghcr.js";
import { isDockerHubRegistry, toDockerHubRef } from "./mirrors.js";

export type { RemoteTag, FetchTagsOptions } from "./dockerhub.js";
export { fetchManifestDigest } from "./manifest.js";
export { isDockerHubRegistry, isDockerHubMirror, toDockerHubRef } from "./mirrors.js";

/**
 * Dispatch to the correct registry client for an image. Unsupported
 * registries throw with a clear message so the CLI can skip them.
 *
 * Docker Hub mirrors (see `mirrors.ts`) are normalized onto docker.io first,
 * so `lscr.io/linuxserver/sonarr` resolves against `linuxserver/sonarr`.
 */
export async function listTags(ref: ImageRef, opts: FetchTagsOptions = {}): Promise<RemoteTag[]> {
  const reg = ref.registry;
  if (isDockerHubRegistry(reg)) {
    return listDockerHubTags(toDockerHubRef(ref), opts);
  }
  if (reg === "ghcr.io") {
    return listGhcrTags(ref, opts);
  }
  throw new Error(`registry not supported yet: ${reg}`);
}

export function isSupportedRegistry(ref: ImageRef): boolean {
  return isDockerHubRegistry(ref.registry) || ref.registry === "ghcr.io";
}
