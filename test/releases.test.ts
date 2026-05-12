import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchCommitsBetween,
  releasesBetween,
  resolveUpstreamRepo,
} from "../src/releases/github.js";
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

describe("fetchCommitsBetween", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes the compare response into GithubCommit[]", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          total_commits: 2,
          html_url: "https://github.com/o/r/compare/aaa...bbb",
          commits: [
            {
              sha: "aaaaaaa1111111111111111111111111111aaaa",
              html_url: "https://github.com/o/r/commit/aaa",
              commit: {
                message: "feat: add thing\n\nbody",
                author: { name: "Alice", email: "a@x", date: "2026-05-01T00:00:00Z" },
              },
            },
            {
              sha: "bbbbbbb2222222222222222222222222222bbbb",
              html_url: "https://github.com/o/r/commit/bbb",
              commit: { message: "fix: oops", author: null },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await fetchCommitsBetween(
      { owner: "o", repo: "r", source: "override" },
      "aaa",
      "bbb",
    );
    expect(result.totalCommits).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.commits).toHaveLength(2);
    expect(result.commits[0]!.shortSha).toBe("aaaaaaa");
    expect(result.commits[0]!.authorName).toBe("Alice");
    expect(result.commits[1]!.authorName).toBeNull();
  });

  it("flags truncated=true when total_commits exceeds the returned array", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          total_commits: 500,
          html_url: "https://github.com/o/r/compare/x...y",
          commits: [
            {
              sha: "a".repeat(40),
              html_url: "",
              commit: { message: "x", author: null },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await fetchCommitsBetween(
      { owner: "o", repo: "r", source: "override" },
      "x",
      "y",
    );
    expect(result.totalCommits).toBe(500);
    expect(result.commits).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("returns empty when base === head without calling the API", async () => {
    const result = await fetchCommitsBetween(
      { owner: "o", repo: "r", source: "override" },
      "same",
      "same",
    );
    expect(result.commits).toEqual([]);
    expect(result.totalCommits).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on non-2xx responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    await expect(
      fetchCommitsBetween({ owner: "o", repo: "r", source: "override" }, "a", "b"),
    ).rejects.toThrow(/404/);
  });
});
