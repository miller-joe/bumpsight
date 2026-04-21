export type Severity = "error" | "warn" | "info";

export interface Finding {
  ruleId: string;
  severity: Severity;
  serviceName?: string;
  message: string;
  hint?: string;
}

export interface LintContext {
  filePath: string;
}
