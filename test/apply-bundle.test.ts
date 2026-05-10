import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOne } from "../src/apply/index.js";
import { type CommandRunner } from "../src/apply/docker.js";
import {
  buildBundlePlan,
  formatBundleLog,
  parsePairedDepsJson,
} from "../src/apply/paired-deps-plan.js";
import {
  openDb,
  recordUpdate,
  setPairedDeps,
  findUpdate,
} from "../src/state/db.js";
import type { DepRecommendation } from "../src/advise/paired-deps.js";

const PAIRED_BUMP: DepRecommendation = {
  upstreamService: "postgresql",
  upstreamImage: "postgres:17-alpine",
  localImage: "postgres:16-alpine",
  localService: "outline-postgres",
  kind: "bump",
};

const PAIRED_ADD: DepRecommendation = {
  upstreamService: "valkey",
  upstreamImage: "valkey/valkey:7-alpine",
  localImage: null,
  localService: null,
  kind: "add",
};

const PAIRED_IMAGE_CHANGE: DepRecommendation = {
  upstreamService: "cache",
  upstreamImage: "valkey/valkey:7-alpine",
  localImage: "redis:7-alpine",
  localService: "outline-redis",
  kind: "image-change",
};

function makeComposeFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bumpsight-bundle-"));
  const file = join(dir, "compose.yaml");
  writeFileSync(file, content, "utf-8");
  return file;
}

describe("parsePairedDepsJson", () => {
  it("returns empty for null", () => {
    expect(parsePairedDepsJson(null)).toEqual([]);
  });

  it("returns empty for malformed JSON", () => {
    expect(parsePairedDepsJson("not json")).toEqual([]);
  });

  it("returns empty for non-array JSON", () => {
    expect(parsePairedDepsJson(`{"recommendations":[]}`)).toEqual([]);
  });

  it("parses a stored array", () => {
    const parsed = parsePairedDepsJson(JSON.stringify([PAIRED_BUMP]));
    expect(parsed).toEqual([PAIRED_BUMP]);
  });
});

describe("buildBundlePlan", () => {
  it("returns an empty plan with no recommendations", () => {
    const file = makeComposeFile(`services:\n  app:\n    image: nginx:1.27\n`);
    const plan = buildBundlePlan(file, []);
    expect(plan).toEqual({ rewrites: [], skipped: [] });
    rmSync(file, { force: true });
  });

  it("emits a rewrite for a same-image tag bump that still matches the local compose", () => {
    const file = makeComposeFile(
      [
        "services:",
        "  outline:",
        "    image: outlinewiki/outline:0.84.0",
        "  outline-postgres:",
        "    image: postgres:16-alpine",
        "",
      ].join("\n"),
    );
    const plan = buildBundlePlan(file, [PAIRED_BUMP]);
    expect(plan.skipped).toEqual([]);
    expect(plan.rewrites).toEqual([
      {
        serviceName: "outline-postgres",
        currentTag: "16-alpine",
        newTag: "17-alpine",
        label: "outline-postgres (16-alpine → 17-alpine)",
      },
    ]);
    rmSync(file, { force: true });
  });

  it("skips kind=add and kind=image-change without offering an automatic rewrite", () => {
    const file = makeComposeFile(
      `services:\n  outline:\n    image: outlinewiki/outline:0.84.0\n  outline-redis:\n    image: redis:7-alpine\n`,
    );
    const plan = buildBundlePlan(file, [PAIRED_ADD, PAIRED_IMAGE_CHANGE]);
    expect(plan.rewrites).toEqual([]);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped[0].reason).toContain("new dep");
    expect(plan.skipped[1].reason).toContain("image name changed");
    rmSync(file, { force: true });
  });

  it("skips when the local tag has drifted since hold time", () => {
    const file = makeComposeFile(
      `services:\n  outline:\n    image: outlinewiki/outline:0.84.0\n  outline-postgres:\n    image: postgres:16.3-alpine\n`,
    );
    const plan = buildBundlePlan(file, [PAIRED_BUMP]);
    expect(plan.rewrites).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/drifted/);
    rmSync(file, { force: true });
  });

  it("skips when the local service is missing at apply time", () => {
    const file = makeComposeFile(
      `services:\n  outline:\n    image: outlinewiki/outline:0.84.0\n`,
    );
    const plan = buildBundlePlan(file, [PAIRED_BUMP]);
    expect(plan.rewrites).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/not present/);
    rmSync(file, { force: true });
  });
});

