import { describe, it, expect, beforeEach } from "vitest";
import {
  openDb,
  recordUpdate,
  findUpdate,
  setNotified,
  setApplied,
  setDecision,
  findUndigestedApplied,
  findUndigestedSuppressed,
  getLastDigestSent,
  markDigested,
  type UpdateRow,
} from "../src/state/db.js";
import type { Database as DB } from "better-sqlite3";
import {
  buildDigestEmail,
  categorize,
} from "../src/notify/digest.js";
import {
  shouldFireDigest,
  runDigestOnce,
} from "../src/daemon/digest.js";
import type { Notifier, NotifyMessage } from "../src/notify/types.js";

let db: DB;
beforeEach(() => {
  db = openDb({ path: ":memory:" });
});

function fakeRow(overrides: Partial<UpdateRow> = {}): UpdateRow {
  return {
    id: 1,
    stack: "demo",
    service: "demo",
    image: "demo:1.0",
    current_tag: "1.0",
    target_tag: "1.1",
    family: null,
    bump: "minor",
    status: "applied",
    approval_token: null,
    discovered_at: 0,
    notified_at: null,
    decided_at: null,
    decided_by: null,
    applied_at: 0,
    apply_log: null,
    digested_at: null,
    advise_text: null,
    ...overrides,
  };
}

describe("categorize", () => {
  it("buckets rows by status and decided_by", () => {
    const rows = [
      fakeRow({ id: 1, status: "applied", decided_by: "auto" }),
      fakeRow({ id: 2, status: "applied", decided_by: "http-link" }),
      fakeRow({ id: 3, status: "applied", decided_by: "manual-audit" }),
      fakeRow({ id: 4, status: "failed", decided_by: "auto" }),
      fakeRow({ id: 5, status: "notified", bump: "digest" }),
    ];
    const s = categorize(rows);
    expect(s.appliedAuto.map((r) => r.id)).toEqual([1]);
    expect(s.appliedApproved.map((r) => r.id)).toEqual([2, 3]);
    expect(s.failures.map((r) => r.id)).toEqual([4]);
    expect(s.suppressedDigests.map((r) => r.id)).toEqual([5]);
  });
});

describe("buildDigestEmail", () => {
  it("returns null when there's nothing to report", () => {
    expect(buildDigestEmail({ rows: [] })).toBeNull();
    // Notified but not digest-class doesn't show up either.
    expect(
      buildDigestEmail({
        rows: [fakeRow({ status: "notified", bump: "minor" })],
      }),
    ).toBeNull();
  });

  it("renders subject + html + collapsibles with row count summary", () => {
    const rows: UpdateRow[] = [
      fakeRow({ id: 1, stack: "n8n", service: "n8n", status: "applied", decided_by: "auto" }),
      fakeRow({ id: 2, stack: "outline", service: "outline", status: "applied", decided_by: "http-link" }),
      fakeRow({
        id: 3,
        stack: "ghost",
        service: "ghost",
        status: "failed",
        apply_log: "boom",
      }),
      fakeRow({
        id: 4,
        stack: "joplin",
        service: "joplin",
        status: "notified",
        bump: "digest",
        current_tag: "abc123",
        target_tag: "def456",
        advise_text: "Looks like a routine digest move.",
      }),
    ];
    const built = buildDigestEmail({
      rows,
      date: new Date("2026-05-06T18:30:00Z"),
      publicUrl: "https://bump.example.com",
    });
    expect(built).not.toBeNull();
    const { message, rowIds, sections } = built!;
    expect(rowIds).toEqual([1, 2, 3, 4]);
    expect(message.subject).toContain("2026-05-06");
    expect(message.subject).toContain("1 auto-applied");
    expect(message.subject).toContain("1 approved");
    expect(message.subject).toContain("1 failed");
    expect(message.subject).toContain("1 digest-class");
    // HTML contains a <details> per row and section headings
    expect(message.htmlBody).toContain("<details");
    expect(message.htmlBody).toContain("Apply failures");
    expect(message.htmlBody).toContain("Auto-applied");
    expect(message.htmlBody).toContain("Approved &amp; applied");
    expect(message.htmlBody).toContain("Digest-class");
    // Public URL appears in the queue footer
    expect(message.htmlBody).toContain("https://bump.example.com/queue");
    // Plain-text body has all the row stack/service references
    expect(message.body).toContain("n8n/n8n");
    expect(message.body).toContain("outline/outline");
    expect(message.body).toContain("ghost/ghost");
    expect(message.body).toContain("joplin/joplin");
    expect(sections.appliedAuto).toHaveLength(1);
    expect(sections.appliedApproved).toHaveLength(1);
    expect(sections.failures).toHaveLength(1);
    expect(sections.suppressedDigests).toHaveLength(1);
  });

  it("collapses apply log behind a details summary with size info", () => {
    const log = "line1\nline2\nline3";
    const built = buildDigestEmail({
      rows: [
        fakeRow({
          id: 5,
          stack: "ghost",
          service: "ghost",
          status: "failed",
          apply_log: log,
        }),
      ],
    });
    expect(built).not.toBeNull();
    const html = built!.message.htmlBody;
    // Apply log is wrapped in a <details> summary, not a bare <pre>, and the
    // summary advertises the line count + size so the operator can decide
    // whether it is worth opening.
    expect(html).toMatch(/<details[^>]*>\s*<summary[^>]*>Apply log <span[^>]*>\(3 lines · 0\.0 KB\)<\/span><\/summary>/);
    expect(html).toContain("line1\nline2\nline3");
  });
});

