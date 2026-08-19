import { dirname, join } from "node:path";
import { chownSync, readdirSync, statSync, type Dirent } from "node:fs";
import { realRunner, type CommandRunner } from "./docker.js";

export interface CommitOptions {
  /** Path to the compose file that was just rewritten. Its parent directory
   *  is the candidate git working copy. */
  composePath: string;
  /** Commit message describing the bump. */
  message: string;
  /** Also `git push` after committing. Default false — local commit only.
   *  A push failure (offline, auth, protected branch) never fails the apply. */
  push?: boolean;
  /** Test seam. Defaults to the real spawn-based runner. */
  runner?: CommandRunner;
  /** Per-git-step timeout. Default 30s. */
  timeoutMs?: number;
}

export interface CommitResult {
  /** true only when a commit was actually created. false when skipped
   *  (not a git working copy, or nothing staged) or on a best-effort failure. */
  committed: boolean;
  /** Human log line for the apply record. Empty when the dir isn't a repo
   *  (the common, silent case for homelabs that don't use working copies). */
  log: string;
}

/**
 * Best-effort: if the directory containing `composePath` is a git working
 * copy, stage the compose file and commit it — so an auto-applied bump lands
 * as a tracked commit instead of leaving the working tree dirty. Opt-in at the
 * call site (default off) so it never surprises deployments that don't keep
 * their stacks under git.
 *
 * NEVER throws — a git failure must not fail the apply (mirrors the prune
 * step). Auto-detects git: a non-working-copy returns `{ committed: false }`
 * silently. Every call passes `-c safe.directory=*` because the bumpsight
 * container runs as root while the stack dirs are owned by an unprivileged
 * uid; git's dubious-ownership guard would otherwise refuse to operate.
 * Commit author comes from the repo's own git config (set when the stack was
 * converted to a working copy) — bumpsight deliberately does not impose one.
 */
export async function commitComposeChange(
  opts: CommitOptions,
): Promise<CommitResult> {
  const runner = opts.runner ?? realRunner;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const dir = dirname(opts.composePath);
  const git = (...args: string[]) =>
    runner("git", ["-C", dir, "-c", "safe.directory=*", ...args], {
      timeoutMs,
    });

  // Auto-detect: only operate inside a real working copy.
  const inside = await git("rev-parse", "--is-inside-work-tree");
  if (inside.exitCode !== 0 || inside.combinedOutput.trim() !== "true") {
    return { committed: false, log: "" };
  }

  const add = await git("add", "--", opts.composePath);
  if (add.exitCode !== 0) {
    return {
      committed: false,
      log: `git: add failed (${add.combinedOutput.trim()})`,
    };
  }

  // `git diff --cached --quiet` exits 0 when nothing is staged. If the apply
  // rewrote the compose back to byte-identical content there's nothing to
  // commit — don't create an empty commit.
  const staged = await git(
    "diff",
    "--cached",
    "--quiet",
    "--",
    opts.composePath,
  );
  if (staged.exitCode === 0) {
    return { committed: false, log: "git: no compose change to commit" };
  }

  const commit = await git("commit", "-m", opts.message, "--", opts.composePath);
  if (commit.exitCode !== 0) {
    return {
      committed: false,
      log: `git: commit failed (${commit.combinedOutput.trim()})`,
    };
  }

  let log = "git: committed compose bump";
  if (opts.push) {
    const push = await git("push");
    log +=
      push.exitCode === 0
        ? " + pushed"
        : ` (push failed: ${push.combinedOutput.trim()})`;
  }
  const reowned = restoreGitOwnership(dir, opts.composePath);
  if (reowned) log += ` (.git re-owned to uid ${reowned})`;
  return { committed: true, log };
}

/**
 * v0.6.4: hand `.git` back to whoever owns the working tree.
 *
 * The container runs as root, so every object, ref and index git writes here
 * lands root-owned inside a repo whose files belong to an unprivileged uid.
 * Nothing breaks immediately — `safe.directory=*` covers our own later runs —
 * but the next commit made by the *human* who owns the stack fails with
 * `insufficient permission for adding an object to repository database`, and
 * only when their change happens to hash into a root-owned object shard. That
 * makes it look intermittent and unrelated to us. A production fleet
 * accumulated this across 28 repos before anyone connected the two.
 *
 * Best-effort and silent: no-ops when we aren't root, when ownership already
 * matches, or on any error. Returns the uid we restored to, or null.
 */
function restoreGitOwnership(dir: string, composePath: string): number | null {
  try {
    if (process.getuid?.() !== 0) return null;
    const target = statSync(composePath);
    const gitDir = join(dir, ".git");
    if (statSync(gitDir).uid === target.uid) return null;
    chownRecursive(gitDir, target.uid, target.gid);
    return target.uid;
  } catch {
    return null;
  }
}

/** Depth-first chown. Swallows per-entry failures so one unreadable path
 *  cannot abort the walk and leave ownership half-restored. */
function chownRecursive(path: string, uid: number, gid: number): void {
  try {
    chownSync(path, uid, gid);
  } catch {
    /* keep going — a single failure must not strand the rest */
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true }) as unknown as Dirent[];
  } catch {
    return;
  }
  for (const e of entries) {
    const child = join(path, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) chownRecursive(child, uid, gid);
    else {
      try {
        chownSync(child, uid, gid);
      } catch {
        /* ignore */
      }
    }
  }
}
