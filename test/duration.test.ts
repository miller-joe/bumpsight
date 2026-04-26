import { describe, it, expect } from "vitest";
import { parseDuration } from "../src/util/duration.js";

describe("parseDuration", () => {
  it("treats bare integers as seconds", () => {
    expect(parseDuration("30")).toBe(30_000);
  });

  it("handles every supported unit", () => {
    expect(parseDuration("100ms")).toBe(100);
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("6h")).toBe(21_600_000);
    expect(parseDuration("2d")).toBe(172_800_000);
  });

  it("tolerates whitespace and case", () => {
    expect(parseDuration("  6H  ")).toBe(21_600_000);
    expect(parseDuration("30 m")).toBe(1_800_000);
  });

  it("rejects garbage", () => {
    expect(() => parseDuration("")).toThrow();
    expect(() => parseDuration("abc")).toThrow();
    expect(() => parseDuration("6x")).toThrow();
    expect(() => parseDuration("1.5h")).toThrow();
  });
});
