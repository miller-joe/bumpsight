import { loadComposeFile, parseImageRef, type ImageRef } from "../compose/parse.js";
import { isSupportedRegistry, listTags } from "../registry/index.js";
import { findLatestInFamily } from "../util/semver.js";

export interface ScanOptions {
  file: string;
  format?: "text" | "json";
  /** Skip the remote tag lookup. Faster, and offline-friendly. */
  offline?: boolean;
  /** Per-image remote-lookup timeout in milliseconds. */
  timeoutMs?: number;
}

interface ScanRow {
  service: string;
  image: string;
  registry: string;
  path: string;
  tag: string;
  digest?: string;
  latest?: string | null;
  error?: string;
  skipped?: string;
}

export async function runScan(
  opts: ScanOptions,
): Promise<{ exitCode: number; output: string }> {
  const compose = loadComposeFile(opts.file);
  const services = Object.entries(compose.services ?? {})
    .filter(([, svc]) => svc.image)
    .map(([name, svc]) => ({ name, ref: parseImageRef(svc.image!) }));

  const rows: ScanRow[] = await Promise.all(
    services.map(({ name, ref }) => resolveRow(name, ref, opts)),
  );

  if (opts.format === "json") {
    return {
      exitCode: 0,
      output: JSON.stringify({ file: opts.file, services: rows }, null, 2),
    };
  }

  const lines: string[] = [`${opts.file}: ${rows.length} service(s) with images`, ""];
  for (const r of rows) {
    const left = `  ${r.service.padEnd(20)} ${r.image}`;
    if (r.skipped) {
      lines.push(`${left}    (skipped: ${r.skipped})`);
    } else if (r.error) {
      lines.push(`${left}    (error: ${r.error})`);
    } else if (r.latest === null) {
      lines.push(`${left}    up to date`);
    } else if (r.latest) {
      lines.push(`${left}    → ${r.latest}`);
    } else {
      lines.push(left);
    }
  }
  lines.push("");
  return { exitCode: 0, output: lines.join("\n") + "\n" };
}

async function resolveRow(service: string, ref: ImageRef, opts: ScanOptions): Promise<ScanRow> {
  const base: ScanRow = {
    service,
    image: ref.raw,
    registry: ref.registry ?? "docker.io",
    path: ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name,
    tag: ref.tag,
    digest: ref.digest,
  };

  if (opts.offline) {
    return { ...base, skipped: "offline mode" };
  }
  if (!isSupportedRegistry(ref)) {
    return { ...base, skipped: `registry ${ref.registry} not supported yet` };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);

  try {
    const remoteTags = await listTags(ref, { signal: controller.signal });
    const latest = findLatestInFamily(
      ref.tag,
      remoteTags.map((t) => t.name),
    );
    return { ...base, latest };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { ...base, error: msg.slice(0, 160) };
  } finally {
    clearTimeout(timeout);
  }
}
