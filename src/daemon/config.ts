import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { BumpAction, PolicyAxes, RulesConfig } from "./rules.js";

export interface DaemonConfig {
  /** Where the SQLite state file lives. */
  dbPath: string;
  /** Compose files to scan. Each entry is mapped to a stack name (basename of dir). */
  composeFiles: string[];
  /** How often the scan loop runs. Milliseconds. */
  intervalMs: number;
  /** Minimum gap between dispatched notifications, in ms. 0 disables rate limiting.
   *  Defaults to 10s — enough to keep MXroute and similar relays from throttling. */
  notifyIntervalMs: number;
  /** Notifier URIs (smtp://…, apprise://…). Empty array disables notifications. */
  notifyUris: string[];
  /** Bump policy. */
  rules: RulesConfig;
  /** Bind port for the approve/deny HTTP server. */
  httpPort: number;
  /** Bind interface for the HTTP server (default 0.0.0.0). */
  httpHost: string;
  /** Public-facing base URL embedded in approve/deny links inside notifications.
   *  When unset, links are omitted from notifications. */
  publicUrl?: string;
  /** OpenAI-compatible LLM endpoint URL (ends in /v1). When unset, advise is skipped.
   *  Works with Ollama (built-in OpenAI compat) and LiteLLM. */
  llmUrl?: string;
  /** Optional bearer token for the LLM endpoint. Required for LiteLLM, OpenAI, etc. */
  llmKey?: string;
  /** Model name to send. For Ollama: e.g. `qwen2.5:14b-instruct`. For LiteLLM: an alias like `smart`. */
  llmModel?: string;
  /** Optional GitHub token used by advise to fetch upstream release notes
   *  without hitting the unauthenticated-rate-limit. */
  githubToken?: string;
  /** v0.4.1: directory to archive every dispatched email to. When set,
   *  each notifyAll call writes a JSON record under this dir so a human
   *  / Claude can audit what was actually sent. Best-effort. */
  outboxDir?: string;
  /** Most recent N outbox files to keep. Default 200. */
  outboxKeepCount?: number;
  /** v0.4.3: hour-of-day (0-23, local TZ) the daily-digest email fires.
   *  Default 18. Set to a negative number to disable. */
  digestHour: number;
}

/**
 * Raw shape of bumpsight.yaml. Accepts BOTH the new v0.4.0 split-axis
 * format AND the legacy single-axis format (deprecated, auto-migrated):
 *
 *   # NEW (v0.4.0+):
 *   default: { app: minor, dependencies: none }
 *   stacks: { vault: { app: patch, dependencies: none } }
 *
 *   # LEGACY (v0.3.x and earlier — still works, mapped at load time):
 *   default: minor
 *   stacks: { vault: patch }
 *
 * Legacy single-axis values are mapped to `{ app: <value>, dependencies: none }`
 * — v0.5.0 changed the philosophy here: dep images (Postgres / Redis / MariaDB
 * / Vault / etc.) follow the parent app's release cadence; bumpsight does not
 * surface independent dep tag changes by default. Set `dependencies` explicitly
 * if you want them tracked.
 * `report` (legacy) becomes `notify` (it was an underused FYI variant).
 */
export type LegacyOrNewAction = BumpAction | "report" | PolicyAxes;

export interface FileConfigShape {
  default?: LegacyOrNewAction;
  stacks?: Record<string, LegacyOrNewAction>;
  /** Optional explicit allowlist. When set, overrides auto-discovery. */
  compose_files?: string[];
  /** Root directory scanned by auto-discovery. Defaults to /stacks. */
  stacks_dir?: string;
  interval?: string;
  notify_interval?: string;
  db_path?: string;
  notify?: string[];
  http_port?: number;
  http_host?: string;
  public_url?: string;
  ollama?: { host?: string; model?: string };
  outbox_dir?: string;
  outbox_keep_count?: number;
  digest_hour?: number;
}

const VALID_ACTIONS: BumpAction[] = ["patch", "minor", "major", "notify", "none"];
const DEPRECATED_ACTIONS = new Set(["report"]);

export function loadConfigFile(path: string): FileConfigShape {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as unknown;
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object") {
    throw new Error(`${path}: top-level must be a mapping`);
  }
  return parsed as FileConfigShape;
}

