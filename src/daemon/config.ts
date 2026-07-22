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
  /** v0.5.2: scheduled deep-prune interval in ms. 0 disables. Off by default
   *  per the "ships to other people's homelabs, defaults must work zero-config"
   *  principle — operators opt in via BUMPSIGHT_PRUNE_SCHEDULE. */
  pruneIntervalMs: number;
  /** v0.5.4: when bundling is enabled for a stack, an Approve on an app-major
   *  bump triggers atomic dep-pin rewrites alongside the app pin (drawing from
   *  the paired-dep recommendations the v0.5.0 lookup captured at hold time).
   *  Defaulted off — `add` / `image-change` recommendations are never bundled
   *  automatically (those need operator judgment); only same-image tag bumps
   *  ride along with the parent. */
  applyPairedDeps: ApplyPairedDepsConfig;
  /** v0.5.7: opt-in non-Docker upstreams to watch via GitHub Releases (e.g. a
   *  manually-pinned binary like git-lfs that has no compose image: line).
   *  Notify-only — bumpsight can't apply a host binary. Empty by default. */
  watchedReleases: WatchedReleaseSpec[];
  /** v0.5.7: how often the watched-releases poll runs. Milliseconds. Only used
   *  when watchedReleases is non-empty. */
  watchIntervalMs: number;
  /** v0.6.0: how loud email is. The GUI/DB is always the primary log; this only
   *  controls the email channel.
   *    all    — per-event hold + applied emails AND the daily digest (the
   *             pre-v0.6.0 behavior).
   *    digest — no per-event emails; only the daily digest (which now carries a
   *             "needs your decision" nudge). The new default — GUI-first.
   *    off    — never email; the dashboard is the only surface. */
  notifyMode: NotifyMode;
  /** v0.6.0: optional shared secret gating the dashboard + POST action routes.
   *  Unset (default) leaves the server open, matching the pre-v0.6.0 LAN-only
   *  posture. The email approve/deny GET links are never gated by this. */
  uiToken?: string;
}

/** v0.6.0: email verbosity. See DaemonConfig.notifyMode. */
export type NotifyMode = "off" | "digest" | "all";

/**
 * v0.5.7: a resolved watched-release entry. The operator declares the upstream
 * GitHub repo and the version they currently have installed; bumpsight polls
 * releases and emails (notify-only) when a newer one appears.
 */
export interface WatchedReleaseSpec {
  /** "owner/repo" as written in config — the dedup/state key. */
  repo: string;
  owner: string;
  repoName: string;
  /** Display label in the email. Defaults to the repo name. */
  name: string;
  /** Operator-declared installed version (bare, e.g. "3.6.1"). */
  current: string;
  /** notify (default) emails on a newer release; none disables without
   *  removing the entry. (No auto-apply — bumpsight can't install a host
   *  binary, so patch/minor/major would be meaningless here.) */
  policy: "notify" | "none";
  /** When false (default), GitHub pre-releases are ignored. */
  includePrerelease: boolean;
}

export interface ApplyPairedDepsConfig {
  /** Global default. Off unless explicitly enabled. */
  default: boolean;
  /** Per-stack overrides. Wins over `default` when present. */
  stacks: Record<string, boolean>;
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
  /** v0.5.2: schedule deep prune (image/volume/builder). Same duration syntax
   *  as `interval`. Empty/missing disables. */
  prune_schedule?: string;
  /** v0.5.4: opt-in apply-time bundling of paired dep changes. Either a bare
   *  boolean (default for every stack) or `{ default?: boolean, stacks?: {…} }`
   *  for per-stack control. Off when missing. */
  apply_paired_deps?: boolean | ApplyPairedDepsFileShape;
  /** v0.5.7: opt-in non-Docker upstreams to watch via GitHub Releases. */
  watched_releases?: WatchedReleaseFileShape[];
  /** v0.5.7: poll cadence for watched_releases (same duration syntax as
   *  `interval`). Defaults to the scan interval when unset. */
  watch_interval?: string;
  /** v0.6.0: email verbosity — off | digest | all. Default `digest`. */
  notify_mode?: string;
  /** v0.6.0: optional shared secret gating the dashboard + POST actions. */
  ui_token?: string;
}

export interface WatchedReleaseFileShape {
  /** "owner/repo" on GitHub. Required. */
  repo?: string;
  /** Installed version. Required. */
  current?: string | number;
  /** Display label. Defaults to the repo name. */
  name?: string;
  /** "notify" (default) or "none". */
  policy?: string;
  /** Track pre-releases too. Default false. */
  include_prerelease?: boolean;
}

