import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScanOnce, reconcileOpenRows } from "../src/daemon/index.js";
import { applyOne } from "../src/apply/index.js";
import {
  openDb,
  listAllUpdates,
  findUpdate,
  listStaleImageChecks,
  recordImageCheck,
} from "../src/state/db.js";
import { interpolateImage, parseImageRef } from "../src/compose/parse.js";
import { isFloatingTag } from "../src/daemon/rules.js";
import { localRepoDigest, resolveDigestToTag } from "../src/daemon/floating.js";
import type { CommandRunner } from "../src/apply/docker.js";
import type { RemoteTag } from "../src/registry/index.js";

function makeStack(
  service: string,
  image: string,
  extra = "",
): { stack: string; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `bumpsight-float-${service}-`));
  const file = join(dir, "compose.yaml");
  writeFileSync(
    file,
    `services:\n  ${service}:\n    image: ${image}\n${extra}    restart: unless-stopped\n`,
    "utf-8",
  );
  return { stack: dir.split("/").pop()!, file, dir };
}

const OLD = "sha256:" + "a".repeat(64);
const NEW = "sha256:" + "b".repeat(64);
const OTHER = "sha256:" + "c".repeat(64);

const recordingRunner = (calls: string[][]): CommandRunner => async (_cmd, args) => {
  calls.push(args);
  return { exitCode: 0, combinedOutput: "ok" };
};

/** A GHCR-style registry: no inline digests, every tag resolved by probe. */
function probeRegistry(map: Record<string, string>) {
  return async (_ref: unknown, tag: string) => map[tag];
}

describe("isFloatingTag", () => {
  it("treats partial versions, channels and names as floating", () => {
    for (const t of ["latest", "release", "4.39", "2", "6-alpine", "13.0-latest", "main-stable", "v1"]) {
      expect(isFloatingTag(t), t).toBe(true);
    }
  });

  it("treats full versions and dates as fixed", () => {
    for (const t of ["1.2.3", "v1.25.5", "1.25.5-rootless", "2025-04-01", "4.0.19.2979-ls321"]) {
      expect(isFloatingTag(t), t).toBe(false);
    }
  });
});

describe("interpolateImage", () => {
  it("resolves defaults and the stack .env", () => {
    const { file, dir } = makeStack("app", "x");
    expect(interpolateImage("ghcr.io/org/app:${APP_VERSION:-release}", file)).toBe(
      "ghcr.io/org/app:release",
    );
    writeFileSync(join(dir, ".env"), 'APP_VERSION="v2.1.0"\n');
    expect(interpolateImage("ghcr.io/org/app:${APP_VERSION:-release}", file)).toBe(
      "ghcr.io/org/app:v2.1.0",
    );
    expect(interpolateImage("nginx:1.27")).toBe("nginx:1.27");
  });
});

describe("resolveDigestToTag", () => {
  it("probes the newest versions first, so a long history cannot exhaust the budget", async () => {
    const tags: RemoteTag[] = [{ name: "latest" }, { name: "v1" }];
    for (let minor = 0; minor <= 40; minor++) tags.push({ name: `v1.${minor}.0` });
    const probes: string[] = [];
    const resolved = await resolveDigestToTag(
      parseImageRef("ghcr.io/org/app:latest"),
      tags,
      NEW,
      "latest",
      async (_ref, tag) => {
        probes.push(tag);
        return tag === "v1.40.0" || tag === "v1" ? NEW : OTHER;
      },
    );
    expect(resolved).toBe("v1.40.0");
    expect(probes[0]).toBe("v1.40.0");
  });

  it("stays inside a numeric floating tag's line and variant", async () => {
    const tags: RemoteTag[] = [
      { name: "6.5.2", digest: OTHER },
      { name: "6.5.2-alpine", digest: NEW },
      { name: "7.0.0-alpine", digest: NEW },
    ];
    const resolved = await resolveDigestToTag(
      parseImageRef("ghost:6-alpine"),
      tags,
      NEW,
      "6-alpine",
      async () => undefined,
    );
    expect(resolved).toBe("6.5.2-alpine");
  });
});

