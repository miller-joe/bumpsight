import { describe, it, expect } from "vitest";
import {
  looksLikeVersion,
  movingTagInfo,
  resolveMovingDelta,
} from "../src/registry/moving-tag-label.js";
import { extractVersion } from "../src/registry/oci-config.js";
import { fromDisplay, toDisplay } from "../src/util/display.js";
import type { UpdateRow } from "../src/state/db.js";

describe("looksLikeVersion", () => {
  it("accepts real version-looking strings", () => {
    for (const v of ["2.20.15", "v10.5.0", "1.35.8", "v4.5.0-29319337385", "5.13.19-d"])
      expect(looksLikeVersion(v)).toBe(true);
  });
  it("rejects branch / channel / empty values", () => {
    for (const v of ["main", "master", "latest", "stable", "edge", "nightly", "", undefined])
      expect(looksLikeVersion(v)).toBe(false);
  });
  it("rejects a value with no digit", () => {
    expect(looksLikeVersion("alpine")).toBe(false);
  });
});

describe("extractVersion", () => {
  it("reads org.opencontainers.image.version, then the label-schema fallback", () => {
    expect(extractVersion({ "org.opencontainers.image.version": "2.3.0" })).toBe("2.3.0");
    expect(extractVersion({ "org.label-schema.version": "1.0" })).toBe("1.0");
    expect(extractVersion({})).toBeUndefined();
  });
});

describe("movingTagInfo", () => {
  it("keeps a version-looking label and derives a full timestamp", () => {
    const info = movingTagInfo({
      labels: { "org.opencontainers.image.version": "2.20.15" },
      created: "2026-04-27T10:00:00Z",
    });
    expect(info).toEqual({ version: "2.20.15", date: "2026-04-27 10:00:00" });
  });
  it("drops a branch-name version but keeps the build timestamp", () => {
    const info = movingTagInfo({
      labels: { "org.opencontainers.image.version": "main" },
      created: "2026-07-17T04:13:11.269Z",
    });
    expect(info).toEqual({ version: undefined, date: "2026-07-17 04:13:11" });
  });
  it("timestamp only when there are no labels at all", () => {
    expect(movingTagInfo({ labels: {}, created: "2026-05-30T20:42:03Z" })).toEqual({
      version: undefined,
      date: "2026-05-30 20:42:03",
    });
  });
  it("two same-day builds register as a delta via the time component", () => {
    const a = movingTagInfo({ labels: {}, created: "2026-07-19T04:00:00Z" });
    const b = movingTagInfo({ labels: {}, created: "2026-07-19T22:30:00Z" });
    expect(resolveMovingDelta(a, b)).toEqual({
      from: "2026-07-19 04:00:00",
      to: "2026-07-19 22:30:00",
    });
  });
});

describe("resolveMovingDelta", () => {
  it("prefers a differing version pair", () => {
    expect(
      resolveMovingDelta({ version: "2.20.14", date: "2026-04-01" }, { version: "2.20.15", date: "2026-04-27" }),
    ).toEqual({ from: "2.20.14", to: "2.20.15" });
  });
  it("falls back to a differing date pair when versions are absent/equal", () => {
    expect(
      resolveMovingDelta({ date: "2026-06-02" }, { date: "2026-07-17" }),
    ).toEqual({ from: "2026-06-02", to: "2026-07-17" });
  });
  it("surfaces a to-only value when the from side is unknown (backfill)", () => {
    expect(resolveMovingDelta({}, { version: "1.35.8", date: "2026-04-25" })).toEqual({ to: "1.35.8" });
    expect(resolveMovingDelta({}, { date: "2026-04-25" })).toEqual({ to: "2026-04-25" });
  });
  it("returns nothing when neither side has anything usable", () => {
    expect(resolveMovingDelta({}, {})).toEqual({});
  });

  it("flags a phantom when both sides decode to the same version", () => {
    // vaultwake case: 0.3.0 both sides, backwards build timestamps → phantom
    expect(
      resolveMovingDelta(
        { version: "0.3.0", date: "2026-06-07 23:47:17" },
        { version: "0.3.0", date: "2026-06-07 23:46:54" },
      ),
    ).toEqual({ sameVersion: true });
  });
});

describe("fromDisplay / toDisplay", () => {
  const base = { current_tag: "abc123def456", target_tag: "def456abc789" };
  it("uses the decoded display override when present", () => {
    const row = { ...base, bump: "digest", display_from: "2.20.14", display_to: "2.20.15" } as UpdateRow;
    expect(fromDisplay(row)).toBe("2.20.14");
    expect(toDisplay(row)).toBe("2.20.15");
  });
  it("hash-ellipsis for an un-decoded digest row", () => {
    const row = { ...base, bump: "digest", display_from: null, display_to: null } as UpdateRow;
    expect(fromDisplay(row)).toBe("abc123def456…");
    expect(toDisplay(row)).toBe("def456abc789…");
  });
  it("raw tag for a normal semver row", () => {
    const row = { current_tag: "1.27", target_tag: "1.28", bump: "minor", display_from: null, display_to: null } as UpdateRow;
    expect(fromDisplay(row)).toBe("1.27");
    expect(toDisplay(row)).toBe("1.28");
  });
  it("mixed: to decoded, from still a hash (backfill)", () => {
    const row = { ...base, bump: "digest", display_from: null, display_to: "2.20.15" } as UpdateRow;
    expect(fromDisplay(row)).toBe("abc123def456…");
    expect(toDisplay(row)).toBe("2.20.15");
  });
});
