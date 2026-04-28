import { describe, it, expect } from "vitest";
import { classifyBump, decideAction } from "../src/daemon/rules.js";

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

describe("decideAction", () => {
  it("auto-applies patches under default 'patch' policy", () => {
    const cfg = { default: "patch" as const, stacks: {} };
    expect(decideAction(cfg, "any", "patch")).toBe("auto-apply");
    expect(decideAction(cfg, "any", "minor")).toBe("hold");
    expect(decideAction(cfg, "any", "major")).toBe("hold");
  });

  it("auto-applies patches and minors under 'minor' policy", () => {
    const cfg = { default: "minor" as const, stacks: {} };
    expect(decideAction(cfg, "any", "patch")).toBe("auto-apply");
    expect(decideAction(cfg, "any", "minor")).toBe("auto-apply");
    expect(decideAction(cfg, "any", "major")).toBe("hold");
  });

  it("auto-applies everything classified under 'major' policy", () => {
    const cfg = { default: "major" as const, stacks: {} };
    expect(decideAction(cfg, "any", "patch")).toBe("auto-apply");
    expect(decideAction(cfg, "any", "minor")).toBe("auto-apply");
    expect(decideAction(cfg, "any", "major")).toBe("auto-apply");
  });

  it("never auto-applies under 'notify' policy", () => {
    const cfg = { default: "notify" as const, stacks: {} };
    expect(decideAction(cfg, "any", "patch")).toBe("hold");
    expect(decideAction(cfg, "any", "major")).toBe("hold");
  });

  it("skips entirely under 'none' policy", () => {
    const cfg = { default: "none" as const, stacks: {} };
    expect(decideAction(cfg, "any", "patch")).toBe("skip");
    expect(decideAction(cfg, "any", "major")).toBe("skip");
  });

  it("never auto-applies an unknown bump regardless of policy", () => {
    for (const action of ["patch", "minor", "major"] as const) {
      const cfg = { default: action, stacks: {} };
      expect(decideAction(cfg, "any", "unknown")).toBe("hold");
    }
  });

  it("returns 'report' for stacks on the report policy regardless of bump kind", () => {
    const cfg = { default: "report" as const, stacks: {} };
    expect(decideAction(cfg, "any", "patch")).toBe("report");
    expect(decideAction(cfg, "any", "minor")).toBe("report");
    expect(decideAction(cfg, "any", "major")).toBe("report");
    expect(decideAction(cfg, "any", "unknown")).toBe("report");
  });

  it("respects per-stack overrides over the default", () => {
    const cfg = {
      default: "patch" as const,
      stacks: { stalwart: "notify" as const, glance: "minor" as const },
    };
    // stalwart: forced notify
    expect(decideAction(cfg, "stalwart", "patch")).toBe("hold");
    // glance: minors auto-apply, defaults wouldn't have allowed it
    expect(decideAction(cfg, "glance", "minor")).toBe("auto-apply");
    // unrelated stack: falls back to default
    expect(decideAction(cfg, "anything-else", "patch")).toBe("auto-apply");
    expect(decideAction(cfg, "anything-else", "minor")).toBe("hold");
  });
});
