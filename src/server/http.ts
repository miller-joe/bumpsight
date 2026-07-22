import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database as DB } from "better-sqlite3";
import {
  findByToken,
  findSiblings,
  findUpdate,
  listNeedsDecision,
  listAllUpdates,
  setDecision,
  setSnooze,
  clearSnooze,
  getAllStackPolicies,
  setStackPolicy,
  clearStackPolicy,
  muteService,
  unmuteService,
  getMutedServices,
  SNOOZE_FOREVER,
  type UpdateRow,
} from "../state/db.js";
import { applyStackPolicyOverrides, type RulesConfig } from "../daemon/rules.js";
import { fromDisplay, toDisplay } from "../util/display.js";
import { parseDuration } from "../util/duration.js";
import { applyOne } from "../apply/index.js";
import type { CommandRunner } from "../apply/docker.js";
import type { Notifier } from "../notify/types.js";
import { dispatchAppliedNotification } from "../daemon/index.js";
import { getAdviseSummary } from "../commands/advise.js";
import {
  isPairedDepBundlingEnabled,
  type ApplyPairedDepsConfig,
} from "../daemon/config.js";

const BRAND_LOGO_INLINE = `<svg viewBox="0 0 96 96" width="30" height="30" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;flex:0 0 auto;" role="img" aria-label="bumpsight"><ellipse cx="20" cy="48" rx="6" ry="14" fill="currentColor" fill-opacity="0.10"/><ellipse cx="20" cy="48" rx="6" ry="14"/><ellipse cx="48" cy="48" rx="5" ry="11"/><ellipse cx="76" cy="48" rx="4" ry="8"/><path d="M20 34 L48 37 L76 40"/><path d="M20 62 L48 59 L76 56"/><circle cx="20" cy="48" r="2.5" fill="currentColor" stroke="none"/></svg>`;

/** Bump-action values accepted by the policy editor (mirrors rules.BumpAction). */
const VALID_ACTIONS = ["patch", "minor", "major", "notify", "none"] as const;

export interface HttpServerDeps {
  db: DB;
  /** Stack name → compose file path. Approvals may trigger apply. */
  composeFiles: Record<string, string>;
  /** Port to listen on. 0 means "any free port" (used in tests). */
  port: number;
  /** Bind interface. Default 0.0.0.0 for container deployments. */
  host?: string;
  /** Test seam for the apply step. */
  runner?: CommandRunner;
  /** v0.4.2: forwarded to applyOne. When false, skip the post-apply
   *  targeted prune. Default true. Tests usually pass false. */
  pruneAfterApply?: boolean;
  log?: (msg: string) => void;
  /** v0.4.1: notifiers used to send the apply-completion email after a click-Approve runs. */
  notifiers?: Notifier[];
  /** OpenAI-compat LLM URL for the post-apply advise call. Optional. */
  llmUrl?: string;
  /** Optional bearer token for the LLM endpoint. */
  llmKey?: string;
  /** Model name for the LLM call. */
  llmModel?: string;
  /** GitHub token for advise's release-notes fetch. */
  githubToken?: string;
  /** Test seam — override advise. Returns null to skip the LLM section. */
  adviseFn?: typeof getAdviseSummary;
  /** Optional outbox archive directory. */
  outboxDir?: string;
  /** Most recent N outbox files to keep. Defaults to 200. */
  outboxKeepCount?: number;
  /** v0.5.4: per-stack opt-in for apply-time paired-dep bundling. When set,
   *  an Approve click on an app-major bump triggers atomic dep-pin rewrites
   *  alongside the app pin (drawn from the v0.5.0 paired-dep snapshot). */
  applyPairedDeps?: ApplyPairedDepsConfig;
  /** v0.6.0: file/env policy, used to render the dashboard's effective-policy
   *  view (overlaid with the DB stack_policies overrides). Optional. */
  rules?: RulesConfig;
  /** v0.6.0: public base URL (unused by the dashboard itself — it uses relative
   *  links — kept for parity with the notification links). */
  publicUrl?: string;
  /** v0.6.0: when set, the dashboard and all POST /api/* routes require this
   *  shared secret (cookie/header/`?key=`). Unset = open (LAN-only posture).
   *  The email approve/deny GET links are never gated by this. */
  uiToken?: string;
}

export interface HttpServerHandle {
  stop(): Promise<void>;
  /** Resolved bound port (useful when port=0). */
  port: number;
}

/**
 * HTTP server for the bumpsight dashboard + approve/deny actions.
 *
 * Read/UI:
 *   GET  /healthz                       — 200 ok, readiness probe (always open).
 *   GET  / , /queue                     — the dashboard (per-app history +
 *                                         needs-decision + policy editor).
 *   GET  /approve/:token, /deny/:token  — email-link handlers (HTML pages).
 *
 * Actions (dashboard, token-addressed, POST + JSON):
 *   POST /api/updates/:token/approve    — approve + apply (group).
 *   POST /api/updates/:token/deny       — deny (no cascade).
 *   POST /api/updates/:token/apply      — force apply / retry (group).
 *   POST /api/updates/:token/snooze     — {duration|until|ignore}.
 *   POST /api/updates/:token/unsnooze
 *   POST /api/stacks/:stack/policy      — {app,dependencies} or {clear:true}.
 *
 * The GET approve/deny routes stay for backward-compat with links already sent
 * in emails; they are capability-gated by the unguessable token. The POST /api
 * routes additionally require a same-origin JSON request (CSRF guard) and, when
 * BUMPSIGHT_UI_TOKEN is set, the shared secret.
 */
