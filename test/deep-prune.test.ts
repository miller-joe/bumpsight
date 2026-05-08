import { describe, it, expect } from "vitest";
import {
  parseReclaimed,
  runDeepPrune,
} from "../src/apply/deep-prune.js";
import {
  startDeepPruneScheduler,
} from "../src/daemon/deep-prune.js";
import type { CommandRunner } from "../src/apply/docker.js";

describe("parseReclaimed", () => {
  it("parses image/volume prune format with GB", () => {
    expect(parseReclaimed("Total reclaimed space: 5.36GB")).toBe(5_360_000_000);
  });

  it("parses MB", () => {
    expect(parseReclaimed("Total reclaimed space: 120MB")).toBe(120_000_000);
  });

  it("parses kB", () => {
    expect(parseReclaimed("Total reclaimed space: 800KB")).toBe(800_000);
  });

  it("parses plain B", () => {
    expect(parseReclaimed("Total reclaimed space: 0B")).toBe(0);
  });

  it("parses builder prune format (Total: <size>)", () => {
    expect(parseReclaimed("foo\nbar\nTotal:  1.5GB\n")).toBe(1_500_000_000);
  });

  it("returns 0 when no recognizable line is present", () => {
    expect(parseReclaimed("nothing here")).toBe(0);
    expect(parseReclaimed("")).toBe(0);
  });

  it("handles surrounding whitespace and case", () => {
    expect(parseReclaimed("  total reclaimed space:  2GB  ")).toBe(
      2_000_000_000,
    );
  });
});

describe("runDeepPrune", () => {
  it("invokes image, volume, and builder prune in order", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      return { exitCode: 0, combinedOutput: "Total reclaimed space: 1GB\n" };
    };
    const result = await runDeepPrune({ runner });

    expect(calls.length).toBe(3);
    expect(calls[0]).toEqual([
      "image",
      "prune",
      "--filter",
      "until=168h",
      "-af",
    ]);
    expect(calls[1]).toEqual(["volume", "prune", "-f"]);
    expect(calls[2]).toEqual(["builder", "prune", "-af"]);

    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(result.totalReclaimedBytes).toBe(3_000_000_000);
    expect(result.summary).toContain("freed ~3.0GB");
    expect(result.summary).toContain("image=1.0GB");
    expect(result.summary).toContain("volume=1.0GB");
    expect(result.summary).toContain("builder=1.0GB");
  });

  it("respects custom imageAgeFilter", async () => {
    let firstArgs: string[] = [];
    let calls = 0;
    const runner: CommandRunner = async (_cmd, args) => {
      if (calls === 0) firstArgs = args;
      calls += 1;
      return { exitCode: 0, combinedOutput: "Total reclaimed space: 0B" };
    };
    await runDeepPrune({ runner, imageAgeFilter: "24h" });
    expect(firstArgs).toContain("until=24h");
  });

  it("skipVolumes / skipBuilder skip those steps", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      return { exitCode: 0, combinedOutput: "Total reclaimed space: 0B" };
    };
    await runDeepPrune({ runner, skipVolumes: true, skipBuilder: true });
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe("image");
  });

  it("records a step as failed without aborting subsequent steps", async () => {
    let n = 0;
    const runner: CommandRunner = async () => {
      n += 1;
      if (n === 2) {
        return { exitCode: 1, combinedOutput: "Error: docker daemon: foo" };
      }
      return { exitCode: 0, combinedOutput: "Total reclaimed space: 100MB" };
    };
    const result = await runDeepPrune({ runner });
    expect(result.steps.length).toBe(3);
    expect(result.steps[0]!.ok).toBe(true);
    expect(result.steps[1]!.ok).toBe(false);
    expect(result.steps[2]!.ok).toBe(true);
    expect(result.totalReclaimedBytes).toBe(200_000_000);
    expect(result.summary).toContain("volume=failed");
  });
});

describe("startDeepPruneScheduler", () => {
  it("runs immediately when startupDelayMs=0 and emits the summary line", async () => {
    const lines: string[] = [];
    const runner: CommandRunner = async () => ({
      exitCode: 0,
      combinedOutput: "Total reclaimed space: 100MB\n",
    });
    const runtime = startDeepPruneScheduler({
      intervalMs: 60_000,
      log: (m) => lines.push(m),
      runner,
      startupDelayMs: 0,
    });
    // Wait for the scheduled tick to actually run.
    await new Promise((r) => setTimeout(r, 20));
    await runtime.stop();
    expect(lines.some((l) => l.startsWith("deep-prune: freed"))).toBe(true);
  });

  it("logs a per-step failure line when a docker step fails", async () => {
    const lines: string[] = [];
    let n = 0;
    const runner: CommandRunner = async () => {
      n += 1;
      if (n === 1) {
        return {
          exitCode: 1,
          combinedOutput: "Error response from daemon: nope\n",
        };
      }
      return { exitCode: 0, combinedOutput: "Total reclaimed space: 50MB" };
    };
    const runtime = startDeepPruneScheduler({
      intervalMs: 60_000,
      log: (m) => lines.push(m),
      runner,
      startupDelayMs: 0,
    });
    await new Promise((r) => setTimeout(r, 20));
    await runtime.stop();
    expect(
      lines.some((l) => l.startsWith("deep-prune-step-failed: image:")),
    ).toBe(true);
  });

  it("runOnce fires the prune outside of the scheduler tick", async () => {
    let calls = 0;
    const runner: CommandRunner = async () => {
      calls += 1;
      return { exitCode: 0, combinedOutput: "Total reclaimed space: 0B" };
    };
    const runtime = startDeepPruneScheduler({
      intervalMs: 60_000,
      log: () => {},
      runner,
      // Pick a delay long enough that the scheduled tick won't fire during the test.
      startupDelayMs: 60_000,
    });
    await runtime.runOnce();
    await runtime.stop();
    // 3 docker calls (image + volume + builder) per pass.
    expect(calls).toBe(3);
  });
});
