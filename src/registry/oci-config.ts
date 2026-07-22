/**
 * v0.5.5 OCI image config-blob fetcher.
 *
 * Given an image ref + digest, walks the Docker Registry v2 protocol two
 * hops:
 *   1. GET manifest at {image}@{digest}
 *   2. If it's a manifest list / image index, pick the linux/amd64 entry
 *      and re-fetch that manifest.
 *   3. From the single-arch manifest, GET the config blob referenced by
 *      `config.digest`.
 *   4. Parse the blob as JSON and return `.config.Labels`.
 *
 * Used by `advise/digest-enrichment` to look up
 * `org.opencontainers.image.revision` and
 * `org.opencontainers.image.source` so digest-class bumps can be
 * decoded into a real upstream git SHA range.
 *
 * Never throws. Returns `{ labels: {} }` on any failure — callers treat
 * an empty label map identically to a missing image.
 */

import type { ImageRef } from "../compose/parse.js";

const MANIFEST_ACCEPT = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
].join(", ");

const BLOB_ACCEPT = [
  "application/vnd.docker.container.image.v1+json",
  "application/vnd.oci.image.config.v1+json",
  "application/json",
].join(", ");

const SINGLE_MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
]);

const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
]);

export interface OciImageLabels {
  /** Labels merged from the config blob. May be empty. */
  labels: Record<string, string>;
  /** v0.6.0: the image config's build timestamp (RFC3339). Taken from the
   *  `org.opencontainers.image.created` label when present, else the config
   *  blob's top-level `created` field (set by virtually every builder). Used
   *  as a human-readable fallback delta for moving-tag digest bumps that carry
   *  no version label. Undefined only when the blob couldn't be read. */
  created?: string;
}

export interface FetchOciLabelsOptions {
  signal?: AbortSignal;
}

interface SingleManifest {
  config?: { digest?: string };
}

interface ManifestIndex {
  manifests?: Array<{
    digest?: string;
    mediaType?: string;
    platform?: { architecture?: string; os?: string };
  }>;
}

interface ImageConfigBlob {
  config?: { Labels?: Record<string, string> | null };
  /** OCI sometimes nests labels at the root too. */
  Labels?: Record<string, string> | null;
  /** Top-level image build timestamp (RFC3339). Present on nearly all images. */
  created?: string;
}

/**
 * Resolve OCI labels for `image` at `digest`. Supports docker.io and ghcr.io.
 * Anything else returns `{ labels: {} }`.
 */
export async function fetchOciLabels(
  ref: ImageRef,
  digest: string,
  opts: FetchOciLabelsOptions = {},
): Promise<OciImageLabels> {
  if (!digest) return { labels: {} };
  const auth = await acquireToken(ref, opts.signal);
  if (!auth) return { labels: {} };
  return fetchLabelsWithToken(ref, digest, auth.token, auth.host, opts.signal);
}

interface RegistryAuth {
  token: string;
  host: string;
}

async function acquireToken(
  ref: ImageRef,
  signal?: AbortSignal,
): Promise<RegistryAuth | null> {
  const reg = ref.registry;
  if (!reg || reg === "docker.io" || reg === "index.docker.io") {
    const namespace = ref.namespace ?? "library";
    const repoPath = `${namespace}/${ref.name}`;
    const tokenUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${encodeURIComponent(repoPath)}:pull`;
    const token = await fetchToken(tokenUrl, signal);
    if (!token) return null;
    return { token, host: "registry-1.docker.io" };
  }
  if (reg === "ghcr.io") {
    const repoPath = ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
    const tokenUrl = `https://ghcr.io/token?scope=repository:${encodeURIComponent(repoPath)}:pull&service=ghcr.io`;
    const token = await fetchToken(tokenUrl, signal);
    if (!token) return null;
    return { token, host: "ghcr.io" };
  }
  return null;
}

async function fetchToken(
  url: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string; access_token?: string };
    return body.token ?? body.access_token ?? null;
  } catch {
    return null;
  }
}

