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
}

export interface FileConfigShape {
  default?: BumpAction;
  stacks?: Record<string, BumpAction>;
  compose_files?: string[];
  interval?: string;
  db_path?: string;
  notify?: string[];
  http_port?: number;
  http_host?: string;
  public_url?: string;
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
