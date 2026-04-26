import { resolve } from "node:path";
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

  const composeFiles =
    opts.composeFiles && opts.composeFiles.length > 0
      ? opts.composeFiles
      : (fileShape.compose_files ?? []);
  if (composeFiles.length === 0) {
    process.stderr.write(
      `bumpsight daemon: no compose files configured. ` +
        `Pass paths as positional arguments or set compose_files in ${configPath}.\n`,
    );
    return 2;
  }

  const intervalRaw =
    opts.interval ?? process.env.BUMPSIGHT_INTERVAL ?? fileShape.interval ?? "6h";
  const intervalMs = parseDuration(intervalRaw);

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

  const cfg: DaemonConfig = {
    dbPath,
    composeFiles: composeFiles.map((p) => resolve(p)),
    intervalMs,
    notifyUris,
    rules,
    httpPort,
    httpHost,
    publicUrl,
    ollamaHost: fileShape.ollama?.host ?? process.env.OLLAMA_HOST,
    ollamaModel: fileShape.ollama?.model ?? process.env.BUMPSIGHT_MODEL,
  };

  const db = openDb({ path: cfg.dbPath });
  const notifiers = buildNotifiers(cfg.notifyUris);
  const log = (msg: string) =>
    process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
  const composeMap = buildComposeFileMap(cfg.composeFiles);

  log(
    `daemon starting: ${cfg.composeFiles.length} compose file(s), ` +
      `interval=${intervalRaw}, notifiers=${notifiers.length}, ` +
      `default=${cfg.rules.default}, db=${cfg.dbPath}, ` +
      `public_url=${cfg.publicUrl ?? "(unset — links disabled)"}`,
  );

  if (opts.once) {
    const result = await runScanOnce({
      db,
      notifiers,
      rules: cfg.rules,
      composeFiles: composeMap,
      publicUrl: cfg.publicUrl,
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