async function fetchLabelsWithToken(
  ref: ImageRef,
  digest: string,
  token: string,
  host: string,
  signal?: AbortSignal,
): Promise<OciImageLabels> {
  const repoPath = repoPathFor(ref);
  const manifestUrl = `https://${host}/v2/${repoPath}/manifests/${encodeURIComponent(digest)}`;
  const manifestRes = await fetchJson<SingleManifest | ManifestIndex>(
    manifestUrl,
    token,
    MANIFEST_ACCEPT,
    signal,
  );
  if (!manifestRes) return { labels: {} };
  const { body, mediaType } = manifestRes;

  let singleManifest: SingleManifest | null = null;
  if (mediaType && INDEX_MEDIA_TYPES.has(mediaType)) {
    const index = body as ManifestIndex;
    const archDigest = pickArchDigest(index);
    if (!archDigest) return { labels: {} };
    const archUrl = `https://${host}/v2/${repoPath}/manifests/${encodeURIComponent(archDigest)}`;
    const archRes = await fetchJson<SingleManifest>(
      archUrl,
      token,
      MANIFEST_ACCEPT,
      signal,
    );
    if (!archRes) return { labels: {} };
    singleManifest = archRes.body;
  } else if (mediaType && SINGLE_MANIFEST_MEDIA_TYPES.has(mediaType)) {
    singleManifest = body as SingleManifest;
  } else {
    // Some registries omit Content-Type; sniff by shape.
    if ((body as ManifestIndex).manifests) {
      const index = body as ManifestIndex;
      const archDigest = pickArchDigest(index);
      if (!archDigest) return { labels: {} };
      const archUrl = `https://${host}/v2/${repoPath}/manifests/${encodeURIComponent(archDigest)}`;
      const archRes = await fetchJson<SingleManifest>(
        archUrl,
        token,
        MANIFEST_ACCEPT,
        signal,
      );
      if (!archRes) return { labels: {} };
      singleManifest = archRes.body;
    } else if ((body as SingleManifest).config?.digest) {
      singleManifest = body as SingleManifest;
    } else {
      return { labels: {} };
    }
  }

  const configDigest = singleManifest?.config?.digest;
  if (!configDigest) return { labels: {} };

  const blobUrl = `https://${host}/v2/${repoPath}/blobs/${encodeURIComponent(configDigest)}`;
  const blobRes = await fetchJson<ImageConfigBlob>(
    blobUrl,
    token,
    BLOB_ACCEPT,
    signal,
  );
  if (!blobRes) return { labels: {} };
  const labels = blobRes.body.config?.Labels ?? blobRes.body.Labels ?? null;
  const created =
    (labels && typeof labels === "object"
      ? labels["org.opencontainers.image.created"]
      : undefined) ??
    (typeof blobRes.body.created === "string" ? blobRes.body.created : undefined);
  if (!labels || typeof labels !== "object") return { labels: {}, created };
  return { labels, created };
}

function repoPathFor(ref: ImageRef): string {
  const reg = ref.registry;
  if (!reg || reg === "docker.io" || reg === "index.docker.io") {
    const namespace = ref.namespace ?? "library";
    return `${namespace}/${ref.name}`;
  }
  return ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
}

interface ManifestIndexEntry {
  digest?: string;
  mediaType?: string;
  platform?: { architecture?: string; os?: string };
}

function pickArchDigest(index: ManifestIndex): string | null {
  const manifests: ManifestIndexEntry[] = index.manifests ?? [];
  const linuxAmd = manifests.find(
    (m) => m.platform?.os === "linux" && m.platform?.architecture === "amd64",
  );
  if (linuxAmd?.digest) return linuxAmd.digest;
  const linuxArm = manifests.find(
    (m) => m.platform?.os === "linux" && m.platform?.architecture === "arm64",
  );
  if (linuxArm?.digest) return linuxArm.digest;
  for (const m of manifests) {
    if (m.digest && !isAttestation(m)) return m.digest;
  }
  return null;
}

function isAttestation(m: ManifestIndexEntry): boolean {
  // Docker buildx publishes attestation manifests under `unknown/unknown`
  // platform. Skip those — they have no useful labels.
  return m.platform?.architecture === "unknown" || m.platform?.os === "unknown";
}

async function fetchJson<T>(
  url: string,
  token: string,
  accept: string,
  signal?: AbortSignal,
): Promise<{ body: T; mediaType: string | null } | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept },
      signal,
    });
    if (!res.ok) return null;
    const mediaType = (res.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    const body = (await res.json()) as T;
    return { body, mediaType: mediaType || null };
  } catch {
    return null;
  }
}

/**
 * Extract the upstream git SHA referenced by an OCI label set. Returns
 * undefined when the canonical `org.opencontainers.image.revision` label
 * is missing or empty. The legacy `org.label-schema.vcs-ref` label is
 * checked as a fallback for older images.
 */
export function extractRevision(labels: Record<string, string>): string | undefined {
  const rev = labels["org.opencontainers.image.revision"];
  if (typeof rev === "string" && rev.length > 0) return rev;
  const legacy = labels["org.label-schema.vcs-ref"];
  if (typeof legacy === "string" && legacy.length > 0) return legacy;
  return undefined;
}

/**
 * v0.6.0: extract the image's self-reported version from
 * `org.opencontainers.image.version` (legacy `org.label-schema.version`
 * fallback). Returned verbatim — the caller decides whether it "looks like a
 * version" (many images set this to a branch name like `main`/`master` or a
 * base-image tag, which is useless as a version delta).
 */
export function extractVersion(labels: Record<string, string>): string | undefined {
  const v = labels["org.opencontainers.image.version"];
  if (typeof v === "string" && v.length > 0) return v;
  const legacy = labels["org.label-schema.version"];
  if (typeof legacy === "string" && legacy.length > 0) return legacy;
  return undefined;
}

/**
 * Extract the upstream repo URL (e.g. https://github.com/owner/repo) from
 * the OCI `source` label, with the same legacy fallback.
 */
export function extractSourceUrl(labels: Record<string, string>): string | undefined {
  const src = labels["org.opencontainers.image.source"];
  if (typeof src === "string" && src.length > 0) return src;
  const legacy = labels["org.label-schema.vcs-url"];
  if (typeof legacy === "string" && legacy.length > 0) return legacy;
  return undefined;
}

/**
 * Parse a GitHub URL into {owner, repo}. Tolerates `.git` suffix and
 * `git+https://` protocol prefixes. Returns null on anything that doesn't
 * look like a github.com URL.
 */
export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  if (!url) return null;
  const stripped = url.replace(/^git\+/, "");
  let parsed: URL;
  try {
    parsed = new URL(stripped);
  } catch {
    return null;
  }
  if (!/^(www\.)?github\.com$/i.test(parsed.hostname)) return null;
  const parts = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}
