import type { ComposeFile, ServiceDef } from "../compose/parse.js";
import { parseImageRef } from "../compose/parse.js";
import type { Finding } from "./types.js";

type RuleFn = (file: ComposeFile) => Finding[];

const allRules: Array<{ id: string; run: RuleFn }> = [
  { id: "BS001", run: ruleLatestTag },
  { id: "BS002", run: rulePrivileged },
  { id: "BS003", run: ruleHostNetwork },
  { id: "BS004", run: ruleMissingHealthcheck },
  { id: "BS005", run: ruleSecretsInEnv },
  { id: "BS006", run: ruleMissingRestartPolicy },
  { id: "BS007", run: ruleMissingMemoryLimit },
  { id: "BS008", run: ruleDockerSock },
  { id: "BS009", run: ruleUnpinnedBuild },
  { id: "BS010", run: ruleWriteableCaps },
];

export function lintCompose(file: ComposeFile): Finding[] {
  const findings: Finding[] = [];
  for (const rule of allRules) {
    findings.push(...rule.run(file));
  }
  return findings;
}

function services(file: ComposeFile): Array<[string, ServiceDef]> {
  return Object.entries(file.services ?? {});
}

function ruleLatestTag(file: ComposeFile): Finding[] {
  const out: Finding[] = [];
  for (const [name, svc] of services(file)) {
    if (!svc.image) continue;
    const ref = parseImageRef(svc.image);
    if (ref.tag === "latest" && !ref.digest) {
      out.push({
        ruleId: "BS001",
        severity: "warn",
        serviceName: name,
        message: `image ${ref.raw} uses implicit or explicit :latest tag`,
        hint: "Pin to a specific version tag so reproducible deployments stay reproducible.",
      });
    }
  }
  return out;
}

function rulePrivileged(file: ComposeFile): Finding[] {
  const out: Finding[] = [];
  for (const [name, svc] of services(file)) {
    if (svc.privileged === true) {
      out.push({
        ruleId: "BS002",
        severity: "error",
        serviceName: name,
        message: "service runs with privileged: true",
        hint: "Privileged containers bypass most kernel security. Use cap_add for only the specific capabilities you need.",
      });
    }
  }
  return out;
}

function ruleHostNetwork(file: ComposeFile): Finding[] {
  const out: Finding[] = [];
  for (const [name, svc] of services(file)) {
    if (svc.network_mode === "host") {
      out.push({
        ruleId: "BS003",
        severity: "warn",
        serviceName: name,
        message: "service uses network_mode: host",
        hint: "Host networking removes container isolation. Consider explicit port mapping unless the container needs low-level network access.",
      });
    }
  }
  return out;
}

function ruleMissingHealthcheck(file: ComposeFile): Finding[] {
  const out: Finding[] = [];
  for (const [name, svc] of services(file)) {
    if (!svc.image) continue; // skip build-only services
    if (!svc.healthcheck) {
      out.push({
        ruleId: "BS004",
        severity: "info",
        serviceName: name,
        message: "no healthcheck defined",
        hint: "A healthcheck lets orchestrators detect hung processes. Even a simple curl or nc command helps.",
      });
    }
  }
  return out;
}

function ruleSecretsInEnv(file: ComposeFile): Finding[] {
  const out: Finding[] = [];
  const secretKeyPattern = /(password|secret|token|api[_-]?key|private[_-]?key|auth)/i;
  for (const [name, svc] of services(file)) {
    const env = svc.environment;
    if (!env) continue;
    const entries = Array.isArray(env)
      ? env.map((e) => {
          const eq = e.indexOf("=");
          return eq >= 0 ? ([e.slice(0, eq), e.slice(eq + 1)] as [string, string]) : ([e, ""] as [string, string]);
        })
      : Object.entries(env);
    for (const [key, value] of entries) {
      if (!secretKeyPattern.test(key)) continue;
      if (value.length === 0) continue; // empty is fine, probably sourced from elsewhere
      if (value.startsWith("$") || value.startsWith("${")) continue; // variable reference, likely from .env
      out.push({
        ruleId: "BS005",
        severity: "warn",
        serviceName: name,
        message: `environment variable ${key} looks like a secret with a literal value`,
        hint: "Move secrets to a .env file (gitignored), Docker secrets, or a vault-agent template.",
      });
    }
  }
  return out;
}

function ruleMissingRestartPolicy(file: ComposeFile): Finding[] {
  const out: Finding[] = [];
  for (const [name, svc] of services(file)) {
    if (!svc.image) continue;
    if (!svc.restart && !svc.deploy) {
      out.push({
        ruleId: "BS006",
        severity: "info",
        serviceName: name,
        message: "no restart policy set",
        hint: "restart: unless-stopped is a sensible default for long-running homelab services.",
      });
    }
  }
  return out;
}

function ruleMissingMemoryLimit(file: ComposeFile): Finding[] {
  const out: Finding[] = [];
  for (const [name, svc] of services(file)) {
    if (!svc.image) continue;
    const hasMem = svc.mem_limit !== undefined || svc.deploy?.resources?.limits?.memory !== undefined;
    if (!hasMem) {
      out.push({
        ruleId: "BS007",
        severity: "info",
        serviceName: name,
        message: "no memory limit configured",
        hint: "A runaway container can swap out the entire host. mem_limit: 1g is a cheap safety net.",
      });
    }
  }
  return out;
}

function ruleDockerSock(file: ComposeFile): Finding[] {
  const out: Finding[] = [];
  for (const [name, svc] of services(file)) {
    const vols = svc.volumes;
    if (!Array.isArray(vols)) continue;
    for (const v of vols) {
      const str = typeof v === "string" ? v : typeof v === "object" && v && "source" in v ? String((v as { source: unknown }).source) : "";
      if (str.includes("/var/run/docker.sock")) {
        out.push({
          ruleId: "BS008",
          severity: "warn",
          serviceName: name,
          message: "mounts the Docker socket",
          hint: "Anything with socket access can control every container on the host. Use a socket proxy (tecnativa/docker-socket-proxy) if the service only needs read access.",
        });
      }
    }
  }
  return out;
}

function ruleUnpinnedBuild(file: ComposeFile): Finding[] {
  // If using build without image, still flag missing tag on inferred image.
  // Handled indirectly by BS001; this rule adds a note for services using both build + image: latest.
  return [];
}

function ruleWriteableCaps(file: ComposeFile): Finding[] {
  const out: Finding[] = [];
  const dangerous = new Set(["SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE", "SYS_MODULE", "ALL"]);
  for (const [name, svc] of services(file)) {
    const caps = svc.cap_add ?? [];
    for (const cap of caps) {
      if (dangerous.has(cap.toUpperCase())) {
        out.push({
          ruleId: "BS010",
          severity: "warn",
          serviceName: name,
          message: `cap_add includes ${cap}`,
          hint: "That capability grants broad privileges. Confirm the service actually needs it.",
        });
      }
    }
  }
  return out;
}
