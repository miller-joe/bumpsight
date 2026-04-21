import { describe, it, expect } from "vitest";
import { parseImageRef } from "../src/compose/parse.js";

describe("parseImageRef", () => {
  it("bare name, default tag", () => {
    const r = parseImageRef("nginx");
    expect(r).toMatchObject({ name: "nginx", tag: "latest", namespace: undefined, registry: undefined });
  });

  it("name with explicit tag", () => {
    const r = parseImageRef("nginx:1.27");
    expect(r).toMatchObject({ name: "nginx", tag: "1.27" });
  });

  it("library namespace", () => {
    const r = parseImageRef("library/nginx:alpine");
    expect(r.namespace).toBe("library");
    expect(r.name).toBe("nginx");
    expect(r.tag).toBe("alpine");
  });

  it("ghcr.io registry with namespace", () => {
    const r = parseImageRef("ghcr.io/linuxserver/sonarr:develop");
    expect(r.registry).toBe("ghcr.io");
    expect(r.namespace).toBe("linuxserver");
    expect(r.name).toBe("sonarr");
    expect(r.tag).toBe("develop");
  });

  it("registry with port", () => {
    const r = parseImageRef("localhost:5000/myapp:v1");
    expect(r.registry).toBe("localhost:5000");
    expect(r.name).toBe("myapp");
    expect(r.tag).toBe("v1");
  });

  it("digest is split out", () => {
    const r = parseImageRef("nginx:latest@sha256:abc123");
    expect(r.tag).toBe("latest");
    expect(r.digest).toBe("sha256:abc123");
  });

  it("nested namespace path", () => {
    const r = parseImageRef("ghcr.io/foo/bar/baz:v2");
    expect(r.registry).toBe("ghcr.io");
    expect(r.namespace).toBe("foo/bar");
    expect(r.name).toBe("baz");
    expect(r.tag).toBe("v2");
  });
});
