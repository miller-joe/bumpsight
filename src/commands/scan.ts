import { loadComposeFile, parseImageRef } from "../compose/parse.js";

export interface ScanOptions {
  file: string;
  format?: "text" | "json";
}

/**
 * List the images referenced by a compose file. Tag-freshness lookups against
 * Docker Hub / GHCR land in a follow-up release; v0.0.1 of this command just
 * enumerates what you've got so the rest of the pipeline has something real
 * to work with.
 */
export function runScan(opts: ScanOptions): { exitCode: number; output: string } {
  const compose = loadComposeFile(opts.file);
  const services = Object.entries(compose.services ?? {});
  const rows = services
    .filter(([, svc]) => svc.image)
    .map(([name, svc]) => {
      const ref = parseImageRef(svc.image!);
      return {
        service: name,
        image: ref.raw,
        registry: ref.registry ?? "docker.io",
        name: ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name,
        tag: ref.tag,
        digest: ref.digest,
      };
    });

  if (opts.format === "json") {
    return {
      exitCode: 0,
      output: JSON.stringify({ file: opts.file, services: rows }, null, 2),
    };
  }

  const lines: string[] = [`${opts.file}: ${rows.length} service(s) with images`];
  lines.push("");
  for (const r of rows) {
    lines.push(`  ${r.service.padEnd(20)} ${r.image}`);
  }
  lines.push("");
  lines.push("(remote tag-freshness lookup is on the roadmap, see README)");
  return { exitCode: 0, output: lines.join("\n") + "\n" };
}
