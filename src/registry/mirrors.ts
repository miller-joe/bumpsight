import type { ImageRef } from "../compose/parse.js";

/**
 * Registries that are pull-through aliases for a Docker Hub repository: the
 * same `namespace/name` is published to Docker Hub, so tag listing, manifest
 * digests and OCI label lookups can all be answered by the Docker Hub client.
 *
 * `lscr.io` is LinuxServer.io's registry alias — `lscr.io/linuxserver/sonarr`
 * is the same repository as Docker Hub's `linuxserver/sonarr`.
 *
 * Why this exists: before v0.6.1 `lscr.io` was simply absent from the
 * supported-registry list, so every LinuxServer image was dropped by the
 * `isSupportedRegistry` guard in the scan loop — silently, because the skip
 * was a bare `continue`. Eight images (qbittorrent ×2, sonarr, radarr,
 * prowlarr, plex, lidarr, beets) were never once evaluated, and qbittorrent
 * sat on 5.1.4 while 5.2.2 shipped a WebUI login-loop fix.
 */
const DOCKER_HUB_MIRRORS = new Set(["lscr.io"]);

/**
 * True when tags for this registry are served by Docker Hub: a bare ref, an
 * explicit docker.io ref, or a known mirror.
 */
export function isDockerHubRegistry(registry?: string): boolean {
  if (!registry) return true;
  return (
    registry === "docker.io" ||
    registry === "index.docker.io" ||
    DOCKER_HUB_MIRRORS.has(registry)
  );
}

/** True only for aliases — not for docker.io itself. */
export function isDockerHubMirror(registry?: string): boolean {
  return registry !== undefined && DOCKER_HUB_MIRRORS.has(registry);
}

/**
 * Rewrite a mirrored ref onto Docker Hub so the Docker Hub client accepts it.
 *
 * `raw` is deliberately left untouched. It is the identity used for state
 * rows and for the compose rewrite, both of which must keep the original
 * registry — we bump `lscr.io/linuxserver/sonarr:X`, never rewrite the line
 * to `linuxserver/sonarr:X`.
 */
export function toDockerHubRef(ref: ImageRef): ImageRef {
  if (!isDockerHubMirror(ref.registry)) return ref;
  return { ...ref, registry: "docker.io" };
}
