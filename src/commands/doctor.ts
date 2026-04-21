import { loadComposeFile } from "../compose/parse.js";
import { lintCompose } from "../lint/rules.js";
import type { Finding } from "../lint/types.js";

export interface DoctorOptions {
  file: string;
  format?: "text" | "json";
}

export function runDoctor(opts: DoctorOptions): { exitCode: number; output: string } {
  const compose = loadComposeFile(opts.file);
  const findings = lintCompose(compose);

  if (opts.format === "json") {
    return {
      exitCode: findings.some((f) => f.severity === "error") ? 1 : 0,
      output: JSON.stringify({ file: opts.file, findings }, null, 2),
    };
  }

  return {
    exitCode: findings.some((f) => f.severity === "error") ? 1 : 0,
    output: formatText(opts.file, findings),
  };
}

function formatText(filePath: string, findings: Finding[]): string {
  if (findings.length === 0) {
    return `${filePath}: clean (no findings)\n`;
  }

  const lines: string[] = [];
  lines.push(`${filePath}:`);
  lines.push("");

  const bySeverity: Record<string, Finding[]> = { error: [], warn: [], info: [] };
  for (const f of findings) bySeverity[f.severity]!.push(f);

  for (const sev of ["error", "warn", "info"] as const) {
    for (const f of bySeverity[sev]!) {
      const svc = f.serviceName ? `[${f.serviceName}]` : "";
      lines.push(`  ${tag(sev)} ${f.ruleId} ${svc} ${f.message}`);
      if (f.hint) lines.push(`         ${f.hint}`);
    }
  }

  lines.push("");
  const e = bySeverity.error!.length;
  const w = bySeverity.warn!.length;
  const i = bySeverity.info!.length;
  lines.push(`summary: ${e} error, ${w} warn, ${i} info`);
  return lines.join("\n") + "\n";
}

function tag(sev: "error" | "warn" | "info"): string {
  switch (sev) {
    case "error":
      return "ERROR";
    case "warn":
      return "WARN ";
    case "info":
      return "INFO ";
  }
}
