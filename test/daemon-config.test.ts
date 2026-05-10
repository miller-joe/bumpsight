import { describe, it, expect } from "vitest";
import {
  buildApplyPairedDepsConfig,
  isPairedDepBundlingEnabled,
} from "../src/daemon/config.js";

describe("buildApplyPairedDepsConfig", () => {
  it("defaults to off when nothing is set", () => {
    const cfg = buildApplyPairedDepsConfig({}, undefined);
    expect(cfg).toEqual({ default: false, stacks: {} });
  });

  it("accepts a bare boolean (apply_paired_deps: true)", () => {
    const cfg = buildApplyPairedDepsConfig({ apply_paired_deps: true }, undefined);
    expect(cfg).toEqual({ default: true, stacks: {} });
  });

  it("accepts the {default, stacks} object shape", () => {
    const cfg = buildApplyPairedDepsConfig(
      {
        apply_paired_deps: {
          default: false,
          stacks: { outline: true, vault: false },
        },
      },
      undefined,
    );
    expect(cfg.default).toBe(false);
    expect(cfg.stacks).toEqual({ outline: true, vault: false });
  });

  it("env BUMPSIGHT_APPLY_PAIRED_DEPS=true overrides default, leaves per-stack alone", () => {
    const cfg = buildApplyPairedDepsConfig(
      {
        apply_paired_deps: {
          default: false,
          stacks: { vault: false },
        },
      },
      "true",
    );
    expect(cfg.default).toBe(true);
    expect(cfg.stacks).toEqual({ vault: false });
  });

  it("env BUMPSIGHT_APPLY_PAIRED_DEPS=false overrides default to off", () => {
    const cfg = buildApplyPairedDepsConfig(
      { apply_paired_deps: true },
      "false",
    );
    expect(cfg.default).toBe(false);
  });

  it("throws on a non-boolean non-object value", () => {
    expect(() =>
      buildApplyPairedDepsConfig(
        { apply_paired_deps: "yes" as unknown as boolean },
        undefined,
      ),
    ).toThrow(/expected boolean/);
  });
});

describe("isPairedDepBundlingEnabled", () => {
  it("returns the default when no per-stack override exists", () => {
    expect(
      isPairedDepBundlingEnabled({ default: true, stacks: {} }, "anything"),
    ).toBe(true);
    expect(
      isPairedDepBundlingEnabled({ default: false, stacks: {} }, "anything"),
    ).toBe(false);
  });

  it("a per-stack override beats the default", () => {
    expect(
      isPairedDepBundlingEnabled(
        { default: false, stacks: { outline: true } },
        "outline",
      ),
    ).toBe(true);
    expect(
      isPairedDepBundlingEnabled(
        { default: true, stacks: { vault: false } },
        "vault",
      ),
    ).toBe(false);
  });
});
