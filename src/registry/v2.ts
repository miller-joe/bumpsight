/**
 * Generic OCI Distribution (Docker Registry v2) client.
 *
 * Used directly for every registry without a dedicated client (quay.io,
 * mcr.microsoft.com, a self-hosted Gitea/Forgejo registry, …) and as the
 * transport for the Docker Hub and GHCR manifest/blob calls.
 *
 * Auth follows the distribution spec: probe `/v2/`, and if the registry
 * answers 401 with a `Bearer` challenge, fetch an anonymous pull token from
 * the advertised realm. A registry that answers 200 needs no token at all.
 * Docker Hub and GHCR have well-known realms, so they skip the probe.
 */

import type { ImageRef } from "../compose/parse.js";
import { isDockerHubRegistry } from "./mirrors.js";
import {
  basicAuthHeader,
  dockerHubCredentials,
  fetchWithRetry,
  parseAuthChallenge,
} from "./http.js";

export interface RegistryTarget {
  /** Host serving the v2 API. */
  host: string;
  /** Repository path under /v2/. */
  repo: string;
  kind: "dockerhub" | "ghcr" | "generic";
}

/** Resolve where the v2 API for an image lives. */
export function registryTarget(ref: ImageRef): RegistryTarget {
  if (isDockerHubRegistry(ref.registry)) {
    return {
      host: "registry-1.docker.io",
      repo: `${ref.namespace ?? "library"}/${ref.name}`,
      kind: "dockerhub",
    };
  }
  const repo = ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name;
  if (ref.registry === "ghcr.io") return { host: "ghcr.io", repo, kind: "ghcr" };
  return { host: ref.registry!, repo, kind: "generic" };
}

/**
 * One authenticated conversation with a registry about one repository. The
 * pull token is acquired lazily on the first request and reused for the rest
 * of the session (pagination, index → manifest → blob walks).
 */
export class RegistrySession {
  private token: string | null | undefined; // undefined = not yet acquired
  private authOk = false;
  constructor(
    readonly target: RegistryTarget,
    private readonly signal?: AbortSignal,
  ) {}

  url(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    if (path.startsWith("/")) return `https://${this.target.host}${path}`;
    return `https://${this.target.host}/v2/${this.target.repo}/${path}`;
  }

  /**
   * Acquire a pull token. Returns false when the registry demanded auth we
   * could not satisfy — callers treat that as "cannot answer".
   */
  async authenticate(): Promise<boolean> {
    if (this.token === undefined) this.authOk = await this.acquire();
    return this.authOk;
  }

  private async acquire(): Promise<boolean> {
    const t = this.target;
    if (t.kind === "dockerhub") {
      const creds = dockerHubCredentials();
      this.token = await fetchToken(
        `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${encodeURIComponent(t.repo)}:pull`,
        creds ? { Authorization: basicAuthHeader(creds) } : {},
        this.signal,
      );
      return this.token !== null;
    }
    if (t.kind === "ghcr") {
      this.token = await fetchToken(
        `https://ghcr.io/token?scope=repository:${encodeURIComponent(t.repo)}:pull&service=ghcr.io`,
        {},
        this.signal,
      );
      return this.token !== null;
    }
    // Generic: ask the registry what it wants.
    const probe = await fetchWithRetry(`https://${t.host}/v2/`, {}, { signal: this.signal });
    await probe.arrayBuffer().catch(() => undefined);
    if (probe.ok) {
      this.token = null; // open registry, no token needed
      return true;
    }
    if (probe.status !== 401) {
      throw new Error(`${t.host}: /v2/ probe returned ${probe.status} ${probe.statusText}`);
    }
    return this.tokenFromChallenge(probe.headers.get("www-authenticate"));
  }

