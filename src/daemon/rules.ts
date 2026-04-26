import { parseTag } from "../util/semver.js";

export type BumpKind = "patch" | "minor" | "major" | "unknown";

/**
 * Classify a tag bump into patch / minor / major using the same family
 * detection as scan. Anything that isn't a clean numeric bump within the
 * same family is "unknown" — and "unknown" is never auto-applied.
 */
export function classifyBump(currentTag: string, newTag: string): BumpKind {
  const cur = parseTag(currentTag);
  const next = parseTag(newTag);
  if (cur.family !== next.family) return "unknown";
  if (!cur.numeric || !next.numeric) return "unknown";
  const major = (cur.numeric[0] ?? 0) !== (next.numeric[0] ?? 0);
  const minor = (cur.numeric[1] ?? 0) !== (next.numeric[1] ?? 0);
  if (major) return "major";
  if (minor) return "minor";
  return "patch";
}

/** Per-stack policy. `notify` always holds for human approval. `none` skips. */
export type BumpAction = "patch" | "minor" | "major" | "notify" | "none";

export interface RulesConfig {
  /** Default policy applied when a stack has no explicit override. */
  default: BumpAction;
  /** Per-stack overrides keyed by stack name (compose project / directory). */
  stacks: Record<string, BumpAction>;
}

export type Decision = "auto-apply" | "hold" | "skip";

/**
 * Decide what to do with a discovered bump.
 *
 *   patch  → auto-apply patches only.
 *   minor  → auto-apply patches and minors.
 *   major  → auto-apply everything classified.
 *   notify → never auto-apply; hold for human approval.
 *   none   → ignore.
 *
 * `unknown` bumps are always held — we can't reason about them safely.
 */
export function decideAction(
  config: RulesConfig,
  stack: string,
  bump: BumpKind,
): Decision {
  const action = config.stacks[stack] ?? config.default;
  if (action === "none") return "skip";
  if (action === "notify") return "hold";
  if (bump === "unknown") return "hold";
  const allowed: Record<Exclude<BumpAction, "notify" | "none">, BumpKind[]> = {
    patch: ["patch"],
    minor: ["patch", "minor"],
    major: ["patch", "minor", "major"],
  };
  return allowed[action].includes(bump) ? "auto-apply" : "hold";
}
