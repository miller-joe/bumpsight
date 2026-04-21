#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runDoctor } from "./commands/doctor.js";
import { runScan } from "./commands/scan.js";
import { runAdvise } from "./commands/advise.js";

const HELP = `bumpsight — Docker image update advisor for self-hosters

Usage:
  bumpsight doctor  <compose-file>   Lint a docker-compose file for common
                                     homelab anti-patterns.
  bumpsight scan    <compose-file>   List images and check Docker Hub / GHCR
                                     for newer tags in the same family.
  bumpsight advise  <image> --to <tag> [--from <tag>]
                                     Summarize breaking changes between two
                                     image tags using a local LLM (Ollama).

Shared options:
  --json                   Output as JSON instead of text.
  --offline                scan: skip the remote tag lookup.
  --timeout <ms>           Per-image network timeout (default 8000).
  -h, --help               Show this help.
  -v, --version            Print the installed version.

advise-specific options:
  --to <tag>               Target tag (required).
  --from <tag>             Current tag. Defaults to the tag in <image>.
  --repo <owner>/<name>    Override upstream GitHub repo mapping.
  --compose <file>         Compose file, so advise knows your service config.
  --service <name>         Compose service name for --compose context.
  --ollama-host <url>      Ollama base URL (default: http://127.0.0.1:11434
                           or $OLLAMA_HOST).
  --model <name>           Ollama model (default: llama3.2 or
                           $BUMPSIGHT_MODEL).
  --github-token <token>   GitHub API token (or $GITHUB_TOKEN).

Examples:
  bumpsight doctor compose.yaml
  bumpsight scan compose.yaml
  bumpsight advise linuxserver/sonarr:4.0.14 --to 4.1.0 \\
    --compose compose.yaml --service sonarr
`;

const VERSION = "0.1.0";

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      json: { type: "boolean" },
      offline: { type: "boolean" },
      timeout: { type: "string" },
      to: { type: "string" },
      from: { type: "string" },
      repo: { type: "string" },
      compose: { type: "string" },
      service: { type: "string" },
      "ollama-host": { type: "string" },
      model: { type: "string" },
      "github-token": { type: "string" },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }

  const [sub, ...rest] = positionals;
  const format: "text" | "json" = values.json ? "json" : "text";
  const timeoutMs = values.timeout ? Number(values.timeout) : undefined;

  switch (sub) {
    case "doctor": {
      const file = rest[0];
      if (!file) {
        process.stderr.write("bumpsight doctor: missing <compose-file>\n");
        return 2;
      }
      const { exitCode, output } = runDoctor({ file, format });
      process.stdout.write(output);
      return exitCode;
    }
    case "scan": {
      const file = rest[0];
      if (!file) {
        process.stderr.write("bumpsight scan: missing <compose-file>\n");
        return 2;
      }
      const { exitCode, output } = await runScan({
        file,
        format,
        offline: values.offline,
        timeoutMs,
      });
      process.stdout.write(output);
      return exitCode;
    }
    case "advise": {
      const image = rest[0];
      if (!image) {
        process.stderr.write("bumpsight advise: missing <image>\n");
        return 2;
      }
      const { exitCode, output } = await runAdvise({
        image,
        from: values.from,
        to: values.to,
        repo: values.repo,
        composeFile: values.compose,
        serviceName: values.service,
        ollamaHost: values["ollama-host"],
        model: values.model,
        githubToken: values["github-token"],
        format,
        timeoutMs,
      });
      process.stdout.write(output);
      return exitCode;
    }
    default:
      process.stderr.write(`unknown command: ${sub}\n\n${HELP}`);
      return 2;
  }
}

try {
  const code = await main(process.argv.slice(2));
  process.exit(code);
} catch (err) {
  process.stderr.write(`bumpsight: ${(err as Error).message}\n`);
  process.exit(1);
}
