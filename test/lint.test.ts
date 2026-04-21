import { describe, it, expect } from "vitest";
import { lintCompose } from "../src/lint/rules.js";
import type { ComposeFile } from "../src/compose/parse.js";

function lint(yaml: ComposeFile): Set<string> {
  return new Set(lintCompose(yaml).map((f) => f.ruleId));
}

describe("BS001 :latest tag", () => {
  it("flags implicit latest", () => {
    expect(lint({ services: { web: { image: "nginx" } } }).has("BS001")).toBe(true);
  });
  it("flags explicit :latest", () => {
    expect(lint({ services: { web: { image: "nginx:latest" } } }).has("BS001")).toBe(true);
  });
  it("does not flag a pinned tag", () => {
    expect(lint({ services: { web: { image: "nginx:1.27" } } }).has("BS001")).toBe(false);
  });
  it("does not flag latest+digest", () => {
    expect(lint({ services: { web: { image: "nginx:latest@sha256:abc" } } }).has("BS001")).toBe(false);
  });
});

describe("BS002 privileged", () => {
  it("flags privileged: true", () => {
    expect(lint({ services: { web: { image: "x:1", privileged: true } } }).has("BS002")).toBe(true);
  });
  it("does not flag when absent", () => {
    expect(lint({ services: { web: { image: "x:1" } } }).has("BS002")).toBe(false);
  });
});

describe("BS003 host network", () => {
  it("flags network_mode: host", () => {
    expect(lint({ services: { web: { image: "x:1", network_mode: "host" } } }).has("BS003")).toBe(true);
  });
});

describe("BS004 missing healthcheck", () => {
  it("flags missing healthcheck", () => {
    expect(lint({ services: { web: { image: "x:1" } } }).has("BS004")).toBe(true);
  });
  it("passes when healthcheck present", () => {
    expect(
      lint({ services: { web: { image: "x:1", healthcheck: { test: ["CMD", "true"] } } } }).has(
        "BS004",
      ),
    ).toBe(false);
  });
});

describe("BS005 secrets in env", () => {
  it("flags a literal password value", () => {
    expect(
      lint({ services: { db: { image: "p:1", environment: { POSTGRES_PASSWORD: "hunter2" } } } }).has(
        "BS005",
      ),
    ).toBe(true);
  });
  it("does not flag a variable reference", () => {
    expect(
      lint({
        services: { db: { image: "p:1", environment: { POSTGRES_PASSWORD: "${DB_PASSWORD}" } } },
      }).has("BS005"),
    ).toBe(false);
  });
  it("handles array-form env vars", () => {
    expect(
      lint({ services: { db: { image: "p:1", environment: ["API_KEY=sk-abc123"] } } }).has(
        "BS005",
      ),
    ).toBe(true);
  });
});

describe("BS006 missing restart policy", () => {
  it("flags when restart unset", () => {
    expect(lint({ services: { web: { image: "x:1" } } }).has("BS006")).toBe(true);
  });
  it("passes with restart set", () => {
    expect(lint({ services: { web: { image: "x:1", restart: "unless-stopped" } } }).has("BS006")).toBe(
      false,
    );
  });
});

describe("BS007 missing memory limit", () => {
  it("flags when absent", () => {
    expect(lint({ services: { web: { image: "x:1" } } }).has("BS007")).toBe(true);
  });
  it("passes with mem_limit", () => {
    expect(lint({ services: { web: { image: "x:1", mem_limit: "1g" } } }).has("BS007")).toBe(false);
  });
  it("passes with deploy.resources.limits.memory", () => {
    expect(
      lint({
        services: {
          web: { image: "x:1", deploy: { resources: { limits: { memory: "1G" } } } },
        },
      }).has("BS007"),
    ).toBe(false);
  });
});

describe("BS008 docker socket mount", () => {
  it("flags string-form volume", () => {
    expect(
      lint({ services: { p: { image: "x:1", volumes: ["/var/run/docker.sock:/var/run/docker.sock"] } } }).has(
        "BS008",
      ),
    ).toBe(true);
  });
  it("flags object-form volume", () => {
    expect(
      lint({
        services: {
          p: {
            image: "x:1",
            volumes: [{ source: "/var/run/docker.sock", target: "/var/run/docker.sock" }],
          },
        },
      }).has("BS008"),
    ).toBe(true);
  });
});

describe("BS010 dangerous capabilities", () => {
  it("flags SYS_ADMIN", () => {
    expect(lint({ services: { x: { image: "x:1", cap_add: ["SYS_ADMIN"] } } }).has("BS010")).toBe(
      true,
    );
  });
  it("passes a benign cap", () => {
    expect(lint({ services: { x: { image: "x:1", cap_add: ["SETUID"] } } }).has("BS010")).toBe(false);
  });
});
