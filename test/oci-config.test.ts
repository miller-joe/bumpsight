import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseImageRef } from "../src/compose/parse.js";
import {
  extractRevision,
  extractSourceUrl,
  fetchOciLabels,
  parseGithubUrl,
} from "../src/registry/oci-config.js";

describe("parseGithubUrl", () => {
  it("parses standard github URLs", () => {
    expect(parseGithubUrl("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("strips .git suffix", () => {
    expect(parseGithubUrl("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("tolerates git+ scheme prefix", () => {
    expect(parseGithubUrl("git+https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("returns null for non-github hosts", () => {
    expect(parseGithubUrl("https://gitlab.com/owner/repo")).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(parseGithubUrl("not a url")).toBeNull();
    expect(parseGithubUrl("")).toBeNull();
  });

  it("handles www.github.com", () => {
    expect(parseGithubUrl("https://www.github.com/o/r")).toEqual({ owner: "o", repo: "r" });
  });

  it("ignores paths past the repo segment", () => {
    expect(parseGithubUrl("https://github.com/owner/repo/tree/main")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });
});

describe("extractRevision / extractSourceUrl", () => {
  it("extracts canonical OCI labels", () => {
    const labels = {
      "org.opencontainers.image.revision": "abc123def456",
      "org.opencontainers.image.source": "https://github.com/owner/repo",
    };
    expect(extractRevision(labels)).toBe("abc123def456");
    expect(extractSourceUrl(labels)).toBe("https://github.com/owner/repo");
  });

  it("falls back to label-schema legacy labels", () => {
    const labels = {
      "org.label-schema.vcs-ref": "deadbeef",
      "org.label-schema.vcs-url": "https://github.com/foo/bar",
    };
    expect(extractRevision(labels)).toBe("deadbeef");
    expect(extractSourceUrl(labels)).toBe("https://github.com/foo/bar");
  });

  it("prefers canonical over legacy when both present", () => {
    const labels = {
      "org.opencontainers.image.revision": "new",
      "org.label-schema.vcs-ref": "old",
    };
    expect(extractRevision(labels)).toBe("new");
  });

  it("returns undefined when no label is present", () => {
    expect(extractRevision({})).toBeUndefined();
    expect(extractSourceUrl({})).toBeUndefined();
  });

  it("treats empty-string labels as missing", () => {
    expect(extractRevision({ "org.opencontainers.image.revision": "" })).toBeUndefined();
    expect(extractSourceUrl({ "org.opencontainers.image.source": "" })).toBeUndefined();
  });
});

describe("fetchOciLabels", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown, contentType: string): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": contentType },
    });
  }

  it("walks docker hub manifest list → arch manifest → config blob and returns labels", async () => {
    const ref = parseImageRef("nginx:latest");
    fetchMock
      // token
      .mockResolvedValueOnce(jsonResponse({ token: "tok" }, "application/json"))
      // manifest list at digest
      .mockResolvedValueOnce(
        jsonResponse(
          {
            manifests: [
              {
                digest: "sha256:archdigest",
                mediaType: "application/vnd.oci.image.manifest.v1+json",
                platform: { os: "linux", architecture: "amd64" },
              },
            ],
          },
          "application/vnd.oci.image.index.v1+json",
        ),
      )
      // single-arch manifest
      .mockResolvedValueOnce(
        jsonResponse(
          { config: { digest: "sha256:cfg" } },
          "application/vnd.oci.image.manifest.v1+json",
        ),
      )
      // config blob
      .mockResolvedValueOnce(
        jsonResponse(
          {
            config: {
              Labels: {
                "org.opencontainers.image.revision": "abc123",
                "org.opencontainers.image.source": "https://github.com/owner/repo",
              },
            },
          },
          "application/vnd.oci.image.config.v1+json",
        ),
      );

    const result = await fetchOciLabels(ref, "sha256:topdigest");
    expect(result.labels["org.opencontainers.image.revision"]).toBe("abc123");
    expect(result.labels["org.opencontainers.image.source"]).toBe(
      "https://github.com/owner/repo",
    );
  });

  it("handles single-arch manifest (no index)", async () => {
    const ref = parseImageRef("ghcr.io/owner/app:v1");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: "tok" }, "application/json"))
      .mockResolvedValueOnce(
        jsonResponse(
          { config: { digest: "sha256:cfg" } },
          "application/vnd.docker.distribution.manifest.v2+json",
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { config: { Labels: { "org.opencontainers.image.revision": "xyz" } } },
          "application/vnd.docker.container.image.v1+json",
        ),
      );
    const result = await fetchOciLabels(ref, "sha256:topdigest");
    expect(result.labels["org.opencontainers.image.revision"]).toBe("xyz");
  });

  it("skips attestation manifests when picking arch", async () => {
    const ref = parseImageRef("nginx:latest");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: "tok" }, "application/json"))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            manifests: [
              {
                digest: "sha256:attest",
                platform: { os: "unknown", architecture: "unknown" },
              },
              {
                digest: "sha256:archdigest",
                platform: { os: "linux", architecture: "amd64" },
              },
            ],
          },
          "application/vnd.oci.image.index.v1+json",
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { config: { digest: "sha256:cfg" } },
          "application/vnd.oci.image.manifest.v1+json",
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { config: { Labels: { "org.opencontainers.image.revision": "abc" } } },
          "application/vnd.oci.image.config.v1+json",
        ),
      );
    const result = await fetchOciLabels(ref, "sha256:top");
    expect(result.labels["org.opencontainers.image.revision"]).toBe("abc");
    // Confirm we requested the amd64 digest, not the attestation digest.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("archdigest"))).toBe(true);
    expect(urls.some((u) => u.includes("sha256:attest"))).toBe(false);
  });

  it("returns empty labels when token fetch fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    const result = await fetchOciLabels(parseImageRef("nginx:latest"), "sha256:abc");
    expect(result.labels).toEqual({});
  });

  it("returns empty labels when registry is unsupported", async () => {
    const ref = parseImageRef("quay.io/owner/app:v1");
    const result = await fetchOciLabels(ref, "sha256:abc");
    expect(result.labels).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty labels when digest is empty", async () => {
    const result = await fetchOciLabels(parseImageRef("nginx:latest"), "");
    expect(result.labels).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns empty labels when manifest 404s", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: "tok" }, "application/json"))
      .mockResolvedValueOnce(new Response("nope", { status: 404 }));
    const result = await fetchOciLabels(parseImageRef("nginx:latest"), "sha256:abc");
    expect(result.labels).toEqual({});
  });

  it("returns empty labels when config blob is missing labels", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ token: "tok" }, "application/json"))
      .mockResolvedValueOnce(
        jsonResponse(
          { config: { digest: "sha256:cfg" } },
          "application/vnd.oci.image.manifest.v1+json",
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ config: {} }, "application/vnd.oci.image.config.v1+json"),
      );
    const result = await fetchOciLabels(parseImageRef("nginx:latest"), "sha256:abc");
    expect(result.labels).toEqual({});
  });
});
