#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runDoctor } from "./commands/doctor.js";
import { runScan } from "./commands/scan.js";
import { runAdvise } from "./commands/advise.js";

const HELP = `bumpsight — Docker image update advisor for self-hosters

Usage:
  bumpsight doctor  <compose-file>   Lint a docker-compose file for common
                                     homelab anti-patterns.
  bumpsight scan    <compose-file>   List the images referenced by a
                                     compose file. Remote tag-freshness
                                     lookup is coming in 0.1.
  bumpsight advise  <image>          Summarize breaking changes between
                                     two image tags using a local LLM.
                                     (shipping in 0.1)

Options:
  --json                   Output as JSON instead of text.
  -h, --help               Show this help.
  -v, --version            Print the installed version.

Examples:
  bumpsight doctor compose.yaml
  bumpsight scan /mnt/ramjet/docker/stacks/jellyfin/compose.yaml --json
`;

function version(): string {
  // Replaced at build time by consumers; for now we print a static placeholder
  // so CI doesn't need a separate step.
  return "0.0.1";
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      json: { type: "boolean" },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(version() + "\n");
    return 0;
  }

  const [sub, ...rest] = positionals;
  const format: "text" | "json" = values.json ? "json" : "text";

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
      const { exitCode, output } = runScan({ file, format });
      process.stdout.write(output);
      return exitCode;
    }
    case "advise": {
      const image = rest[0];
      if (!image) {
        process.stderr.write("bumpsight advise: missing <image>\n");
        return 2;
      }
      const { exitCode, output } = runAdvise({ image, format });
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
