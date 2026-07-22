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

  it("/queue dashboard renders needs-decision cards + per-app history", async () => {
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
        expect(body).toContain("Needs decision");
        expect(body).toContain("Update history by app");
        expect(body).toContain("stalwart");
        expect(body).toContain("hashicorp/vault");
        // Token-addressed POST actions wired into the cards for actionable rows.
        expect(body).toContain("bsAct('tok-pending','approve')");
        expect(body).toContain("bsAct('tok-notif','approve')");
      },
    );
  });

  it("POST /api/updates/:token/apply force-applies a pending row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bumpsight-http-"));
    const file = join(dir, "compose.yaml");
    writeFileSync(file, `services:\n  app:\n    image: nginx:1.27\n`, "utf-8");
    const db = openDb({ path: ":memory:" });
    const id = recordUpdate(db, {
      stack: "appstack", service: "app", image: "nginx:1.27",
      currentTag: "1.27", targetTag: "1.28", bump: "minor", approvalToken: "tok-apply-1",
    });
    let runnerCalls = 0;
    const runner: CommandRunner = async () => {
      runnerCalls += 1;
      return { exitCode: 0, combinedOutput: "ok" };
    };
    await withServer(
      () => startHttpServer({ db, composeFiles: { appstack: file }, port: 0, runner, pruneAfterApply: false }),
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/updates/tok-apply-1/apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
          body: "{}",
        });
        expect(res.status).toBe(200);
        expect((await res.json()).ok).toBe(true);
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(findUpdate(db, id)!.status).toBe("applied");
    expect(runnerCalls).toBe(2);
    rmSync(file, { force: true });
  });

  it("POST snooze hides a row from the needs-decision section", async () => {
    const db = openDb({ path: ":memory:" });
    recordUpdate(db, {
      stack: "s", service: "a", image: "img:1", currentTag: "1", targetTag: "2",
      bump: "minor", approvalToken: "tok-snooze",
    });
    db.prepare("UPDATE updates SET status='notified', notified_at=? WHERE approval_token=?")
      .run(Date.now(), "tok-snooze");
    await withServer(
      () => startHttpServer({ db, composeFiles: {}, port: 0 }),
      async (port) => {
        const snooze = await fetch(`http://127.0.0.1:${port}/api/updates/tok-snooze/snooze`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
          body: JSON.stringify({ duration: "7d" }),
        });
        expect(snooze.status).toBe(200);
        const dash = await (await fetch(`http://127.0.0.1:${port}/`)).text();
        // still in history, but not in the needs-decision cards
        expect(dash).not.toContain("bsAct('tok-snooze','approve')");
        expect(dash).toContain("Snoozed / ignored (1)");
      },
    );
  });

  it("rejects a cross-origin / non-JSON POST (CSRF guard)", async () => {
    const db = openDb({ path: ":memory:" });
    recordUpdate(db, {
      stack: "s", service: "a", image: "img:1", currentTag: "1", targetTag: "2",
      bump: "minor", approvalToken: "tok-csrf",
    });
    await withServer(
      () => startHttpServer({ db, composeFiles: {}, port: 0 }),
      async (port) => {
        // wrong content-type (form post)
        const form = await fetch(`http://127.0.0.1:${port}/api/updates/tok-csrf/deny`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "x=1",
        });
        expect(form.status).toBe(403);
        // cross-site fetch
        const cross = await fetch(`http://127.0.0.1:${port}/api/updates/tok-csrf/deny`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
          body: "{}",
        });
        expect(cross.status).toBe(403);
        expect(findUpdate(db, 1)!.status).toBe("pending");
      },
    );
  });

  it("UI token gates the dashboard and POST actions", async () => {
    const db = openDb({ path: ":memory:" });
    recordUpdate(db, {
      stack: "s", service: "a", image: "img:1", currentTag: "1", targetTag: "2",
      bump: "minor", approvalToken: "tok-auth",
    });
    await withServer(
      () => startHttpServer({ db, composeFiles: {}, port: 0, uiToken: "s3cret" }),
      async (port) => {
        // dashboard without key → login page (no cards)
        const noKey = await (await fetch(`http://127.0.0.1:${port}/`)).text();
        expect(noKey).toContain("access key");
        // POST without token → 401
        const unauth = await fetch(`http://127.0.0.1:${port}/api/updates/tok-auth/deny`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
          body: "{}",
        });
        expect(unauth.status).toBe(401);
        // POST with header token → 200
        const authed = await fetch(`http://127.0.0.1:${port}/api/updates/tok-auth/deny`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "same-origin",
            "x-bumpsight-token": "s3cret",
          },
          body: "{}",
        });
        expect(authed.status).toBe(200);
        expect(findUpdate(db, 1)!.status).toBe("denied");
      },
    );
  });

  it("dashboard quarantines dependencies into a warning-labelled section", async () => {
    const db = openDb({ path: ":memory:" });
    // an app (grafana) and a dependency (postgres), both held/notified
    recordUpdate(db, { stack: "app", service: "grafana", image: "grafana/grafana:10", currentTag: "10.0.0", targetTag: "10.1.0", bump: "minor", approvalToken: "tok-app" });
    recordUpdate(db, { stack: "app", service: "pg", image: "postgres:16", currentTag: "16", targetTag: "17", bump: "major", approvalToken: "tok-dep" });
    db.prepare("UPDATE updates SET status='notified', notified_at=?").run(Date.now());
    await withServer(
      () => startHttpServer({ db, composeFiles: {}, port: 0 }),
      async (port) => {
        const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
        expect(body).toContain("Dependency updates held back");
        expect(body).toContain("⚠ DEPENDENCY");
        expect(body).toContain("Update anyway"); // the path to update a dep
        // the dep card and app card both render, but the dep is in the collapsed section
        const main = body.split('<details class="deps-section"')[0];
        expect(main).toContain("bsAct('tok-app','approve')"); // app in main queue
        expect(main).not.toContain("bsAct('tok-dep','approve')"); // dep NOT in main queue
      },
    );
  });

  it("POST /api/stacks/:stack/policy persists an override", async () => {
    const db = openDb({ path: ":memory:" });
    await withServer(
      () => startHttpServer({ db, composeFiles: { outline: "/x/compose.yaml" }, port: 0,
        rules: { default: { app: "minor", dependencies: "none" }, stacks: {} } }),
      async (port) => {
        const good = await fetch(`http://127.0.0.1:${port}/api/stacks/outline/policy`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
          body: JSON.stringify({ app: "notify", dependencies: "none" }),
        });
        expect(good.status).toBe(200);
        const { getStackPolicy } = await import("../src/state/db.js");
        expect(getStackPolicy(db, "outline")!.app).toBe("notify");
        // invalid value rejected
        const bad = await fetch(`http://127.0.0.1:${port}/api/stacks/outline/policy`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
          body: JSON.stringify({ app: "whenever", dependencies: "none" }),
        });
        expect(bad.status).toBe(400);
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
