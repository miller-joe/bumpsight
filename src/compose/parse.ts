import { parse as parseYaml } from "yaml";
import { readFileSync, statSync } from "node:fs";

export interface ComposeFile {
  version?: string;
  services?: Record<string, ServiceDef>;
  networks?: Record<string, unknown>;
  volumes?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ServiceDef {
  image?: string;
  build?: unknown;
  container_name?: string;
  restart?: string;
  ports?: unknown[];
  environment?: Record<string, string> | string[];
  env_file?: string | string[];
  volumes?: unknown[];
  networks?: unknown;
  depends_on?: unknown;
  healthcheck?: Record<string, unknown>;
  mem_limit?: string | number;
  cpus?: string | number;
  privileged?: boolean;
  cap_add?: string[];
  cap_drop?: string[];
  network_mode?: string;
  user?: string;
  read_only?: boolean;
  security_opt?: string[];
  deploy?: {
    resources?: {
      limits?: { memory?: string; cpus?: string };
    };
  };
  [k: string]: unknown;
}

export interface ImageRef {
  raw: string;
  registry?: string;
  namespace?: string;
  name: string;
  tag: string;
  digest?: string;
}

export function loadComposeFile(path: string): ComposeFile {
  const raw = readFileSync(path, "utf-8");
  return parseComposeString(raw, path);
}

/**
 * Parse compose YAML text without touching the filesystem. Used by the
 * v0.5.0 paired-dep-recommendation lookup to inspect upstream compose files
 * fetched over HTTP.
 */
export function parseComposeString(raw: string, where = "<string>"): ComposeFile {
  const parsed = parseYaml(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${where}: not a valid compose file`);
  }
  return parsed as ComposeFile;
}

export function parseImageRef(ref: string): ImageRef {
  // Pattern: [registry/]namespace/name[:tag][@digest]
  // or       name[:tag][@digest]
  // Examples:
  //   nginx
  //   nginx:1.27
  //   library/nginx:latest
  //   ghcr.io/user/name:v1
  //   linuxserver/sonarr:develop@sha256:abc
  let working = ref;
  let digest: string | undefined;
  const atIdx = working.indexOf("@");
  if (atIdx >= 0) {
    digest = working.slice(atIdx + 1);
    working = working.slice(0, atIdx);
  }

  const parts = working.split("/");
  let registry: string | undefined;
  let namespace: string | undefined;
  let last = parts[parts.length - 1]!;

  // Detect a registry: the first segment contains a dot or colon, or is "localhost"
  if (parts.length > 1) {
    const first = parts[0]!;
    if (first.includes(".") || first.includes(":") || first === "localhost") {
      registry = first;
      if (parts.length > 2) {
        namespace = parts.slice(1, -1).join("/");
      }
    } else {
      namespace = parts.slice(0, -1).join("/");
    }
  }

  let tag = "latest";
  const colonIdx = last.indexOf(":");
  let name: string;
  if (colonIdx >= 0) {
    name = last.slice(0, colonIdx);
    tag = last.slice(colonIdx + 1);
  } else {
    name = last;
  }

  return {
    raw: ref,
    registry,
    namespace,
    name,
    tag,
    digest,
  };
}

/**
 * Resolve compose variable references in an image string —
 * `${VAR}`, `${VAR:-default}`, `${VAR-default}` and `$VAR` — against the
 * stack's `.env` file (next to the compose file), falling back to the
 * default. A reference with neither is left as-is.
 *
 * Without this, `image: ghcr.io/org/app:${APP_VERSION:-release}` parsed as
 * tag `${APP_VERSION:-release}`, which no registry has, so the image was
 * never checked.
 */
export function interpolateImage(image: string, composePath?: string): string {
  if (!image.includes("$")) return image;
  const env = composePath ? readDotEnv(composePath) : {};
  return image.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (whole, braced: string | undefined, op: string | undefined, def: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare!;
      const v = env[name];
      if (op === ":-") return v ? v : (def ?? "");
      if (op === "-") return v !== undefined ? v : (def ?? "");
      return v !== undefined ? v : whole;
    },
  );
}

const dotEnvCache = new Map<string, { mtimeMs: number; vars: Record<string, string> }>();

function readDotEnv(composePath: string): Record<string, string> {
  const file = `${composePath.replace(/\/[^/]*$/, "")}/.env`;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return {};
  }
  const cached = dotEnvCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.vars;
  const vars: Record<string, string> = {};
  try {
    for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2]!.trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      vars[m[1]!] = v;
    }
  } catch {
    return {};
  }
  dotEnvCache.set(file, { mtimeMs, vars });
  return vars;
}
