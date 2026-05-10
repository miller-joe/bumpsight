import { spawn } from "node:child_process";

export interface DockerCommandResult {
  exitCode: number;
  combinedOutput: string;
}

/**
 * Indirection point for tests: a function that runs a command and returns
 * its exit code + combined stdout/stderr. The default implementation
 * shells out to `docker` via child_process.spawn.
 */
export type CommandRunner = (
  command: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<DockerCommandResult>;

export const realRunner: CommandRunner = async (command, args, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (b) => (buffer += b.toString()));
    child.stderr.on("data", (b) => (buffer += b.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      const exit = killed ? 124 : (code ?? 1);
      resolve({ exitCode: exit, combinedOutput: buffer });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        combinedOutput: buffer + `\n${(err as Error).message}\n`,
      });
    });
  });
};

export interface ApplyOptions {
  composePath: string;
  /** Service to operate on. v0.5.4 accepts an array so paired-dep bundling
   *  can pull + restart the primary and its bundled deps in the same step. */
  serviceName: string | string[];
  /** Per-step timeout in milliseconds. Default 10 minutes. */
  timeoutMs?: number;
  /** Test indirection. Defaults to the real spawn-based runner. */
  runner?: CommandRunner;
}

export interface ApplyResult {
  ok: boolean;
  pull: DockerCommandResult;
  up?: DockerCommandResult;
  log: string;
}

/**
 * Run `docker compose -f <file> pull <service>` then `... up -d <service>`.
 * Stops at the first failure and returns the combined log. The caller is
 * expected to have already rewritten the compose file's image tag.
 */
export async function pullAndUp(opts: ApplyOptions): Promise<ApplyResult> {
  const runner = opts.runner ?? realRunner;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const services = Array.isArray(opts.serviceName)
    ? opts.serviceName
    : [opts.serviceName];

  // --quiet suppresses the per-layer progress redraws. Without a TTY,
  // compose's "plain" progress mode emits each redraw as a fresh newline
  // (e.g. `xxxxxxxxxxxx Downloading [=>  ] 96.53MB/3.862GB` 100s of times),
  // which on a multi-GB pull can balloon the captured log past 100KB and
  // the resulting hold-email past 250KB. With --quiet, stdout is empty on
  // success and errors still surface on stderr.
  const pull = await runner(
    "docker",
    ["compose", "-f", opts.composePath, "pull", "--quiet", ...services],
    { timeoutMs },
  );
  if (pull.exitCode !== 0) {
    return {
      ok: false,
      pull,
      log: formatStep("pull", pull),
    };
  }

  const up = await runner(
    "docker",
    ["compose", "-f", opts.composePath, "up", "-d", ...services],
    { timeoutMs },
  );
  return {
    ok: up.exitCode === 0,
    pull,
    up,
    log: formatStep("pull", pull) + "\n" + formatStep("up", up),
  };
}

function formatStep(label: string, r: DockerCommandResult): string {
  const head = `==== docker compose ${label} (exit ${r.exitCode}) ====`;
  return `${head}\n${r.combinedOutput.trimEnd()}`;
}
