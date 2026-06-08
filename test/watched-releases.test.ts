import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb, getWatchedReleaseState } from "../src/state/db.js";
import { buildWatchedReleases } from "../src/daemon/config.js";
import type { WatchedReleaseSpec } from "../src/daemon/config.js";
import {
  runWatchedReleasesOnce,
  buildWatchedMessage,
} from "../src/daemon/watched-releases.js";
import type { GithubRelease } from "../src/releases/github.js";
import type { Notifier, NotifyMessage } from "../src/notify/types.js";

function release(tag: string, opts: Partial<GithubRelease> = {}): GithubRelease {
  return {
    tagName: tag,
    name: opts.name ?? null,
    publishedAt: opts.publishedAt ?? null,
    body: opts.body ?? null,
    prerelease: opts.prerelease ?? false,
    draft: opts.draft ?? false,
    url: opts.url ?? `https://github.com/x/y/releases/tag/${tag}`,
  };
}

function spec(overrides: Partial<WatchedReleaseSpec> = {}): WatchedReleaseSpec {
  return {
    repo: "git-lfs/git-lfs",
    owner: "git-lfs",
    repoName: "git-lfs",
    name: "git-lfs",
    current: "3.6.1",
    policy: "notify",
    includePrerelease: false,
    ...overrides,
  };
}

function collector(): { sent: NotifyMessage[]; notifier: Notifier } {
  const sent: NotifyMessage[] = [];
  return {
    sent,
    notifier: { name: "test", send: async (m) => void sent.push(m) },
  };
}

// fetchReleases seam: returns a fixed list, ignores coords/opts.
const fakeFetch = (releases: GithubRelease[]) =>
  (async () => releases) as never;

describe("buildWatchedReleases", () => {
  it("returns [] when unset or not a list", () => {
    expect(buildWatchedReleases({})).toEqual([]);
    expect(
      buildWatchedReleases({ watched_releases: "nope" as never }),
    ).toEqual([]);
  });

  it("resolves a full entry and applies defaults", () => {
    const out = buildWatchedReleases({
      watched_releases: [{ repo: "git-lfs/git-lfs", current: "3.6.1" }],
    });
    expect(out).toEqual([
      {
        repo: "git-lfs/git-lfs",
        owner: "git-lfs",
        repoName: "git-lfs",
        name: "git-lfs",
        current: "3.6.1",
        policy: "notify",
        includePrerelease: false,
      },
    ]);
  });

  it("honors name, policy, include_prerelease and coerces numeric current", () => {
    const out = buildWatchedReleases({
      watched_releases: [
        {
          repo: "hashicorp/terraform",
          current: 1.9 as never,
          name: "Terraform",
          policy: "none",
          include_prerelease: true,
        },
      ],
    });
    expect(out[0]).toMatchObject({
      name: "Terraform",
      current: "1.9",
      policy: "none",
      includePrerelease: true,
    });
  });

  it("warns + skips malformed entries, never throws", () => {
    const warnings: string[] = [];
    const out = buildWatchedReleases(
      {
        watched_releases: [
          { current: "1.0" }, // no repo
          { repo: "noslash", current: "1.0" }, // bad repo
          { repo: "a/b" }, // no current
          { repo: "c/d", current: "1.0", policy: "bogus" }, // bad policy
          { repo: "e/f", current: "1.0" }, // valid
        ],
      },
      (m) => warnings.push(m),
    );
    expect(out.map((s) => s.repo)).toEqual(["e/f"]);
    expect(warnings.length).toBe(4);
  });

  it("collapses duplicate repos to the first", () => {
    const out = buildWatchedReleases({
      watched_releases: [
        { repo: "a/b", current: "1.0" },
        { repo: "a/b", current: "2.0" },
      ],
    });
    expect(out.length).toBe(1);
    expect(out[0]!.current).toBe("1.0");
  });
});

