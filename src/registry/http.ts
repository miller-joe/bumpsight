/**
 * Shared HTTP plumbing for the registry clients: retry/back-off on rate
 * limits, WWW-Authenticate challenge parsing, and optional Docker Hub
 * credentials.
 *
 * Why the retry exists: anonymous Docker Hub API calls hit 429 several times
 * a day on a fleet of ~100 images. Each 429 used to drop that image from the
 * scan outright, while the scan summary still read "0 new" — an image that
 * was never checked looked identical to one that was up to date.
 */

import { readFileSync } from "node:fs";

export interface RetryOptions {
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  signal?: AbortSignal;
}

/** Longest single wait we will honor from a Retry-After / reset header. */
const MAX_RETRY_WAIT_MS = 60_000;
const BASE_BACKOFF_MS = 2_000;

let sleepImpl: (ms: number) => Promise<void> = (ms) =>
  new Promise((r) => setTimeout(r, ms));

/** Test seam: replace the back-off sleep (tests pass a no-op). Returns the
 *  previous implementation so a test can restore it. */
export function setRegistrySleep(
  fn: (ms: number) => Promise<void>,
): (ms: number) => Promise<void> {
  const prev = sleepImpl;
  sleepImpl = fn;
  return prev;
}

/**
 * How long to wait before retrying a rate-limited response. Honors
 * `Retry-After` (seconds or HTTP date) and Docker Hub's
 * `X-RateLimit-Reset` (epoch seconds); otherwise exponential back-off.
 * Always capped so a hostile header cannot stall a scan for hours.
 */
export function retryDelayMs(res: Response, attempt: number, now = Date.now()): number {
  const fallback = BASE_BACKOFF_MS * 2 ** attempt;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return clampWait(secs * 1000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return clampWait(at - now);
  }
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset) {
    const at = Number(reset) * 1000;
    if (Number.isFinite(at) && at > now) return clampWait(at - now);
  }
  return clampWait(fallback);
}

function clampWait(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.min(ms, MAX_RETRY_WAIT_MS);
}

/**
 * `fetch` that retries on 429 and 503 with back-off. Any other status is
 * returned to the caller unchanged, as is the final rate-limited response
 * once retries are exhausted.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal: opts.signal ?? init.signal });
    if ((res.status !== 429 && res.status !== 503) || attempt >= maxRetries) {
      return res;
    }
    // Drain so the connection can be reused.
    await res.arrayBuffer().catch(() => undefined);
    await sleepImpl(retryDelayMs(res, attempt));
  }
}

export interface AuthChallenge {
  scheme: string;
  params: Record<string, string>;
}

/**
 * Parse a `WWW-Authenticate` header, e.g.
 * `Bearer realm="https://auth.example.com/token",service="registry.example.com"`.
 * Returns undefined for an empty header.
 */
export function parseAuthChallenge(header: string | null): AuthChallenge | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const sp = trimmed.indexOf(" ");
  const scheme = (sp < 0 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
  const rest = sp < 0 ? "" : trimmed.slice(sp + 1);
  const params: Record<string, string> = {};
  const re = /([a-zA-Z_]+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    params[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  return { scheme, params };
}

export interface DockerHubCredentials {
  user: string;
  token: string;
}

/**
 * Optional Docker Hub credentials — a username plus a personal access token
 * (read-only scope is enough). Read from `BUMPSIGHT_DOCKERHUB_USER` /
 * `BUMPSIGHT_DOCKERHUB_TOKEN`, or from files named by the `_FILE` variants
 * (for secrets mounted by an orchestrator). Both halves are required; with
 * either missing, requests stay anonymous.
 */
export function dockerHubCredentials(
  env: NodeJS.ProcessEnv = process.env,
): DockerHubCredentials | undefined {
  const user = envOrFile(env, "BUMPSIGHT_DOCKERHUB_USER");
  const token = envOrFile(env, "BUMPSIGHT_DOCKERHUB_TOKEN");
  if (!user || !token) return undefined;
  return { user, token };
}

function envOrFile(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name]?.trim();
  if (direct) return direct;
  const file = env[`${name}_FILE`]?.trim();
  if (!file) return undefined;
  try {
    const v = readFileSync(file, "utf-8").trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

export function basicAuthHeader(c: DockerHubCredentials): string {
  return `Basic ${Buffer.from(`${c.user}:${c.token}`).toString("base64")}`;
}
