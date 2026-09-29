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
import { RegistrySession, registryTarget } from "./v2.js";

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
 * Resolve OCI labels for `image` at `digest`. Works for any registry — Docker
 * Hub (including its mirrors, see `mirrors.ts`), GHCR, and anything else via
 * the generic v2 client. Never throws; failures return `{ labels: {} }`.
 */
export async function fetchOciLabels(
  ref: ImageRef,
  digest: string,
  opts: FetchOciLabelsOptions = {},
): Promise<OciImageLabels> {
  if (!digest) return { labels: {} };
  const session = new RegistrySession(registryTarget(ref), opts.signal);
  try {
    if (!(await session.authenticate())) return { labels: {} };
  } catch {
    return { labels: {} };
  }
  return fetchLabelsWithSession(session, digest);
}

async function fetchLabelsWithSession(
  session: RegistrySession,
  digest: string,
): Promise<OciImageLabels> {
  const manifestRes = await fetchJson<SingleManifest | ManifestIndex>(
    session,
    `manifests/${encodeURIComponent(digest)}`,
    MANIFEST_ACCEPT,
  );
  if (!manifestRes) return { labels: {} };
  const { body, mediaType } = manifestRes;

  const isIndex =
    (mediaType && INDEX_MEDIA_TYPES.has(mediaType)) ||
    // Some registries omit Content-Type; sniff by shape.
    (!mediaType || !SINGLE_MANIFEST_MEDIA_TYPES.has(mediaType)
      ? Array.isArray((body as ManifestIndex).manifests)
      : false);

  let singleManifest: SingleManifest | null = null;
  if (isIndex) {
    const archDigest = pickArchDigest(body as ManifestIndex);
    if (!archDigest) return { labels: {} };
    const archRes = await fetchJson<SingleManifest>(
      session,
      `manifests/${encodeURIComponent(archDigest)}`,
      MANIFEST_ACCEPT,
    );
    if (!archRes) return { labels: {} };
    singleManifest = archRes.body;
  } else if (
    (mediaType && SINGLE_MANIFEST_MEDIA_TYPES.has(mediaType)) ||
    (body as SingleManifest).config?.digest
  ) {
    singleManifest = body as SingleManifest;
  } else {
    return { labels: {} };
  }

  const configDigest = singleManifest?.config?.digest;
  if (!configDigest) return { labels: {} };

  const blobRes = await fetchJson<ImageConfigBlob>(
    session,
    `blobs/${encodeURIComponent(configDigest)}`,
    BLOB_ACCEPT,
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
  session: RegistrySession,
  path: string,
  accept: string,
): Promise<{ body: T; mediaType: string | null } | null> {
  try {
    const res = await session.fetch(path, { accept });
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