describe("runWatchedReleasesOnce", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb({ path: ":memory:" });
  });

  it("notifies once when a newer release exists, then dedups", async () => {
    const { sent, notifier } = collector();
    const releases = [release("v3.7.0"), release("v3.6.1"), release("v3.6.0")];

    const r1 = await runWatchedReleasesOnce({
      db,
      specs: [spec()],
      notifiers: [notifier],
      fetchReleasesFn: fakeFetch(releases),
    });
    expect(r1).toMatchObject({ checked: 1, behind: 1, notified: 1 });
    expect(sent.length).toBe(1);
    expect(sent[0]!.subject).toContain("3.6.1 → v3.7.0");

    const state = getWatchedReleaseState(db, "git-lfs/git-lfs");
    expect(state?.notified_tag).toBe("v3.7.0");
    expect(state?.current).toBe("3.6.1");

    // Second pass: same latest → no new email.
    const r2 = await runWatchedReleasesOnce({
      db,
      specs: [spec()],
      notifiers: [notifier],
      fetchReleasesFn: fakeFetch(releases),
    });
    expect(r2).toMatchObject({ behind: 1, notified: 0 });
    expect(sent.length).toBe(1);
  });

  it("re-notifies when a newer release than the last appears", async () => {
    const { sent, notifier } = collector();
    await runWatchedReleasesOnce({
      db,
      specs: [spec()],
      notifiers: [notifier],
      fetchReleasesFn: fakeFetch([release("v3.7.0")]),
    });
    const r2 = await runWatchedReleasesOnce({
      db,
      specs: [spec()],
      notifiers: [notifier],
      fetchReleasesFn: fakeFetch([release("v3.8.0"), release("v3.7.0")]),
    });
    expect(r2).toMatchObject({ notified: 1 });
    expect(sent.length).toBe(2);
    expect(sent[1]!.subject).toContain("v3.8.0");
  });

  it("is silent when already up to date", async () => {
    const { sent, notifier } = collector();
    const r = await runWatchedReleasesOnce({
      db,
      specs: [spec({ current: "3.7.0" })],
      notifiers: [notifier],
      fetchReleasesFn: fakeFetch([release("v3.7.0"), release("v3.6.1")]),
    });
    expect(r).toMatchObject({ checked: 1, behind: 0, notified: 0 });
    expect(sent.length).toBe(0);
  });

  it("skips policy: none entirely (not even checked)", async () => {
    const { sent, notifier } = collector();
    const r = await runWatchedReleasesOnce({
      db,
      specs: [spec({ policy: "none" })],
      notifiers: [notifier],
      fetchReleasesFn: fakeFetch([release("v9.9.9")]),
    });
    expect(r).toMatchObject({ checked: 0, behind: 0, notified: 0 });
    expect(sent.length).toBe(0);
  });

  it("ignores pre-releases by default, honors include_prerelease", async () => {
    const { sent, notifier } = collector();
    const releases = [release("v4.0.0", { prerelease: true }), release("v3.6.1")];

    const noPre = await runWatchedReleasesOnce({
      db,
      specs: [spec()],
      notifiers: [notifier],
      fetchReleasesFn: fakeFetch(releases),
    });
    expect(noPre).toMatchObject({ behind: 0, notified: 0 });

    const db2 = openDb({ path: ":memory:" });
    const withPre = await runWatchedReleasesOnce({
      db: db2,
      specs: [spec({ includePrerelease: true })],
      notifiers: [notifier],
      fetchReleasesFn: fakeFetch(releases),
    });
    expect(withPre).toMatchObject({ behind: 1, notified: 1 });
    expect(sent[0]!.subject).toContain("v4.0.0");
  });

  it("ignores drafts always", async () => {
    const { notifier } = collector();
    const r = await runWatchedReleasesOnce({
      db,
      specs: [spec()],
      notifiers: [notifier],
      fetchReleasesFn: fakeFetch([
        release("v5.0.0", { draft: true }),
        release("v3.6.1"),
      ]),
    });
    expect(r).toMatchObject({ behind: 0, notified: 0 });
  });

  it("records fetch errors per repo without aborting others", async () => {
    const { notifier } = collector();
    const r = await runWatchedReleasesOnce({
      db,
      specs: [spec()],
      notifiers: [notifier],
      fetchReleasesFn: (async () => {
        throw new Error("rate limited");
      }) as never,
    });
    expect(r.errors["git-lfs/git-lfs"]).toContain("rate limited");
    expect(r.notified).toBe(0);
  });

  it("marks notified even with no notifiers (no-op delivery)", async () => {
    const r = await runWatchedReleasesOnce({
      db,
      specs: [spec()],
      notifiers: [],
      fetchReleasesFn: fakeFetch([release("v3.7.0")]),
    });
    expect(r.notified).toBe(1);
    expect(getWatchedReleaseState(db, "git-lfs/git-lfs")?.notified_tag).toBe(
      "v3.7.0",
    );
  });

  it("does NOT mark notified when delivery fails (will retry)", async () => {
    const failing: Notifier = {
      name: "boom",
      send: async () => {
        throw new Error("smtp down");
      },
    };
    const r = await runWatchedReleasesOnce({
      db,
      specs: [spec()],
      notifiers: [failing],
      fetchReleasesFn: fakeFetch([release("v3.7.0")]),
    });
    expect(r.notified).toBe(0);
    expect(getWatchedReleaseState(db, "git-lfs/git-lfs")?.notified_tag).toBe(
      null,
    );
  });

  it("persists advise text when an LLM is configured", async () => {
    const { notifier } = collector();
    await runWatchedReleasesOnce({
      db,
      specs: [spec()],
      notifiers: [notifier],
      llmUrl: "http://llm/v1",
      fetchReleasesFn: fakeFetch([release("v3.7.0")]),
      adviseFn: (async () => ({
        ok: true,
        summary: "pure-SSH transfer fixes.",
        repo: "git-lfs/git-lfs",
        releaseCount: 1,
        source: "release-notes",
      })) as never,
    });
    expect(getWatchedReleaseState(db, "git-lfs/git-lfs")?.advise_text).toBe(
      "pure-SSH transfer fixes.",
    );
  });
});

describe("buildWatchedMessage", () => {
  it("renders a notify-only email (no approve/deny, manual-action note)", () => {
    const msg = buildWatchedMessage({
      spec: spec(),
      latestTag: "v3.7.0",
      bump: "minor",
      releaseUrl: "https://github.com/git-lfs/git-lfs/releases/tag/v3.7.0",
      advise: null,
    });
    expect(msg.subject).toBe("git-lfs: 3.6.1 → v3.7.0 (GitHub release)");
    expect(msg.body).toContain("watched non-Docker upstream");
    expect(msg.body).toContain("does NOT apply");
    expect(msg.body).toContain("github.com/git-lfs/git-lfs");
    expect(msg.htmlBody).toContain("watched release");
    // No approval machinery for notify-only watches.
    expect(msg.body.toLowerCase()).not.toContain("approve");
  });
});
