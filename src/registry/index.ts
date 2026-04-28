import type { ImageRef } from "../compose/parse.js";
import { listDockerHubTags, type RemoteTag, type FetchTagsOptions } from "./dockerhub.js";
import { listGhcrTags } from "./ghcr.js";

export type { RemoteTag, FetchTagsOptions } from "./dockerhub.js";
export { fetchManifestDigest } from "./manifest.js";

/**
 * Dispatch to the correct registry client for an image. Unsupported
 * registries throw with a clear message so the CLI can skip them.
 */
export async function listTags(ref: ImageRef, opts: FetchTagsOptions = {}): Promise<RemoteTag[]> {
  const reg = ref.registry;
  if (!reg || reg === "docker.io" || reg === "index.docker.io") {
    return listDockerHubTags(ref, opts);
  }
  if (reg === "ghcr.io") {
    return listGhcrTags(ref, opts);
  }
  throw new Error(`registry not supported yet: ${reg}`);
}

export function isSupportedRegistry(ref: ImageRef): boolean {
  const reg = ref.registry;
  if (!reg) return true;
  return reg === "docker.io" || reg === "index.docker.io" || reg === "ghcr.io";
}