  private async tokenFromChallenge(header: string | null): Promise<boolean> {
    const ch = parseAuthChallenge(header);
    if (!ch || ch.scheme !== "bearer" || !ch.params.realm) {
      this.token = null;
      return false;
    }
    const qs = new URLSearchParams();
    if (ch.params.service) qs.set("service", ch.params.service);
    qs.set("scope", ch.params.scope || `repository:${this.target.repo}:pull`);
    const sep = ch.params.realm.includes("?") ? "&" : "?";
    this.token = await fetchToken(`${ch.params.realm}${sep}${qs}`, {}, this.signal);
    return this.token !== null;
  }

  /** GET/HEAD a registry path with the session's token. Retries once with a
   *  fresh token when the registry answers 401 with a new challenge (scoped
   *  realms can require a per-repo token the `/v2/` probe did not give us). */
  async fetch(
    path: string,
    init: { method?: string; accept?: string } = {},
  ): Promise<Response> {
    if (!(await this.authenticate())) {
      throw new Error(`${this.target.host}: could not obtain a pull token for ${this.target.repo}`);
    }
    const doFetch = () =>
      fetchWithRetry(
        this.url(path),
        {
          method: init.method ?? "GET",
          headers: {
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
            ...(init.accept ? { Accept: init.accept } : {}),
          },
        },
        { signal: this.signal },
      );
    const res = await doFetch();
    if (res.status === 401 && this.target.kind === "generic") {
      const challenge = res.headers.get("www-authenticate");
      await res.arrayBuffer().catch(() => undefined);
      if (await this.tokenFromChallenge(challenge)) return doFetch();
    }
    return res;
  }
}

async function fetchToken(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetchWithRetry(url, { headers }, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string; access_token?: string };
    return body.token ?? body.access_token ?? null;
  } catch {
    return null;
  }
}

export const MANIFEST_ACCEPT = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
].join(", ");

/**
 * Manifest digest for `reference` (a tag or digest). HEAD first — it does not
 * count against Docker Hub's pull limit — then GET when a proxy strips the
 * header from HEAD responses. Returns undefined for a missing manifest.
 */
export async function headManifestDigest(
  session: RegistrySession,
  reference: string,
): Promise<string | undefined> {
  const path = `manifests/${encodeURIComponent(reference)}`;
  const head = await session.fetch(path, { method: "HEAD", accept: MANIFEST_ACCEPT });
  const fromHead = head.headers.get("docker-content-digest");
  if (fromHead) return fromHead;
  if (!head.ok) return undefined;
  const get = await session.fetch(path, { accept: MANIFEST_ACCEPT });
  const fromGet = get.headers.get("docker-content-digest");
  await get.arrayBuffer().catch(() => undefined);
  return get.ok ? (fromGet ?? undefined) : undefined;
}

/**
 * Full tag list via `/v2/<repo>/tags/list`, following `Link: rel="next"`
 * pagination. Registries return tags in lexical order, so truncating early
 * would drop exactly the newest versions — the cap is a safety net only.
 */
export async function listAllTags(
  session: RegistrySession,
  opts: { pageSize?: number; maxTags?: number } = {},
): Promise<string[]> {
  const pageSize = opts.pageSize ?? 1000;
  const maxTags = opts.maxTags ?? 20_000;
  const tags: string[] = [];
  let next: string | null = `tags/list?n=${pageSize}`;
  let pages = 0;
  while (next && tags.length < maxTags && pages < 100) {
    pages += 1;
    const res = await session.fetch(next, { accept: "application/json" });
    if (!res.ok) {
      throw new Error(
        `${session.target.host}: ${res.status} ${res.statusText} listing tags for ${session.target.repo}`,
      );
    }
    const body = (await res.json()) as { tags?: string[] | null };
    const page = body.tags ?? [];
    for (const t of page) tags.push(t);
    const link = res.headers.get("link");
    next = parseNextLink(link);
    // A registry that ignores `n` and never paginates returns everything in
    // one page with no Link header; one that paginates without Link is not
    // spec-compliant and we stop rather than loop.
  }
  return tags;
}

/** Extract the `rel="next"` target from an RFC 5988 Link header. */
export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (m) return m[1]!;
  }
  return null;
}
