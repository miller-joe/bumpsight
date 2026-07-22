import { describe, it, expect } from "vitest";
import { classifyBump, decideAction, isDependencyImage } from "../src/daemon/rules.js";

describe("classifyBump", () => {
  it("classifies a major version change", () => {
    expect(classifyBump("0.15.5", "0.16.0")).toBe("minor");
    expect(classifyBump("1.2.3", "2.0.0")).toBe("major");
  });

  it("classifies a minor version change", () => {
    expect(classifyBump("4.0.14", "4.1.0")).toBe("minor");
  });

  it("classifies a patch version change", () => {
    expect(classifyBump("4.0.14", "4.0.15")).toBe("patch");
    expect(classifyBump("4.0.14.9383", "4.0.14.9400")).toBe("patch");
  });

  it("treats a 'v' prefix the same as no prefix", () => {
    expect(classifyBump("v1.2.3", "1.2.4")).toBe("patch");
    expect(classifyBump("v1.2.3", "v2.0.0")).toBe("major");
  });

  it("returns unknown when families differ (variants)", () => {
    expect(classifyBump("16-alpine", "17")).toBe("unknown");
    expect(classifyBump("16.2", "16.3-alpine")).toBe("unknown");
  });

  it("returns unknown for non-numeric tags", () => {
    expect(classifyBump("latest", "stable")).toBe("unknown");
    expect(classifyBump("develop", "1.2.3")).toBe("unknown");
  });
});

describe("isDependencyImage", () => {
  it("matches official Postgres in any common form", () => {
    expect(isDependencyImage("postgres")).toBe(true);
    expect(isDependencyImage("library/postgres")).toBe(true);
    expect(isDependencyImage("docker.io/library/postgres")).toBe(true);
    expect(isDependencyImage("Postgres")).toBe(true); // case-insensitive
  });

  it("matches namespaced dependency images (vault, valkey, pgvector, redis)", () => {
    expect(isDependencyImage("hashicorp/vault")).toBe(true);
    expect(isDependencyImage("valkey/valkey")).toBe(true);
    expect(isDependencyImage("pgvector/pgvector")).toBe(true);
    expect(isDependencyImage("redis")).toBe(true);
  });

  it("matches GHCR-prefixed dependency images via registry strip", () => {
    expect(isDependencyImage("ghcr.io/hashicorp/vault")).toBe(true);
  });

  it("does NOT match application-layer images", () => {
    expect(isDependencyImage("nginx")).toBe(false); // nginx is webserver, not dep
    expect(isDependencyImage("library/node")).toBe(false);
    expect(isDependencyImage("n8nio/n8n")).toBe(false);
    expect(isDependencyImage("vaultwarden/server")).toBe(false); // vaultwarden ≠ Vault
  });

  it("does NOT match unknown forks (intentional — only canonical names covered)", () => {
    expect(isDependencyImage("randomfork/postgres-custom")).toBe(false);
  });
});

describe("decideAction (v0.4.0 split-axis policy)", () => {
  // Helpers for legibility in the new split-axis world.
  const both = (action: "patch" | "minor" | "major" | "notify" | "none") =>
    ({ default: { app: action, dependencies: action }, stacks: {} } as const);
  const split = (
    app: "patch" | "minor" | "major" | "notify" | "none",
    dependencies: "patch" | "minor" | "major" | "notify" | "none",
  ) => ({ default: { app, dependencies }, stacks: {} } as const);

  it("auto-applies patches under app='patch' (non-dep image)", () => {
    const cfg = both("patch");
    expect(decideAction(cfg, "any", "patch", false)).toBe("auto-apply");
    expect(decideAction(cfg, "any", "minor", false)).toBe("hold");
    expect(decideAction(cfg, "any", "major", false)).toBe("hold");
  });

  it("auto-applies patches+minors under app='minor'", () => {
    const cfg = both("minor");
    expect(decideAction(cfg, "any", "patch", false)).toBe("auto-apply");
    expect(decideAction(cfg, "any", "minor", false)).toBe("auto-apply");
    expect(decideAction(cfg, "any", "major", false)).toBe("hold");
  });

  it("auto-applies everything classified under app='major'", () => {
    const cfg = both("major");
    expect(decideAction(cfg, "any", "patch", false)).toBe("auto-apply");
    expect(decideAction(cfg, "any", "minor", false)).toBe("auto-apply");
    expect(decideAction(cfg, "any", "major", false)).toBe("auto-apply");
  });

  it("never auto-applies under 'notify'", () => {
    const cfg = both("notify");
    expect(decideAction(cfg, "any", "patch", false)).toBe("hold");
    expect(decideAction(cfg, "any", "major", false)).toBe("hold");
  });

  it("skips entirely under 'none'", () => {
    const cfg = both("none");
    expect(decideAction(cfg, "any", "patch", false)).toBe("skip");
    expect(decideAction(cfg, "any", "major", false)).toBe("skip");
  });

  it("holds an unknown bump, but AUTO-APPLIES a digest (moving-tag) bump under any auto-apply policy", () => {
    for (const action of ["patch", "minor", "major"] as const) {
      const cfg = both(action);
      expect(decideAction(cfg, "any", "unknown", false)).toBe("hold");
      // v0.6.0: pinning :latest opts into rolling updates → digest auto-applies.
      expect(decideAction(cfg, "any", "digest", false)).toBe("auto-apply");
    }
    // notify still holds a digest (operator wants to be asked); none skips it.
    expect(decideAction(both("notify"), "any", "digest", false)).toBe("hold");
    expect(decideAction(both("none"), "any", "digest", false)).toBe("skip");
  });

  it("uses the dependencies axis for dependency images", () => {
    // Adventurous on app, conservative on deps — typical homelab default.
    const cfg = split("major", "none");
    // app axis applies for non-dep image
    expect(decideAction(cfg, "any", "major", false)).toBe("auto-apply");
    // deps axis applies for dep image: skip silently
    expect(decideAction(cfg, "any", "patch", true)).toBe("skip");
    expect(decideAction(cfg, "any", "major", true)).toBe("skip");
  });

  it("dep major doesn't auto-apply when deps='minor'", () => {
    const cfg = split("major", "minor");
    expect(decideAction(cfg, "any", "patch", true)).toBe("auto-apply");
    expect(decideAction(cfg, "any", "minor", true)).toBe("auto-apply");
    expect(decideAction(cfg, "any", "major", true)).toBe("hold");
  });

  it("respects per-stack overrides over the default", () => {
    const cfg = {
      default: { app: "patch", dependencies: "notify" },
      stacks: {
        stalwart: { app: "notify", dependencies: "none" },
        glance: { app: "minor", dependencies: "notify" },
      },
    } as const;
    // stalwart app: forced notify (always hold)
    expect(decideAction(cfg, "stalwart", "patch", false)).toBe("hold");
    // stalwart dep: 'none' -> silent skip
    expect(decideAction(cfg, "stalwart", "patch", true)).toBe("skip");
    // glance app: minor auto-applies (default 'patch' wouldn't have)
    expect(decideAction(cfg, "glance", "minor", false)).toBe("auto-apply");
    // unrelated stack: falls back to default
    expect(decideAction(cfg, "anything-else", "patch", false)).toBe("auto-apply");
    expect(decideAction(cfg, "anything-else", "patch", true)).toBe("hold"); // default deps='notify'
  });
});
