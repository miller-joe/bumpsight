import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findPairedDepBumps,
  formatPairedDepReport,
  type PairedDepLookupResult,
} from "../src/advise/paired-deps.js";
import type { RepoCoords } from "../src/releases/github.js";

const COORDS: RepoCoords = { owner: "goauthentik", repo: "authentik", source: "ghcr" };

describe("findPairedDepBumps", () => {
  let tmp: string;
  let composePath: string;
  const fetchMock = vi.fn();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bumpsight-paired-"));
    composePath = join(tmp, "compose.yaml");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function mockUpstreamCompose(content: string): void {
    fetchMock.mockImplementation(async (url: string) => {
      // First plausible compose path returns content.
      if (url.includes("docker-compose.yml") || url.includes("compose.yaml")) {
        return new Response(content, { status: 200 });
      }
      return new Response("", { status: 404 });
    });
  }

  it("flags a postgres major bump when upstream compose pins a newer version", async () => {
    writeFileSync(
      composePath,
      [
        "services:",
        "  server:",
        "    image: ghcr.io/goauthentik/server:2024.10.0",
        "  postgresql:",
        "    image: docker.io/library/postgres:16-alpine",
      ].join("\n"),
    );
    mockUpstreamCompose(
      [
        "services:",
        "  server:",
        "    image: ghcr.io/goauthentik/server:2025.4.0",
        "  postgresql:",
        "    image: docker.io/library/postgres:17-alpine",
      ].join("\n"),
    );

    const result = await findPairedDepBumps(COORDS, "2025.4.0", composePath);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]!).toMatchObject({
      upstreamService: "postgresql",
      upstreamImage: "docker.io/library/postgres:17-alpine",
      localImage: "docker.io/library/postgres:16-alpine",
      kind: "bump",
    });
    expect(result.sourceUrl).toContain("raw.githubusercontent.com");
  });

  it("does not report the upstream project's own app as a paired dep", async () => {
    // Vault's own compose: the `vault` service IS the app, even though
    // hashicorp/vault is in KNOWN_DEPENDENCY_IMAGES for sidecar use elsewhere.
    const vaultCoords: RepoCoords = { owner: "hashicorp", repo: "vault", source: "dockerhub" };
    writeFileSync(
      composePath,
      [
        "services:",
        "  vault:",
        "    image: hashicorp/vault:2.0.0",
        "  cache:",
        "    image: redis:7",
      ].join("\n"),
    );
    mockUpstreamCompose(
      [
        "services:",
        "  vault:",
        "    image: hashicorp/vault:2.1.0",
        "  cache:",
        "    image: redis:8",
      ].join("\n"),
    );

    const result = await findPairedDepBumps(vaultCoords, "2.1.0", composePath);
    // redis is a genuine paired dep; the vault service itself is not.
    expect(result.recommendations.map((r) => r.upstreamService)).toEqual(["cache"]);
  });

  it("flags an image-change when redis becomes valkey", async () => {
    writeFileSync(
      composePath,
      [
        "services:",
        "  server:",
        "    image: ghcr.io/goauthentik/server:2024.10.0",
        "  cache:",
        "    image: redis:7",
      ].join("\n"),
    );
    mockUpstreamCompose(
      [
        "services:",
        "  server:",
        "    image: ghcr.io/goauthentik/server:2025.4.0",
        "  cache:",
        "    image: valkey/valkey:8",
      ].join("\n"),
    );

    const result = await findPairedDepBumps(COORDS, "2025.4.0", composePath);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]!.kind).toBe("image-change");
    expect(result.recommendations[0]!.localImage).toBe("redis:7");
    expect(result.recommendations[0]!.upstreamImage).toBe("valkey/valkey:8");
  });

  it("flags a NEW dep (add) when upstream compose introduces one", async () => {
    writeFileSync(
      composePath,
      [
        "services:",
        "  server:",
        "    image: ghcr.io/goauthentik/server:2024.10.0",
      ].join("\n"),
    );
    mockUpstreamCompose(
      [
        "services:",
        "  server:",
        "    image: ghcr.io/goauthentik/server:2025.4.0",
        "  redis:",
        "    image: redis:7-alpine",
      ].join("\n"),
    );

    const result = await findPairedDepBumps(COORDS, "2025.4.0", composePath);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]!).toMatchObject({
      upstreamService: "redis",
      kind: "add",
      localImage: null,
    });
  });

  it("returns empty when local and upstream pin the same dep version", async () => {
    writeFileSync(
      composePath,
      [
        "services:",
        "  server:",
        "    image: ghcr.io/goauthentik/server:2024.10.0",
        "  postgresql:",
        "    image: postgres:17-alpine",
      ].join("\n"),
    );
    mockUpstreamCompose(
      [
        "services:",
        "  server:",
        "    image: ghcr.io/goauthentik/server:2025.4.0",
        "  postgresql:",
        "    image: postgres:17-alpine",
      ].join("\n"),
    );

    const result = await findPairedDepBumps(COORDS, "2025.4.0", composePath);
    expect(result.recommendations).toEqual([]);
  });

  it("ignores non-dependency images in upstream compose", async () => {
    writeFileSync(
      composePath,
      [
        "services:",
        "  server:",
        "    image: ghcr.io/goauthentik/server:2024.10.0",
      ].join("\n"),
    );
    mockUpstreamCompose(
      [
        "services:",
        "  server:",
        "    image: ghcr.io/goauthentik/server:2025.4.0",
        "  worker:",
        "    image: ghcr.io/goauthentik/server:2025.4.0",
      ].join("\n"),
    );

    const result = await findPairedDepBumps(COORDS, "2025.4.0", composePath);
    expect(result.recommendations).toEqual([]);
  });

  it("returns empty when upstream compose can't be fetched", async () => {
    writeFileSync(composePath, "services:\n  server:\n    image: x:1\n");
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));

    const result = await findPairedDepBumps(COORDS, "2025.4.0", composePath);
    expect(result.recommendations).toEqual([]);
    expect(result.sourceUrl).toBeUndefined();
  });

  it("matches local service by image-family when names differ", async () => {
    writeFileSync(
      composePath,
      [
        "services:",
        "  server:",
        "    image: ghcr.io/goauthentik/server:2024.10.0",
        "  db:", // operator renamed `postgresql` → `db`
        "    image: postgres:16",
      ].join("\n"),
    );
    mockUpstreamCompose(
      [
        "services:",
        "  server:",
        "    image: ghcr.io/goauthentik/server:2025.4.0",
        "  postgresql:",
        "    image: postgres:17",
      ].join("\n"),
    );

    const result = await findPairedDepBumps(COORDS, "2025.4.0", composePath);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]!.localService).toBe("db");
    expect(result.recommendations[0]!.kind).toBe("bump");
  });
});

describe("formatPairedDepReport", () => {
  it("returns empty string when nothing to report", () => {
    const empty: PairedDepLookupResult = { recommendations: [] };
    expect(formatPairedDepReport(empty)).toBe("");
  });

  it("renders a bump line", () => {
    const result: PairedDepLookupResult = {
      sourceUrl: "https://raw.githubusercontent.com/x/y/v1/compose.yaml",
      recommendations: [
        {
          upstreamService: "postgresql",
          upstreamImage: "postgres:17",
          localImage: "postgres:16",
          localService: "db",
          kind: "bump",
        },
      ],
    };
    const out = formatPairedDepReport(result);
    expect(out).toContain("Paired dependency recommendations");
    expect(out).toContain("db: postgres:16 → postgres:17");
    expect(out).toContain("raw.githubusercontent.com");
  });

  it("renders an add line", () => {
    const result: PairedDepLookupResult = {
      recommendations: [
        {
          upstreamService: "redis",
          upstreamImage: "redis:7-alpine",
          localImage: null,
          localService: null,
          kind: "add",
        },
      ],
    };
    const out = formatPairedDepReport(result);
    expect(out).toContain("redis: new dependency");
  });
});
