import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScanOnce, buildComposeFileMap } from "../src/daemon/index.js";
import { openDb, listByStatus } from "../src/state/db.js";
import type { Notifier, NotifyMessage } from "../src/notify/types.js";
import type { CommandRunner } from "../src/apply/docker.js";

function makeStack(name: string, image: string): { stack: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), `bumpsight-${name}-`));
  const file = join(dir, "compose.yaml");
  writeFileSync(
    file,
    `services:\n  ${name}:\n    image: ${image}\n    restart: unless-stopped\n`,
    "utf-8",
  );
  // The stack name the daemon derives is basename(dirname(absolute path))
  const stack = dir.split("/").pop()!;
  return { stack, file };
}

const okRunner: CommandRunner = async () => ({
  exitCode: 0,
  combinedOutput: "ok",
});

const failRunner: CommandRunner = async () => ({
  exitCode: 1,
  combinedOutput: "boom",
});

describe("runScanOnce", () => {
  it("holds a minor bump under 'patch' policy and includes approve/deny links", async () => {
    const { stack, file } = makeStack("jellyfin", "linuxserver/jellyfin:10.10.7");
    const db = openDb({ path: ":memory:" });
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = {
      name: "stub",
      send: async (m) => void sent.push(m),
    };
    const fakeListTags = async () => [
      { name: "10.10.7" },
      { name: "10.11.0" },
    ];

    const result = await runScanOnce({
      db,
      notifiers: [notifier],
      rules: { default: { app: "patch", dependencies: "patch" }, stacks: {} },
      composeFiles: { [stack]: file },
      publicUrl: "https://bump.example.com",
      listTagsFn: fakeListTags as never,
    });

    expect(result.held).toBe(1);
    expect(result.autoApplied).toBe(0);
    const subject = sent[0]!.subject;
    expect(subject).toContain("linuxserver/jellyfin:10.10.7");
    expect(subject).toContain("10.11.0");
    expect(sent[0]!.body).toContain("Click Approve to pull");
    expect(sent[0]!.body).toContain("Kind:    minor bump");
    // URLs are now baked into the body text (action card at top), not the links
    // list — that's intentional so we don't double-render in HTML+text emails.
    expect(sent[0]!.body).toMatch(/Approve: https:\/\/bump\.example\.com\/approve\/[A-Za-z0-9_-]+/);
    expect(sent[0]!.body).toMatch(/Deny:\s+https:\/\/bump\.example\.com\/deny\/[A-Za-z0-9_-]+/);
    // HTML body should have the styled buttons at the top.
    expect(sent[0]!.htmlBody).toBeDefined();
    expect(sent[0]!.htmlBody!).toContain("background:#16a34a");
    expect(sent[0]!.htmlBody!).toContain(">Approve<");
    expect(sent[0]!.htmlBody!).toContain(">Deny<");

    rmSync(file, { force: true });
  });

  it("auto-applies a patch and rewrites the compose file in place", async () => {
    const { stack, file } = makeStack("jellyfin", "linuxserver/jellyfin:10.10.7");
    const db = openDb({ path: ":memory:" });
    const fakeListTags = async () => [
      { name: "10.10.7" },
      { name: "10.10.8" },
    ];
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = {
      name: "stub",
      send: async (m) => void sent.push(m),
    };
    const calls: { args: string[] }[] = [];
    const runner: CommandRunner = async (_, args) => {
      calls.push({ args });
      return { exitCode: 0, combinedOutput: "ok" };
    };

    const result = await runScanOnce({
      db,
      notifiers: [notifier],
      rules: { default: { app: "patch", dependencies: "patch" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: fakeListTags as never,
      runner,
      pruneAfterApply: false,
    });

    expect(result.autoApplied).toBe(1);
    expect(result.autoAppliedOk).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(["compose", "-f", file, "pull", "--quiet", "jellyfin"]);
    expect(calls[1]!.args).toEqual(["compose", "-f", file, "up", "-d", "jellyfin"]);
    // Compose file actually got rewritten
    expect(readFileSync(file, "utf-8")).toContain("linuxserver/jellyfin:10.10.8");
    // Notification reports the success in the body
    expect(sent[0]!.body).toContain("Status:  applied");

    rmSync(file, { force: true });
  });

  it("reports apply failure in notification when docker compose returns non-zero", async () => {
    const { stack, file } = makeStack("jellyfin", "linuxserver/jellyfin:10.10.7");
    const db = openDb({ path: ":memory:" });
    const fakeListTags = async () => [
      { name: "10.10.7" },
      { name: "10.10.8" },
    ];
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = {
      name: "stub",
      send: async (m) => void sent.push(m),
    };

    const result = await runScanOnce({
      db,
      notifiers: [notifier],
      rules: { default: { app: "patch", dependencies: "patch" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: fakeListTags as never,
      runner: failRunner,
    });

    expect(result.autoApplied).toBe(1);
    expect(result.autoAppliedOk).toBe(0);
    expect(sent[0]!.body).toContain("Status:  failed");

    rmSync(file, { force: true });
  });

  it("dedups: one notification covers multiple stacks running the same image", async () => {
    const a = makeStack("vault-a", "hashicorp/vault:1.21.0");
    const b = makeStack("vault-b", "hashicorp/vault:1.21.0");
    const c = makeStack("vault-c", "hashicorp/vault:1.21.0");
    const db = openDb({ path: ":memory:" });
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = {
      name: "stub",
      send: async (m) => void sent.push(m),
    };
    const fakeListTags = async () => [
      { name: "1.21.0" },
      { name: "1.21.1" },
    ];

    const result = await runScanOnce({
      db,
      notifiers: [notifier],
      rules: { default: { app: "notify", dependencies: "notify" }, stacks: {} },
      composeFiles: { [a.stack]: a.file, [b.stack]: b.file, [c.stack]: c.file },
      publicUrl: "https://bump.example.com",
      listTagsFn: fakeListTags as never,
    });

    expect(result.held).toBe(3);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("3 stacks");
    expect(sent[0]!.body).toContain("Approval applies to all 3 stacks");

    rmSync(a.file, { force: true });
    rmSync(b.file, { force: true });
    rmSync(c.file, { force: true });
  });

  it("leaves rows pending when notifier delivery fails", async () => {
    const { stack, file } = makeStack("jellyfin", "linuxserver/jellyfin:10.10.7");
    const db = openDb({ path: ":memory:" });
    const fakeListTags = async () => [
      { name: "10.10.7" },
      { name: "10.11.0" },
    ];
    const failingNotifier: Notifier = {
      name: "broken",
      send: async () => {
        throw new Error("smtp 450 throttled");
      },
    };

    await runScanOnce({
      db,
      notifiers: [failingNotifier],
      rules: { default: { app: "notify", dependencies: "notify" }, stacks: {} },
      composeFiles: { [stack]: file },
      publicUrl: "https://bump.example.com",
      listTagsFn: fakeListTags as never,
    });

    const { listByStatus } = await import("../src/state/db.js");
    expect(listByStatus(db, "pending")).toHaveLength(1);
    expect(listByStatus(db, "notified")).toHaveLength(0);

    rmSync(file, { force: true });
  });

  it("rate-limits dispatches when notifyIntervalMs is set", async () => {
    const a = makeStack("svc-a", "linuxserver/jellyfin:10.10.7");
    const b = makeStack("svc-b", "linuxserver/sonarr:4.0.0");
    const db = openDb({ path: ":memory:" });
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = {
      name: "stub",
      send: async (m) => void sent.push(m),
    };
    const fakeListTags = async (ref: { name: string; tag: string }) => {
      if (ref.name.includes("jellyfin"))
        return [{ name: "10.10.7" }, { name: "10.11.0" }];
      return [{ name: "4.0.0" }, { name: "4.1.0" }];
    };
    const sleeps: number[] = [];
    const sleepFn = async (ms: number) => {
      sleeps.push(ms);
    };

    await runScanOnce({
      db,
      notifiers: [notifier],
      rules: { default: { app: "notify", dependencies: "notify" }, stacks: {} },
      composeFiles: { [a.stack]: a.file, [b.stack]: b.file },
      publicUrl: "https://bump.example.com",
      listTagsFn: fakeListTags as never,
      notifyIntervalMs: 10_000,
      sleepFn,
    });

    expect(sent).toHaveLength(2);
    // Two distinct image bumps → no dedup → second dispatch should sleep.
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(10_000);

    rmSync(a.file, { force: true });
    rmSync(b.file, { force: true });
  });

  it("under split policy with deps='none': dep image is silently skipped while app proceeds", async () => {
    // app=notify still asks; deps=none silently skips. Build a multi-service
    // stack where one is the app and one is a known dep image.
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-split-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(
      file,
      `services:\n  app:\n    image: outline:1.0.0\n  db:\n    image: postgres:15.5\n`,
      "utf-8",
    );
    const stack = dir.split("/").pop()!;
    const db = openDb({ path: ":memory:" });
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = {
      name: "stub",
      send: async (m) => void sent.push(m),
    };
    const fakeListTags = async (ref: { name: string; tag: string }) => {
      if (ref.name.includes("postgres"))
        return [{ name: "15.5" }, { name: "15.6" }, { name: "16.0" }];
      return [{ name: "1.0.0" }, { name: "1.1.0" }];
    };

    const result = await runScanOnce({
      db,
      notifiers: [notifier],
      // app=notify (always ask), dependencies=none (silently skip postgres)
      rules: { default: { app: "notify", dependencies: "none" }, stacks: {} },
      composeFiles: { [stack]: file },
      publicUrl: "https://bump.example.com",
      listTagsFn: fakeListTags as never,
    });

    // Only the app got an ask email; postgres was skipped silently.
    expect(result.held).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("outline");
    expect(sent[0]!.body).not.toContain("postgres");

    rmSync(file, { force: true });
  });

  it("auto-applied notifications include LLM advise summary when llmUrl is set", async () => {
    const { stack, file } = makeStack("jellyfin", "linuxserver/jellyfin:10.10.7");
    const db = openDb({ path: ":memory:" });
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = {
      name: "stub",
      send: async (m) => void sent.push(m),
    };
    const fakeListTags = async () => [
      { name: "10.10.7" },
      { name: "10.10.8" },
    ];
    const adviseFn = async () => ({
      ok: true,
      summary: "No breaking changes. Bug fixes only.",
      repo: "linuxserver/docker-jellyfin",
      releaseCount: 1,
      source: "release-notes" as const,
    });

    await runScanOnce({
      db,
      notifiers: [notifier],
      rules: { default: { app: "patch", dependencies: "patch" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: fakeListTags as never,
      runner: okRunner,
      llmUrl: "http://stub/v1",
      adviseFn,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Auto-applied per policy");
    expect(sent[0]!.body).toContain("No breaking changes");
    expect(sent[0]!.htmlBody).toBeDefined();
    expect(sent[0]!.htmlBody!).toContain("background:#dcfce7"); // green success banner
    expect(sent[0]!.htmlBody!).toContain("No breaking changes");

    rmSync(file, { force: true });
  });

  it("digest tracking: first scan of :latest records digest silently, no bump", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-latest-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(file, `services:\n  app:\n    image: nginx:latest\n`, "utf-8");
    const stack = dir.split("/").pop()!;
    const db = openDb({ path: ":memory:" });
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = { name: "stub", send: async (m) => void sent.push(m) };
    const fakeListTags = async () => [
      { name: "latest", digest: "sha256:aaaaaaaaaaaa1111" },
      { name: "1.27.0", digest: "sha256:cccccccccccc2222" },
    ];

    const result = await runScanOnce({
      db,
      notifiers: [notifier],
      rules: { default: { app: "notify", dependencies: "notify" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: fakeListTags as never,
    });

    expect(result.discovered).toBe(0);
    expect(sent).toHaveLength(0);
    // Digest got recorded for next scan
    const { getStoredDigest } = await import("../src/state/db.js");
    expect(getStoredDigest(db, "nginx:latest", "latest")?.digest).toBe(
      "sha256:aaaaaaaaaaaa1111",
    );
    rmSync(file, { force: true });
  });

  it("digest tracking: second scan with changed digest records a digest bump", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-latest-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(file, `services:\n  app:\n    image: nginx:latest\n`, "utf-8");
    const stack = dir.split("/").pop()!;
    const db = openDb({ path: ":memory:" });
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = { name: "stub", send: async (m) => void sent.push(m) };
    let digest = "sha256:aaaaaaaaaaaa1111";
    const fakeListTags = async () => [{ name: "latest", digest }];

    const deps = {
      db,
      notifiers: [notifier],
      rules: { default: { app: "notify" as const, dependencies: "notify" as const }, stacks: {} },
      composeFiles: { [stack]: file },
      publicUrl: "https://bump.example.com",
      listTagsFn: fakeListTags as never,
    };
    // First scan: silent record
    await runScanOnce(deps);
    expect(sent).toHaveLength(0);

    // Second scan: digest changed
    digest = "sha256:bbbbbbbbbbbb2222";
    const result = await runScanOnce(deps);
    expect(result.discovered).toBe(1);
    expect(result.held).toBe(1);
    // v0.4.1: digest-class bumps no longer fire per-event emails. The row
    // is still recorded + marked notified, but the daily-digest path is
    // the channel that surfaces them. Per-event ASK email was noise.
    expect(sent).toHaveLength(0);

    // Stored digest advanced to the new value
    const { getStoredDigest } = await import("../src/state/db.js");
    expect(getStoredDigest(db, "nginx:latest", "latest")?.digest).toBe(
      "sha256:bbbbbbbbbbbb2222",
    );

    // Third scan with no further change: no new bump
    sent.length = 0;
    const third = await runScanOnce(deps);
    expect(third.discovered).toBe(0);
    expect(sent).toHaveLength(0);

    rmSync(file, { force: true });
  });

  it("digest tracking Phase 2: resolves :latest digest to semver pair and auto-applies under matching policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-phase2-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(file, `services:\n  app:\n    image: nginx:latest\n`, "utf-8");
    const stack = dir.split("/").pop()!;
    const db = openDb({ path: ":memory:" });
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = {
      name: "stub",
      send: async (m) => void sent.push(m),
    };

    // First scan: :latest digest matches 1.27.4
    let latestDigest = "sha256:aaaa";
    const fakeListTags = async () => [
      { name: "latest", digest: latestDigest },
      { name: "1", digest: latestDigest },
      { name: "1.27", digest: latestDigest },
      { name: "1.27.4", digest: "sha256:aaaa" },
      { name: "1.27.5", digest: "sha256:bbbb" },
    ];
    const calls: { args: string[] }[] = [];
    const runner: CommandRunner = async (_, args) => {
      calls.push({ args });
      return { exitCode: 0, combinedOutput: "ok" };
    };

    const deps = {
      db,
      notifiers: [notifier],
      rules: { default: { app: "patch" as const, dependencies: "patch" as const }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: fakeListTags as never,
      runner,
    };
    // First scan resolves :latest → 1.27.4 silently.
    await runScanOnce(deps);
    expect(sent).toHaveLength(0);
    expect(calls).toHaveLength(0);

    // Second scan: :latest now points at 1.27.5's digest (a patch bump).
    latestDigest = "sha256:bbbb";
    const result = await runScanOnce(deps);
    expect(result.autoApplied).toBe(1);
    expect(result.autoAppliedOk).toBe(1);
    // pull + up ran against the moving-tag stack
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toContain("pull");
    expect(calls[1]!.args).toContain("up");
    // Compose file is NOT rewritten — still says :latest
    expect(readFileSync(file, "utf-8")).toContain("nginx:latest");
    // Notification reports the resolved semver pair, not digest prefixes
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("From:    1.27.4");
    expect(sent[0]!.body).toContain("To:      1.27.5");
    expect(sent[0]!.body).toContain("Origin:  digest change on :latest");
    rmSync(file, { force: true });
  });

  it("digest tracking Phase 2: falls back to digest hold when prior side has no resolved tag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-phase2-fallback-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(file, `services:\n  app:\n    image: nginx:latest\n`, "utf-8");
    const stack = dir.split("/").pop()!;
    const db = openDb({ path: ":memory:" });
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = {
      name: "stub",
      send: async (m) => void sent.push(m),
    };

    // Pre-seed a v0.3.1-style row: digest known, resolved_tag null.
    const { saveDigest } = await import("../src/state/db.js");
    saveDigest(db, "nginx:latest", "latest", "sha256:aaaa", null);

    const fakeListTags = async () => [
      { name: "latest", digest: "sha256:bbbb" },
      { name: "1.27.5", digest: "sha256:bbbb" },
    ];
    const calls: { args: string[] }[] = [];
    const runner: CommandRunner = async (_, args) => {
      calls.push({ args });
      return { exitCode: 0, combinedOutput: "ok" };
    };

    // Even under `major` policy, fallback should hold.
    const result = await runScanOnce({
      db,
      notifiers: [notifier],
      rules: { default: { app: "major", dependencies: "major" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: fakeListTags as never,
      runner,
    });
    expect(result.autoApplied).toBe(0);
    expect(result.held).toBe(1);
    expect(calls).toHaveLength(0);
    // v0.4.1: digest-class bumps no longer fire per-event email; row is
    // recorded + held for the daily digest.
    expect(sent).toHaveLength(0);
    rmSync(file, { force: true });
  });

  it("digest tracking Phase 2: probes GHCR manifests when tag list lacks inline digests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-phase2-ghcr-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(
      file,
      `services:\n  app:\n    image: ghcr.io/example/app:latest\n`,
      "utf-8",
    );
    const stack = dir.split("/").pop()!;
    const db = openDb({ path: ":memory:" });
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = {
      name: "stub",
      send: async (m) => void sent.push(m),
    };

    // GHCR-style tag list: no inline digests
    const fakeListTags = async () => [
      { name: "latest" },
      { name: "1.27.4" },
      { name: "1.27.5" },
    ];

    let movingDigest = "sha256:aaaa";
    const probes: string[] = [];
    const fetchManifestDigestFn = async (
      _ref: unknown,
      tag: string,
    ): Promise<string | undefined> => {
      probes.push(tag);
      if (tag === "latest") return movingDigest;
      if (tag === "1.27.4") return "sha256:aaaa";
      if (tag === "1.27.5") return "sha256:bbbb";
      return undefined;
    };

    const deps = {
      db,
      notifiers: [notifier],
      rules: { default: { app: "notify" as const, dependencies: "notify" as const }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: fakeListTags as never,
      fetchManifestDigestFn: fetchManifestDigestFn as never,
    };
    // First scan: silent record after probing.
    await runScanOnce(deps);
    expect(sent).toHaveLength(0);

    movingDigest = "sha256:bbbb";
    const result = await runScanOnce(deps);
    expect(result.held).toBe(1);
    expect(sent).toHaveLength(1);
    // Resolved pair shown in body
    expect(sent[0]!.body).toContain("From:    1.27.4");
    expect(sent[0]!.body).toContain("To:      1.27.5");
    rmSync(file, { force: true });
  });

  it("digest tracking: never auto-applies a digest bump even under 'major' policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-latest-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(file, `services:\n  app:\n    image: nginx:latest\n`, "utf-8");
    const stack = dir.split("/").pop()!;
    const db = openDb({ path: ":memory:" });
    let digest = "sha256:aaaaaaaaaaaa1111";
    const fakeListTags = async () => [{ name: "latest", digest }];
    const calls: string[] = [];
    const runner = async (..._args: unknown[]) => {
      calls.push("ran");
      return { exitCode: 0, combinedOutput: "" };
    };

    const deps = {
      db,
      notifiers: [] as Notifier[],
      rules: { default: { app: "major" as const, dependencies: "major" as const }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: fakeListTags as never,
      runner: runner as never,
    };
    await runScanOnce(deps);
    digest = "sha256:bbbbbbbbbbbb2222";
    const result = await runScanOnce(deps);
    expect(result.autoApplied).toBe(0);
    expect(result.held).toBe(1);
    expect(calls).toHaveLength(0); // docker compose was never invoked
    rmSync(file, { force: true });
  });

  it("v0.5.5: digest-class bumps persist OCI-label enrichment into advise_text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-v055-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(file, `services:\n  app:\n    image: nginx:latest\n`, "utf-8");
    const stack = dir.split("/").pop()!;
    const db = openDb({ path: ":memory:" });
    let digest = "sha256:aaaaaaaaaaaa1111";
    const fakeListTags = async () => [{ name: "latest", digest }];

    const enrichCalls: Array<{ prev: string; next: string }> = [];
    const enrichDigestFn = async (opts: {
      prevDigest: string;
      newDigest: string;
    }) => {
      enrichCalls.push({ prev: opts.prevDigest, next: opts.newDigest });
      return {
        ok: true,
        summary: "Digest range: abc…def on github.com/owner/repo (3 commits)\n\n- feat: x",
        prevRevision: "abc",
        newRevision: "def",
        repo: "owner/repo",
      };
    };

    const deps = {
      db,
      notifiers: [] as Notifier[],
      rules: { default: { app: "notify" as const, dependencies: "notify" as const }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: fakeListTags as never,
      llmUrl: "http://llm/v1",
      enrichDigestFn: enrichDigestFn as never,
    };

    // First scan records the digest silently.
    await runScanOnce(deps);
    expect(enrichCalls).toHaveLength(0);

    digest = "sha256:bbbbbbbbbbbb2222";
    const result = await runScanOnce(deps);
    expect(result.held).toBe(1);
    expect(enrichCalls).toHaveLength(1);
    expect(enrichCalls[0]!.prev).toBe("sha256:aaaaaaaaaaaa1111");
    expect(enrichCalls[0]!.next).toBe("sha256:bbbbbbbbbbbb2222");

    const { listByStatus: list } = await import("../src/state/db.js");
    const rows = list(db, "notified");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.advise_text).toContain("Digest range");
    expect(rows[0]!.advise_text).toContain("github.com/owner/repo");

    rmSync(file, { force: true });
  });

  it("v0.5.5: skipped digest enrichment leaves advise_text null without breaking the row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-v055-skip-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(file, `services:\n  app:\n    image: nginx:latest\n`, "utf-8");
    const stack = dir.split("/").pop()!;
    const db = openDb({ path: ":memory:" });
    let digest = "sha256:aaaaaaaaaaaa1111";
    const fakeListTags = async () => [{ name: "latest", digest }];

    const enrichDigestFn = async () => ({
      ok: false,
      error: "no revision labels",
    });

    const deps = {
      db,
      notifiers: [] as Notifier[],
      rules: { default: { app: "notify" as const, dependencies: "notify" as const }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: fakeListTags as never,
      llmUrl: "http://llm/v1",
      enrichDigestFn: enrichDigestFn as never,
    };
    await runScanOnce(deps);
    digest = "sha256:bbbbbbbbbbbb2222";
    const result = await runScanOnce(deps);
    expect(result.held).toBe(1);
    const { listByStatus: list } = await import("../src/state/db.js");
    const rows = list(db, "notified");
    expect(rows[0]!.advise_text).toBeNull();
    rmSync(file, { force: true });
  });

  it("v0.5.5: enrichment is skipped when LLM is not configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-v055-nollm-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(file, `services:\n  app:\n    image: nginx:latest\n`, "utf-8");
    const stack = dir.split("/").pop()!;
    const db = openDb({ path: ":memory:" });
    let digest = "sha256:aaaaaaaaaaaa1111";
    const fakeListTags = async () => [{ name: "latest", digest }];

    const enrichDigestFn = vi.fn();
    const deps = {
      db,
      notifiers: [] as Notifier[],
      rules: { default: { app: "notify" as const, dependencies: "notify" as const }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: fakeListTags as never,
      // no llmUrl
      enrichDigestFn: enrichDigestFn as never,
    };
    await runScanOnce(deps);
    digest = "sha256:bbbbbbbbbbbb2222";
    await runScanOnce(deps);
    expect(enrichDigestFn).not.toHaveBeenCalled();
    rmSync(file, { force: true });
  });

  it("does not duplicate work on repeat scans", async () => {
    const { stack, file } = makeStack("jellyfin", "linuxserver/jellyfin:10.10.7");
    const db = openDb({ path: ":memory:" });
    const fakeListTags = async () => [
      { name: "10.10.7" },
      { name: "10.10.8" },
    ];
    const deps = {
      db,
      notifiers: [] as Notifier[],
      rules: { default: { app: "patch" as const, dependencies: "patch" as const }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: fakeListTags as never,
      runner: okRunner,
    };

    const first = await runScanOnce(deps);
    const second = await runScanOnce(deps);

    expect(first.discovered).toBe(1);
    // After auto-apply, file is on 10.10.8; rescan finds nothing newer.
    expect(second.discovered).toBe(0);

    rmSync(file, { force: true });
  });
});

describe("buildComposeFileMap", () => {
  it("derives stack names from the parent directory", () => {
    const map = buildComposeFileMap([
      "/mnt/stacks/glance/compose.yaml",
      "/mnt/stacks/jellyfin/compose.yaml",
    ]);
    expect(Object.keys(map).sort()).toEqual(["glance", "jellyfin"]);
    expect(map.glance).toMatch(/glance\/compose.yaml$/);
  });
});
