import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database as DB } from "better-sqlite3";
import {
  findByToken,
  findSiblings,
  setDecision,
  type UpdateRow,
} from "../state/db.js";
import { applyOne } from "../apply/index.js";
import type { CommandRunner } from "../apply/docker.js";

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
  log?: (msg: string) => void;
}

export interface HttpServerHandle {
  stop(): Promise<void>;
  /** Resolved bound port (useful when port=0). */
  port: number;
}

/**
 * Tiny HTTP server for approve/deny clicks. Three routes:
 *
 *   GET /healthz           — 200 ok, used for readiness probes.
 *   GET /approve/:token    — mark approved + kick off apply in background.
 *   GET /deny/:token       — mark denied.
 *
 * Idempotent: if the token's row was already decided, the response shows
 * the existing state instead of re-firing the action. Anything else
 * 404s with a generic page (don't leak token validity timing info beyond
 * what's already implicit in HTTP).
 */
export function startHttpServer(deps: HttpServerDeps): Promise<HttpServerHandle> {
  const log = deps.log ?? (() => {});
  const server: Server = createServer(async (req, res) => {
    try {
      await handle(req, res, deps, log);
    } catch (err) {
      log(`http: handler crashed: ${(err as Error).message}`);
      writeHtml(res, 500, page("Server error", "Something went wrong."));
    }
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
  if (req.method !== "GET" && req.method !== "HEAD") {
    writeHtml(res, 405, page("Method not allowed", "Only GET is supported."));
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/healthz" || path === "/") {
    writeHtml(res, 200, page("bumpsight", "ok"));
    return;
  }

  const approveMatch = path.match(/^\/approve\/([A-Za-z0-9_-]{8,})$/);
  const denyMatch = path.match(/^\/deny\/([A-Za-z0-9_-]{8,})$/);

  if (approveMatch) {
    await handleApprove(approveMatch[1]!, res, deps, log);
    return;
  }
  if (denyMatch) {
    handleDeny(denyMatch[1]!, res, deps, log);
    return;
  }

  writeHtml(res, 404, page("Not found", "No such route."));
}

async function handleApprove(
  token: string,
  res: ServerResponse,
  deps: HttpServerDeps,
  log: (msg: string) => void,
): Promise<void> {
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

  // Find sibling rows (same image bump on other stacks) so this single
  // click approves the whole group that the notification covered.
  const siblings = findSiblings(deps.db, row);
  const all = [row, ...siblings];

  for (const r of all) {
    setDecision(deps.db, r.id, { status: "approved", decidedBy: "http-link" });
  }
  // Reply immediately, run apply in background so the click feels snappy.
  writeHtml(res, 200, approvedPendingPage(row, siblings));

  void (async () => {
    for (const r of all) {
      try {
        const after = await applyOne(
          { db: deps.db, composeFiles: deps.composeFiles, runner: deps.runner },
          r.id,
        );
        log(`apply ${r.id} (${r.stack}/${r.service}): ${after.status}`);
      } catch (err) {
        log(`apply ${r.id} crashed: ${(err as Error).message}`);
      }
    }
  })();
}

function handleDeny(
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

function writeHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset=utf-8><title>${escapeHtml(title)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}h1{margin:0 0 1rem;font-size:1.4rem}.k{color:#555}code{background:#f4f4f4;padding:.1rem .3rem;border-radius:.2rem}</style>
<h1>${escapeHtml(title)}</h1>
<p>${body}</p>`;
}

function summaryRows(row: UpdateRow): string {
  return `
  <p><span class=k>Stack:</span>   <code>${escapeHtml(row.stack)}</code></p>
  <p><span class=k>Service:</span> <code>${escapeHtml(row.service)}</code></p>
  <p><span class=k>Image:</span>   <code>${escapeHtml(row.image)}</code></p>
  <p><span class=k>From:</span>    <code>${escapeHtml(row.current_tag)}</code></p>
  <p><span class=k>To:</span>      <code>${escapeHtml(row.target_tag)}</code></p>
  <p><span class=k>Bump:</span>    ${row.bump}</p>`;
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
    `This update was already approved.${summaryRows(row)}<p><span class=k>Status:</span> ${row.status}</p>`,
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
    `An earlier apply attempt failed. Re-trigger from the daemon log if needed.${summaryRows(row)}`,
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
