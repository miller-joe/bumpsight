import { describe, it, expect, vi } from "vitest";
import { enrichDigestBump } from "../src/advise/digest-enrichment.js";
import type { CompareResult, GithubCommit } from "../src/releases/github.js";

function makeCommits(n: number): GithubCommit[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: `${"a".repeat(7)}${i.toString().padStart(33, "0")}`,
    shortSha: `${"a".repeat(6)}${i}`.slice(0, 7),
    message: `commit subject ${i}\n\ncommit body ${i}`,
    authorName: "Test",
    authorEmail: "test@example.com",
    authoredAt: "2026-05-12T00:00:00Z",
    url: `https://github.com/o/r/commit/abc${i}`,
  }));
}

function fakeLabels(rev?: string, src?: string) {
  return async () => {
    const labels: Record<string, string> = {};
    if (rev) labels["org.opencontainers.image.revision"] = rev;
    if (src) labels["org.opencontainers.image.source"] = src;
    return { labels };
  };
}

describe("enrichDigestBump", () => {
  it("returns ok=true with commit-range header + LLM summary when everything resolves", async () => {
    const commits = makeCommits(3);
    const compare: CompareResult = {
      commits,
      totalCommits: 3,
      htmlUrl: "https://github.com/owner/repo/compare/aaa...bbb",
      truncated: false,
    };
    const chatFn = vi.fn().mockResolvedValue("- Added X\n- Fixed Y\n- Removed Z");

    const result = await enrichDigestBump({
      image: "ghcr.io/owner/app",
      prevDigest: "sha256:111",
      newDigest: "sha256:222",
      llmUrl: "http://llm/v1",
      fetchLabels: vi.fn(async (_ref: unknown, digest: string) => {
        if (digest === "sha256:111") {
          return {
            labels: {
              "org.opencontainers.image.revision": "abc1234",
              "org.opencontainers.image.source": "https://github.com/owner/repo",
            },
          };
        }
        return {
          labels: {
            "org.opencontainers.image.revision": "def5678",
            "org.opencontainers.image.source": "https://github.com/owner/repo",
          },
        };
      }) as never,
      fetchCompare: vi.fn(async () => compare) as never,
      chatFn: chatFn as never,
    });

    expect(result.ok).toBe(true);
    expect(result.prevRevision).toBe("abc1234");
    expect(result.newRevision).toBe("def5678");
    expect(result.repo).toBe("owner/repo");
    expect(result.compareUrl).toBe("https://github.com/owner/repo/compare/aaa...bbb");
    expect(result.summary).toContain("Digest range: abc1234…def5678");
    expect(result.summary).toContain("3 commits");
    expect(result.summary).toContain("Added X");
    expect(chatFn).toHaveBeenCalledOnce();
  });

  it("returns ok=false when revision labels are missing", async () => {
    const result = await enrichDigestBump({
      image: "nginx:latest",
      prevDigest: "sha256:111",
      newDigest: "sha256:222",
      llmUrl: "http://llm/v1",
      fetchLabels: fakeLabels(undefined, "https://github.com/o/r") as never,
      fetchCompare: vi.fn() as never,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/revision labels/);
  });

  it("returns ok=false for non-github source URLs", async () => {
    const result = await enrichDigestBump({
      image: "x:latest",
      prevDigest: "sha256:111",
      newDigest: "sha256:222",
      llmUrl: "http://llm/v1",
      fetchLabels: fakeLabels("abc", "https://gitlab.com/o/r") as never,
      fetchCompare: vi.fn() as never,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-github/);
    expect(result.prevRevision).toBe("abc");
  });

  it("falls back to commit-list rendering when LLM is unavailable", async () => {
    const commits = makeCommits(2);
    const compare: CompareResult = {
      commits,
      totalCommits: 2,
      htmlUrl: "https://github.com/o/r/compare/x...y",
      truncated: false,
    };
    const result = await enrichDigestBump({
      image: "ghcr.io/o/r",
      prevDigest: "sha256:111",
      newDigest: "sha256:222",
      // No llmUrl — caller didn't configure one.
      fetchLabels: fakeLabels("abc", "https://github.com/o/r") as never,
      fetchCompare: vi.fn(async () => compare) as never,
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Commit subjects:");
    expect(result.summary).toContain("commit subject 0");
    expect(result.summary).toContain("commit subject 1");
  });

  it("falls back to commit-list when LLM throws", async () => {
    const commits = makeCommits(1);
    const compare: CompareResult = {
      commits,
      totalCommits: 1,
      htmlUrl: "https://github.com/o/r/compare/x...y",
      truncated: false,
    };
    const result = await enrichDigestBump({
      image: "ghcr.io/o/r",
      prevDigest: "sha256:111",
      newDigest: "sha256:222",
      llmUrl: "http://llm/v1",
      fetchLabels: fakeLabels("abc", "https://github.com/o/r") as never,
      fetchCompare: vi.fn(async () => compare) as never,
      chatFn: vi.fn(async () => {
        throw new Error("llm down");
      }) as never,
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Commit subjects:");
  });

  it("returns ok=false when compare API throws", async () => {
    const result = await enrichDigestBump({
      image: "ghcr.io/o/r",
      prevDigest: "sha256:111",
      newDigest: "sha256:222",
      llmUrl: "http://llm/v1",
      fetchLabels: fakeLabels("abc", "https://github.com/o/r") as never,
      fetchCompare: vi.fn(async () => {
        throw new Error("404");
      }) as never,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/compare api/);
    expect(result.repo).toBe("o/r");
  });

  it("returns ok=false when digests are identical", async () => {
    const result = await enrichDigestBump({
      image: "x:latest",
      prevDigest: "sha256:same",
      newDigest: "sha256:same",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/identical/);
  });

  it("returns ok=false when either digest is empty", async () => {
    const result = await enrichDigestBump({
      image: "x:latest",
      prevDigest: "",
      newDigest: "sha256:222",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing digests/);
  });

  it("caps commits sent to LLM at 30 and notes truncation in the summary", async () => {
    const commits = makeCommits(45);
    const compare: CompareResult = {
      commits,
      totalCommits: 60, // GitHub says more existed
      htmlUrl: "https://github.com/o/r/compare/x...y",
      truncated: true,
    };
    const chatFn = vi.fn(async (messages: unknown) => {
      // Verify we capped at 30 commits before talking to the LLM.
      const msgs = messages as Array<{ content: string }>;
      const userMsg = msgs[msgs.length - 1]!.content;
      const lineCount = (userMsg.match(/^- /gm) ?? []).length;
      expect(lineCount).toBe(30);
      return "summary";
    });
    const result = await enrichDigestBump({
      image: "ghcr.io/o/r",
      prevDigest: "sha256:111",
      newDigest: "sha256:222",
      llmUrl: "http://llm/v1",
      fetchLabels: fakeLabels("abc", "https://github.com/o/r") as never,
      fetchCompare: vi.fn(async () => compare) as never,
      chatFn: chatFn as never,
    });
    expect(result.ok).toBe(true);
    expect(result.commits?.length).toBe(30);
    expect(result.totalCommits).toBe(60);
    expect(result.summary).toContain("60 commits");
  });
});
