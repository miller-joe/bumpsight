import type { ImageRef } from "../compose/parse.js";
import { isDockerHubRegistry, toDockerHubRef } from "./mirrors.js";

const MANIFEST_ACCEPT = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
].join(", ");

export interface FetchManifestOptions {
  signal?: AbortSignal;
}

/**
 * Fetch the digest (Docker-Content-Digest header) for a single (image, tag)
 * via the Docker Registry v2 protocol. Returns undefined when the manifest
 * is missing or the registry doesn't expose a digest header.
 *
 * Supports docker.io (including its mirrors, see `mirrors.ts`) and ghcr.io.
 * Both require a per-request anonymous pull token; the auth realm differs
 * between them.
 */
export async function fetchManifestDigest(
  ref: ImageRef,
  tag: string,
  opts: FetchManifestOptions = {},
): Promise<string | undefined> {
  const reg = ref.registry;
  if (isDockerHubRegistry(reg)) {
    return fetchDockerHubManifestDigest(toDockerHubRef(ref), tag, opts);
  }
  if (reg === "ghcr.io") {
    return fetchGhcrManifestDigest(ref, tag, opts);
  }
  return undefined;
}

async function fetchDockerHubManifestDigest(
  ref: ImageRef,
  tag: string,
  opts: FetchManifestOptions,
): Promise<string | undefined> {
  const namespace = ref.namespace ?? "library";
  const repoPath = `${namespace}/${ref.name}`;

  const tokenUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${encodeURIComponent(repoPath)}:pull`;
  const tokenRes = await fetch(tokenUrl, { signal: opts.signal });
  if (!tokenRes.ok) return undefined;
  const tokenBody = (await tokenRes.json()) as { token?: string };
  const token = tokenBody.token;
  if (!token) return undefined;

  const manifestUrl = `https://registry-1.docker.io/v2/${repoPath}/manifests/${encodeURIComponent(tag)}`;
  return headDigest(manifestUrl, token, opts.signal);
}

async function fetchGhcrManifestDigest(
  ref: ImageRef,
  tag: string,
  opts: FetchManifestOptions,
): Promise<string | undefined> {
  const repoPath = ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
  const tokenUrl = `https://ghcr.io/token?scope=repository:${encodeURIComponent(repoPath)}:pull&service=ghcr.io`;
  const tokenRes = await fetch(tokenUrl, { signal: opts.signal });
  if (!tokenRes.ok) return undefined;
  const tokenBody = (await tokenRes.json()) as {
    token?: string;
    access_token?: string;
  };
  const token = tokenBody.token ?? tokenBody.access_token;
  if (!token) return undefined;

  const manifestUrl = `https://ghcr.io/v2/${repoPath}/manifests/${encodeURIComponent(tag)}`;
  return headDigest(manifestUrl, token, opts.signal);
}

async function headDigest(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // HEAD is the cheap path; some proxies don't surface the header on HEAD,
  // so we fall back to GET if needed.
  const headRes = await fetch(url, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
    signal,
  });
  const headerHead = headRes.headers.get("docker-content-digest");
  if (headerHead) return headerHead;
  if (!headRes.ok) return undefined;

  const getRes = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
    signal,
  });
  if (!getRes.ok) return undefined;
  return getRes.headers.get("docker-content-digest") ?? undefined;
}
