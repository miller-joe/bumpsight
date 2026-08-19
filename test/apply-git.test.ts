import { describe, it, expect } from "vitest";
import { commitComposeChange } from "../src/apply/git.js";
import type {
  CommandRunner,
  DockerCommandResult,
} from "../src/apply/docker.js";

const OK = (out = ""): DockerCommandResult => ({
  exitCode: 0,
  combinedOutput: out,
});
const FAIL = (out = ""): DockerCommandResult => ({
  exitCode: 1,
  combinedOutput: out,
});

/**
 * A CommandRunner that dispatches on the git subcommand. Calls always look
 * like: git -C <dir> -c safe.directory=* <subcmd> ...  → args[4] is the
 * subcommand. Records every call for assertions.
 */
function makeGitRunner(script: Record<string, DockerCommandResult>) {
  const calls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    expect(command).toBe("git");
    const sub = args[4];
    const res = script[sub];
    if (!res) throw new Error(`unscripted git subcommand: ${sub}`);
    return res;
  };
  return { runner, calls };
}

describe("commitComposeChange", () => {
  it("does not touch repo ownership unless explicitly opted in", async () => {
    // The chown is gated on restoreOwnership. Left off (the default), the
    // commit path must behave exactly as before and never mention re-owning —
    // a public tool must not rewrite ownership of a repo it did not create.
    const { runner } = makeGitRunner({
      "rev-parse": OK("true\n"),
      add: OK(),
      diff: FAIL(),
      commit: OK(),
    });
    const res = await commitComposeChange({
      composePath: "/nonexistent/stack/compose.yaml",
      message: "bump",
      runner,
    });
    expect(res.committed).toBe(true);
    expect(res.log).not.toContain("re-owned");
  });

  it("opting in never fails the commit, even when the chown cannot run", async () => {
    // Non-root test process + a path that does not exist: restoreGitOwnership
    // must swallow both and leave the commit result intact.
    const { runner } = makeGitRunner({
      "rev-parse": OK("true\n"),
      add: OK(),
      diff: FAIL(),
      commit: OK(),
    });
    const res = await commitComposeChange({
      composePath: "/nonexistent/stack/compose.yaml",
      message: "bump",
      restoreOwnership: true,
      runner,
    });
    expect(res.committed).toBe(true);
    expect(res.log).toContain("committed compose bump");
  });

  it("commits a staged compose change inside a working copy", async () => {
    const { runner, calls } = makeGitRunner({
      "rev-parse": OK("true\n"),
      add: OK(),
      diff: FAIL(), // exit 1 = something is staged
      commit: OK("[main abc1234] mailrise: bump\n"),
    });
    const r = await commitComposeChange({
      composePath: "/mnt/ramjet/docker/stacks/mailrise/compose.yaml",
      message: "mailrise: bump mailrise 1 -> 2",
      runner,
    });
    expect(r.committed).toBe(true);
    expect(r.log).toContain("committed");
    // -C <dir> and safe.directory=* are always passed
    expect(calls[0]).toEqual([
      "git",
      "-C",
      "/mnt/ramjet/docker/stacks/mailrise",
      "-c",
      "safe.directory=*",
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    expect(calls.some((c) => c.includes("commit"))).toBe(true);
  });

  it("skips silently when the dir is not a git working copy", async () => {
    const { runner, calls } = makeGitRunner({
      "rev-parse": FAIL("fatal: not a git repository\n"),
    });
    const r = await commitComposeChange({
      composePath: "/stacks/foo/compose.yaml",
      message: "m",
      runner,
    });
    expect(r.committed).toBe(false);
    expect(r.log).toBe("");
    expect(
      calls.some((c) => c.includes("add") || c.includes("commit")),
    ).toBe(false);
  });

  it("does not create an empty commit when nothing is staged", async () => {
    const { runner, calls } = makeGitRunner({
      "rev-parse": OK("true\n"),
      add: OK(),
      diff: OK(), // exit 0 = nothing staged
    });
    const r = await commitComposeChange({
      composePath: "/stacks/foo/compose.yaml",
      message: "m",
      runner,
    });
    expect(r.committed).toBe(false);
    expect(r.log).toContain("no compose change");
    expect(calls.some((c) => c.includes("commit"))).toBe(false);
  });

  it("is best-effort: a failed commit is logged, not thrown", async () => {
    const { runner } = makeGitRunner({
      "rev-parse": OK("true\n"),
      add: OK(),
      diff: FAIL(),
      commit: FAIL("Author identity unknown\n"),
    });
    const r = await commitComposeChange({
      composePath: "/stacks/foo/compose.yaml",
      message: "m",
      runner,
    });
    expect(r.committed).toBe(false);
    expect(r.log).toContain("commit failed");
  });

  it("pushes after committing when push:true", async () => {
    const { runner, calls } = makeGitRunner({
      "rev-parse": OK("true\n"),
      add: OK(),
      diff: FAIL(),
      commit: OK(),
      push: OK(),
    });
    const r = await commitComposeChange({
      composePath: "/stacks/foo/compose.yaml",
      message: "m",
      push: true,
      runner,
    });
    expect(r.committed).toBe(true);
    expect(r.log).toContain("pushed");
    expect(calls.some((c) => c.includes("push"))).toBe(true);
  });
});
