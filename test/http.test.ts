import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHttpServer } from "../src/server/http.js";
import { openDb, recordUpdate, findUpdate } from "../src/state/db.js";
import type { CommandRunner } from "../src/apply/docker.js";

async function withServer<T>(
  setup: () => Awaited<ReturnType<typeof startHttpServer>>,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const handle = await setup();
  try {
    return await fn(handle.port);
  } finally {
    await handle.stop();
  }
}

describe("HTTP server", () => {
  it("serves /healthz", async () => {
    const db = openDb({ path: ":memory:" });
    await withServer(
      () => startHttpServer({ db, composeFiles: {}, port: 0 }),
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("ok");
      },
    );
  });

  it("404s on unknown routes", async () => {
    const db = openDb({ path: ":memory:" });
    await withServer(
      () => startHttpServer({ db, composeFiles: {}, port: 0 }),
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/no-such-thing`);
        expect(res.status).toBe(404);
      },
    );
  });

  it("approves a pending row, kicks off apply, and the row ends up applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-http-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(file, `services:\n  app:\n    image: nginx:1.27\n`, "utf-8");
    const db = openDb({ path: ":memory:" });
    const id = recordUpdate(db, {
      stack: "appstack",
      service: "app",
      image: "nginx:1.27",
      currentTag: "1.27",
      targetTag: "1.28",
      bump: "minor",
      approvalToken: "token-approve-1",
    });

    const runner: CommandRunner = async () => ({
      exitCode: 0,
      combinedOutput: "ok",
    });

    await withServer(
      () =>
        startHttpServer({
          db,
          composeFiles: { appstack: file },
          port: 0,
          runner,
        }),
      async (port) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/approve/token-approve-1`,
        );
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain("Approved");
      },
    );

    // Drain the in-flight apply that the handler kicked off.
    await new Promise((r) => setTimeout(r, 50));

    const after = findUpdate(db, id)!;
    expect(after.status).toBe("applied");
    expect(readFileSync(file, "utf-8")).toContain("nginx:1.28");
    rmSync(file, { force: true });
  });

  it("denies a pending row without applying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-http-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(file, `services:\n  app:\n    image: nginx:1.27\n`, "utf-8");
    const db = openDb({ path: ":memory:" });
    const id = recordUpdate(db, {
      stack: "appstack",
      service: "app",
      image: "nginx:1.27",
      currentTag: "1.27",
      targetTag: "1.28",
      bump: "minor",
      approvalToken: "token-deny-1",
    });

    let runnerCalls = 0;
    const runner: CommandRunner = async () => {
      runnerCalls += 1;
      return { exitCode: 0, combinedOutput: "" };
    };

    await withServer(
      () =>
        startHttpServer({
          db,
          composeFiles: { appstack: file },
          port: 0,
          runner,
        }),
      async (port) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/deny/token-deny-1`,
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("Denied");
      },
    );

    expect(runnerCalls).toBe(0);
    expect(findUpdate(db, id)!.status).toBe("denied");
    expect(readFileSync(file, "utf-8")).toContain("nginx:1.27");
    rmSync(file, { force: true });
  });

  it("returns 404 for an unknown approval token", async () => {
    const db = openDb({ path: ":memory:" });
    await withServer(
      () => startHttpServer({ db, composeFiles: {}, port: 0 }),
      async (port) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/approve/this-token-does-not-exist`,
        );
        expect(res.status).toBe(404);
      },
    );
  });

  it("idempotency: re-clicking approve on an already-applied row does not re-run apply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-http-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(file, `services:\n  app:\n    image: nginx:1.27\n`, "utf-8");
    const db = openDb({ path: ":memory:" });
    recordUpdate(db, {
      stack: "appstack",
      service: "app",
      image: "nginx:1.27",
      currentTag: "1.27",
      targetTag: "1.28",
      bump: "minor",
      approvalToken: "tok-idem",
    });

    let runnerCalls = 0;
    const runner: CommandRunner = async () => {
      runnerCalls += 1;
      return { exitCode: 0, combinedOutput: "" };
    };

    await withServer(
      () =>
        startHttpServer({
          db,
          composeFiles: { appstack: file },
          port: 0,
          runner,
        }),
      async (port) => {
        await fetch(`http://127.0.0.1:${port}/approve/tok-idem`);
        // Wait for the background apply to finish.
        await new Promise((r) => setTimeout(r, 50));
        await fetch(`http://127.0.0.1:${port}/approve/tok-idem`);
      },
    );

    // First click should run pull + up = 2. Second click should not re-run.
    expect(runnerCalls).toBe(2);
    rmSync(file, { force: true });
  });
});