describe("localRepoDigest", () => {
  it("picks the RepoDigest for the ref's repository", async () => {
    const runner: CommandRunner = async () => ({
      exitCode: 0,
      combinedOutput: JSON.stringify([`other/thing@${OTHER}`, `authelia/authelia@${OLD}`]),
    });
    expect(await localRepoDigest(parseImageRef("authelia/authelia:4.39"), runner)).toBe(OLD);
    expect(
      await localRepoDigest(parseImageRef("docker.io/authelia/authelia:4.39"), runner),
    ).toBe(OLD);
  });

  it("is undefined when the image is not present", async () => {
    const runner: CommandRunner = async () => ({ exitCode: 1, combinedOutput: "No such image" });
    expect(await localRepoDigest(parseImageRef("nginx:1.27"), runner)).toBeUndefined();
  });
});

describe("floating tags pinned by digest (tag@sha256)", () => {
  const ref = `ghcr.io/example/webmail:latest@${OLD}`;
  const tags = async () => [
    { name: "latest" },
    { name: "v1" },
    { name: "v1.7.1" },
    { name: "v1.9.0" },
    { name: "v1.11.2" },
  ];
  const registry = probeRegistry({
    latest: NEW,
    v1: NEW,
    "v1.11.2": NEW,
    "v1.9.0": OTHER,
    "v1.7.1": OLD,
  });

  it("surfaces the moved digest with real versions and holds it under notify", async () => {
    const { stack, file } = makeStack("webmail", ref);
    const db = openDb({ path: ":memory:" });
    const result = await runScanOnce({
      db,
      notifiers: [],
      rules: { default: { app: "notify", dependencies: "none" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: tags as never,
      fetchManifestDigestFn: registry as never,
      labelVersionFn: async () => undefined,
    });
    expect(result.discovered).toBe(1);
    expect(result.held).toBe(1);
    const row = listAllUpdates(db)[0]!;
    expect(row.current_tag).toBe("v1.7.1");
    expect(row.target_tag).toBe("v1.11.2");
    expect(row.bump).toBe("minor");
    expect(row.family).toBe("pinned:latest");
    expect(row.target_image).toBe(`ghcr.io/example/webmail:latest@${NEW}`);

    // Reconcile must not retire it: the compose still pins this exact ref.
    const rec = reconcileOpenRows(
      db,
      { default: { app: "notify", dependencies: "none" }, stacks: {} },
      { [stack]: file },
    );
    expect(rec.stale).toBe(0);
    expect(findUpdate(db, row.id)!.superseded ?? 0).toBe(0);

    // Approving rewrites the digest, not the tag.
    const calls: string[][] = [];
    const after = await applyOne(
      { db, composeFiles: { [stack]: file }, runner: recordingRunner(calls), pruneAfterApply: false },
      row.id,
    );
    expect(after.status).toBe("applied");
    expect(readFileSync(file, "utf-8")).toContain(`ghcr.io/example/webmail:latest@${NEW}`);
    expect(calls.map((c) => c.slice(3, 4)[0])).toEqual(["pull", "up"]);
  });

  it("auto-applies under an app policy that covers the classified bump", async () => {
    const { stack, file } = makeStack("webmail", ref);
    const db = openDb({ path: ":memory:" });
    const calls: string[][] = [];
    const result = await runScanOnce({
      db,
      notifiers: [],
      rules: { default: { app: "minor", dependencies: "none" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: tags as never,
      fetchManifestDigestFn: registry as never,
      labelVersionFn: async () => undefined,
      runner: recordingRunner(calls),
      pruneAfterApply: false,
    });
    expect(result.autoAppliedOk).toBe(1);
    expect(readFileSync(file, "utf-8")).toContain(`@${NEW}`);
  });

  it("holds as unknown when the versions cannot be decoded, even under 'major'", async () => {
    const { stack, file } = makeStack("webmail", ref);
    const db = openDb({ path: ":memory:" });
    const result = await runScanOnce({
      db,
      notifiers: [],
      rules: { default: { app: "major", dependencies: "none" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: (async () => [{ name: "latest" }]) as never,
      fetchManifestDigestFn: probeRegistry({ latest: NEW }) as never,
      labelVersionFn: async () => undefined,
      movingDeltaFn: async () => ({ from: "2026-09-01 10:00:00", to: "2026-09-20 10:00:00" }),
    });
    expect(result.autoApplied).toBe(0);
    expect(result.held).toBe(1);
    const row = listAllUpdates(db)[0]!;
    expect(row.bump).toBe("unknown");
    expect(row.display_from).toBe("2026-09-01 10:00:00");
    expect(row.display_to).toBe("2026-09-20 10:00:00");
  });

  it("uses the OCI version label when no version tag shares the digest", async () => {
    const { stack, file } = makeStack("webmail", ref);
    const db = openDb({ path: ":memory:" });
    await runScanOnce({
      db,
      notifiers: [],
      rules: { default: { app: "notify", dependencies: "none" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: (async () => [{ name: "latest" }]) as never,
      fetchManifestDigestFn: probeRegistry({ latest: NEW }) as never,
      labelVersionFn: async (_r, d) => (d === OLD ? "1.7.1" : "1.7.2"),
    });
    const row = listAllUpdates(db)[0]!;
    expect([row.current_tag, row.target_tag, row.bump]).toEqual(["1.7.1", "1.7.2", "patch"]);
  });

  it("ignores a rebuild of the same version", async () => {
    const { stack, file } = makeStack("webmail", ref);
    const db = openDb({ path: ":memory:" });
    const result = await runScanOnce({
      db,
      notifiers: [],
      rules: { default: { app: "notify", dependencies: "none" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: (async () => [{ name: "latest" }]) as never,
      fetchManifestDigestFn: probeRegistry({ latest: NEW }) as never,
      labelVersionFn: async () => "1.7.1",
    });
    expect(result.discovered).toBe(0);
    expect(result.checked).toBe(1);
  });

  it("is quiet when the pinned digest is current", async () => {
    const { stack, file } = makeStack("webmail", ref);
    const db = openDb({ path: ":memory:" });
    const result = await runScanOnce({
      db,
      notifiers: [],
      rules: { default: { app: "notify", dependencies: "none" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: (async () => [{ name: "latest" }]) as never,
      fetchManifestDigestFn: probeRegistry({ latest: OLD }) as never,
    });
    expect(result.discovered).toBe(0);
    expect(result.checked).toBe(1);
  });
});

describe("bare floating tags", () => {
  it("compares against the local image digest and applies with pull + recreate", async () => {
    const { stack, file } = makeStack("authelia", "authelia/authelia:4.39");
    const db = openDb({ path: ":memory:" });
    const calls: string[][] = [];
    const result = await runScanOnce({
      db,
      notifiers: [],
      rules: { default: { app: "minor", dependencies: "none" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: (async () => [
        { name: "4.39", digest: NEW },
        { name: "4.39.8", digest: OLD },
        { name: "4.39.9", digest: NEW },
      ]) as never,
      localDigestFn: async () => OLD,
      runner: recordingRunner(calls),
      pruneAfterApply: false,
    });
    expect(result.autoAppliedOk).toBe(1);
    const row = listAllUpdates(db)[0]!;
    expect([row.current_tag, row.target_tag, row.bump, row.family]).toEqual([
      "4.39.8",
      "4.39.9",
      "patch",
      "moving:4.39",
    ]);
    // The compose line is left alone; the pull picks up the new digest.
    expect(readFileSync(file, "utf-8")).toContain("image: authelia/authelia:4.39\n");
    expect(calls.map((c) => c[3])).toEqual(["pull", "up"]);
  });

  it("records a baseline on first sight when the image is not local", async () => {
    const { stack, file } = makeStack("app", "louislam/uptime-kuma:2");
    const db = openDb({ path: ":memory:" });
    const opts = {
      db,
      notifiers: [],
      rules: { default: { app: "notify" as const, dependencies: "none" as const }, stacks: {} },
      composeFiles: { [stack]: file },
      localDigestFn: async () => undefined,
      labelVersionFn: async () => undefined,
    };
    const first = await runScanOnce({
      ...opts,
      listTagsFn: (async () => [{ name: "2", digest: OLD }, { name: "2.0.1", digest: OLD }]) as never,
    });
    expect(first.discovered).toBe(0);
    const second = await runScanOnce({
      ...opts,
      listTagsFn: (async () => [
        { name: "2", digest: NEW },
        { name: "2.0.1", digest: OLD },
        { name: "2.0.2", digest: NEW },
      ]) as never,
    });
    expect(second.discovered).toBe(1);
    const row = listAllUpdates(db)[0]!;
    expect([row.current_tag, row.target_tag]).toEqual(["2.0.1", "2.0.2"]);
  });
});

describe("tag bump on a digest-pinned ref", () => {
  it("rewrites the digest along with the tag", async () => {
    const { stack, file } = makeStack("cache", `valkey/valkey:9.0.1@${OLD}`);
    const db = openDb({ path: ":memory:" });
    const calls: string[][] = [];
    await runScanOnce({
      db,
      notifiers: [],
      rules: { default: { app: "patch", dependencies: "patch" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: (async () => [
        { name: "9.0.1", digest: OLD },
        { name: "9.0.2", digest: NEW },
      ]) as never,
      runner: recordingRunner(calls),
      pruneAfterApply: false,
    });
    expect(readFileSync(file, "utf-8")).toContain(`valkey/valkey:9.0.2@${NEW}`);
  });
});

describe("scan accounting", () => {
  it("counts local builds, failed checks and successes separately", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-acct-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(
      file,
      [
        "services:",
        "  built:",
        "    build: .",
        "    image: myapp:dev",
        "  localonly:",
        "    image: something-local:1.0",
        "  flaky:",
        "    image: someorg/flaky:1.0.0",
        "  fine:",
        "    image: someorg/fine:1.0.0",
        "",
      ].join("\n"),
    );
    const stack = dir.split("/").pop()!;
    const db = openDb({ path: ":memory:" });
    const result = await runScanOnce({
      db,
      notifiers: [],
      rules: { default: { app: "notify", dependencies: "none" }, stacks: {} },
      composeFiles: { [stack]: file },
      listTagsFn: (async (ref: { raw: string }) => {
        if (ref.raw.startsWith("something-local")) {
          throw new Error("Docker Hub: 404 Not Found fetching https://hub.docker.com/…");
        }
        if (ref.raw.includes("flaky")) throw new Error("Docker Hub: 429 Too Many Requests");
        return [{ name: "1.0.0" }];
      }) as never,
    });
    expect(result.scanned).toBe(4);
    expect(result.localBuilds).toBe(2);
    expect(result.unchecked).toBe(1);
    expect(result.checked).toBe(1);
    expect(Object.keys(result.errors)).toEqual(["someorg/flaky:1.0.0"]);

    // Four days on, the healthy image has been checked again; the failing
    // one has not succeeded since it was first seen, so it is stale.
    const later = Date.now() + 4 * 24 * 3600 * 1000;
    recordImageCheck(db, "someorg/fine:1.0.0", [`${stack}/fine`], undefined, later);
    recordImageCheck(db, "someorg/flaky:1.0.0", [`${stack}/flaky`], "429", later);
    const stale = listStaleImageChecks(db, {
      staleAfterMs: 3 * 24 * 3600 * 1000,
      seenWithinMs: 2 * 24 * 3600 * 1000,
      now: later,
    });
    expect(stale.map((s) => s.image)).toEqual(["someorg/flaky:1.0.0"]);
    expect(stale[0]!.last_success_at).toBeNull();
  });
});

describe("formatScanReport", () => {
  it("says how many services were NOT checked instead of only '0 new'", async () => {
    const { formatScanReport } = await import("../src/daemon/index.js");
    const lines = formatScanReport({
      scanned: 10,
      discovered: 0,
      autoApplied: 0,
      autoAppliedOk: 0,
      held: 0,
      errors: { "someorg/app:1.0.0": "Docker Hub: 429 Too Many Requests" },
      skipped: 0,
      skippedByRegistry: {},
      checked: 7,
      unchecked: 1,
      localBuilds: 2,
    });
    expect(lines[0]).toBe(
      "scan: 10 services (7 checked, 1 NOT checked (errors), 2 local), 0 new (0 auto, 0 applied ok, 0 held)",
    );
    expect(lines[1]).toBe("scan-error: someorg/app:1.0.0: Docker Hub: 429 Too Many Requests");
  });
});