describe("shouldFireDigest", () => {
  it("waits until the configured hour", () => {
    const at5 = new Date("2026-05-06T05:00:00");
    expect(shouldFireDigest(at5, null, 18)).toBe(false);
  });
  it("fires the first time at-or-after the hour with no prior send", () => {
    const at18 = new Date("2026-05-06T18:00:00");
    expect(shouldFireDigest(at18, null, 18)).toBe(true);
  });
  it("does not double-fire on the same local day", () => {
    const at18 = new Date("2026-05-06T18:00:00");
    const at19 = new Date("2026-05-06T19:00:00");
    expect(shouldFireDigest(at19, at18.getTime(), 18)).toBe(false);
  });
  it("re-fires the next day", () => {
    const lastSent = new Date("2026-05-06T18:00:00").getTime();
    const nextDay = new Date("2026-05-07T18:00:00");
    expect(shouldFireDigest(nextDay, lastSent, 18)).toBe(true);
  });
});

describe("runDigestOnce", () => {
  it("skips when there's nothing to report", async () => {
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = {
      name: "stub",
      send: async (m) => void sent.push(m),
    };
    const logs: string[] = [];
    const ok = await runDigestOnce({
      db,
      notifiers: [notifier],
      hour: 18,
      log: (m) => logs.push(m),
    });
    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
    expect(logs.some((l) => l.includes("nothing to report"))).toBe(true);
  });

  it("sends the email and marks rows digested when there are events", async () => {
    // Auto-applied row
    const id1 = recordUpdate(db, {
      stack: "n8n",
      service: "n8n",
      image: "n8nio/n8n:1.0",
      currentTag: "1.0",
      targetTag: "1.1",
      bump: "minor",
    });
    setApplied(db, id1, { ok: true, log: "ok" });
    // Approved + applied row
    const id2 = recordUpdate(db, {
      stack: "outline",
      service: "outline",
      image: "outlinewiki/outline:1",
      currentTag: "1.0",
      targetTag: "1.1",
      bump: "minor",
    });
    setDecision(db, id2, { status: "approved", decidedBy: "http-link" });
    setApplied(db, id2, { ok: true, log: "ok" });
    // Suppressed digest-class row
    const id3 = recordUpdate(db, {
      stack: "joplin",
      service: "joplin",
      image: "joplin/server:latest",
      currentTag: "abc123",
      targetTag: "def456",
      bump: "digest",
    });
    setNotified(db, id3);

    const sent: NotifyMessage[] = [];
    const notifier: Notifier = {
      name: "stub",
      send: async (m) => void sent.push(m),
    };
    const logs: string[] = [];
    const ok = await runDigestOnce({
      db,
      notifiers: [notifier],
      hour: 18,
      log: (m) => logs.push(m),
    });
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("bumpsight daily digest");
    // After send, the rows should all carry digested_at and never re-show.
    expect(findUndigestedApplied(db, 86400_000)).toHaveLength(0);
    expect(findUndigestedSuppressed(db, 86400_000)).toHaveLength(0);
    expect(getLastDigestSent(db)).not.toBeNull();
  });

  it("nudges on a held row whose app is a dependency-listed image, but not on a sidecar", async () => {
    // Vault SERVER stack — hashicorp/vault is the app here, so it belongs in
    // the "needs your decision" nudge despite being in KNOWN_DEPENDENCY_IMAGES.
    const app = recordUpdate(db, {
      stack: "vault",
      service: "vault",
      image: "hashicorp/vault:2.0.0",
      currentTag: "2.0.0",
      targetTag: "2.0.4",
      bump: "patch",
    });
    setNotified(db, app);
    // Same image as a sidecar elsewhere — a real dependency, stays email-quiet.
    const sidecar = recordUpdate(db, {
      stack: "outline",
      service: "vault-agent",
      image: "hashicorp/vault:2.0.0",
      currentTag: "2.0.0",
      targetTag: "2.0.4",
      bump: "patch",
    });
    setNotified(db, sidecar);

    const sent: NotifyMessage[] = [];
    const notifier: Notifier = {
      name: "stub",
      send: async (m) => void sent.push(m),
    };
    const ok = await runDigestOnce({
      db,
      notifiers: [notifier],
      hour: 18,
      log: () => {},
    });
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Needs your decision (1)");
    expect(sent[0]!.body).toContain("vault/vault");
    expect(sent[0]!.body).not.toContain("outline/vault-agent");
  });

  it("retries on next call when delivery fails on every notifier", async () => {
    const id = recordUpdate(db, {
      stack: "n8n",
      service: "n8n",
      image: "n8nio/n8n:1.0",
      currentTag: "1.0",
      targetTag: "1.1",
      bump: "minor",
    });
    setApplied(db, id, { ok: true, log: "ok" });

    const failing: Notifier = {
      name: "broken",
      send: async () => {
        throw new Error("smtp boom");
      },
    };
    const logs: string[] = [];
    const ok = await runDigestOnce({
      db,
      notifiers: [failing],
      hour: 18,
      log: (m) => logs.push(m),
    });
    expect(ok).toBe(false);
    // Row stays un-digested, ready for the next tick.
    expect(findUndigestedApplied(db, 86400_000)).toHaveLength(1);
    expect(logs.some((l) => l.includes("send failed"))).toBe(true);
  });

  it("marks rows digested when notifiers list is empty (avoids accumulation)", async () => {
    const id = recordUpdate(db, {
      stack: "n8n",
      service: "n8n",
      image: "n8nio/n8n:1.0",
      currentTag: "1.0",
      targetTag: "1.1",
      bump: "minor",
    });
    setApplied(db, id, { ok: true, log: "ok" });
    const logs: string[] = [];
    const ok = await runDigestOnce({
      db,
      notifiers: [],
      hour: 18,
      log: (m) => logs.push(m),
    });
    expect(ok).toBe(false);
    expect(findUndigestedApplied(db, 86400_000)).toHaveLength(0);
    expect(logs.some((l) => l.includes("no notifiers configured"))).toBe(true);
  });
});

