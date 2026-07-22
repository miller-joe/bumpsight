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
  paired_deps_json: string | null;
  /** v0.6.0: when set and in the future, the row is snoozed — hidden from the
   *  dashboard's "needs decision" section (and the daily-digest nudge) until
   *  this timestamp passes. "Ignore" is modelled as a far-future value so it
   *  stays reversible without adding a new status (a new status would force an
   *  expensive CHECK-constraint table rebuild). Null = not snoozed. */
  snoozed_until: number | null;
  /** v0.6.0: human-readable display override for a moving-tag digest bump whose
   *  digests were decoded to a version or build date via OCI labels (so the row
   *  shows `2.20.14 → 2.20.15` instead of `sha256:abc… → sha256:def…`).
   *  current_tag/target_tag remain the source of truth; these are display-only.
   *  Either side may be null (fall back to the hash for that side). */
  display_from: string | null;
  display_to: string | null;
  /** v0.6.0: 1 when this row has been retired from "needs decision" but kept in
   *  history. Set for three cases (see dismiss_reason): a moving-tag digest
   *  replaced by a newer one, a row the current policy would auto-apply/skip
   *  (reconciled), or an app the operator muted. Modelled as a flag, not a
   *  status, to stay on the cheap ADD COLUMN migration path. */
  superseded: number | null;
  /** v0.6.0: why the row was retired — 'superseded' | 'auto-apply' | 'skip' |
   *  'muted'. Drives the history badge. Null on non-retired rows. */
  dismiss_reason: string | null;
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
  paired_deps_json TEXT,
  snoozed_until   INTEGER,
  display_from    TEXT,
  display_to      TEXT,
  superseded      INTEGER,
  dismiss_reason  TEXT,
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

