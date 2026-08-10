import { describe, it, expect, vi, afterEach } from "vitest";
import { parseImageRef } from "../src/compose/parse.js";
import {
  isDockerHubMirror,
  isDockerHubRegistry,
  toDockerHubRef,
} from "../src/registry/mirrors.js";
import { isSupportedRegistry, listTags } from "../src/registry/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isDockerHubRegistry", () => {
  it("treats a bare ref as Docker Hub", () => {
    expect(isDockerHubRegistry(undefined)).toBe(true);
  });

  it("accepts docker.io and index.docker.io", () => {
    expect(isDockerHubRegistry("docker.io")).toBe(true);
    expect(isDockerHubRegistry("index.docker.io")).toBe(true);
  });

  it("accepts lscr.io as a Docker Hub mirror", () => {
    expect(isDockerHubRegistry("lscr.io")).toBe(true);
  });

  it("rejects registries with their own client or none at all", () => {
    expect(isDockerHubRegistry("ghcr.io")).toBe(false);
    expect(isDockerHubRegistry("quay.io")).toBe(false);
    expect(isDockerHubRegistry("localhost:5000")).toBe(false);
  });
});

describe("isDockerHubMirror", () => {
  it("is true only for aliases, not docker.io itself", () => {
    expect(isDockerHubMirror("lscr.io")).toBe(true);
    expect(isDockerHubMirror("docker.io")).toBe(false);
    expect(isDockerHubMirror(undefined)).toBe(false);
  });
});

describe("toDockerHubRef", () => {
  it("rewrites the registry but preserves raw, namespace, name and tag", () => {
    const ref = parseImageRef("lscr.io/linuxserver/qbittorrent:5.2.3_v2.0.13-ls470");
    const hub = toDockerHubRef(ref);
    expect(hub.registry).toBe("docker.io");
    expect(hub.namespace).toBe("linuxserver");
    expect(hub.name).toBe("qbittorrent");
    expect(hub.tag).toBe("5.2.3_v2.0.13-ls470");
    // raw stays intact: it keys state rows and drives the compose rewrite,
    // which must keep `lscr.io/...` in the file.
    expect(hub.raw).toBe("lscr.io/linuxserver/qbittorrent:5.2.3_v2.0.13-ls470");
  });

  it("leaves non-mirror refs untouched", () => {
    const ref = parseImageRef("ghcr.io/immich-app/server:release");
    expect(toDockerHubRef(ref)).toBe(ref);
  });
});

describe("isSupportedRegistry", () => {
  it("covers lscr.io — the regression that hid every LinuxServer image", () => {
    expect(isSupportedRegistry(parseImageRef("lscr.io/linuxserver/sonarr:4.0.17"))).toBe(true);
    expect(isSupportedRegistry(parseImageRef("lscr.io/linuxserver/plex:1.43.1"))).toBe(true);
  });

  it("still covers the registries that already worked", () => {
    expect(isSupportedRegistry(parseImageRef("nginx:1.27"))).toBe(true);
    expect(isSupportedRegistry(parseImageRef("docker.io/library/nginx:1.27"))).toBe(true);
    expect(isSupportedRegistry(parseImageRef("ghcr.io/immich-app/server:release"))).toBe(true);
  });

  it("still rejects registries with no client", () => {
    expect(isSupportedRegistry(parseImageRef("quay.io/prometheus/node-exporter:v1"))).toBe(false);
  });
});

describe("listTags for a mirrored registry", () => {
  it("queries the Docker Hub repo, not the mirror host", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          count: 1,
          next: null,
          results: [{ name: "5.2.3_v2.0.13-ls470", last_updated: "2026-08-09T07:52:16Z" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ) as unknown as Response,
    );

    const tags = await listTags(parseImageRef("lscr.io/linuxserver/qbittorrent:5.1.4-r3-ls452"));

    expect(tags.map((t) => t.name)).toEqual(["5.2.3_v2.0.13-ls470"]);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("hub.docker.com/v2/repositories/linuxserver/qbittorrent/tags/");
    expect(url).not.toContain("lscr.io");
  });

  it("throws for a registry that genuinely has no client", async () => {
    await expect(
      listTags(parseImageRef("quay.io/prometheus/node-exporter:v1")),
    ).rejects.toThrow(/registry not supported yet: quay\.io/);
  });
});
