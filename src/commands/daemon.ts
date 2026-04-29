import { resolve, join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { startDaemon, runScanOnce, buildComposeFileMap } from "../daemon/index.js";
import {
  buildRulesConfig,
  loadConfigFile,
  type DaemonConfig,
} from "../daemon/config.js";
import { parseDuration } from "../util/duration.js";
import { openDb } from "../state/db.js";
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
  };

  const db = openDb({ path: cfg.dbPath });
  const notifiers = buildNotifiers(cfg.notifyUris);
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
      `advise=${cfg.llmUrl ? `on @ ${cfg.llmUrl} (${cfg.llmModel ?? "default-model"})` : "off"}`,
  );

  if (opts.once) {
    const result = await runScanOnce({
      db,
      notifiers,
      rules: cfg.rules,
      composeFiles: composeMap,
      publicUrl: cfg.publicUrl,
      llmUrl: cfg.llmUrl,
      llmKey: cfg.llmKey,
      llmModel: cfg.llmModel,
      githubToken: cfg.githubToken,
      notifyIntervalMs: cfg.notifyIntervalMs,
    });
    log(
      `scan: ${result.scanned} services, ${result.discovered} new (${result.autoApplied} auto, ${result.held} held)`,
    );
    for (const [k, v] of Object.entries(result.errors)) {
      log(`scan-error: ${k}: ${v}`);
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
  });

  const runtime = startDaemon(cfg, {
    db,
    notifiers,
    composeFiles: composeMap,
    publicUrl: cfg.publicUrl,
    llmUrl: cfg.llmUrl,
    llmKey: cfg.llmKey,
    llmModel: cfg.llmModel,
    githubToken: cfg.githubToken,
    log,
  });

  const shutdown = async (signal: string) => {
    log(`received ${signal}, draining…`);
    await runtime.stop();
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
