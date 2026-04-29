import { describe, it, expect } from "vitest";
import { parseTag, compareTags, findLatestInFamily } from "../src/util/semver.js";

describe("parseTag", () => {
  it("bare semver (3 parts)", () => {
    const t = parseTag("1.2.3");
    expect(t.family).toBe("semver:3");
    expect(t.numeric).toEqual([1, 2, 3]);
  });

  it("v-prefixed semver (3 parts)", () => {
    const t = parseTag("v4.0.14");
    expect(t.family).toBe("semver:3");
    expect(t.numeric).toEqual([4, 0, 14]);
  });

  it("semver with -alpine suffix", () => {
    const t = parseTag("16.2-alpine");
    expect(t.family).toBe("semver-alpine:2");
    expect(t.numeric).toEqual([16, 2]);
    expect(t.suffix).toBe("-alpine");
  });

  it("single-integer tag is its own family", () => {
    const t = parseTag("176");
    expect(t.family).toBe("semver:1");
    expect(t.numeric).toEqual([176]);
  });

  it("bare integer does not match 3-part semver", () => {
    expect(findLatestInFamily("4.0.14", ["176", "200"])).toBeNull();
  });

  it("date-based tag", () => {
    const t = parseTag("2026-04-15");
    expect(t.family).toBe("date");
    expect(t.dateYMD).toBe(20260415);
  });

  it("channel name", () => {
    const t = parseTag("latest");
    expect(t.family).toBe("channel:latest");
  });

  it("LinuxServer.io tag with -rN-lsNNN strips build numbers from family", () => {
    const a = parseTag("4.0.17.2952-r0-ls309");
    const b = parseTag("4.0.18.2960-r1-ls310");
    expect(a.family).toBe(b.family);
    expect(a.numeric).toEqual([4, 0, 17, 2952]);
    expect(b.numeric).toEqual([4, 0, 18, 2960]);
    // suffix is preserved on the parsed object so display can keep it
    expect(a.suffix).toBe("-r0-ls309");
  });

  it("LinuxServer.io version- prefix gets stripped before semver parse", () => {
    const t = parseTag("version-1.43.1.10611-1e34174b1-ls303");
    expect(t.family).toMatch(/^semver/);
    expect(t.numeric).toEqual([1, 43, 1, 10611]);
  });

  it("LinuxServer.io comparison: newer ls-suffixed tag wins in same family", () => {
    expect(findLatestInFamily("4.0.17.2952-r0-ls309", [
      "4.0.18.2960-r0-ls310",
      "4.0.16.2900-r0-ls300",
    ])).toBe("4.0.18.2960-r0-ls310");
  });

  it("LinuxServer.io: alpine variant + ls suffix kept distinct from bare", () => {
    // Variants like -alpine should remain in their own family even when
    // an ls build number is also present.
    const a = parseTag("3.0-alpine-r0-ls123");
    const b = parseTag("3.0-r0-ls123");
    expect(a.family).not.toBe(b.family);
  });
});

describe("compareTags / findLatestInFamily", () => {
  it("finds a newer semver", () => {
    expect(findLatestInFamily("4.0.14", ["4.0.13", "4.0.14", "4.1.0", "4.1.1"])).toBe("4.1.1");
  });

  it("returns null when nothing newer", () => {
    expect(findLatestInFamily("4.1.1", ["4.0.13", "4.1.0"])).toBeNull();
  });

  it("ignores tags in a different family", () => {
    expect(findLatestInFamily("4.0.14", ["develop", "latest", "nightly", "4.1.0"])).toBe("4.1.0");
  });

  it("respects suffix family — alpine vs bare", () => {
    // current tag is bare 16.2, don't jump to 16.3-alpine (different variant)
    expect(findLatestInFamily("16.2", ["16.3-alpine", "16.3"])).toBe("16.3");
  });

  it("alpine variant stays in alpine", () => {
    expect(findLatestInFamily("16.2-alpine", ["16.3", "16.3-alpine"])).toBe("16.3-alpine");
  });

  it("date-based progression", () => {
    expect(findLatestInFamily("2026-04-15", ["2026-04-14", "2026-04-16", "develop"])).toBe("2026-04-16");
  });
});

describe("compareTags directly", () => {
  it("returns 0 for different families", () => {
    expect(compareTags(parseTag("1.2.3"), parseTag("2026-04-15"))).toBe(0);
    expect(compareTags(parseTag("1.2.3"), parseTag("latest"))).toBe(0);
  });

  it("returns 0 across different numeric part counts (intentional)", () => {
    // Different part counts are different families: this is a deliberate
    // conservative choice so `16` isn't bumped to `16.2` automatically.
    expect(compareTags(parseTag("1.2"), parseTag("1.2.0"))).toBe(0);
    expect(compareTags(parseTag("1.2"), parseTag("1.2.1"))).toBe(0);
    expect(compareTags(parseTag("1.3"), parseTag("1.2.9"))).toBe(0);
  });

  it("compares within the same part count", () => {
    expect(compareTags(parseTag("1.2"), parseTag("1.3"))).toBeLessThan(0);
    expect(compareTags(parseTag("1.2.3"), parseTag("1.2.4"))).toBeLessThan(0);
    expect(compareTags(parseTag("2.0.0"), parseTag("1.9.9"))).toBeGreaterThan(0);
  });
});
