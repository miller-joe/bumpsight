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
          pruneAfterApply: false,
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
          pruneAfterApply: false,
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

  it("/queue lists pending and notified rows with approve/deny links", async () => {
    const db = openDb({ path: ":memory:" });
    recordUpdate(db, {
      stack: "stalwart", service: "stalwart", image: "stalwart:0.15", currentTag: "0.15", targetTag: "0.16",
      bump: "minor", approvalToken: "tok-pending",
    });
    recordUpdate(db, {
      stack: "vault-a", service: "vault-agent", image: "hashicorp/vault:1.21",
      currentTag: "1.21", targetTag: "1.22", bump: "minor", approvalToken: "tok-notif",
    });
    // notified one
    db.prepare("UPDATE updates SET status='notified', notified_at=? WHERE approval_token=?")
      .run(Date.now(), "tok-notif");

    await withServer(
      () => startHttpServer({ db, composeFiles: {}, port: 0 }),
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/queue`);
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain("bumpsight queue");
        expect(body).toContain("Pending");
        expect(body).toContain("Notified — awaiting approval");
        expect(body).toContain("stalwart");
        expect(body).toContain("hashicorp/vault");
        // approve/deny links rendered for actionable rows
        expect(body).toContain('href="/approve/tok-pending"');
        expect(body).toContain('href="/deny/tok-notif"');
      },
    );
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

  it("approving one row also approves+applies sibling rows for the same image bump", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "bumpsight-http-"));
    const dirB = mkdtempSync(join(tmpdir(), "bumpsight-http-"));
    const fileA = join(dirA, "compose.yaml");
    const fileB = join(dirB, "compose.yaml");
    writeFileSync(fileA, `services:\n  vault-agent:\n    image: hashicorp/vault:1.21\n`, "utf-8");
    writeFileSync(fileB, `services:\n  vault-agent:\n    image: hashicorp/vault:1.21\n`, "utf-8");
    const stackA = dirA.split("/").pop()!;
    const stackB = dirB.split("/").pop()!;
    const db = openDb({ path: ":memory:" });
    const idA = recordUpdate(db, {
      stack: stackA,
      service: "vault-agent",
      image: "hashicorp/vault:1.21",
      currentTag: "1.21",
      targetTag: "1.22",
      bump: "minor",
      approvalToken: "tok-canonical",
    });
    const idB = recordUpdate(db, {
      stack: stackB,
      service: "vault-agent",
      image: "hashicorp/vault:1.21",
      currentTag: "1.21",
      targetTag: "1.22",
      bump: "minor",
      // Sibling has no token — only canonical row's token is on the email.
      approvalToken: undefined,
    });

    let runnerCalls = 0;
    const runner: CommandRunner = async () => {
      runnerCalls += 1;
      return { exitCode: 0, combinedOutput: "ok" };
    };

    await withServer(
      () =>
        startHttpServer({
          db,
          composeFiles: { [stackA]: fileA, [stackB]: fileB },
          port: 0,
          runner,
          pruneAfterApply: false,
        }),
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/approve/tok-canonical`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("1 other stack");
      },
    );

    // Wait for both background applies to finish.
    await new Promise((r) => setTimeout(r, 100));

    expect(findUpdate(db, idA)!.status).toBe("applied");
    expect(findUpdate(db, idB)!.status).toBe("applied");
    // Two rows × (pull + up) = 4 runner calls.
    expect(runnerCalls).toBe(4);

    rmSync(fileA, { force: true });
    rmSync(fileB, { force: true });
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
          pruneAfterApply: false,
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
