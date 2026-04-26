import { describe, it, expect, beforeEach } from "vitest";
import {
  openDb,
  recordUpdate,
  findUpdate,
  findByToken,
  listByStatus,
  setNotified,
  setDecision,
  setApplied,
  digest,
} from "../src/state/db.js";
import type { Database as DB } from "better-sqlite3";

let db: DB;
beforeEach(() => {
  db = openDb({ path: ":memory:" });
});

describe("recordUpdate", () => {
  it("inserts a new pending row", () => {
    const id = recordUpdate(db, {
      stack: "jellyfin",
      service: "jellyfin",
      image: "linuxserver/jellyfin:10.10.7",
      currentTag: "10.10.7",
      targetTag: "10.10.8",
      bump: "patch",
      approvalToken: "tok-1",
    });
    const row = findUpdate(db, id);
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending");
    expect(row!.bump).toBe("patch");
    expect(row!.approval_token).toBe("tok-1");
  });

  it("is idempotent — same (stack,service,from,to) returns same id", () => {
    const u = {
      stack: "jellyfin",
      service: "jellyfin",
      image: "linuxserver/jellyfin:10.10.7",
      currentTag: "10.10.7",
      targetTag: "10.10.8",
      bump: "patch" as const,
    };
    const id1 = recordUpdate(db, u);
    const id2 = recordUpdate(db, u);
    expect(id1).toBe(id2);
    // and there's only one row total
    expect(listByStatus(db, "pending")).toHaveLength(1);
  });

  it("records distinct rows for different target tags", () => {
    recordUpdate(db, {
      stack: "x",
      service: "a",
      image: "img:1.0",
      currentTag: "1.0",
      targetTag: "1.1",
      bump: "minor",
    });
    recordUpdate(db, {
      stack: "x",
      service: "a",
      image: "img:1.0",
      currentTag: "1.0",
      targetTag: "1.2",
      bump: "minor",
    });
    expect(listByStatus(db, "pending")).toHaveLength(2);
  });
});

describe("status transitions", () => {
  it("setNotified moves pending → notified", () => {
    const id = recordUpdate(db, {
      stack: "x",
      service: "a",
      image: "img:1",
      currentTag: "1",
      targetTag: "2",
      bump: "major",
    });
    setNotified(db, id);
    const row = findUpdate(db, id)!;
    expect(row.status).toBe("notified");
    expect(row.notified_at).toBeGreaterThan(0);
  });

  it("setDecision records approval/denial", () => {
    const id = recordUpdate(db, {
      stack: "x",
      service: "a",
      image: "img:1",
      currentTag: "1",
      targetTag: "2",
      bump: "major",
    });
    setDecision(db, id, { status: "approved", decidedBy: "joe@example.com" });
    const row = findUpdate(db, id)!;
    expect(row.status).toBe("approved");
    expect(row.decided_by).toBe("joe@example.com");
    expect(row.decided_at).toBeGreaterThan(0);
  });

  it("setApplied records success/failure with optional log", () => {
    const id = recordUpdate(db, {
      stack: "x",
      service: "a",
      image: "img:1",
      currentTag: "1",
      targetTag: "2",
      bump: "minor",
    });
    setApplied(db, id, { ok: true, log: "Recreated container" });
    let row = findUpdate(db, id)!;
    expect(row.status).toBe("applied");
    expect(row.apply_log).toBe("Recreated container");

    const id2 = recordUpdate(db, {
      stack: "x",
      service: "b",
      image: "img:1",
      currentTag: "1",
      targetTag: "2",
      bump: "minor",
    });
    setApplied(db, id2, { ok: false, log: "pull failed: timeout" });
    row = findUpdate(db, id2)!;
    expect(row.status).toBe("failed");
    expect(row.apply_log).toBe("pull failed: timeout");
  });
});

describe("findByToken", () => {
  it("returns the row matching the approval token", () => {
    const id = recordUpdate(db, {
      stack: "x",
      service: "a",
      image: "img:1",
      currentTag: "1",
      targetTag: "2",
      bump: "minor",
      approvalToken: "abc123",
    });
    const row = findByToken(db, "abc123");
    expect(row?.id).toBe(id);
  });

  it("returns undefined for an unknown token", () => {
    expect(findByToken(db, "missing")).toBeUndefined();
  });
});

describe("digest", () => {
  it("aggregates counts and recent applies within a window", () => {
    const id1 = recordUpdate(db, {
      stack: "x",
      service: "a",
      image: "img:1",
      currentTag: "1",
      targetTag: "2",
      bump: "patch",
    });
    setApplied(db, id1, { ok: true });

    const id2 = recordUpdate(db, {
      stack: "x",
      service: "b",
      image: "img:1",
      currentTag: "1",
      targetTag: "2",
      bump: "minor",
    });
    setNotified(db, id2);

    const id3 = recordUpdate(db, {
      stack: "x",
      service: "c",
      image: "img:1",
      currentTag: "1",
      targetTag: "2",
      bump: "major",
    });
    setApplied(db, id3, { ok: false, log: "boom" });

    const stats = digest(db, 7 * 24 * 60 * 60 * 1000);
    expect(stats.applied).toBe(1);
    expect(stats.pendingApproval).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.recentApplies).toHaveLength(1);
    expect(stats.recentApplies[0]!.id).toBe(id1);
  });
});
