import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { BumpAction, RulesConfig } from "./rules.js";

export interface DaemonConfig {
  /** Where the SQLite state file lives. */
  dbPath: string;
  /** Compose files to scan. Each entry is mapped to a stack name (basename of dir). */
  composeFiles: string[];
  /** How often the scan loop runs. Milliseconds. */
  intervalMs: number;
  /** Notifier URIs (smtp://…, apprise://…). Empty array disables notifications. */
  notifyUris: string[];
  /** Bump policy. */
  rules: RulesConfig;
  /** Optional Ollama base URL for advise; if unset advise is skipped. */
  ollamaHost?: string;
  /** Ollama model name when advise runs. */
  ollamaModel?: string;
}

export interface FileConfigShape {
  default?: BumpAction;
  stacks?: Record<string, BumpAction>;
  compose_files?: string[];
  interval?: string;
  db_path?: string;
  notify?: string[];
  ollama?: { host?: string; model?: string };
}

const VALID_ACTIONS: BumpAction[] = [
  "patch",
  "minor",
  "major",
  "notify",
  "none",
];

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

function parseAction(value: string, where: string): BumpAction {
  if (!VALID_ACTIONS.includes(value as BumpAction)) {
    throw new Error(
      `${where}: invalid action "${value}" (expected ${VALID_ACTIONS.join(" | ")})`,
    );
  }
  return value as BumpAction;
}

export function buildRulesConfig(
  fileShape: FileConfigShape,
  envDefault?: string,
): RulesConfig {
  const defaultAction = envDefault
    ? parseAction(envDefault, "BUMPSIGHT_AUTO_APPLY")
    : fileShape.default
      ? parseAction(fileShape.default, "config.default")
      : "notify";
  const stacks: Record<string, BumpAction> = {};
  if (fileShape.stacks) {
    for (const [name, action] of Object.entries(fileShape.stacks)) {
      stacks[name] = parseAction(action, `config.stacks.${name}`);
    }
  }
  return { default: defaultAction, stacks };
}
