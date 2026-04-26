import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScanOnce } from "../src/daemon/index.js";
import { openDb, listByStatus } from "../src/state/db.js";
import type { Notifier, NotifyMessage } from "../src/notify/types.js";

function makeStack(name: string, image: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bumpsight-${name}-`));
  const file = join(dir, "compose.yaml");
  writeFileSync(
    file,
    `services:\n  ${name}:\n    image: ${image}\n    restart: unless-stopped\n`,
    "utf-8",
  );
  return file;
}

describe("runScanOnce", () => {
  it("records a held notification for a minor bump under 'patch' policy", async () => {
    const composeFile = makeStack("jellyfin", "linuxserver/jellyfin:10.10.7");
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
      composeFiles: [composeFile],
      listTagsFn: fakeListTags as never,
    });

    expect(result.scanned).toBe(1);
    expect(result.discovered).toBe(1);
    expect(result.held).toBe(1);
    expect(result.autoApplied).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("10.11.0");
    expect(sent[0]!.subject).toContain("approval needed");

    const notified = listByStatus(db, "notified");
    expect(notified).toHaveLength(1);
    expect(notified[0]!.target_tag).toBe("10.11.0");

    rmSync(composeFile, { force: true });
  });

  it("auto-applies a patch under 'patch' policy", async () => {
    const composeFile = makeStack("jellyfin", "linuxserver/jellyfin:10.10.7");
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

    const result = await runScanOnce({
      db,
      notifiers: [notifier],
      rules: { default: "patch", stacks: {} },
      composeFiles: [composeFile],
      listTagsFn: fakeListTags as never,
    });

    expect(result.autoApplied).toBe(1);
    expect(result.held).toBe(0);
    expect(sent[0]!.subject).toContain("auto-apply queued");

    rmSync(composeFile, { force: true });
  });

  it("skips entirely when stack policy is 'none'", async () => {
    const composeFile = makeStack("jellyfin", "linuxserver/jellyfin:10.10.7");
    const db = openDb({ path: ":memory:" });
    const fakeListTags = async () => [
      { name: "10.10.7" },
      { name: "10.10.8" },
    ];
    const stack = composeFile.split("/").slice(-2, -1)[0]!;

    const result = await runScanOnce({
      db,
      notifiers: [],
      rules: { default: "patch", stacks: { [stack]: "none" } },
      composeFiles: [composeFile],
      listTagsFn: fakeListTags as never,
    });

    expect(result.discovered).toBe(0);
    rmSync(composeFile, { force: true });
  });

  it("does not duplicate work on repeat scans", async () => {
    const composeFile = makeStack("jellyfin", "linuxserver/jellyfin:10.10.7");
    const db = openDb({ path: ":memory:" });
    const fakeListTags = async () => [
      { name: "10.10.7" },
      { name: "10.10.8" },
    ];
    const deps = {
      db,
      notifiers: [] as Notifier[],
      rules: { default: "patch" as const, stacks: {} },
      composeFiles: [composeFile],
      listTagsFn: fakeListTags as never,
    };

    const first = await runScanOnce(deps);
    const second = await runScanOnce(deps);

    expect(first.discovered).toBe(1);
    expect(second.discovered).toBe(0);
    rmSync(composeFile, { force: true });
  });
});
