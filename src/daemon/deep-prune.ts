import { runDeepPrune, type DeepPruneOptions } from "../apply/deep-prune.js";
import type { CommandRunner } from "../apply/docker.js";

/**
 * v0.5.2: scheduled deep-prune runtime.
 *
 * Fires the prune pipeline every `intervalMs`, with the first run starting
 * after `startupDelayMs` so the daemon's startup log flushes ahead of it.
 * On each tick we log a single summary line:
 *
 *     deep-prune: freed ~5.4GB (image=4.2GB volume=120MB builder=1.1GB)
 *
 * Failures inside `runDeepPrune` are caught and logged but do not stop the
 * scheduler — a transient docker socket hiccup shouldn't permanently disable
 * the cleanup loop.
 */

export interface DeepPruneSchedulerDeps {
  intervalMs: number;
  log: (msg: string) => void;
  runner?: CommandRunner;
  pruneOptions?: DeepPruneOptions;
  /** Initial delay before the first run. Defaults to 30s. Set to 0 to run
   *  immediately (used by tests). */
  startupDelayMs?: number;
}

export interface DeepPruneRuntime {
  stop(): Promise<void>;
  /** Force one prune pass — used by tests / manual triggers. */
  runOnce(): Promise<void>;
}

export function startDeepPruneScheduler(
  deps: DeepPruneSchedulerDeps,
): DeepPruneRuntime {
  let stopping = false;
  let inFlight: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;

  const runOnce = async () => {
    try {
      const result = await runDeepPrune({
        runner: deps.runner,
        ...(deps.pruneOptions ?? {}),
      });
      deps.log(result.summary);
      for (const step of result.steps) {
        if (!step.ok) {
          const firstLine = step.output.split("\n")[0]?.slice(0, 200) ?? "";
          deps.log(`deep-prune-step-failed: ${step.step}: ${firstLine}`);
        }
      }
    } catch (err) {
      deps.log(`deep-prune-failed: ${(err as Error).message}`);
    }
  };

  const tick = async () => {
    if (stopping) return;
    inFlight = runOnce();
    await inFlight;
    if (!stopping) {
      timer = setTimeout(tick, deps.intervalMs);
    }
  };

  const startupDelay = deps.startupDelayMs ?? 30_000;
  timer = setTimeout(tick, startupDelay);

  return {
    stop: async () => {
      stopping = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
    runOnce,
  };
}
