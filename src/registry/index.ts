import type { ImageRef } from "../compose/parse.js";
import { listDockerHubTags, type RemoteTag, type FetchTagsOptions } from "./dockerhub.js";
import { listGhcrTags } from "./ghcr.js";
import { isDockerHubRegistry, toDockerHubRef } from "./mirrors.js";
import { RegistrySession, listAllTags, registryTarget } from "./v2.js";

export type { RemoteTag, FetchTagsOptions } from "./dockerhub.js";
export { fetchManifestDigest } from "./manifest.js";
export { isDockerHubRegistry, isDockerHubMirror, toDockerHubRef } from "./mirrors.js";

/**
 * Dispatch to the correct registry client for an image. Docker Hub and GHCR
 * have dedicated clients; every other registry goes through the generic OCI
 * Distribution client (`v2.ts`), so no registry is skipped for lack of one.
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
  return listGenericTags(ref, opts);
}

/** Tags for any v2 registry, via the generic client. */
export async function listGenericTags(
  ref: ImageRef,
  opts: FetchTagsOptions = {},
): Promise<RemoteTag[]> {
  const session = new RegistrySession(registryTarget(ref), opts.signal);
  const names = await listAllTags(session, { maxTags: opts.maxTags });
  return names.map((name) => ({ name }));
}

/**
 * True when bumpsight can check this image. Every registry now can — the
 * generic client covers the ones without a dedicated client — so this only
 * remains as the single place to say otherwise if that ever changes.
 */
export function isSupportedRegistry(_ref: ImageRef): boolean {
  return true;
}

/** True for registries with a purpose-built client (Docker Hub, GHCR). */
export function hasDedicatedClient(ref: ImageRef): boolean {
  return isDockerHubRegistry(ref.registry) || ref.registry === "ghcr.io";
}
