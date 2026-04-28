import { describe, it, expect } from "vitest";
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
      rules: { default: "patch", stacks: {} },
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
      rules: { default: "patch", stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: fakeListTags as never,
      runner,
    });

    expect(result.autoApplied).toBe(1);
    expect(result.autoAppliedOk).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(["compose", "-f", file, "pull", "jellyfin"]);
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
      rules: { default: "patch", stacks: {} },
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
      rules: { default: "notify", stacks: {} },
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
      rules: { default: "notify", stacks: {} },
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
      rules: { default: "notify", stacks: {} },
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

  it("under 'report' policy: dispatches FYI notification and never generates approval token", async () => {
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

    await runScanOnce({
      db,
      notifiers: [notifier],
      rules: { default: "report", stacks: {} },
      composeFiles: { [stack]: file },
      publicUrl: "https://bump.example.com",
      listTagsFn: fakeListTags as never,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('FYI');
    expect(sent[0]!.body).not.toContain("Click Approve");
    // No buttons in HTML either
    expect(sent[0]!.htmlBody).not.toContain(">Approve<");
    expect(sent[0]!.htmlBody).toContain("policy <code>report</code>");
    // Row should have no approval token (so no approve link is even possible)
    const { listByStatus } = await import("../src/state/db.js");
    const rows = listByStatus(db, "notified");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.approval_token).toBeNull();

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
      rules: { default: "patch", stacks: {} },
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
      rules: { default: "patch" as const, stacks: {} },
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
