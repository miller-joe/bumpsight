import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseImageRef } from "../src/compose/parse.js";
import { listTags, fetchManifestDigest } from "../src/registry/index.js";
import {
  dockerHubCredentials,
  fetchWithRetry,
  parseAuthChallenge,
  retryDelayMs,
  setRegistrySleep,
} from "../src/registry/http.js";
import { parseNextLink } from "../src/registry/v2.js";
import { _resetDockerHubAuth } from "../src/registry/dockerhub.js";
import { findLatestInFamily } from "../src/util/semver.js";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function routeFetch(handler: Handler) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => handler(String(input), init ?? {}));
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function header(init: RequestInit, name: string): string | undefined {
  const h = init.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
}

const sleeps: number[] = [];
let restoreSleep: ((ms: number) => Promise<void>) | undefined;

beforeEach(() => {
  sleeps.length = 0;
  restoreSleep = setRegistrySleep(async (ms) => void sleeps.push(ms));
  _resetDockerHubAuth();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (restoreSleep) setRegistrySleep(restoreSleep);
  delete process.env.BUMPSIGHT_DOCKERHUB_USER;
  delete process.env.BUMPSIGHT_DOCKERHUB_TOKEN;
  delete process.env.BUMPSIGHT_DOCKERHUB_TOKEN_FILE;
});

describe("parseAuthChallenge", () => {
  it("parses a bearer challenge with quoted params", () => {
    expect(
      parseAuthChallenge(
        'Bearer realm="https://registry.example.com/v2/token",service="container_registry",scope="repository:org/app:pull"',
      ),
    ).toEqual({
      scheme: "bearer",
      params: {
        realm: "https://registry.example.com/v2/token",
        service: "container_registry",
        scope: "repository:org/app:pull",
      },
    });
  });

  it("returns undefined for a missing header", () => {
    expect(parseAuthChallenge(null)).toBeUndefined();
  });
});

describe("parseNextLink", () => {
  it("extracts the next page from a Link header", () => {
    expect(
      parseNextLink('</v2/org/app/tags/list?last=1.2.3&n=1000>; rel="next"'),
    ).toBe("/v2/org/app/tags/list?last=1.2.3&n=1000");
    expect(parseNextLink(null)).toBeNull();
  });
});