function parseAction(
  value: string,
  where: string,
  log?: (msg: string) => void,
): BumpAction {
  if (DEPRECATED_ACTIONS.has(value)) {
    log?.(
      `${where}: legacy action "${value}" auto-migrated to "notify" (drop-it from your config when convenient)`,
    );
    return "notify";
  }
  if (!VALID_ACTIONS.includes(value as BumpAction)) {
    throw new Error(
      `${where}: invalid action "${value}" (expected ${VALID_ACTIONS.join(" | ")})`,
    );
  }
  return value as BumpAction;
}

/**
 * Normalize a single config-file value (old single-string OR new {app,deps}
 * object) into the new PolicyAxes shape. Legacy strings map to
 * `{ app: <value>, dependencies: "none" }` — v0.5.0 silences deps by default.
 * Set `dependencies` explicitly in the new {app, dependencies} format if you
 * want bumpsight to surface independent dep tag changes.
 */
function normalizeAxes(
  value: LegacyOrNewAction,
  where: string,
  log?: (msg: string) => void,
): PolicyAxes {
  if (typeof value === "string") {
    const a = parseAction(value, where, log);
    return { app: a, dependencies: "none" };
  }
  if (value && typeof value === "object") {
    const app = parseAction(
      (value as PolicyAxes).app ?? "major",
      `${where}.app`,
      log,
    );
    const dependencies = parseAction(
      (value as PolicyAxes).dependencies ?? "none",
      `${where}.dependencies`,
      log,
    );
    return { app, dependencies };
  }
  throw new Error(`${where}: expected a string action or {app, dependencies} object`);
}

export interface BuildRulesOpts {
  envDefault?: string;
  envApp?: string;
  envDependencies?: string;
  log?: (msg: string) => void;
}

export function buildRulesConfig(
  fileShape: FileConfigShape,
  optsOrEnvDefault?: BuildRulesOpts | string,
): RulesConfig {
  const opts: BuildRulesOpts =
    typeof optsOrEnvDefault === "string"
      ? { envDefault: optsOrEnvDefault }
      : (optsOrEnvDefault ?? {});
  const log = opts.log;

  // Default policy resolution (in priority order):
  //   1. New env vars (BUMPSIGHT_AUTO_UPDATE_APP / BUMPSIGHT_AUTO_UPDATE_DEPENDENCIES)
  //   2. Legacy env var (BUMPSIGHT_AUTO_APPLY) — applies to the app axis only;
  //      deps stay on their own default ('none') unless explicitly overridden.
  //   3. File default (new {app,deps} object OR legacy single string)
  //   4. Hard fallback: { app: "major", dependencies: "none" }
  //
  // v0.5.0 changed the hard fallback from {notify, notify} to {major, none} —
  // a Watchtower-like auto-everything for the primary service, and silent for
  // dep images (Postgres / Redis / MariaDB / Vault / etc.) since those follow
  // the parent app's release cadence. Operators who want the old "ask about
  // every bump" behavior should set `default: notify` in their config.
  let defaultAxes: PolicyAxes = { app: "major", dependencies: "none" };
  if (fileShape.default !== undefined) {
    defaultAxes = normalizeAxes(fileShape.default, "config.default", log);
  }
  if (opts.envDefault) {
    const a = parseAction(opts.envDefault, "BUMPSIGHT_AUTO_APPLY", log);
    // v0.5.0: legacy env applies to the app axis only. Pre-v0.5.0 it set
    // both axes to the same value, but that contradicts the new "deps follow
    // parent app" philosophy — operators who actually want the env to drive
    // both should set BUMPSIGHT_AUTO_UPDATE_APP and BUMPSIGHT_AUTO_UPDATE_DEPENDENCIES.
    defaultAxes = { app: a, dependencies: defaultAxes.dependencies };
  }
  if (opts.envApp) {
    defaultAxes.app = parseAction(opts.envApp, "BUMPSIGHT_AUTO_UPDATE_APP", log);
  }
  if (opts.envDependencies) {
    defaultAxes.dependencies = parseAction(
      opts.envDependencies,
      "BUMPSIGHT_AUTO_UPDATE_DEPENDENCIES",
      log,
    );
  }

  const stacks: Record<string, PolicyAxes> = {};
  if (fileShape.stacks) {
    for (const [name, action] of Object.entries(fileShape.stacks)) {
      stacks[name] = normalizeAxes(action, `config.stacks.${name}`, log);
    }
  }

  return { default: defaultAxes, stacks };
}
