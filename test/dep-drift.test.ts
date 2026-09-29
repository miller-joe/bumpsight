import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDepDrift } from "../src/daemon/dep-drift.js";

function stackDir(compose: string): { stack: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "bumpsight-drift-"));
  const file = join(dir, "compose.yaml");
  writeFileSync(file, compose, "utf-8");
  return { stack: dir.split("/").pop()!, file };
}

describe("scanDepDrift", () => {
  it("skips services whose tag carries no version to compare", async () => {
    // `latest` tells us nothing about which upstream ref to read, so these must
    // not trigger a network lookup at all.
    const { stack, file } = stackDir(
      "services:\n  app:\n    image: someorg/someapp:latest\n",
    );
    const r = await scanDepDrift({ composeFiles: { [stack]: file } });
    expect(r.findings).toEqual([]);
    expect(r.advisories).toEqual([]);
  });

  it("ignores dependency images as drift sources", async () => {
    // A dep has no upstream compose of its own to consult — only the parent app
    // does. Postgres alone in a stack must produce nothing.
    const { stack, file } = stackDir(
      "services:\n  db:\n    image: postgres:16-alpine\n",
    );
    const r = await scanDepDrift({ composeFiles: { [stack]: file } });
    expect(r.findings).toEqual([]);
  });

  it("survives an unreadable compose file without throwing", async () => {
    const r = await scanDepDrift({
      composeFiles: { ghost: "/nonexistent/compose.yaml" },
    });
    expect(r.findings).toEqual([]);
    expect(r.advisories).toEqual([]);
  });
});