export function startHttpServer(deps: HttpServerDeps): Promise<HttpServerHandle> {
  const log = deps.log ?? (() => {});
  const server: Server = createServer((req, res) => {
    handle(req, res, deps, log).catch((err) => {
      log(`http: handler crashed: ${(err as Error).message}`);
      if (!res.headersSent) {
        writeHtml(res, 500, page("Server error", "Something went wrong."));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, deps.host ?? "0.0.0.0", () => {
      const addr = server.address() as AddressInfo;
      log(`http: listening on ${addr.address}:${addr.port}`);
      resolve({
        port: addr.port,
        stop: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  log: (msg: string) => void,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // Health check is always open (no auth), so probes work behind a UI token.
  if (path === "/healthz") {
    writeHtml(res, 200, "ok");
    return;
  }

  // ── POST action API (token/stack-addressed, JSON) ──────────────────────────
  if (req.method === "POST" && path.startsWith("/api/")) {
    await handleApi(req, res, deps, url, path, log);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    writeHtml(res, 405, page("Method not allowed", "Only GET/POST are supported."));
    return;
  }

  // ── Email-link handlers: capability-gated by the token itself, never by the
  //    UI token. Left open so links in already-sent emails keep working. ──────
  const approveMatch = path.match(/^\/approve\/([A-Za-z0-9_-]{8,})$/);
  const denyMatch = path.match(/^\/deny\/([A-Za-z0-9_-]{8,})$/);
  if (approveMatch) {
    handleApprovePage(approveMatch[1]!, res, deps, log);
    return;
  }
  if (denyMatch) {
    handleDenyPage(denyMatch[1]!, res, deps, log);
    return;
  }

  // ── Dashboard (optionally UI-token gated) ──────────────────────────────────
  if (path === "/" || path === "/queue") {
    const auth = checkAuth(req, url, deps);
    if (!auth.authed) {
      writeHtml(res, 200, loginPage());
      return;
    }
    const headers: Record<string, string> = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    };
    if (auth.setCookie) headers["Set-Cookie"] = auth.setCookie;
    res.writeHead(200, headers);
    res.end(dashboardPage(deps));
    return;
  }

  writeHtml(res, 404, page("Not found", "No such route."));
}

// ─── POST /api/* dispatch ──────────────────────────────────────────────────

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HttpServerDeps,
  url: URL,
  path: string,
  log: (msg: string) => void,
): Promise<void> {
  // CSRF: require a same-origin JSON request. A cross-site <form> can't set the
  // JSON content-type; a cross-origin fetch trips the Origin / Sec-Fetch-Site
  // check. Enforced even when no UI token is set.
  if (!csrfOk(req)) {
    writeJson(res, 403, { ok: false, error: "cross-origin or non-JSON request rejected" });
    return;
  }
  // UI-token gate (cookie/header only for POST — never the query string).
  if (deps.uiToken && !hasValidToken(req, deps.uiToken)) {
    writeJson(res, 401, { ok: false, error: "unauthorized (set the UI token)" });
    return;
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    if (raw.trim()) body = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    writeJson(res, 400, { ok: false, error: `bad body: ${(err as Error).message}` });
    return;
  }

  const updateMatch = path.match(/^\/api\/updates\/([A-Za-z0-9_-]{8,})\/(\w+)$/);
  if (updateMatch) {
    const token = updateMatch[1]!;
    const action = updateMatch[2]!;
    const result = performUpdateAction(deps, token, action, body, log);
    writeJson(res, result.status, result.payload);
    return;
  }

  const policyMatch = path.match(/^\/api\/stacks\/([^/]+)\/policy$/);
  if (policyMatch) {
    const stack = decodeURIComponent(policyMatch[1]!);
    const result = performPolicyAction(deps, stack, body);
    writeJson(res, result.status, result.payload);
    return;
  }

  if (path === "/api/mute") {
    const stack = String(body.stack ?? "");
    const service = String(body.service ?? "");
    if (!stack || !service) {
      writeJson(res, 400, { ok: false, error: "mute needs {stack, service, mute}" });
      return;
    }
    if (body.mute === false) unmuteService(deps.db, stack, service);
    else muteService(deps.db, stack, service);
    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { ok: false, error: "no such action" });
}

interface ActionResult {
  status: number;
  payload: Record<string, unknown>;
}

function performUpdateAction(
  deps: HttpServerDeps,
  token: string,
  action: string,
  body: Record<string, unknown>,
  log: (msg: string) => void,
): ActionResult {
  const row = findByToken(deps.db, token);
  if (!row) return { status: 404, payload: { ok: false, error: "unknown token" } };

  switch (action) {
    case "approve": {
      if (row.status === "approved" || row.status === "applied")
        return { status: 200, payload: { ok: true, note: "already approved" } };
      if (row.status === "denied" || row.status === "failed")
        return {
          status: 409,
          payload: { ok: false, error: `row is ${row.status}; use apply to re-run` },
        };
      const claimed = claimGroup(deps.db, row, false);
      if (claimed.length > 0) void applyRowsAndNotify(deps, claimed, log);
      return { status: 200, payload: { ok: true, applied: claimed.length } };
    }
    case "apply": {
      // Force apply / retry — works on pending/notified/denied/failed. The
      // conditional claim (status IN …) closes the race with a concurrent
      // scan and flips a failed/denied row back to approved so applyOne (which
      // no-ops on applied/failed) will actually re-run it.
      const claimed = claimGroup(deps.db, row, true);
      if (claimed.length === 0)
        return { status: 409, payload: { ok: false, error: "row is not in an appliable state" } };
      void applyRowsAndNotify(deps, claimed, log);
      return { status: 200, payload: { ok: true, applied: claimed.length } };
    }
    case "deny": {
      if (row.status === "applied" || row.status === "approved")
        return { status: 409, payload: { ok: false, error: `already ${row.status}` } };
      // Deny does NOT cascade to siblings — denying one stack ≠ denying all.
      setDecision(deps.db, row.id, { status: "denied", decidedBy: "http-link" });
      log(`denied ${row.id} (${row.stack}/${row.service}) via ui`);
      return { status: 200, payload: { ok: true } };
    }
    case "snooze": {
      let until: number;
      if (body.ignore === true) {
        until = SNOOZE_FOREVER;
      } else if (typeof body.duration === "string" && body.duration.trim()) {
        try {
          until = Date.now() + parseDuration(body.duration);
        } catch (err) {
          return { status: 400, payload: { ok: false, error: (err as Error).message } };
        }
      } else if (typeof body.until === "number" && Number.isFinite(body.until)) {
        until = body.until;
      } else {
        return { status: 400, payload: { ok: false, error: "snooze needs {duration|until|ignore}" } };
      }
      setSnooze(deps.db, row.id, until);
      return { status: 200, payload: { ok: true, snoozed_until: until } };
    }
    case "unsnooze": {
      clearSnooze(deps.db, row.id);
      return { status: 200, payload: { ok: true } };
    }
    case "mute": {
      // Ignore = mute the whole app: retire its open rows and stop the scan
      // surfacing future bumps for it (reversible from the Muted apps list).
      muteService(deps.db, row.stack, row.service);
      return { status: 200, payload: { ok: true, muted: `${row.stack}/${row.service}` } };
    }
    default:
      return { status: 404, payload: { ok: false, error: `unknown action "${action}"` } };
  }
}

function performPolicyAction(
  deps: HttpServerDeps,
  stack: string,
  body: Record<string, unknown>,
): ActionResult {
  if (body.clear === true) {
    clearStackPolicy(deps.db, stack);
    return { status: 200, payload: { ok: true, cleared: true } };
  }
  const app = String(body.app ?? "");
  const dependencies = String(body.dependencies ?? "");
  if (!(VALID_ACTIONS as readonly string[]).includes(app)) {
    return { status: 400, payload: { ok: false, error: `invalid app policy "${app}"` } };
  }
  if (!(VALID_ACTIONS as readonly string[]).includes(dependencies)) {
    return { status: 400, payload: { ok: false, error: `invalid dependencies policy "${dependencies}"` } };
  }
  setStackPolicy(deps.db, stack, app, dependencies);
  return { status: 200, payload: { ok: true, stack, app, dependencies } };
}

// ─── Claim + shared apply helper ────────────────────────────────────────────

/**
 * Conditionally claim a row for apply (approve it) if it's still in an
 * actionable state. Returns true iff this call is the one that transitioned it
 * — so two concurrent claimers can't both proceed. `allowDecided` widens the
 * set to include denied/failed rows (force-apply / retry).
 */
function claimRow(db: DB, id: number, allowDecided: boolean): boolean {
  const states = allowDecided
    ? "'pending','notified','denied','failed'"
    : "'pending','notified'";
  const r = db
    .prepare(
      `UPDATE updates SET status='approved', decided_by='http-link', decided_at=?
       WHERE id=? AND status IN (${states})`,
    )
    .run(Date.now(), id);
  return r.changes === 1;
}

/** Claim the row plus its still-actionable siblings (same image bump). */
function claimGroup(db: DB, row: UpdateRow, allowDecided: boolean): UpdateRow[] {
  const siblings = findSiblings(db, row);
  const all = [row, ...siblings];
  const claimed: UpdateRow[] = [];
  for (const r of all) {
    if (claimRow(db, r.id, allowDecided)) {
      const fresh = findUpdate(db, r.id);
      if (fresh) claimed.push(fresh);
    }
  }
  return claimed;
}

/**
 * Apply each claimed row and dispatch a completion notification. Extracted so
 * the email-link GET path and the dashboard POST path share one implementation.
 * Runs in the background (caller `void`s it) so the HTTP response stays snappy.
 */
async function applyRowsAndNotify(
  deps: HttpServerDeps,
  rows: UpdateRow[],
  log: (msg: string) => void,
): Promise<void> {
  for (const r of rows) {
    try {
      const after = await applyOne(
        {
          db: deps.db,
          composeFiles: deps.composeFiles,
          runner: deps.runner,
          pruneAfterApply: deps.pruneAfterApply,
          bundlePairedDeps:
            deps.applyPairedDeps !== undefined &&
            isPairedDepBundlingEnabled(deps.applyPairedDeps, r.stack),
        },
        r.id,
      );
      log(`apply ${r.id} (${r.stack}/${r.service}): ${after.status}`);

      // v0.4.1: close the silent-failure loop — email the outcome (success or
      // failure) after every apply attempt.
      if (deps.notifiers && deps.notifiers.length > 0) {
        const fresh = findUpdate(deps.db, r.id);
        if (fresh) {
          const adviseFn = deps.adviseFn ?? getAdviseSummary;
          const advise =
            deps.llmUrl && (after.status === "applied" || after.status === "failed")
              ? await adviseFn({
                  image: fresh.image,
                  from: fresh.current_tag,
                  to: fresh.target_tag,
                  composeFile: deps.composeFiles[fresh.stack],
                  serviceName: fresh.service,
                  llmUrl: deps.llmUrl,
                  llmKey: deps.llmKey,
                  model: deps.llmModel,
                  githubToken: deps.githubToken,
                }).catch(() => null)
              : null;
          await dispatchAppliedNotification(
            deps.notifiers,
            fresh,
            advise,
            deps.outboxDir
              ? { dir: deps.outboxDir, keepCount: deps.outboxKeepCount }
              : undefined,
          ).catch((err: Error) => log(`apply-notify ${r.id} crashed: ${err.message}`));
        }
      }
    } catch (err) {
      log(`apply ${r.id} crashed: ${(err as Error).message}`);
    }
  }
}

// ─── Email-link GET pages (backward-compat; token-gated) ─────────────────────

function handleApprovePage(
  token: string,
  res: ServerResponse,
  deps: HttpServerDeps,
  log: (msg: string) => void,
): void {
  const row = findByToken(deps.db, token);
  if (!row) {
    writeHtml(res, 404, page("Not found", "This approval link is unknown or expired."));
    return;
  }
  if (row.status === "approved" || row.status === "applied") {
    writeHtml(res, 200, alreadyAppliedPage(row));
    return;
  }
  if (row.status === "denied") {
    writeHtml(res, 200, deniedPage(row));
    return;
  }
  if (row.status === "failed") {
    writeHtml(res, 200, failedPage(row));
    return;
  }
  const siblings = findSiblings(deps.db, row);
  const claimed = claimGroup(deps.db, row, false);
  // Reply immediately; apply runs in the background.
  writeHtml(res, 200, approvedPendingPage(row, siblings));
  if (claimed.length > 0) void applyRowsAndNotify(deps, claimed, log);
}

function handleDenyPage(
  token: string,
  res: ServerResponse,
  deps: HttpServerDeps,
  log: (msg: string) => void,
): void {
  const row = findByToken(deps.db, token);
  if (!row) {
    writeHtml(res, 404, page("Not found", "This deny link is unknown or expired."));
    return;
  }
  if (row.status === "denied") {
    writeHtml(res, 200, deniedPage(row));
    return;
  }
  if (row.status === "approved" || row.status === "applied") {
    writeHtml(
      res,
      409,
      page(
        "Already approved",
        `${row.image} → ${row.target_tag} was already approved and can't be denied now.`,
      ),
    );
    return;
  }
  const siblings = findSiblings(deps.db, row);
  const all = [row, ...siblings];
  for (const r of all) {
    setDecision(deps.db, r.id, { status: "denied", decidedBy: "http-link" });
    log(`denied ${r.id} (${r.stack}/${r.service})`);
  }
  writeHtml(res, 200, deniedPage({ ...row, status: "denied" }, siblings));
}

// ─── Auth / CSRF / body ──────────────────────────────────────────────────────

function checkAuth(
  req: IncomingMessage,
  url: URL,
  deps: HttpServerDeps,
): { authed: boolean; setCookie?: string } {
  if (!deps.uiToken) return { authed: true };
  const key = url.searchParams.get("key");
  if (key && key === deps.uiToken) {
    return {
      authed: true,
      setCookie: `bs_ui=${encodeURIComponent(deps.uiToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
    };
  }
  return { authed: hasValidToken(req, deps.uiToken) };
}

function hasValidToken(req: IncomingMessage, uiToken: string): boolean {
  const header = req.headers["x-bumpsight-token"];
  if (typeof header === "string" && header === uiToken) return true;
  const cookie = parseCookies(req.headers.cookie)["bs_ui"];
  return cookie !== undefined && cookie === uiToken;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function csrfOk(req: IncomingMessage): boolean {
  const ct = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") return false;
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers["origin"];
  if (typeof origin === "string" && origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    if (originHost !== req.headers["host"]) return false;
  }
  return true;
}

function readBody(req: IncomingMessage, cap = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ─── Dashboard render ────────────────────────────────────────────────────────

function fmtTime(ms: number | null | undefined): string {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "—";
}

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    pending: "b-amber",
    notified: "b-amber",
    approved: "b-blue",
    applied: "b-green",
    failed: "b-red",
    denied: "b-slate",
  };
  return `<span class="badge ${map[status] ?? "b-slate"}">${escapeHtml(status)}</span>`;
}

function bumpBadge(bump: string): string {
  const map: Record<string, string> = {
    major: "b-red",
    minor: "b-blue",
    patch: "b-green",
    digest: "b-slate",
    unknown: "b-slate",
  };
  return `<span class="badge ${map[bump] ?? "b-slate"}">${escapeHtml(bump)}</span>`;
}

function delta(row: UpdateRow): string {
  return `<code>${escapeHtml(fromDisplay(row))}</code> → <code>${escapeHtml(toDisplay(row))}</code>`;
}

function adviseBlock(row: UpdateRow): string {
  if (!row.advise_text) return "";
  return `<details class="advise"><summary>release-note summary</summary><pre>${escapeHtml(row.advise_text)}</pre></details>`;
}

function decisionCard(row: UpdateRow): string {
  const t = escapeHtml(row.approval_token ?? "");
  return `<div class="card" data-row data-stack="${escapeHtml(row.stack)}" data-bump="${escapeHtml(row.bump)}" data-search="${escapeHtml(`${row.stack} ${row.service} ${row.image}`.toLowerCase())}">
    <div class="card-head">
      <div class="card-title"><strong>${escapeHtml(row.stack)}</strong> <span class="muted">/ ${escapeHtml(row.service)}</span> ${bumpBadge(row.bump)}</div>
      <div class="muted small">${escapeHtml(row.image)}</div>
    </div>
    <div class="card-delta">${delta(row)}</div>
    ${adviseBlock(row)}
    <div class="actions">
      <button class="btn btn-green" onclick="bsAct('${t}','approve')">Approve &amp; apply</button>
      <button class="btn btn-slate" onclick="bsAct('${t}','deny')" title="Reject this version; a newer one can still surface">Deny</button>
      <button class="btn btn-ghost" onclick="bsSnooze('${t}',{duration:'1d'})">Snooze 1d</button>
      <button class="btn btn-ghost" onclick="bsSnooze('${t}',{duration:'7d'})">7d</button>
      <button class="btn btn-ghost" onclick="if(confirm('Mute this app? You will stop seeing all updates for it until you un-mute.'))bsAct('${t}','mute')" title="Stop surfacing any updates for this app">Mute app</button>
    </div>
  </div>`;
}

function historyRow(row: UpdateRow): string {
  const t = escapeHtml(row.approval_token ?? "");
  const when = fmtTime(row.applied_at ?? row.decided_at ?? row.notified_at ?? row.discovered_at);
  const canApply = row.status === "failed" || row.status === "denied";
  const retry = canApply && row.approval_token
    ? `<button class="btn btn-ghost small" onclick="bsAct('${t}','apply')">re-apply</button>`
    : "";
  const badge = row.superseded
    ? `<span class="badge b-slate">${escapeHtml(row.dismiss_reason ?? "superseded")}</span>`
    : statusBadge(row.status);
  return `<tr>
    <td>${badge}</td>
    <td>${delta(row)} ${bumpBadge(row.bump)}</td>
    <td class="muted small">${escapeHtml(when)}</td>
    <td>${retry}</td>
  </tr>`;
}

function perAppSection(rows: UpdateRow[]): string {
  // Group by stack → service, each newest-first (rows already sorted desc).
  const byStack = new Map<string, Map<string, UpdateRow[]>>();
  for (const r of rows) {
    let svc = byStack.get(r.stack);
    if (!svc) {
      svc = new Map();
      byStack.set(r.stack, svc);
    }
    const list = svc.get(r.service) ?? [];
    list.push(r);
    svc.set(r.service, list);
  }
  if (byStack.size === 0) return `<p class="muted">No updates recorded yet.</p>`;

  const stacks = [...byStack.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return stacks
    .map(([stack, services]) => {
      const svcHtml = [...services.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([service, list]) => {
          const latest = list[0]!;
          return `<div class="svc" data-search="${escapeHtml(`${stack} ${service} ${latest.image}`.toLowerCase())}">
            <div class="svc-head">${escapeHtml(service)} <span class="muted small">${escapeHtml(latest.image)}</span> ${statusBadge(latest.status)}</div>
            <table class="hist"><tbody>${list.map(historyRow).join("")}</tbody></table>
          </div>`;
        })
        .join("");
      return `<details class="stack" data-stack="${escapeHtml(stack)}" open>
        <summary><strong>${escapeHtml(stack)}</strong> <span class="muted small">${services.size} service(s)</span></summary>
        ${svcHtml}
      </details>`;
    })
    .join("");
}

function timelineSection(rows: UpdateRow[]): string {
  const recent = rows
    .filter((r) => r.status === "applied" || r.status === "failed" || r.status === "denied")
    .slice(0, 30);
  if (recent.length === 0) return `<p class="muted">No activity yet.</p>`;
  return `<table class="hist"><tbody>${recent
    .map(
      (r) => `<tr>
      <td>${statusBadge(r.status)}</td>
      <td><strong>${escapeHtml(r.stack)}</strong> <span class="muted">/ ${escapeHtml(r.service)}</span></td>
      <td>${delta(r)}</td>
      <td class="muted small">${escapeHtml(fmtTime(r.applied_at ?? r.decided_at))}</td>
    </tr>`,
    )
    .join("")}</tbody></table>`;
}

function policySection(deps: HttpServerDeps): string {
  const rules = deps.rules;
  const overrides = getAllStackPolicies(deps.db);
  const effective = rules ? applyStackPolicyOverrides(rules, overrides) : undefined;
  const stackNames = new Set<string>([
    ...Object.keys(deps.composeFiles),
    ...Object.keys(overrides),
  ]);
  if (stackNames.size === 0) return `<p class="muted">No stacks configured.</p>`;

  const sel = (name: string, current: string) =>
    `<select class="${name}">${VALID_ACTIONS.map(
      (a) => `<option value="${a}"${a === current ? " selected" : ""}>${a}</option>`,
    ).join("")}</select>`;

  const rows = [...stackNames]
    .sort()
    .map((stack) => {
      const eff = effective ? effective.stacks[stack] ?? effective.default : { app: "?", dependencies: "?" };
      const isOverride = overrides[stack] !== undefined;
      const fromFile = rules?.stacks[stack] !== undefined;
      const source = isOverride ? "UI override" : fromFile ? "config" : "default";
      return `<tr data-policy-stack="${escapeHtml(stack)}" data-search="${escapeHtml(stack.toLowerCase())}">
        <td><strong>${escapeHtml(stack)}</strong></td>
        <td>app: ${sel("pol-app", String(eff.app))}</td>
        <td>deps: ${sel("pol-dep", String(eff.dependencies))}</td>
        <td class="muted small">${source}</td>
        <td>
          <button class="btn btn-blue small" onclick="bsPolicy(this)">Save</button>
          ${isOverride ? `<button class="btn btn-ghost small" onclick="bsPolicyClear(this)">Reset</button>` : ""}
        </td>
      </tr>`;
    })
    .join("");

  return `<table class="policy"><thead><tr><th>stack</th><th>app policy</th><th>deps policy</th><th>source</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function snoozedSection(rows: UpdateRow[], now: number): string {
  const snoozed = rows.filter(
    (r) =>
      (r.status === "pending" || r.status === "notified") &&
      r.snoozed_until !== null &&
      r.snoozed_until > now,
  );
  if (snoozed.length === 0) return "";
  const items = snoozed
    .map((r) => {
      const t = escapeHtml(r.approval_token ?? "");
      const label = r.snoozed_until === SNOOZE_FOREVER ? "ignored" : `until ${fmtTime(r.snoozed_until)}`;
      return `<tr>
        <td><strong>${escapeHtml(r.stack)}</strong> <span class="muted">/ ${escapeHtml(r.service)}</span></td>
        <td>${delta(r)} ${bumpBadge(r.bump)}</td>
        <td class="muted small">${label}</td>
        <td><button class="btn btn-ghost small" onclick="bsAct('${t}','unsnooze')">un-snooze</button></td>
      </tr>`;
    })
    .join("");
  return `<details class="snoozed"><summary>Snoozed / ignored (${snoozed.length})</summary><table class="hist"><tbody>${items}</tbody></table></details>`;
}

function mutedAppsSection(deps: HttpServerDeps): string {
  const muted = getMutedServices(deps.db);
  if (muted.length === 0) return "";
  const items = muted
    .map(
      (m) => `<tr data-search="${escapeHtml(`${m.stack} ${m.service}`.toLowerCase())}">
        <td><strong>${escapeHtml(m.stack)}</strong> <span class="muted">/ ${escapeHtml(m.service)}</span></td>
        <td class="muted small">muted ${escapeHtml(fmtTime(m.muted_at))}</td>
        <td><button class="btn btn-ghost small" onclick="bsMute('${escapeHtml(m.stack)}','${escapeHtml(m.service)}',false)">un-mute</button></td>
      </tr>`,
    )
    .join("");
  return `<details class="snoozed"><summary>Muted apps (${muted.length})</summary><table class="hist"><tbody>${items}</tbody></table></details>`;
}

function dashboardPage(deps: HttpServerDeps): string {
  const now = Date.now();
  const needs = listNeedsDecision(deps.db, now).filter(
    (r) => r.snoozed_until === null || r.snoozed_until <= now,
  );
  const all = listAllUpdates(deps.db);

  const needsHtml =
    needs.length > 0
      ? needs.map(decisionCard).join("")
      : `<p class="muted">Nothing waiting on you. 🎉</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bumpsight</title>
<style>${DASH_CSS}</style>
</head><body>
<header class="topbar">
  <div class="brand">${BRAND_LOGO_INLINE}<span>bumpsight</span></div>
  <div class="topbar-right">
    <input id="filter" class="filter" type="search" placeholder="filter by stack / service / image…" oninput="bsFilter()">
    <label class="auto"><input type="checkbox" id="autorefresh" checked onchange="bsToggleAuto(this)"> auto-refresh</label>
  </div>
</header>
<main>
  <section>
    <h2>Needs decision <span class="count">${needs.length}</span></h2>
    <div class="cards">${needsHtml}</div>
    ${snoozedSection(all, now)}
    ${mutedAppsSection(deps)}
  </section>

  <section>
    <h2>Update history by app</h2>
    ${perAppSection(all)}
  </section>

  <section>
    <h2>Recent activity</h2>
    ${timelineSection(all)}
  </section>

  <section>
    <h2>Per-stack policy</h2>
    <p class="muted small">Overrides apply on the next scan. <code>notify</code> = always ask; <code>none</code> = ignore this stack.</p>
    ${policySection(deps)}
  </section>
</main>
<script>${DASH_JS}</script>
</body></html>`;
}

const DASH_CSS = `
:root{--bg:#f1f5f9;--card:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--code:#f1f5f9;}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--ink:#e5e7eb;--muted:#94a3b8;--line:#1f2937;--accent:#60a5fa;--code:#1f2937;}}
:root[data-theme=light]{--bg:#f1f5f9;--card:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--code:#f1f5f9;}
:root[data-theme=dark]{--bg:#0b1120;--card:#111827;--ink:#e5e7eb;--muted:#94a3b8;--line:#1f2937;--accent:#60a5fa;--code:#1f2937;}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--ink)}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-size:12px}
.muted{color:var(--muted)}.small{font-size:12px}
.topbar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:12px 20px;background:var(--card);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:600;color:var(--accent)}
.brand span{color:var(--ink)}
.topbar-right{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.filter{padding:7px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);min-width:240px}
.auto{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:5px}
main{max-width:60rem;margin:0 auto;padding:20px}
section{margin:0 0 30px}
h2{font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
.count{background:var(--accent);color:#fff;border-radius:999px;font-size:12px;padding:1px 9px}
.cards{display:grid;gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;align-items:baseline}
.card-title{font-size:15px}
.card-delta{margin:8px 0}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.btn{border:1px solid var(--line);border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;background:var(--bg);color:var(--ink)}
.btn.small{padding:3px 8px;font-size:12px}
.btn-green{background:#16a34a;color:#fff;border-color:#16a34a}
.btn-blue{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn-slate{background:#475569;color:#fff;border-color:#475569}
.btn-ghost{background:transparent}
.badge{display:inline-block;font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;vertical-align:middle}
.b-green{background:#dcfce7;color:#14532d}.b-red{background:#fee2e2;color:#7f1d1d}.b-blue{background:#dbeafe;color:#1e3a8a}.b-amber{background:#fef3c7;color:#92400e}.b-slate{background:#e2e8f0;color:#334155}
@media (prefers-color-scheme:dark){.b-green{background:#14532d;color:#bbf7d0}.b-red{background:#7f1d1d;color:#fecaca}.b-blue{background:#1e3a8a;color:#bfdbfe}.b-amber{background:#78350f;color:#fde68a}.b-slate{background:#334155;color:#cbd5e1}}
details.advise{margin-top:8px}details.advise summary{cursor:pointer;font-size:12px;color:var(--muted)}
details.advise pre{white-space:pre-wrap;background:var(--code);border:1px solid var(--line);border-radius:6px;padding:10px 12px;font-size:12px;margin:6px 0 0}
details.stack{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px 14px;margin-bottom:10px}
details.stack>summary{cursor:pointer;padding:6px 0;font-size:14px}
.svc{padding:6px 0;border-top:1px solid var(--line)}
.svc-head{font-size:13px;margin:2px 0 4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
details.snoozed{margin-top:12px}details.snoozed>summary{cursor:pointer;color:var(--muted);font-size:13px}
table{border-collapse:collapse;width:100%}
table.hist td{padding:4px 8px;border-top:1px solid var(--line);font-size:13px;vertical-align:top}
table.hist tr:first-child td{border-top:none}
table.policy{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
table.policy th{text-align:left;padding:8px 10px;font-size:12px;color:var(--muted);background:var(--bg)}
table.policy td{padding:8px 10px;border-top:1px solid var(--line);font-size:13px}
select{padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}
.hide{display:none !important}
`;

const DASH_JS = `
let bsAuto = localStorage.getItem('bsAuto') !== '0';
document.getElementById('autorefresh').checked = bsAuto;
function bsToggleAuto(cb){bsAuto=cb.checked;localStorage.setItem('bsAuto',bsAuto?'1':'0');}
async function bsPost(path,body){
  try{
    const res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    if(!res.ok){const j=await res.json().catch(()=>({error:res.statusText}));alert('Failed: '+(j.error||res.status));return false;}
    return true;
  }catch(e){alert('Request failed: '+e.message);return false;}
}
async function bsAct(token,action){if(await bsPost('/api/updates/'+token+'/'+action,{}))location.reload();}
async function bsSnooze(token,opts){if(await bsPost('/api/updates/'+token+'/snooze',opts))location.reload();}
async function bsMute(stack,service,mute){if(await bsPost('/api/mute',{stack,service,mute}))location.reload();}
async function bsPolicy(btn){
  const row=btn.closest('[data-policy-stack]');
  const stack=row.getAttribute('data-policy-stack');
  const app=row.querySelector('.pol-app').value;
  const dependencies=row.querySelector('.pol-dep').value;
  if(await bsPost('/api/stacks/'+encodeURIComponent(stack)+'/policy',{app,dependencies}))location.reload();
}
async function bsPolicyClear(btn){
  const stack=btn.closest('[data-policy-stack]').getAttribute('data-policy-stack');
  if(await bsPost('/api/stacks/'+encodeURIComponent(stack)+'/policy',{clear:true}))location.reload();
}
function bsFilter(){
  const q=document.getElementById('filter').value.trim().toLowerCase();
  document.querySelectorAll('[data-search]').forEach(el=>{
    el.classList.toggle('hide', q!=='' && !el.getAttribute('data-search').includes(q));
  });
}
setInterval(()=>{
  if(!bsAuto)return;
  const a=document.activeElement;
  if(a&&(a.closest('[data-policy-stack]')||a.id==='filter'))return;
  location.reload();
},30000);
`;

// ─── Shared HTML helpers (email-link pages) ─────────────────────────────────

function writeHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function page(title: string, body: string): string {
  // Note: pages use inline CSS/JS — do not add a restrictive CSP without
  // 'unsafe-inline' or the dashboard/pages silently break.
  return `<!doctype html><meta charset=utf-8><title>${escapeHtml(title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}h1{margin:0 0 1rem;font-size:1.4rem;display:flex;align-items:center;gap:10px;color:#2563eb}.k{color:#555}code{background:#f4f4f4;padding:.1rem .3rem;border-radius:.2rem}</style>
<h1>${BRAND_LOGO_INLINE}<span style="color:#1a1a1a">${escapeHtml(title)}</span></h1>
<p>${body}</p><p><a href="/">← dashboard</a></p>`;
}

function loginPage(): string {
  return `<!doctype html><meta charset=utf-8><title>bumpsight — sign in</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:24rem;margin:5rem auto;padding:0 1rem;color:#1a1a1a}form{display:flex;gap:8px;margin-top:1rem}input{flex:1;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px}button{padding:8px 16px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer}</style>
<h1 style="color:#2563eb">bumpsight</h1><p>This dashboard is protected. Enter the access key.</p>
<form method="GET" action="/"><input name="key" type="password" placeholder="access key" autofocus><button>Enter</button></form>`;
}

function summaryRows(row: UpdateRow): string {
  return `
  <p><span class=k>Stack:</span>   <code>${escapeHtml(row.stack)}</code></p>
  <p><span class=k>Service:</span> <code>${escapeHtml(row.service)}</code></p>
  <p><span class=k>Image:</span>   <code>${escapeHtml(row.image)}</code></p>
  <p><span class=k>From:</span>    <code>${escapeHtml(row.current_tag)}</code></p>
  <p><span class=k>To:</span>      <code>${escapeHtml(row.target_tag)}</code></p>
  <p><span class=k>Bump:</span>    ${escapeHtml(row.bump)}</p>`;
}

function approvedPendingPage(row: UpdateRow, siblings: UpdateRow[] = []): string {
  const extra =
    siblings.length > 0
      ? `<p>Approval also applied to ${siblings.length} other stack(s) running the same image: <code>${siblings
          .map((s) => escapeHtml(`${s.stack}/${s.service}`))
          .join(", ")}</code>.</p>`
      : "";
  return page(
    "Approved — applying",
    `Pulling and recreating <code>${escapeHtml(row.service)}</code> on <code>${escapeHtml(row.stack)}</code>. Watch the daemon log for the result.${extra}${summaryRows(row)}`,
  );
}

function alreadyAppliedPage(row: UpdateRow): string {
  return page(
    "Already approved",
    `This update was already approved.${summaryRows(row)}<p><span class=k>Status:</span> ${escapeHtml(row.status)}</p>`,
  );
}

function deniedPage(row: UpdateRow, siblings: UpdateRow[] = []): string {
  const extra =
    siblings.length > 0
      ? `<p>Denial also applied to ${siblings.length} other stack(s) running the same image: <code>${siblings
          .map((s) => escapeHtml(`${s.stack}/${s.service}`))
          .join(", ")}</code>.</p>`
      : "";
  return page(
    "Denied",
    `The bump was rejected and won't be applied.${extra}${summaryRows(row)}`,
  );
}

function failedPage(row: UpdateRow): string {
  return page(
    "Last apply failed",
    `An earlier apply attempt failed. Re-apply from the dashboard if needed.${summaryRows(row)}`,
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