describe("db helpers", () => {
  it("findUndigestedSuppressed only returns digest-class notified rows", () => {
    const idA = recordUpdate(db, {
      stack: "a",
      service: "a",
      image: "x:latest",
      currentTag: "abc123",
      targetTag: "def456",
      bump: "digest",
    });
    setNotified(db, idA);
    // Non-digest notified — should NOT match.
    const idB = recordUpdate(db, {
      stack: "b",
      service: "b",
      image: "y:1.0",
      currentTag: "1.0",
      targetTag: "1.1",
      bump: "minor",
    });
    setNotified(db, idB);
    const got = findUndigestedSuppressed(db, 86400_000);
    expect(got.map((r) => r.id)).toEqual([idA]);
  });

  it("getLastDigestSent reflects markDigested", () => {
    expect(getLastDigestSent(db)).toBeNull();
    const id = recordUpdate(db, {
      stack: "a",
      service: "a",
      image: "x:1.0",
      currentTag: "1.0",
      targetTag: "1.1",
      bump: "minor",
    });
    setApplied(db, id, { ok: true });
    markDigested(db, [id]);
    expect(getLastDigestSent(db)).not.toBeNull();
  });
});

describe("v0.6.0 needs-your-decision section", () => {
  it("renders the section and is empty when nothing is pending", () => {
    const held = fakeRow({ id: 7, status: "notified", stack: "outline", service: "outline" });
    const withNudge = buildDigestEmail({ rows: [], needsDecision: [held] });
    expect(withNudge).not.toBeNull();
    expect(withNudge!.message.subject).toContain("1 awaiting decision");
    expect(withNudge!.message.body).toContain("Needs your decision (1)");
    expect(withNudge!.rowIds).toEqual([]); // NOT consumed
    // nothing at all → null
    expect(buildDigestEmail({ rows: [], needsDecision: [] })).toBeNull();
  });

  it("runDigestOnce sends a decision-only digest and advances the fired marker", async () => {
    const id = recordUpdate(db, {
      stack: "outline", service: "outline", image: "outlinewiki/outline:0.84.0",
      currentTag: "0.84.0", targetTag: "0.85.0", bump: "major",
    });
    setNotified(db, id);
    const sent: NotifyMessage[] = [];
    const notifier: Notifier = { name: "stub", send: async (m) => void sent.push(m) };
    const sentOk = await runDigestOnce({
      db,
      notifiers: [notifier],
      hour: 18,
      log: () => {},
      now: () => 1_700_000_000_000,
    });
    expect(sentOk).toBe(true);
    expect(sent[0]!.subject).toContain("awaiting decision");
    // marker advanced so the scheduler won't re-fire the same day
    expect(getLastDigestSent(db)).toBe(1_700_000_000_000);
    // the held row is untouched (still notified, not digested)
    const row = findUpdate(db, id)!;
    expect(row.status).toBe("notified");
    expect(row.digested_at).toBeNull();
  });
});
