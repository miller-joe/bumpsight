import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import type { BumpKind } from "../daemon/rules.js";

export type UpdateStatus =
  | "pending"
  | "notified"
  | "approved"
  | "denied"
  | "applied"
  | "failed";

export interface UpdateRow {
  id: number;
  stack: string;
  service: string;
  image: string;
  current_tag: string;
  target_tag: string;
  family: string | null;
  bump: BumpKind;
  status: UpdateStatus;
  approval_token: string | null;
  discovered_at: number;
  notified_at: number | null;
  decided_at: number | null;
  decided_by: string | null;
  applied_at: number | null;
  apply_log: string | null;
  digested_at: number | null;
  advise_text: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS updates (
  id              INTEGER PRIMARY KEY,
  stack           TEXT NOT NULL,
  service         TEXT NOT NULL,
  image           TEXT NOT NULL,
  current_tag     TEXT NOT NULL,
  target_tag      TEXT NOT NULL,
  family          TEXT,
  bump            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','notified','approved','denied','applied','failed')),
  approval_token  TEXT,
  discovered_at   INTEGER NOT NULL,
  notified_at     INTEGER,
  decided_at      INTEGER,
  decided_by      TEXT,
  applied_at      INTEGER,
  apply_log       TEXT,
  digested_at     INTEGER,
  advise_text     TEXT,
  UNIQUE (stack, service, current_tag, target_tag)
);
CREATE INDEX IF NOT EXISTS idx_updates_status ON updates(status);
CREATE INDEX IF NOT EXISTS idx_updates_token ON updates(approval_token);
CREATE INDEX IF NOT EXISTS idx_updates_applied_digest ON updates(applied_at, digested_at)
  WHERE applied_at IS NOT NULL AND digested_at IS NULL;

-- Last-seen digest per (image, tag). Used to detect digest changes on moving
-- tags like :latest where the version isn't encoded in the tag itself.
-- resolved_tag records the most-precise semver tag we found sharing this
-- digest at observation time (Phase 2 — used to classify digest changes
-- as patch/minor/major instead of always "digest").
CREATE TABLE IF NOT EXISTS tag_digests (
  image         TEXT NOT NULL,
  tag           TEXT NOT NULL,
  digest        TEXT NOT NULL,
  resolved_tag  TEXT,
  seen_at       INTEGER NOT NULL,
  PRIMARY KEY (image, tag)
);
`;

/**
 * Idempotent migration. The pre-v0.3.1 schema had a CHECK constraint on the
 * `bump` column restricting it to patch/minor/major/unknown — the digest-
 * tracking feature adds a new `digest` value. SQLite can't ALTER a CHECK
 * constraint, so we rename + recreate when we detect the old form.
 */
function migrate(db: DB): void {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='updates'",
    )
    .get() as { sql: string } | undefined;
  if (row && row.sql.includes("'patch','minor','major','unknown'")) {
    // pre-v0.3.1 had a CHECK on `bump` that doesn't include 'digest'.
    // SQLite can't ALTER a CHECK in place, so rename + recreate.
    db.exec("ALTER TABLE updates RENAME TO _updates_v1");
    db.exec(SCHEMA);
    db.exec("INSERT INTO updates SELECT * FROM _updates_v1");
    db.exec("DROP TABLE _updates_v1");
  }

  // Add tag_digests.resolved_tag if upgrading from v0.3.1 (Phase 1).
  const td = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='tag_digests'",
    )
    .get() as { sql: string } | undefined;
  if (td && !/\bresolved_tag\b/.test(td.sql)) {
    db.exec("ALTER TABLE tag_digests ADD COLUMN resolved_tag TEXT");
  }

  // v0.4.0: add digested_at column for daily-digest dedup.
  const u = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='updates'",
    )
    .get() as { sql: string } | undefined;
  if (u && !/\bdigested_at\b/.test(u.sql)) {
    db.exec("ALTER TABLE updates ADD COLUMN digested_at INTEGER");
  }

  // v0.4.1: persist the LLM advise body so we can audit what was actually
  // shown to the operator. Useful for debugging "why is the AI advice
  // unhelpful in this email" — read straight off the row instead of
  // re-rendering and hoping the model gives the same output twice.
  const u2 = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='updates'",
    )
    .get() as { sql: string } | undefined;
  if (u2 && !/\badvise_text\b/.test(u2.sql)) {
    db.exec("ALTER TABLE updates ADD COLUMN advise_text TEXT");
  }
}

export interface OpenOptions {
  /** Path to the SQLite file, or ":memory:" for an ephemeral DB (used by tests). */
  path: string;
}

export function openDb(opts: OpenOptions): DB {
  const db = new Database(opts.path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.exec(SCHEMA);
  return db;
}

export interface StoredDigest {
  digest: string;
  resolvedTag: string | null;
}

/**
 * Look up the last-seen digest for (image, tag). Returns undefined if we've
 * never recorded one — caller's first observation should always be stored
 * silently (no bump generated for the initial observation). The resolved_tag
 * field carries the most-precise semver tag that shared this digest at the
 * time of observation (Phase 2). Rows recorded under v0.3.1 have it null.
 */
export function getStoredDigest(
  db: DB,
  image: string,
  tag: string,
): StoredDigest | undefined {
  const row = db
    .prepare(
      `SELECT digest, resolved_tag FROM tag_digests WHERE image = ? AND tag = ?`,
    )
    .get(image, tag) as
    | { digest: string; resolved_tag: string | null }
    | undefined;
  if (!row) return undefined;
  return { digest: row.digest, resolvedTag: row.resolved_tag };
}

/**
 * Record (or replace) the last-seen digest for (image, tag). The optional
 * resolvedTag is the most-precise semver tag known to share this digest at
 * the time of observation (used by Phase 2 digest → semver resolution).
 */
export function saveDigest(
  db: DB,
  image: string,
  tag: string,
  digest: string,
  resolvedTag?: string | null,
): void {
  db.prepare(
    `INSERT INTO tag_digests (image, tag, digest, resolved_tag, seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(image, tag) DO UPDATE SET
       digest = excluded.digest,
       resolved_tag = excluded.resolved_tag,
       seen_at = excluded.seen_at`,
  ).run(image, tag, digest, resolvedTag ?? null, Date.now());
}

export interface NewUpdate {
  stack: string;
  service: string;
  image: string;
  currentTag: string;
  targetTag: string;
  family?: string;
  bump: BumpKind;
  approvalToken?: string;
}

/**
 * Insert a discovered update. If the same (stack, service, current_tag,
 * target_tag) row already exists, returns the existing id and leaves the
 * row alone — re-scans must not flap the status of an already-decided
 * record. Returns the row id either way.
 */
export function recordUpdate(db: DB, u: NewUpdate): number {
  const existing = db
    .prepare(
      `SELECT id FROM updates
       WHERE stack = ? AND service = ? AND current_tag = ? AND target_tag = ?`,
    )
    .get(u.stack, u.service, u.currentTag, u.targetTag) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;

  const result = db
    .prepare(
      `INSERT INTO updates
       (stack, service, image, current_tag, target_tag, family, bump,
        status, approval_token, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      u.stack,
      u.service,
      u.image,
      u.currentTag,
      u.targetTag,
      u.family ?? null,
      u.bump,
      u.approvalToken ?? null,
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

export function findUpdate(db: DB, id: number): UpdateRow | undefined {
  return db.prepare(`SELECT * FROM updates WHERE id = ?`).get(id) as
    | UpdateRow
    | undefined;
}

export function findByToken(db: DB, token: string): UpdateRow | undefined {
  return db
    .prepare(`SELECT * FROM updates WHERE approval_token = ?`)
    .get(token) as UpdateRow | undefined;
}

export function listByStatus(db: DB, status: UpdateStatus): UpdateRow[] {
  return db
    .prepare(`SELECT * FROM updates WHERE status = ? ORDER BY discovered_at DESC`)
    .all(status) as UpdateRow[];
}

/**
 * Find sibling rows that share the same image bump (same image, current_tag,
 * target_tag) and are still awaiting a decision. Used by the approve/deny
 * handler to apply one click to every stack running the same image.
 *
 * Excludes the canonical row's own id so callers can iterate without
 * special-casing it. Includes only rows in actionable states ('pending',
 * 'notified') — already-decided siblings are left alone.
 */
export function findSiblings(db: DB, row: UpdateRow): UpdateRow[] {
  return db
    .prepare(
      `SELECT * FROM updates
       WHERE id != ?
         AND image = ?
         AND current_tag = ?
         AND target_tag = ?
         AND status IN ('pending','notified')
       ORDER BY id ASC`,
    )
    .all(row.id, row.image, row.current_tag, row.target_tag) as UpdateRow[];
}

export function setNotified(db: DB, id: number): void {
  db.prepare(
    `UPDATE updates SET status = 'notified', notified_at = ? WHERE id = ?`,
  ).run(Date.now(), id);
}

export interface DecisionUpdate {
  status: "approved" | "denied";
  decidedBy: string;
}

export function setDecision(db: DB, id: number, d: DecisionUpdate): void {
  db.prepare(
    `UPDATE updates SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?`,
  ).run(d.status, Date.now(), d.decidedBy, id);
}

export interface ApplyResult {
  ok: boolean;
  log?: string;
}

export function setApplied(db: DB, id: number, r: ApplyResult): void {
  db.prepare(
    `UPDATE updates SET status = ?, applied_at = ?, apply_log = ? WHERE id = ?`,
  ).run(r.ok ? "applied" : "failed", Date.now(), r.log ?? null, id);
}

/**
 * Persist the LLM-rendered advise body for a row (v0.4.1). Captured at the
 * time the bump notification is dispatched so a later debug session can
 * read what the operator actually saw, without having to re-call the LLM
 * (and risk a different stochastic answer).
 */
export function setAdviseText(db: DB, id: number, text: string): void {
  db.prepare(`UPDATE updates SET advise_text = ? WHERE id = ?`).run(text, id);
}

/**
 * Daily-digest support (v0.4.0). Returns rows that were applied (or failed
 * apply) in the given window AND haven't been included in a digest yet.
 * Caller marks them digested via `markDigested` once the daily report email
 * actually went out.
 */
export function findUndigestedApplied(
  db: DB,
  sinceMs: number,
): UpdateRow[] {
  const cutoff = Date.now() - sinceMs;
  return db
    .prepare(
      `SELECT * FROM updates
       WHERE applied_at IS NOT NULL
         AND applied_at >= ?
         AND digested_at IS NULL
         AND status IN ('applied', 'failed')
       ORDER BY applied_at ASC`,
    )
    .all(cutoff) as UpdateRow[];
}

/**
 * v0.4.3 daily-digest support: returns digest-class bumps that were marked
 * notified within the window but never produced a per-event email (v0.4.1
 * suppressed those — see daemon/index.ts dispatchGroup). They show up in the
 * daily-digest rollup so the operator still sees them.
 */
export function findUndigestedSuppressed(
  db: DB,
  sinceMs: number,
): UpdateRow[] {
  const cutoff = Date.now() - sinceMs;
  return db
    .prepare(
      `SELECT * FROM updates
       WHERE bump = 'digest'
         AND status = 'notified'
         AND notified_at IS NOT NULL
         AND notified_at >= ?
         AND digested_at IS NULL
       ORDER BY notified_at ASC`,
    )
    .all(cutoff) as UpdateRow[];
}

/**
 * v0.4.3: timestamp of the most recent digest send (any row). Used by the
 * scheduler to decide whether today's digest has already fired. Null when
 * no digest has ever shipped on this DB.
 */
export function getLastDigestSent(db: DB): number | null {
  const row = db
    .prepare(`SELECT MAX(digested_at) AS t FROM updates`)
    .get() as { t: number | null } | undefined;
  return row?.t ?? null;
}

export function markDigested(db: DB, ids: number[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(`UPDATE updates SET digested_at = ? WHERE id = ?`);
  const now = Date.now();
  const tx = db.transaction((rows: number[]) => {
    for (const id of rows) stmt.run(now, id);
  });
  tx(ids);
}

export interface DigestStats {
  applied: number;
  pendingApproval: number;
  failed: number;
  recentApplies: UpdateRow[];
}

export function digest(db: DB, sinceMs: number): DigestStats {
  const now = Date.now();
  const cutoff = now - sinceMs;
  const applied = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM updates WHERE status = 'applied' AND applied_at >= ?`,
      )
      .get(cutoff) as { n: number }
  ).n;
  const pendingApproval = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM updates WHERE status = 'notified'`)
      .get() as { n: number }
  ).n;
  const failed = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM updates WHERE status = 'failed' AND applied_at >= ?`,
      )
      .get(cutoff) as { n: number }
  ).n;
  const recentApplies = db
    .prepare(
      `SELECT * FROM updates WHERE status = 'applied' AND applied_at >= ?
       ORDER BY applied_at DESC LIMIT 50`,
    )
    .all(cutoff) as UpdateRow[];
  return { applied, pendingApproval, failed, recentApplies };
}