-- v0.5.7: watched_releases — opt-in tracking of non-Docker upstreams that
-- ship as GitHub Releases (e.g. a manually-pinned binary like git-lfs). These
-- have no compose image: line, so the normal scan loop can't see them. The
-- operator declares the installed version + the upstream repo; bumpsight polls
-- GitHub Releases and emails (notify-only — it can't apply a host binary) when
-- a newer release appears. notified_tag dedups so each newer release fires
-- exactly one email until the operator updates current or a newer one lands.
CREATE TABLE IF NOT EXISTS watched_releases (
  repo          TEXT PRIMARY KEY,   -- "owner/repo" — the dedup/state key
  current       TEXT NOT NULL,      -- operator-declared installed version
  latest_seen   TEXT,              -- newest upstream release observed (informational)
  notified_tag  TEXT,              -- upstream tag the last email was about (dedup)
  notified_at   INTEGER,
  checked_at    INTEGER,
  advise_text   TEXT
);

-- v0.6.0: per-stack policy overrides set from the dashboard UI. These take
-- precedence over the file/env default + stacks policy at scan time (the daemon
-- merges this table into RulesConfig.stacks each tick). Kept in state rather
-- than mutating the operator bumpsight.yaml so the change is reversible,
-- survives config reloads, and never fights the git-tracked compose tree /
-- commit-on-apply flow. Created via CREATE TABLE IF NOT EXISTS — no migrate()
-- entry needed (same pattern as watched_releases).
CREATE TABLE IF NOT EXISTS stack_policies (
  stack         TEXT PRIMARY KEY,
  app           TEXT NOT NULL,
  dependencies  TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- v0.6.0: single-row marker of when the daily digest last fired. Before v0.6.0
-- the "did we send today" check relied solely on MAX(updates.digested_at),
-- which only advances when applied/suppressed rows are consumed. The new
-- "needs your decision" digest section can be the sole reason a digest sends
-- (no rows consumed), so we need a marker that advances on every send — else a
-- decision-only digest would re-fire every scheduler tick all day.
CREATE TABLE IF NOT EXISTS digest_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  last_fired_at INTEGER NOT NULL
);

-- v0.6.0: muted apps. "Ignore" mutes a (stack, service): existing open rows are
-- retired and the scan skips it, so no future bumps for it surface either. The
-- row is the reversible mute state — un-muting removes it and the scan resumes
-- surfacing updates for that app.
CREATE TABLE IF NOT EXISTS muted_services (
  stack     TEXT NOT NULL,
  service   TEXT NOT NULL,
  muted_at  INTEGER NOT NULL,
  PRIMARY KEY (stack, service)
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

  // v0.5.4: persist the paired-dep recommendations alongside the advise body
  // so the apply step can atomically bundle dep rewrites with the app rewrite
  // when bundling is opted in for a stack. Stored as JSON
  // (DepRecommendation[]); nullable when the lookup didn't run or produced
  // nothing.
  const u3 = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='updates'",
    )
    .get() as { sql: string } | undefined;
  if (u3 && !/\bpaired_deps_json\b/.test(u3.sql)) {
    db.exec("ALTER TABLE updates ADD COLUMN paired_deps_json TEXT");
  }

  // v0.6.0: snoozed_until powers the dashboard's snooze/ignore filter. Fresh
  // installs get it from SCHEMA above; existing DBs get the ALTER here. The
  // regex guard makes this a no-op once the column exists, and it's skipped on
  // a brand-new DB (table absent → row undefined) where SCHEMA supplies it.
  const u4 = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='updates'",
    )
    .get() as { sql: string } | undefined;
  if (u4 && !/\bsnoozed_until\b/.test(u4.sql)) {
    db.exec("ALTER TABLE updates ADD COLUMN snoozed_until INTEGER");
  }

  // v0.6.0: display_from / display_to — human-readable delta for moving-tag
  // digest bumps decoded via OCI labels. Same dual-add pattern (SCHEMA for
  // fresh installs, guarded ALTER here for upgrades).
  const u5 = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='updates'",
    )
    .get() as { sql: string } | undefined;
  if (u5 && !/\bdisplay_from\b/.test(u5.sql)) {
    db.exec("ALTER TABLE updates ADD COLUMN display_from TEXT");
    db.exec("ALTER TABLE updates ADD COLUMN display_to TEXT");
  }

  // v0.6.0: superseded flag — retires older moving-tag digest rows once a newer
  // digest lands for the same (stack, service). Same dual-add pattern.
  const u6 = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='updates'",
    )
    .get() as { sql: string } | undefined;
  if (u6 && !/\bsuperseded\b/.test(u6.sql)) {
    db.exec("ALTER TABLE updates ADD COLUMN superseded INTEGER");
  }

  // v0.6.0: dismiss_reason — labels why a retired row left the queue.
  const u7 = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='updates'",
    )
    .get() as { sql: string } | undefined;
  if (u7 && !/\bdismiss_reason\b/.test(u7.sql)) {
    db.exec("ALTER TABLE updates ADD COLUMN dismiss_reason TEXT");
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
 * v0.5.4: persist the structured paired-dep recommendations on the row.
 * Captured at hold-time alongside the advise body so apply-time bundling
 * has the same set of recommendations the operator saw in the email when
 * they clicked Approve. Pass the JSON string (DepRecommendation[]).
 */
export function setPairedDeps(db: DB, id: number, json: string): void {
  db.prepare(`UPDATE updates SET paired_deps_json = ? WHERE id = ?`).run(
    json,
    id,
  );
}

/**
 * v0.6.0: set the human-readable display override for a moving-tag digest bump.
 * Either side may be null (falls back to the hash for that side). current_tag /
 * target_tag are left untouched — these are display-only.
 */
export function setDisplayTags(
  db: DB,
  id: number,
  from: string | null,
  to: string | null,
): void {
  db.prepare(
    `UPDATE updates SET display_from = ?, display_to = ? WHERE id = ?`,
  ).run(from, to, id);
}

// ─── v0.6.0: snooze / ignore (dashboard filter, no scan wiring) ──────────────

/** Far-future timestamp used to model an indefinite "ignore" as a snooze. */
export const SNOOZE_FOREVER = 4102444800000; // 2100-01-01T00:00:00Z

/**
 * Snooze a row until `untilMs`. Hidden from the dashboard "needs decision"
 * section and the daily-digest nudge until then. Pass {@link SNOOZE_FOREVER}
 * to "ignore" indefinitely. Purely a presentation filter — the scan loop is
 * unaffected (a snoozed `notified` row is already left untouched by re-scans
 * via the recordUpdate dedup + status guard).
 */
export function setSnooze(db: DB, id: number, untilMs: number): void {
  db.prepare(`UPDATE updates SET snoozed_until = ? WHERE id = ?`).run(
    untilMs,
    id,
  );
}

/** Clear a snooze so the row reappears in "needs decision". */
export function clearSnooze(db: DB, id: number): void {
  db.prepare(`UPDATE updates SET snoozed_until = NULL WHERE id = ?`).run(id);
}

/**
 * Rows awaiting a human decision (`pending` or `notified`) that are not
 * currently snoozed. Powers the dashboard's "Needs decision" section and the
 * daily-digest nudge. `nowMs` is passed in so tests can control the clock.
 */
export function listNeedsDecision(db: DB, nowMs: number): UpdateRow[] {
  return db
    .prepare(
      `SELECT * FROM updates
       WHERE status IN ('pending','notified')
         AND (snoozed_until IS NULL OR snoozed_until <= ?)
         AND (superseded IS NULL OR superseded = 0)
       ORDER BY discovered_at DESC`,
    )
    .all(nowMs) as UpdateRow[];
}

/**
 * v0.6.0: retire older still-open moving-tag digest rows for a (stack, service)
 * once a newer digest bump lands for it. Marks every other pending/notified
 * digest-class row for the same service (excluding `keepId`) as superseded, so
 * the dashboard shows exactly one open card per moving-tag app — the current
 * one — instead of a pile of undecodable old-build cards. Returns the count
 * retired. Rows stay in history; only their "needs decision" visibility drops.
 */
export function supersedeOlderDigestRows(
  db: DB,
  stack: string,
  service: string,
  keepId: number,
): number {
  const r = db
    .prepare(
      `UPDATE updates SET superseded = 1, dismiss_reason = 'superseded'
       WHERE stack = ? AND service = ? AND bump = 'digest'
         AND id != ?
         AND status IN ('pending','notified')
         AND (superseded IS NULL OR superseded = 0)`,
    )
    .run(stack, service, keepId);
  return r.changes;
}

/**
 * v0.6.0: retire a single open row from the queue with a reason, keeping it in
 * history. Used by the reconcile pass (for `skip`), by mute ('muted'), and by
 * phantom suppression ('unchanged'). Only affects still-open rows.
 */
export function dismissRow(db: DB, id: number, reason: string): void {
  db.prepare(
    `UPDATE updates SET superseded = 1, dismiss_reason = ?
     WHERE id = ? AND status IN ('pending','notified')`,
  ).run(reason, id);
}

/**
 * v0.6.0: delete a row outright. Used by reconcile for auto-apply-eligible rows
 * so the next scan re-discovers the CURRENT delta and applies it (rather than
 * dismissing a possibly-stale row, which the scan's dedup would then skip —
 * silently dropping a genuinely-pending update). The update itself is never
 * lost: the scan always re-derives current state; only the stale record goes.
 */
export function deleteUpdate(db: DB, id: number): void {
  db.prepare(`DELETE FROM updates WHERE id = ?`).run(id);
}

// ─── v0.6.0: muted apps ──────────────────────────────────────────────────────

/** Mute a (stack, service): retire its open rows and stop the scan surfacing it. */
export function muteService(db: DB, stack: string, service: string): void {
  db.prepare(
    `INSERT INTO muted_services (stack, service, muted_at) VALUES (?, ?, ?)
     ON CONFLICT(stack, service) DO NOTHING`,
  ).run(stack, service, Date.now());
  db.prepare(
    `UPDATE updates SET superseded = 1, dismiss_reason = 'muted'
     WHERE stack = ? AND service = ? AND status IN ('pending','notified')
       AND (superseded IS NULL OR superseded = 0)`,
  ).run(stack, service);
}

/** Un-mute a (stack, service) so the scan surfaces its updates again. */
export function unmuteService(db: DB, stack: string, service: string): void {
  db.prepare(`DELETE FROM muted_services WHERE stack = ? AND service = ?`).run(
    stack,
    service,
  );
}

export interface MutedServiceRow {
  stack: string;
  service: string;
  muted_at: number;
}

/** All muted (stack, service) pairs, for the scan skip-set and the UI list. */
export function getMutedServices(db: DB): MutedServiceRow[] {
  return db
    .prepare(`SELECT stack, service, muted_at FROM muted_services ORDER BY stack, service`)
    .all() as MutedServiceRow[];
}

/**
 * Every update row, newest first. The dashboard groups these by stack/service
 * for the per-app history view and slices the head for the activity timeline.
 * Homelab-scale — a bounded number of rows — so no LIMIT; group/slice in the
 * render layer.
 */
export function listAllUpdates(db: DB): UpdateRow[] {
  return db
    .prepare(`SELECT * FROM updates ORDER BY discovered_at DESC`)
    .all() as UpdateRow[];
}

// ─── v0.6.0: per-stack policy overrides (set from the dashboard UI) ───────────

export interface StackPolicyRow {
  stack: string;
  app: string;
  dependencies: string;
  updated_at: number;
}

/**
 * All UI-set per-stack policy overrides, keyed by stack name. The daemon merges
 * these into RulesConfig.stacks each scan tick (DB wins over the file/env
 * policy). Values are stored as raw BumpAction strings and validated by the
 * caller before write.
 */
export function getAllStackPolicies(
  db: DB,
): Record<string, { app: string; dependencies: string }> {
  const rows = db
    .prepare(`SELECT stack, app, dependencies FROM stack_policies`)
    .all() as { stack: string; app: string; dependencies: string }[];
  const out: Record<string, { app: string; dependencies: string }> = {};
  for (const r of rows) out[r.stack] = { app: r.app, dependencies: r.dependencies };
  return out;
}

/** One stack's override, or undefined if none is set. */
export function getStackPolicy(db: DB, stack: string): StackPolicyRow | undefined {
  return db
    .prepare(`SELECT * FROM stack_policies WHERE stack = ?`)
    .get(stack) as StackPolicyRow | undefined;
}

/** Upsert a per-stack policy override. */
export function setStackPolicy(
  db: DB,
  stack: string,
  app: string,
  dependencies: string,
): void {
  db.prepare(
    `INSERT INTO stack_policies (stack, app, dependencies, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(stack) DO UPDATE SET
       app = excluded.app,
       dependencies = excluded.dependencies,
       updated_at = excluded.updated_at`,
  ).run(stack, app, dependencies, Date.now());
}

/** Remove a stack's override so it falls back to the file/env default. */
export function clearStackPolicy(db: DB, stack: string): void {
  db.prepare(`DELETE FROM stack_policies WHERE stack = ?`).run(stack);
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
  const marker = db
    .prepare(`SELECT last_fired_at AS t FROM digest_state WHERE id = 1`)
    .get() as { t: number | null } | undefined;
  const a = row?.t ?? null;
  const b = marker?.t ?? null;
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * v0.6.0: record that the daily digest fired at `ts`. Advances the marker used
 * by the scheduler's once-per-day check even when no rows were consumed (e.g. a
 * digest that only carried the "needs your decision" nudge).
 */
export function recordDigestFired(db: DB, ts: number): void {
  db.prepare(
    `INSERT INTO digest_state (id, last_fired_at) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_fired_at = excluded.last_fired_at`,
  ).run(ts);
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

// ─── v0.5.7: watched-releases state ──────────────────────────────────────────

export interface WatchedReleaseStateRow {
  repo: string;
  current: string;
  latest_seen: string | null;
  notified_tag: string | null;
  notified_at: number | null;
  checked_at: number | null;
  advise_text: string | null;
}

export function getWatchedReleaseState(
  db: DB,
  repo: string,
): WatchedReleaseStateRow | undefined {
  return db
    .prepare(`SELECT * FROM watched_releases WHERE repo = ?`)
    .get(repo) as WatchedReleaseStateRow | undefined;
}

/**
 * Record a poll result for a watched repo. Upserts the operator-declared
 * `current` version and the newest release seen, plus the check timestamp.
 * Deliberately leaves `notified_tag` / `notified_at` / `advise_text` alone —
 * those are owned by {@link recordWatchedNotified} so a re-check between
 * polls never clears the dedup marker.
 */
export function recordWatchedCheck(
  db: DB,
  repo: string,
  current: string,
  latestSeen: string | null,
): void {
  db.prepare(
    `INSERT INTO watched_releases (repo, current, latest_seen, checked_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(repo) DO UPDATE SET
       current = excluded.current,
       latest_seen = excluded.latest_seen,
       checked_at = excluded.checked_at`,
  ).run(repo, current, latestSeen, Date.now());
}

/**
 * Mark that a notification went out for `notifiedTag`. Called only after the
 * email actually delivered, so a transient SMTP failure leaves the row eligible
 * to re-fire on the next poll (same robustness contract as setNotified).
 */
export function recordWatchedNotified(
  db: DB,
  repo: string,
  notifiedTag: string,
  adviseText: string | null,
): void {
  db.prepare(
    `UPDATE watched_releases
       SET notified_tag = ?, notified_at = ?, advise_text = ?
     WHERE repo = ?`,
  ).run(notifiedTag, Date.now(), adviseText, repo);
}