describe("formatBundleLog", () => {
  it("returns empty string when nothing to report", () => {
    expect(formatBundleLog({ rewrites: [], skipped: [] })).toBe("");
  });

  it("includes both rewrites and skipped entries", () => {
    const out = formatBundleLog({
      rewrites: [
        {
          serviceName: "db",
          currentTag: "16",
          newTag: "17",
          label: "db (16 → 17)",
        },
      ],
      skipped: [
        {
          upstreamService: "valkey",
          upstreamImage: "valkey/valkey:7",
          reason: "new dep",
        },
      ],
    });
    expect(out).toContain("bundled paired deps: db (16 → 17)");
    expect(out).toContain("paired-dep skipped: valkey");
  });
});

describe("applyOne with bundling", () => {
  it("rewrites primary + paired dep atomically and pulls both services in one command", async () => {
    const file = makeComposeFile(
      [
        "services:",
        "  outline:",
        "    image: outlinewiki/outline:0.84.0",
        "  outline-postgres:",
        "    image: postgres:16-alpine",
        "",
      ].join("\n"),
    );
    const db = openDb({ path: ":memory:" });
    const id = recordUpdate(db, {
      stack: "outline",
      service: "outline",
      image: "outlinewiki/outline:0.84.0",
      currentTag: "0.84.0",
      targetTag: "0.85.0",
      bump: "major",
    });
    setPairedDeps(db, id, JSON.stringify([PAIRED_BUMP]));

    const calls: string[][] = [];
    const runner: CommandRunner = async (_, args) => {
      calls.push(args);
      return { exitCode: 0, combinedOutput: "" };
    };

    const after = await applyOne(
      {
        db,
        composeFiles: { outline: file },
        runner,
        pruneAfterApply: false,
        bundlePairedDeps: true,
      },
      id,
    );

    expect(after.status).toBe("applied");
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("outlinewiki/outline:0.85.0");
    expect(content).toContain("postgres:17-alpine");
    expect(calls[0]).toEqual([
      "compose",
      "-f",
      file,
      "pull",
      "--quiet",
      "outline",
      "outline-postgres",
    ]);
    expect(calls[1]).toEqual([
      "compose",
      "-f",
      file,
      "up",
      "-d",
      "outline",
      "outline-postgres",
    ]);
    expect(after.apply_log).toContain("bundled paired deps: outline-postgres");
    rmSync(file, { force: true });
  });

  it("leaves paired deps alone when bundling is off", async () => {
    const file = makeComposeFile(
      `services:\n  outline:\n    image: outlinewiki/outline:0.84.0\n  outline-postgres:\n    image: postgres:16-alpine\n`,
    );
    const db = openDb({ path: ":memory:" });
    const id = recordUpdate(db, {
      stack: "outline",
      service: "outline",
      image: "outlinewiki/outline:0.84.0",
      currentTag: "0.84.0",
      targetTag: "0.85.0",
      bump: "major",
    });
    setPairedDeps(db, id, JSON.stringify([PAIRED_BUMP]));

    const calls: string[][] = [];
    const runner: CommandRunner = async (_, args) => {
      calls.push(args);
      return { exitCode: 0, combinedOutput: "" };
    };

    const after = await applyOne(
      {
        db,
        composeFiles: { outline: file },
        runner,
        pruneAfterApply: false,
        bundlePairedDeps: false,
      },
      id,
    );

    expect(after.status).toBe("applied");
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("outlinewiki/outline:0.85.0");
    expect(content).toContain("postgres:16-alpine"); // untouched
    expect(calls[0]).not.toContain("outline-postgres");
    rmSync(file, { force: true });
  });

  it("rolls the compose back when a paired-dep rewrite drifts", async () => {
    const file = makeComposeFile(
      `services:\n  outline:\n    image: outlinewiki/outline:0.84.0\n  outline-postgres:\n    image: postgres:16.3-alpine\n`,
    );
    const original = readFileSync(file, "utf-8");
    const db = openDb({ path: ":memory:" });
    const id = recordUpdate(db, {
      stack: "outline",
      service: "outline",
      image: "outlinewiki/outline:0.84.0",
      currentTag: "0.84.0",
      targetTag: "0.85.0",
      bump: "major",
    });
    // Recommendation says "currently 16-alpine" but the live file says
    // "16.3-alpine" → drift, bundle should be skipped (not aborted) since
    // buildBundlePlan filters drifted entries into `skipped`. Verify the
    // primary still applies cleanly and paired dep is left alone.
    setPairedDeps(db, id, JSON.stringify([PAIRED_BUMP]));

    const runner: CommandRunner = async () => ({
      exitCode: 0,
      combinedOutput: "",
    });

    const after = await applyOne(
      {
        db,
        composeFiles: { outline: file },
        runner,
        pruneAfterApply: false,
        bundlePairedDeps: true,
      },
      id,
    );

    expect(after.status).toBe("applied");
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("outlinewiki/outline:0.85.0");
    expect(content).toContain("postgres:16.3-alpine"); // operator's pin preserved
    expect(after.apply_log).toContain("paired-dep skipped");
    expect(content).not.toBe(original); // primary did rewrite
    rmSync(file, { force: true });
  });

  it("rolls the entire bundle back when docker pull fails", async () => {
    const original = [
      "services:",
      "  outline:",
      "    image: outlinewiki/outline:0.84.0",
      "  outline-postgres:",
      "    image: postgres:16-alpine",
      "",
    ].join("\n");
    const file = makeComposeFile(original);
    const db = openDb({ path: ":memory:" });
    const id = recordUpdate(db, {
      stack: "outline",
      service: "outline",
      image: "outlinewiki/outline:0.84.0",
      currentTag: "0.84.0",
      targetTag: "0.85.0",
      bump: "major",
    });
    setPairedDeps(db, id, JSON.stringify([PAIRED_BUMP]));

    const runner: CommandRunner = async () => ({
      exitCode: 1,
      combinedOutput: "boom",
    });

    const after = await applyOne(
      {
        db,
        composeFiles: { outline: file },
        runner,
        pruneAfterApply: false,
        bundlePairedDeps: true,
      },
      id,
    );

    expect(after.status).toBe("failed");
    expect(readFileSync(file, "utf-8")).toBe(original);
    rmSync(file, { force: true });
  });

  it("is a no-op when no paired-deps were persisted", async () => {
    const file = makeComposeFile(
      `services:\n  outline:\n    image: outlinewiki/outline:0.84.0\n`,
    );
    const db = openDb({ path: ":memory:" });
    const id = recordUpdate(db, {
      stack: "outline",
      service: "outline",
      image: "outlinewiki/outline:0.84.0",
      currentTag: "0.84.0",
      targetTag: "0.85.0",
      bump: "major",
    });

    const calls: string[][] = [];
    const runner: CommandRunner = async (_, args) => {
      calls.push(args);
      return { exitCode: 0, combinedOutput: "" };
    };

    const after = await applyOne(
      {
        db,
        composeFiles: { outline: file },
        runner,
        pruneAfterApply: false,
        bundlePairedDeps: true,
      },
      id,
    );
    expect(after.status).toBe("applied");
    expect(calls[0]).toEqual([
      "compose",
      "-f",
      file,
      "pull",
      "--quiet",
      "outline",
    ]);
    const row = findUpdate(db, id)!;
    expect(row.paired_deps_json).toBeNull();
    rmSync(file, { force: true });
  });
});
