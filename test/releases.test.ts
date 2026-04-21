import { describe, it, expect } from "vitest";
import { releasesBetween, resolveUpstreamRepo } from "../src/releases/github.js";
import type { GithubRelease } from "../src/releases/github.js";
import { parseImageRef } from "../src/compose/parse.js";

function release(tag: string): GithubRelease {
  return {
    tagName: tag,
    name: null,
    publishedAt: null,
    body: null,
    prerelease: false,
    draft: false,
    url: `https://example.com/${tag}`,
  };
}

describe("releasesBetween", () => {
  it("returns the slice from newer-to-older between from and to", () => {
    // GitHub returns newest first.
    const releases = ["4.1.1", "4.1.0", "4.0.14", "4.0.13"].map(release);
    const out = releasesBetween(releases, "4.0.14", "4.1.1").map((r) => r.tagName);
    expect(out).toEqual(["4.1.1", "4.1.0"]);
  });

  it("matches v-prefix to bare tag names", () => {
    const releases = ["v4.1.1", "v4.1.0", "v4.0.14"].map(release);
    const out = releasesBetween(releases, "4.0.14", "4.1.1").map((r) => r.tagName);
    expect(out).toEqual(["v4.1.1", "v4.1.0"]);
  });

  it("returns all up to target if from is missing", () => {
    const releases = ["4.1.1", "4.1.0", "4.0.14"].map(release);
    const out = releasesBetween(releases, "3.9.0", "4.1.1").map((r) => r.tagName);
    expect(out).toEqual(["4.1.1", "4.1.0", "4.0.14"]);
  });

  it("returns everything if to is missing", () => {
    const releases = ["4.1.1", "4.1.0"].map(release);
    expect(releasesBetween(releases, "4.0.14", "99.0.0")).toEqual(releases);
  });
});

describe("resolveUpstreamRepo", () => {
  it("handles --repo override", async () => {
    const r = await resolveUpstreamRepo(parseImageRef("whatever:1"), "foo/bar");
    expect(r).toEqual({ owner: "foo", repo: "bar", source: "override" });
  });

  it("maps linuxserver/name to linuxserver/docker-name", async () => {
    const r = await resolveUpstreamRepo(parseImageRef("linuxserver/sonarr:4.0"));
    expect(r).toEqual({ owner: "linuxserver", repo: "docker-sonarr", source: "linuxserver" });
  });

  it("maps ghcr.io/owner/name to owner/name", async () => {
    const r = await resolveUpstreamRepo(parseImageRef("ghcr.io/owner/name:v1"));
    expect(r).toEqual({ owner: "owner", repo: "name", source: "ghcr" });
  });
});