export interface ApplyPairedDepsFileShape {
  default?: boolean;
  stacks?: Record<string, boolean>;
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
      (value as PolicyAxes).app ?? "minor",
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
  //   4. Hard fallback: { app: "minor", dependencies: "none" }
  //
  // v0.5.x default: auto-apply patch + minor on the primary service, hold
  // majors for human approval, and stay silent on dep images (Postgres /
  // Redis / MariaDB / Vault / etc.) since those follow the parent app's
  // release cadence. Pre-v0.5.0 was {notify, notify}; v0.5.0 briefly tried
  // {major, none} (Watchtower-like, auto-everything-including-major) but
  // that was too aggressive — semver explicitly flags majors as potentially
  // breaking, so they should land in front of a human. v0.5.1 settled on
  // {minor, none}. Operators who want the old "ask about every bump"
  // behavior should set `default: { app: notify, dependencies: notify }`.
  let defaultAxes: PolicyAxes = { app: "minor", dependencies: "none" };
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

/**
 * v0.5.4: resolve the apply-paired-deps opt-in config. Three sources, last
 * wins (so an env override beats config beats hard-coded default):
 *   1. Hard default → `{ default: false, stacks: {} }`
 *   2. `apply_paired_deps` in bumpsight.yaml (boolean OR `{default,stacks}`)
 *   3. `BUMPSIGHT_APPLY_PAIRED_DEPS` env var → overrides default only
 */
export function buildApplyPairedDepsConfig(
  fileShape: FileConfigShape,
  envValue: string | undefined,
  log?: (msg: string) => void,
): ApplyPairedDepsConfig {
  let cfg: ApplyPairedDepsConfig = { default: false, stacks: {} };
  if (fileShape.apply_paired_deps !== undefined) {
    if (typeof fileShape.apply_paired_deps === "boolean") {
      cfg = { default: fileShape.apply_paired_deps, stacks: {} };
    } else if (
      fileShape.apply_paired_deps &&
      typeof fileShape.apply_paired_deps === "object"
    ) {
      const fs = fileShape.apply_paired_deps;
      cfg = {
        default: fs.default ?? false,
        stacks: { ...(fs.stacks ?? {}) },
      };
    } else {
      throw new Error(
        `config.apply_paired_deps: expected boolean or {default, stacks} object`,
      );
    }
  }
  if (envValue !== undefined) {
    const lc = envValue.trim().toLowerCase();
    if (lc === "true" || lc === "1" || lc === "yes" || lc === "on") {
      cfg.default = true;
    } else if (lc === "false" || lc === "0" || lc === "no" || lc === "off" || lc === "") {
      cfg.default = false;
    } else {
      log?.(
        `BUMPSIGHT_APPLY_PAIRED_DEPS: unrecognized value "${envValue}", ignoring`,
      );
    }
  }
  return cfg;
}

/**
 * v0.6.0: resolve the email verbosity mode. Precedence (last wins):
 *   1. Hard default → `digest` (GUI-first; only the daily digest emails).
 *   2. `notify_mode` in bumpsight.yaml.
 *   3. `BUMPSIGHT_NOTIFY_MODE` env var.
 * An unrecognized value is warned and ignored (falls through to the prior
 * source) rather than throwing — a typo in an opt-in verbosity knob should
 * never take down the daemon.
 */
export function buildNotifyMode(
  fileShape: FileConfigShape,
  envValue: string | undefined,
  log?: (msg: string) => void,
): NotifyMode {
  let mode: NotifyMode = "digest";
  const apply = (raw: string, where: string): void => {
    const v = raw.trim().toLowerCase();
    if (v === "off" || v === "digest" || v === "all") {
      mode = v;
    } else if (v !== "") {
      log?.(`${where}: invalid notify_mode "${raw}" (expected off | digest | all), ignoring`);
    }
  };
  if (fileShape.notify_mode !== undefined) {
    apply(String(fileShape.notify_mode), "config.notify_mode");
  }
  if (envValue !== undefined) {
    apply(envValue, "BUMPSIGHT_NOTIFY_MODE");
  }
  return mode;
}

/**
 * Per-stack lookup with default fallback. Used by apply to decide whether to
 * bundle paired-dep rewrites on a given Approve click / auto-apply pass.
 */
export function isPairedDepBundlingEnabled(
  cfg: ApplyPairedDepsConfig,
  stack: string,
): boolean {
  if (Object.prototype.hasOwnProperty.call(cfg.stacks, stack)) {
    return cfg.stacks[stack]!;
  }
  return cfg.default;
}

/**
 * v0.5.7: resolve the opt-in `watched_releases` list. Each entry is validated
 * independently — a malformed one is logged and skipped rather than throwing,
 * so a typo in an opt-in extra never takes down the core image-watching
 * daemon. Duplicate repos collapse to the first (they'd share one state key).
 */
export function buildWatchedReleases(
  fileShape: FileConfigShape,
  log?: (msg: string) => void,
): WatchedReleaseSpec[] {
  const raw = fileShape.watched_releases;
  if (!raw) return [];
  if (!Array.isArray(raw)) {
    log?.(`config.watched_releases: expected a list, ignoring`);
    return [];
  }
  const out: WatchedReleaseSpec[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const where = `config.watched_releases[${i}]`;
    const entry = raw[i];
    if (!entry || typeof entry !== "object") {
      log?.(`${where}: not a mapping, skipping`);
      continue;
    }
    const repo = typeof entry.repo === "string" ? entry.repo.trim() : "";
    const slash = repo.indexOf("/");
    const owner = slash > 0 ? repo.slice(0, slash) : "";
    const repoName = slash > 0 ? repo.slice(slash + 1) : "";
    if (!owner || !repoName || repoName.includes("/")) {
      log?.(`${where}: invalid repo "${repo}" (expected "owner/repo"), skipping`);
      continue;
    }
    if (entry.current === undefined || entry.current === null) {
      log?.(`${where} (${repo}): missing "current" version, skipping`);
      continue;
    }
    const current = String(entry.current).trim();
    if (!current) {
      log?.(`${where} (${repo}): empty "current" version, skipping`);
      continue;
    }
    const policyRaw =
      typeof entry.policy === "string" ? entry.policy.trim().toLowerCase() : "notify";
    if (policyRaw !== "notify" && policyRaw !== "none") {
      log?.(
        `${where} (${repo}): invalid policy "${entry.policy}" (expected notify | none), skipping`,
      );
      continue;
    }
    if (seen.has(repo)) {
      log?.(`${where}: duplicate repo "${repo}", keeping the first entry`);
      continue;
    }
    seen.add(repo);
    out.push({
      repo,
      owner,
      repoName,
      name:
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : repoName,
      current,
      policy: policyRaw,
      includePrerelease: entry.include_prerelease === true,
    });
  }
  return out;
}
