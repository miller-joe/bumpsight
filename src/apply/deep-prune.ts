import type { CommandRunner } from "./docker.js";
import { realRunner } from "./docker.js";

/**
 * v0.5.2: scheduled deep prune.
 *
 * Complements the post-apply targeted prune from v0.4.2. The targeted prune
 * only runs after a successful apply and only removes the just-replaced image
 * tag — it never touches dangling layers from cancelled builds, orphaned
 * volumes, or the buildx cache. Over weeks of churn those accumulate (Joe
 * reclaimed 52.6 GB manually after a few months of homelab churn).
 *
 * The scheduler is opt-in via `BUMPSIGHT_PRUNE_SCHEDULE` (an interval like
 * `7d`). Off by default per the "ships to other people's homelabs, defaults
 * must work zero-config" principle.
 *
 * Three steps run in order; failures don't abort the next step:
 *   1. `docker image prune --filter until=168h -af` — remove all dangling
 *      images, plus tagged images older than 168h that no container references.
 *   2. `docker volume prune -f` — remove anonymous volumes not in use by any
 *      container.
 *   3. `docker builder prune -af` — clear the buildx cache.
 *
 * Reclaimed bytes are parsed from each command's output. Image + volume
 * prune emit `Total reclaimed space: 1.23GB`; buildx emits `Total: 1.23GB`.
 */

export interface DeepPruneOptions {
  runner?: CommandRunner;
  /** Override the `until=168h` filter for image prune. Default `168h`. */
  imageAgeFilter?: string;
  /** When true, skip volume prune. Volumes are riskier (anonymous volumes
   *  may hold real data); operators who want extra safety can opt out. */
  skipVolumes?: boolean;
  /** When true, skip builder prune. */
  skipBuilder?: boolean;
}

export interface PruneStepResult {
  step: "image" | "volume" | "builder";
  ok: boolean;
  reclaimedBytes: number;
  output: string;
}

export interface DeepPruneResult {
  steps: PruneStepResult[];
  totalReclaimedBytes: number;
  /** Single human-readable summary line for daemon log + email. */
  summary: string;
}

const DOCKER_TIMEOUT_MS = 5 * 60_000;

export async function runDeepPrune(
  opts: DeepPruneOptions = {},
): Promise<DeepPruneResult> {
  const runner = opts.runner ?? realRunner;
  const ageFilter = opts.imageAgeFilter ?? "168h";
  const steps: PruneStepResult[] = [];

  steps.push(
    await runStep(
      runner,
      "image",
      ["image", "prune", `--filter`, `until=${ageFilter}`, "-af"],
    ),
  );
  if (!opts.skipVolumes) {
    steps.push(await runStep(runner, "volume", ["volume", "prune", "-f"]));
  }
  if (!opts.skipBuilder) {
    steps.push(await runStep(runner, "builder", ["builder", "prune", "-af"]));
  }

  const totalReclaimedBytes = steps.reduce(
    (acc, s) => acc + s.reclaimedBytes,
    0,
  );
  const totalLabel = formatBytes(totalReclaimedBytes);
  const stepLabels = steps
    .map(
      (s) =>
        `${s.step}=${s.ok ? formatBytes(s.reclaimedBytes) : "failed"}`,
    )
    .join(" ");
  const summary = `deep-prune: freed ~${totalLabel} (${stepLabels})`;

  return { steps, totalReclaimedBytes, summary };
}

async function runStep(
  runner: CommandRunner,
  step: PruneStepResult["step"],
  args: string[],
): Promise<PruneStepResult> {
  const r = await runner("docker", args, { timeoutMs: DOCKER_TIMEOUT_MS });
  if (r.exitCode !== 0) {
    return {
      step,
      ok: false,
      reclaimedBytes: 0,
      output: r.combinedOutput,
    };
  }
  return {
    step,
    ok: true,
    reclaimedBytes: parseReclaimed(r.combinedOutput),
    output: r.combinedOutput,
  };
}

/**
 * Pull the reclaimed-bytes total out of a `docker prune` output.
 *
 *   image / volume:  `Total reclaimed space: 5.36GB`
 *   builder:         `Total:  1.5GB`
 *
 * Returns 0 when no recognizable line is present (older docker, empty prune,
 * or future format change). Never throws.
 */
export function parseReclaimed(output: string): number {
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(
      /^\s*Total(?:\s+reclaimed\s+space)?:\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGTP]?B)\s*$/i,
    );
    if (m) {
      const value = Number(m[1]);
      const unit = m[2]!.toUpperCase();
      const factor = UNIT_FACTORS[unit] ?? 1;
      return Math.round(value * factor);
    }
  }
  return 0;
}

const UNIT_FACTORS: Record<string, number> = {
  B: 1,
  KB: 1_000,
  MB: 1_000_000,
  GB: 1_000_000_000,
  TB: 1_000_000_000_000,
  PB: 1_000_000_000_000_000,
};

function formatBytes(n: number): string {
  if (n <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}
