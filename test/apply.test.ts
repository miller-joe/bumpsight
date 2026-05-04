import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rewriteImageTag, replaceTagInRef } from "../src/apply/compose.js";
import { applyOne } from "../src/apply/index.js";
import { pullAndUp, type CommandRunner } from "../src/apply/docker.js";
import { openDb, recordUpdate } from "../src/state/db.js";

describe("replaceTagInRef", () => {
  it("swaps a simple tag", () => {
    expect(replaceTagInRef("nginx:1.27", "1.27", "1.28")).toBe("nginx:1.28");
  });

  it("preserves the registry segment", () => {
    expect(
      replaceTagInRef("ghcr.io/user/app:1.0", "1.0", "2.0"),
    ).toBe("ghcr.io/user/app:2.0");
  });

  it("handles localhost:5000 registry without confusing the port colon for a tag", () => {
    expect(
      replaceTagInRef("localhost:5000/x:1.2", "1.2", "1.3"),
    ).toBe("localhost:5000/x:1.3");
  });

  it("treats a missing tag as 'latest'", () => {
    expect(replaceTagInRef("nginx", "latest", "1.27")).toBe("nginx:1.27");
  });

  it("preserves a digest suffix", () => {
    expect(
      replaceTagInRef("nginx:1.27@sha256:abc", "1.27", "1.28"),
    ).toBe("nginx:1.28@sha256:abc");
  });

  it("throws on tag drift", () => {
    expect(() =>
      replaceTagInRef("nginx:1.27", "1.26", "1.28"),
    ).toThrow(/drift/);
  });
});

describe("rewriteImageTag", () => {
  it("rewrites the image tag while preserving comments and other services", () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-rewrite-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(
      file,
      [
        "# top-level comment",
        "services:",
        "  jellyfin:",
        "    image: linuxserver/jellyfin:10.10.7  # pinned",
        "    restart: unless-stopped",
        "  postgres:",
        "    image: postgres:16",
        "",
      ].join("\n"),
      "utf-8",
    );

    rewriteImageTag({
      composePath: file,
      serviceName: "jellyfin",
      expectedCurrentTag: "10.10.7",
      newTag: "10.10.8",
    });

    const after = readFileSync(file, "utf-8");
    expect(after).toContain("linuxserver/jellyfin:10.10.8");
    expect(after).toContain("# top-level comment");
    expect(after).toContain("postgres:16");
    expect(after).toContain("# pinned");

    rmSync(file, { force: true });
  });

  it("throws when the image scalar is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-rewrite-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(
      file,
      `services:\n  app:\n    build: ./Dockerfile\n`,
      "utf-8",
    );
    expect(() =>
      rewriteImageTag({
        composePath: file,
        serviceName: "app",
        expectedCurrentTag: "x",
        newTag: "y",
      }),
    ).toThrow(/image not found/);
    rmSync(file, { force: true });
  });
});

describe("pullAndUp", () => {
  it("returns ok when both steps succeed", async () => {
    const okRunner: CommandRunner = async () => ({
      exitCode: 0,
      combinedOutput: "fine",
    });
    const r = await pullAndUp({
      composePath: "/x.yaml",
      serviceName: "app",
      runner: okRunner,
    });
    expect(r.ok).toBe(true);
    expect(r.up?.exitCode).toBe(0);
    expect(r.log).toContain("==== docker compose pull");
    expect(r.log).toContain("==== docker compose up");
  });

  it("short-circuits when pull fails", async () => {
    let calls = 0;
    const runner: CommandRunner = async () => {
      calls += 1;
      return { exitCode: 1, combinedOutput: "no" };
    };
    const r = await pullAndUp({
      composePath: "/x.yaml",
      serviceName: "app",
      runner,
    });
    expect(r.ok).toBe(false);
    expect(calls).toBe(1);
    expect(r.up).toBeUndefined();
  });
});

describe("applyOne", () => {
  it("rewrites file, runs docker, marks applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-apply-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(
      file,
      `services:\n  app:\n    image: nginx:1.27\n`,
      "utf-8",
    );
    const db = openDb({ path: ":memory:" });
    const id = recordUpdate(db, {
      stack: "appstack",
      service: "app",
      image: "nginx:1.27",
      currentTag: "1.27",
      targetTag: "1.28",
      bump: "minor",
    });

    const okRunner: CommandRunner = async () => ({
      exitCode: 0,
      combinedOutput: "ok",
    });
    const after = await applyOne(
      { db, composeFiles: { appstack: file }, runner: okRunner },
      id,
    );

    expect(after.status).toBe("applied");
    expect(readFileSync(file, "utf-8")).toContain("nginx:1.28");
    rmSync(file, { force: true });
  });

  it("marks failed when docker exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-apply-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(
      file,
      `services:\n  app:\n    image: nginx:1.27\n`,
      "utf-8",
    );
    const db = openDb({ path: ":memory:" });
    const id = recordUpdate(db, {
      stack: "appstack",
      service: "app",
      image: "nginx:1.27",
      currentTag: "1.27",
      targetTag: "1.28",
      bump: "minor",
    });

    const failRunner: CommandRunner = async () => ({
      exitCode: 1,
      combinedOutput: "boom",
    });
    const after = await applyOne(
      { db, composeFiles: { appstack: file }, runner: failRunner },
      id,
    );

    expect(after.status).toBe("failed");
    expect(after.apply_log).toContain("boom");
    rmSync(file, { force: true });
  });

  it("is a no-op when the row was already applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-apply-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(
      file,
      `services:\n  app:\n    image: nginx:1.27\n`,
      "utf-8",
    );
    const db = openDb({ path: ":memory:" });
    const id = recordUpdate(db, {
      stack: "appstack",
      service: "app",
      image: "nginx:1.27",
      currentTag: "1.27",
      targetTag: "1.28",
      bump: "minor",
    });

    let calls = 0;
    const counting: CommandRunner = async () => {
      calls += 1;
      return { exitCode: 0, combinedOutput: "" };
    };

    await applyOne(
      { db, composeFiles: { appstack: file }, runner: counting, pruneAfterApply: false },
      id,
    );
    await applyOne(
      { db, composeFiles: { appstack: file }, runner: counting, pruneAfterApply: false },
      id,
    );

    // First call: pull + up = 2. Second call: noop = 0. (Prune disabled in this test.)
    expect(calls).toBe(2);
    rmSync(file, { force: true });
  });
});
