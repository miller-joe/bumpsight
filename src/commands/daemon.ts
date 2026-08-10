import { resolve, join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import {
  startDaemon,
  runScanOnce,
  buildComposeFileMap,
  reconcileOpenRows,
} from "../daemon/index.js";
import { startDigestScheduler } from "../daemon/digest.js";
import { startDeepPruneScheduler } from "../daemon/deep-prune.js";
import {
  runWatchedReleasesOnce,
  startWatchedReleasesScheduler,
} from "../daemon/watched-releases.js";
import {
  buildApplyPairedDepsConfig,
  buildNotifyMode,
  buildRulesConfig,
  buildWatchedReleases,
  loadConfigFile,
  type DaemonConfig,
} from "../daemon/config.js";
import { applyStackPolicyOverrides } from "../daemon/rules.js";
import { parseDuration } from "../util/duration.js";
import { openDb, getAllStackPolicies } from "../state/db.js";
import { buildNotifiers, parseNotifyEnv } from "../notify/index.js";
import { startHttpServer } from "../server/http.js";

export interface DaemonCliOptions {
  /** Path to the daemon config file. Defaults to /config/bumpsight.yaml. */
  configFile?: string;
  /** Overrides env BUMPSIGHT_DB. Defaults to /var/lib/bumpsight/state.db. */
  dbPath?: string;
  /** One or more compose files (CLI override). When set, replaces config. */
  composeFiles?: string[];
  /** Override BUMPSIGHT_INTERVAL. */
  interval?: string;
  /** Override BUMPSIGHT_NOTIFY (comma-separated). */
  notify?: string;
  /** Override BUMPSIGHT_AUTO_APPLY default policy. */
  autoApply?: string;
  /** Run a single scan pass and exit (useful for cron-driven setups + tests). */
  once?: boolean;
}

export async function runDaemon(opts: DaemonCliOptions): Promise<number> {
  const configPath =
    opts.configFile ?? process.env.BUMPSIGHT_CONFIG ?? "/config/bumpsight.yaml";
  const fileShape = loadConfigFile(configPath);

  // Compose-file resolution. Three sources, first wins:
  //   1. CLI positional args
  //   2. compose_files: list in bumpsight.yaml (explicit allowlist)
  //   3. auto-discovery: every <stacksDir>/<name>/compose.{yaml,yml}
  // Auto-discovery is the default — bumpsight is opt-out, not opt-in.
  // To exclude a stack, set its per-stack policy to `none` in bumpsight.yaml.
  const stacksDir =
    process.env.BUMPSIGHT_STACKS_DIR ?? fileShape.stacks_dir ?? "/stacks";
  let composeFiles: string[];
  if (opts.composeFiles && opts.composeFiles.length > 0) {
    composeFiles = opts.composeFiles;
  } else if (fileShape.compose_files && fileShape.compose_files.length > 0) {
    composeFiles = fileShape.compose_files;
  } else {
    composeFiles = autoDiscoverComposeFiles(stacksDir);
    if (composeFiles.length === 0) {
      process.stderr.write(
        `bumpsight daemon: no compose files found. Either pass paths as ` +
          `positional arguments, set compose_files in ${configPath}, or mount ` +
          `your compose tree at ${stacksDir} (configurable via BUMPSIGHT_STACKS_DIR).\n`,
      );
      return 2;
    }
  }

  const intervalRaw =
    opts.interval ?? process.env.BUMPSIGHT_INTERVAL ?? fileShape.interval ?? "6h";
  const intervalMs = parseDuration(intervalRaw);

  const notifyIntervalRaw =
    process.env.BUMPSIGHT_NOTIFY_INTERVAL ?? fileShape.notify_interval ?? "10s";
  const notifyIntervalMs = parseDuration(notifyIntervalRaw);

  const dbPath =
    opts.dbPath ??
    process.env.BUMPSIGHT_DB ??
    fileShape.db_path ??
    "/var/lib/bumpsight/state.db";

  const notifyValue = opts.notify ?? process.env.BUMPSIGHT_NOTIFY;
  const envUris = parseNotifyEnv(notifyValue);
  const fileUris = fileShape.notify ?? [];
  const notifyUris = envUris.length > 0 ? envUris : fileUris;

  const rules = buildRulesConfig(
    fileShape,
    opts.autoApply ?? process.env.BUMPSIGHT_AUTO_APPLY,
  );

  const httpPort = Number(
    process.env.BUMPSIGHT_HTTP_PORT ?? fileShape.http_port ?? 9100,
  );
  const httpHost =
    process.env.BUMPSIGHT_HTTP_HOST ?? fileShape.http_host ?? "0.0.0.0";
  const publicUrl =
    process.env.BUMPSIGHT_PUBLIC_URL ?? fileShape.public_url ?? undefined;

  // Backward compat: if BUMPSIGHT_LLM_URL is unset but OLLAMA_HOST is, derive
  // the OpenAI-compat URL from Ollama's host (Ollama supports /v1 natively).
  const ollamaHostEnv = fileShape.ollama?.host ?? process.env.OLLAMA_HOST;
  const llmUrl =
    process.env.BUMPSIGHT_LLM_URL ??
    (ollamaHostEnv ? `${ollamaHostEnv.replace(/\/+$/, "")}/v1` : undefined);
  const llmKey = process.env.BUMPSIGHT_LLM_KEY;
  const llmModel = fileShape.ollama?.model ?? process.env.BUMPSIGHT_MODEL;

  const outboxDir =
    process.env.BUMPSIGHT_OUTBOX_DIR ??
    fileShape.outbox_dir ??
    "/var/lib/bumpsight/outbox";
  const outboxKeepCount = Number(
    process.env.BUMPSIGHT_OUTBOX_KEEP ?? fileShape.outbox_keep_count ?? 200,
  );

  // v0.4.3: digest hour (0-23, local TZ). Negative number disables.
  const digestHourRaw =
    process.env.BUMPSIGHT_DIGEST_HOUR ?? fileShape.digest_hour ?? 18;
  const digestHour = Number(digestHourRaw);
  if (Number.isNaN(digestHour)) {
    process.stderr.write(
      `bumpsight daemon: invalid digest hour "${digestHourRaw}" (expected 0-23, or <0 to disable)\n`,
    );
    return 2;
  }

  // v0.5.2: optional deep-prune schedule. Empty / missing = off.
  const pruneScheduleRaw =
    process.env.BUMPSIGHT_PRUNE_SCHEDULE ?? fileShape.prune_schedule ?? "";
  let pruneIntervalMs = 0;
  if (pruneScheduleRaw.trim()) {
    try {
      pruneIntervalMs = parseDuration(pruneScheduleRaw);
    } catch (err) {
      process.stderr.write(
        `bumpsight daemon: invalid BUMPSIGHT_PRUNE_SCHEDULE "${pruneScheduleRaw}": ${(err as Error).message}\n`,
      );
      return 2;
    }
  }

  // v0.5.4: opt-in apply-time bundling of paired dep changes. Off by default.
  const applyPairedDeps = buildApplyPairedDepsConfig(
    fileShape,
    process.env.BUMPSIGHT_APPLY_PAIRED_DEPS,
    (msg) => process.stderr.write(`bumpsight daemon: ${msg}\n`),
  );

  // v0.5.7: opt-in non-Docker upstreams watched via GitHub Releases. Empty by
  // default — malformed entries are warned + skipped, never fatal.
  const watchedReleases = buildWatchedReleases(fileShape, (msg) =>
    process.stderr.write(`bumpsight daemon: ${msg}\n`),
  );
  const watchIntervalRaw =
    process.env.BUMPSIGHT_WATCH_INTERVAL ?? fileShape.watch_interval ?? intervalRaw;
  let watchIntervalMs = intervalMs;
  if (watchIntervalRaw !== intervalRaw) {
    try {
      watchIntervalMs = parseDuration(watchIntervalRaw);
    } catch (err) {
      process.stderr.write(
        `bumpsight daemon: invalid BUMPSIGHT_WATCH_INTERVAL "${watchIntervalRaw}": ${(err as Error).message}\n`,
      );
      return 2;
    }
  }

  // v0.6.0: email verbosity (off | digest | all). Default `digest` — GUI-first.
  const notifyMode = buildNotifyMode(
    fileShape,
    process.env.BUMPSIGHT_NOTIFY_MODE,
    (msg) => process.stderr.write(`bumpsight daemon: ${msg}\n`),
  );
  // v0.6.0: optional shared secret gating the dashboard + POST action routes.
  const uiToken = process.env.BUMPSIGHT_UI_TOKEN ?? fileShape.ui_token ?? undefined;

  const cfg: DaemonConfig = {
    dbPath,
    composeFiles: composeFiles.map((p) => resolve(p)),
    intervalMs,
    notifyIntervalMs,
    notifyUris,
    rules,
    httpPort,
    httpHost,
    publicUrl,
    llmUrl,
    llmKey,
    llmModel,
    githubToken: process.env.GITHUB_TOKEN,
    outboxDir,
    outboxKeepCount,
    digestHour,
    pruneIntervalMs,
    applyPairedDeps,
    watchedReleases,
    watchIntervalMs,
    notifyMode,
    uiToken,
  };

  const db = openDb({ path: cfg.dbPath });
  const notifiers = buildNotifiers(cfg.notifyUris);
  // v0.6.0: the per-event email channels (hold + applied) only fire under
  // `notify_mode: all`. In `digest`/`off` we hand those channels an empty
  // notifier list — dispatch treats "no notifiers" as a successful no-op, so
  // rows still advance to `notified` and advise_text still persists for the
  // GUI; there's just no email. The daily digest keeps the real notifiers (and
  // is only started at all when mode !== "off").
  const perEvent = cfg.notifyMode === "all" ? notifiers : [];
  const log = (msg: string) =>
    process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
  const composeMap = buildComposeFileMap(cfg.composeFiles);

  const discoveryHint =
    opts.composeFiles && opts.composeFiles.length > 0
      ? "(from CLI args)"
      : fileShape.compose_files && fileShape.compose_files.length > 0
        ? "(from compose_files in config)"
        : `(auto-discovered under ${stacksDir})`;
  log(
    `daemon starting: ${cfg.composeFiles.length} compose file(s) ${discoveryHint}, ` +
      `interval=${intervalRaw}, notify_interval=${notifyIntervalRaw}, ` +
      `notifiers=${notifiers.length}, ` +
      `policy=app:${cfg.rules.default.app}/deps:${cfg.rules.default.dependencies}, db=${cfg.dbPath}, ` +
      `public_url=${cfg.publicUrl ?? "(unset — links disabled)"}, ` +
      `advise=${cfg.llmUrl ? `on @ ${cfg.llmUrl} (${cfg.llmModel ?? "default-model"})` : "off"}, ` +
      `digest=${cfg.digestHour < 0 ? "off" : `${String(cfg.digestHour).padStart(2, "0")}:00 local`}, ` +
      `prune=${cfg.pruneIntervalMs > 0 ? `every ${pruneScheduleRaw}` : "off"}, ` +
      `bundle_paired_deps=${describeBundling(cfg.applyPairedDeps)}, ` +
      `watched_releases=${cfg.watchedReleases.length > 0 ? `${cfg.watchedReleases.length} repo(s) every ${watchIntervalRaw}` : "off"}, ` +
      `notify_mode=${cfg.notifyMode}, ui_auth=${cfg.uiToken ? "on" : "off"}`,
  );

  if (opts.once) {
    const onceRules = applyStackPolicyOverrides(cfg.rules, getAllStackPolicies(db));
    const rec = reconcileOpenRows(db, onceRules);
    if (rec.dismissed + rec.requeued > 0)
      log(`reconcile: ${rec.dismissed} dismissed, ${rec.requeued} requeued for auto-apply`);
    const result = await runScanOnce({
      db,
      notifiers: perEvent,
      rules: onceRules,
      composeFiles: composeMap,
      publicUrl: cfg.publicUrl,
      llmUrl: cfg.llmUrl,
      llmKey: cfg.llmKey,
      llmModel: cfg.llmModel,
      githubToken: cfg.githubToken,
      notifyIntervalMs: cfg.notifyIntervalMs,
      outboxDir: cfg.outboxDir,
      outboxKeepCount: cfg.outboxKeepCount,
      applyPairedDeps: cfg.applyPairedDeps,
    });
    log(
      `scan: ${result.scanned} services` +
        (result.skipped > 0 ? ` (${result.skipped} skipped)` : "") +
        `, ${result.discovered} new (${result.autoApplied} auto, ${result.held} held)`,
    );
    for (const [reg, refs] of Object.entries(result.skippedByRegistry)) {
      log(
        `scan-skip: registry ${reg} has no client — ${refs.length} image(s) NOT checked: ${refs.join(", ")}`,
      );
    }
    for (const [k, v] of Object.entries(result.errors)) {
      log(`scan-error: ${k}: ${v}`);
    }
    if (cfg.watchedReleases.length > 0) {
      const watch = await runWatchedReleasesOnce({
        db,
        specs: cfg.watchedReleases,
        notifiers,
        llmUrl: cfg.llmUrl,
        llmKey: cfg.llmKey,
        llmModel: cfg.llmModel,
        githubToken: cfg.githubToken,
        notifyIntervalMs: cfg.notifyIntervalMs,
        outboxDir: cfg.outboxDir,
        outboxKeepCount: cfg.outboxKeepCount,
        log,
      });
      log(
        `watch: ${watch.checked} repo(s), ${watch.behind} behind, ${watch.notified} notified`,
      );
      for (const [repo, err] of Object.entries(watch.errors)) {
        log(`watch-error: ${repo}: ${err}`);
      }
    }
    db.close();
    return 0;
  }

  const httpHandle = await startHttpServer({
    db,
    composeFiles: composeMap,
    port: cfg.httpPort,
    host: cfg.httpHost,
    log,
    notifiers: perEvent,
    llmUrl: cfg.llmUrl,
    llmKey: cfg.llmKey,
    llmModel: cfg.llmModel,
    githubToken: cfg.githubToken,
    outboxDir: cfg.outboxDir,
    outboxKeepCount: cfg.outboxKeepCount,
    applyPairedDeps: cfg.applyPairedDeps,
    rules: cfg.rules,
    publicUrl: cfg.publicUrl,
    uiToken: cfg.uiToken,
  });

  const runtime = startDaemon(cfg, {
    db,
    notifiers: perEvent,
    composeFiles: composeMap,
    publicUrl: cfg.publicUrl,
    llmUrl: cfg.llmUrl,
    llmKey: cfg.llmKey,
    llmModel: cfg.llmModel,
    githubToken: cfg.githubToken,
    outboxDir: cfg.outboxDir,
    outboxKeepCount: cfg.outboxKeepCount,
    log,
    applyPairedDeps: cfg.applyPairedDeps,
  });

  // v0.6.0: the daily digest is the one email channel that survives the
  // GUI-first default. It keeps the real notifiers (not the per-event `[]`),
  // but is only started when digest is enabled AND email isn't fully off.
  const digestRuntime =
    cfg.digestHour >= 0 && cfg.notifyMode !== "off"
      ? startDigestScheduler({
          db,
          notifiers,
          hour: cfg.digestHour,
          publicUrl: cfg.publicUrl,
          outboxDir: cfg.outboxDir,
          outboxKeepCount: cfg.outboxKeepCount,
          log,
        })
      : null;

  const pruneRuntime =
    cfg.pruneIntervalMs > 0
      ? startDeepPruneScheduler({
          intervalMs: cfg.pruneIntervalMs,
          log,
        })
      : null;

  const watchRuntime =
    cfg.watchedReleases.length > 0
      ? startWatchedReleasesScheduler({
          db,
          specs: cfg.watchedReleases,
          notifiers,
          llmUrl: cfg.llmUrl,
          llmKey: cfg.llmKey,
          llmModel: cfg.llmModel,
          githubToken: cfg.githubToken,
          notifyIntervalMs: cfg.notifyIntervalMs,
          outboxDir: cfg.outboxDir,
          outboxKeepCount: cfg.outboxKeepCount,
          intervalMs: cfg.watchIntervalMs,
          log,
        })
      : null;

  const shutdown = async (signal: string) => {
    log(`received ${signal}, draining…`);
    await runtime.stop();
    if (digestRuntime) await digestRuntime.stop();
    if (pruneRuntime) await pruneRuntime.stop();
    if (watchRuntime) await watchRuntime.stop();
    await httpHandle.stop();
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  return await new Promise<number>(() => {
    /* daemon runs until SIGINT/SIGTERM */
  });
}

function describeBundling(
  cfg: DaemonConfig["applyPairedDeps"],
): string {
  const overrides = Object.entries(cfg.stacks);
  if (!cfg.default && overrides.length === 0) return "off";
  if (cfg.default && overrides.length === 0) return "on (all stacks)";
  const onStacks = overrides.filter(([, v]) => v).map(([k]) => k);
  const offStacks = overrides.filter(([, v]) => !v).map(([k]) => k);
  const parts: string[] = [cfg.default ? "default=on" : "default=off"];
  if (onStacks.length > 0) parts.push(`on=${onStacks.join(",")}`);
  if (offStacks.length > 0) parts.push(`off=${offStacks.join(",")}`);
  return parts.join(" ");
}

/**
 * Auto-discover compose files under a stacks directory, one level deep.
 *
 *   <root>/<stack>/compose.yaml
 *   <root>/<stack>/compose.yml
 *
 * Hidden directories (starting with `.`) are skipped — that gives users a
 * dot-prefix archive convention to opt-out without editing config.
 */
function autoDiscoverComposeFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    for (const name of ["compose.yaml", "compose.yml"]) {
      const candidate = join(root, entry.name, name);
      try {
        if (statSync(candidate).isFile()) {
          out.push(candidate);
          break;
        }
      } catch {
        // not present — try next
      }
    }
  }
  return out.sort();
}