describe("generic v2 registry client", () => {
  it("follows the bearer challenge, paginates tags, and keeps suffix families", async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    routeFetch((url, init) => {
      seen.push({ url, auth: header(init, "authorization") });
      if (url === "https://registry.example.com/v2/") {
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://registry.example.com/v2/token",service="container_registry"',
          },
        });
      }
      if (url.startsWith("https://registry.example.com/v2/token")) {
        return json({ token: "anon-token" });
      }
      if (url === "https://registry.example.com/v2/org/app/tags/list?n=1000") {
        return json(
          { tags: ["1.25.5", "1.25.5-rootless"] },
          { headers: { link: '</v2/org/app/tags/list?last=1.25.5-rootless&n=1000>; rel="next"' } },
        );
      }
      if (url === "https://registry.example.com/v2/org/app/tags/list?last=1.25.5-rootless&n=1000") {
        return json({ tags: ["1.27.3", "1.27.3-rootless", "latest"] });
      }
      return new Response("unexpected", { status: 500 });
    });

    const tags = await listTags(parseImageRef("registry.example.com/org/app:1.25.5-rootless"));
    const names = tags.map((t) => t.name);
    expect(names).toEqual(["1.25.5", "1.25.5-rootless", "1.27.3", "1.27.3-rootless", "latest"]);
    expect(findLatestInFamily("1.25.5-rootless", names)).toBe("1.27.3-rootless");

    const tokenCall = seen.find((s) => s.url.includes("/v2/token"))!;
    expect(tokenCall.url).toContain("service=container_registry");
    expect(tokenCall.url).toContain("scope=repository%3Aorg%2Fapp%3Apull");
    const listCalls = seen.filter((s) => s.url.includes("tags/list"));
    expect(listCalls).toHaveLength(2);
    expect(listCalls.every((c) => c.auth === "Bearer anon-token")).toBe(true);
  });

  it("reads a manifest digest from a registry that needs no token", async () => {
    routeFetch((url, init) => {
      if (url === "https://images.example.net/v2/") return new Response("", { status: 200 });
      if (url === "https://images.example.net/v2/tools/cli/manifests/latest") {
        expect(init.method).toBe("HEAD");
        expect(header(init, "authorization")).toBeUndefined();
        return new Response(null, {
          status: 200,
          headers: { "docker-content-digest": "sha256:feed" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    expect(
      await fetchManifestDigest(parseImageRef("images.example.net/tools/cli:latest"), "latest"),
    ).toBe("sha256:feed");
  });
});

describe("rate-limit handling", () => {
  it("retries a 429 and honors Retry-After", async () => {
    let calls = 0;
    routeFetch(() => {
      calls += 1;
      return calls === 1
        ? new Response("slow down", { status: 429, headers: { "retry-after": "7" } })
        : json({ ok: true });
    });
    const res = await fetchWithRetry("https://api.example.com/x");
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([7000]);
  });

  it("caps the wait and falls back to exponential back-off", () => {
    const capped = new Response("", { status: 429, headers: { "retry-after": "86400" } });
    expect(retryDelayMs(capped, 0)).toBe(60_000);
    const bare = new Response("", { status: 429 });
    expect(retryDelayMs(bare, 0)).toBe(2000);
    expect(retryDelayMs(bare, 2)).toBe(8000);
  });

  it("falls back to the registry tag list when the Hub API stays rate-limited", async () => {
    routeFetch((url) => {
      if (url.startsWith("https://hub.docker.com/")) {
        return new Response("rate limited", { status: 429 });
      }
      if (url.startsWith("https://auth.docker.io/token")) return json({ token: "t" });
      if (url === "https://registry-1.docker.io/v2/library/redis/tags/list?n=1000") {
        return json({ tags: ["7.2.4", "7.2.5"] });
      }
      return new Response("unexpected", { status: 500 });
    });
    const tags = await listTags(parseImageRef("redis:7.2.4"));
    expect(tags.map((t) => t.name)).toEqual(["7.2.4", "7.2.5"]);
    // first attempt + 3 retries against the Hub API before falling back
    expect(sleeps).toHaveLength(3);
  });
});

describe("Docker Hub credentials", () => {
  it("is anonymous unless both halves are set", () => {
    expect(dockerHubCredentials({ BUMPSIGHT_DOCKERHUB_USER: "someone" })).toBeUndefined();
    expect(
      dockerHubCredentials({
        BUMPSIGHT_DOCKERHUB_USER: "someone",
        BUMPSIGHT_DOCKERHUB_TOKEN: "example-access-token",
      }),
    ).toEqual({ user: "someone", token: "example-access-token" });
  });

  it("reads the token from a _FILE path", () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-cred-"));
    const f = join(dir, "token");
    writeFileSync(f, "token-from-file\n");
    expect(
      dockerHubCredentials({
        BUMPSIGHT_DOCKERHUB_USER: "someone",
        BUMPSIGHT_DOCKERHUB_TOKEN_FILE: f,
      }),
    ).toEqual({ user: "someone", token: "token-from-file" });
  });

  it("authenticates the Hub API and registry token requests when configured", async () => {
    process.env.BUMPSIGHT_DOCKERHUB_USER = "someone";
    process.env.BUMPSIGHT_DOCKERHUB_TOKEN = "example-access-token";
    const seen: Array<{ url: string; auth?: string }> = [];
    routeFetch((url, init) => {
      seen.push({ url, auth: header(init, "authorization") });
      if (url === "https://hub.docker.com/v2/auth/token") return json({ access_token: "jwt" });
      if (url.startsWith("https://hub.docker.com/v2/repositories/")) {
        return json({ count: 1, next: null, results: [{ name: "1.0.1", last_updated: null }] });
      }
      if (url.startsWith("https://auth.docker.io/token")) return json({ token: "pull" });
      if (url.includes("/manifests/")) {
        return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:ab" } });
      }
      return new Response("unexpected", { status: 500 });
    });

    await listTags(parseImageRef("someorg/app:1.0.0"));
    expect(seen.find((s) => s.url.includes("/repositories/"))!.auth).toBe("Bearer jwt");

    await fetchManifestDigest(parseImageRef("someorg/app:1.0.0"), "1.0.1");
    const tokenReq = seen.find((s) => s.url.startsWith("https://auth.docker.io/token"))!;
    expect(tokenReq.auth).toBe(
      `Basic ${Buffer.from("someone:example-access-token").toString("base64")}`,
    );
  });
});
