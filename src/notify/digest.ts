import type { UpdateRow } from "../state/db.js";
import type { NotifyMessage } from "./types.js";

const BRAND_LOGO_INLINE = `<svg viewBox="0 0 96 96" width="36" height="36" fill="none" stroke="#2563eb" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;flex:0 0 auto;" role="img" aria-label="bumpsight"><ellipse cx="20" cy="48" rx="6" ry="14" fill="#2563eb" fill-opacity="0.08"/><ellipse cx="20" cy="48" rx="6" ry="14"/><ellipse cx="48" cy="48" rx="5" ry="11"/><ellipse cx="76" cy="48" rx="4" ry="8"/><path d="M20 34 L48 37 L76 40"/><path d="M20 62 L48 59 L76 56"/><circle cx="20" cy="48" r="2.5" fill="#2563eb" stroke="none"/></svg>`;

/**
 * v0.4.3 daily-digest email. Aggregates the day's bumpsight activity into a
 * single rollup so the operator's inbox isn't flooded by per-event emails for
 * silently-applied or silently-suppressed events.
 *
 * Categories included (only the ones with items render):
 *   - Auto-applied successes
 *   - Approved & applied successes (decided_by = http-link / manual-audit)
 *   - Apply failures (auto OR approved)
 *   - Suppressed digest-class bumps (rolling-tag refs that never produced a
 *     per-event email under v0.4.1's email-noise suppression)
 *
 * Returns null when every category is empty — caller skips the send.
 */

export interface DigestSections {
  appliedAuto: UpdateRow[];
  appliedApproved: UpdateRow[];
  failures: UpdateRow[];
  suppressedDigests: UpdateRow[];
}

export function categorize(rows: UpdateRow[]): DigestSections {
  const sections: DigestSections = {
    appliedAuto: [],
    appliedApproved: [],
    failures: [],
    suppressedDigests: [],
  };
  for (const row of rows) {
    const isHumanApproved =
      row.decided_by === "http-link" || row.decided_by === "manual-audit";
    if (row.status === "failed") {
      sections.failures.push(row);
    } else if (row.status === "applied") {
      if (isHumanApproved) sections.appliedApproved.push(row);
      else sections.appliedAuto.push(row);
    } else if (row.status === "notified" && row.bump === "digest") {
      sections.suppressedDigests.push(row);
    }
  }
  return sections;
}

function totalCount(s: DigestSections): number {
  return (
    s.appliedAuto.length +
    s.appliedApproved.length +
    s.failures.length +
    s.suppressedDigests.length
  );
}

function dateLabel(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function rowDelta(row: UpdateRow): string {
  if (row.bump === "digest") {
    return `digest sha256:${row.current_tag}… → sha256:${row.target_tag}…`;
  }
  return `${row.current_tag} → ${row.target_tag}`;
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

export interface BuildDigestOptions {
  rows: UpdateRow[];
  /** The date this digest is being sent for. Used for the subject line. */
  date?: Date;
  /** Optional public URL — adds a "/queue" link to the email footer. */
  publicUrl?: string;
}

export interface DigestEmail {
  message: NotifyMessage;
  /** Rows whose ids should be marked digested after a successful send. */
  rowIds: number[];
  sections: DigestSections;
}

/** Returns null when there's nothing to report. */
export function buildDigestEmail(opts: BuildDigestOptions): DigestEmail | null {
  const sections = categorize(opts.rows);
  const total = totalCount(sections);
  if (total === 0) return null;

  const date = opts.date ?? new Date();
  const label = dateLabel(date);

  const summary: string[] = [];
  if (sections.appliedAuto.length > 0)
    summary.push(`${sections.appliedAuto.length} auto-applied`);
  if (sections.appliedApproved.length > 0)
    summary.push(`${sections.appliedApproved.length} approved`);
  if (sections.failures.length > 0)
    summary.push(`${sections.failures.length} failed`);
  if (sections.suppressedDigests.length > 0)
    summary.push(`${sections.suppressedDigests.length} digest-class`);

  const subject = `bumpsight daily digest — ${label} — ${summary.join(", ")}`;

  const body = renderText(sections, label, opts.publicUrl);
  const htmlBody = renderHtml(sections, label, opts.publicUrl);

  const rowIds: number[] = [
    ...sections.appliedAuto,
    ...sections.appliedApproved,
    ...sections.failures,
    ...sections.suppressedDigests,
  ].map((r) => r.id);

  return {
    message: { subject, body, htmlBody, links: undefined },
    rowIds,
    sections,
  };
}

function renderText(
  sections: DigestSections,
  label: string,
  publicUrl?: string,
): string {
  const lines: string[] = [];
  lines.push(`Bumpsight daily digest — ${label}`);
  lines.push("");
  const renderSection = (heading: string, rows: UpdateRow[]) => {
    if (rows.length === 0) return;
    lines.push(`───── ${heading} (${rows.length}) ─────`);
    for (const row of rows) {
      lines.push(`  • ${row.stack}/${row.service}: ${row.image}`);
      lines.push(`    ${rowDelta(row)}  (${row.bump})`);
      if (row.advise_text) {
        const head = row.advise_text.split("\n")[0]!.slice(0, 200);
        lines.push(`    advice: ${head}`);
      }
      if (row.status === "failed" && row.apply_log) {
        const tail = row.apply_log.split("\n").slice(-3).join(" / ").slice(0, 240);
        lines.push(`    log: ${tail}`);
      }
    }
    lines.push("");
  };
  renderSection("Apply failures", sections.failures);
  renderSection("Auto-applied", sections.appliedAuto);
  renderSection("Approved & applied", sections.appliedApproved);
  renderSection("Digest-class (rolling tags, suppressed)", sections.suppressedDigests);
  if (publicUrl) {
    lines.push(`Queue: ${publicUrl.replace(/\/+$/, "")}/queue`);
  }
  return lines.join("\n");
}

interface SectionCfg {
  heading: string;
  rows: UpdateRow[];
  rowColor: string;
  bg: string;
  border: string;
}

function renderHtml(
  sections: DigestSections,
  label: string,
  publicUrl?: string,
): string {
  const e = escapeHtml;
  const cfgs: SectionCfg[] = [
    {
      heading: "Apply failures",
      rows: sections.failures,
      rowColor: "#7f1d1d",
      bg: "#fee2e2",
      border: "#fca5a5",
    },
    {
      heading: "Auto-applied",
      rows: sections.appliedAuto,
      rowColor: "#14532d",
      bg: "#dcfce7",
      border: "#86efac",
    },
    {
      heading: "Approved & applied",
      rows: sections.appliedApproved,
      rowColor: "#1e3a8a",
      bg: "#dbeafe",
      border: "#93c5fd",
    },
    {
      heading: "Digest-class (rolling tags, suppressed)",
      rows: sections.suppressedDigests,
      rowColor: "#3f3f46",
      bg: "#f4f4f5",
      border: "#d4d4d8",
    },
  ];

  const renderRow = (row: UpdateRow): string => {
    const summaryLine = `${e(row.stack)}/${e(row.service)} <span style="color:#94a3b8;">·</span> <code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;font-size:12px;">${e(row.image)}</code> <span style="color:#94a3b8;">·</span> ${e(rowDelta(row))} <span style="color:#94a3b8;">(${e(row.bump)})</span>`;

    const adviseSection = row.advise_text
      ? `
        <div style="margin-top:10px;">
          <div style="font-size:11px;color:#64748b;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em;">LLM advice (as sent at the time)</div>
          <div style="font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12px;line-height:1.5;background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;padding:10px 12px;white-space:pre-wrap;">${e(row.advise_text)}</div>
        </div>`
      : "";

    const applyLogSection = row.apply_log
      ? (() => {
          const lines = row.apply_log.split("\n").length;
          const kb = (row.apply_log.length / 1024).toFixed(1);
          return `
        <div style="margin-top:10px;">
          <details style="margin:0;border:1px solid #e2e8f0;border-radius:4px;background:#f8fafc;">
            <summary style="cursor:pointer;padding:6px 12px;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;list-style:none;">Apply log <span style="text-transform:none;letter-spacing:0;">(${lines} line${lines === 1 ? "" : "s"} · ${kb} KB)</span></summary>
            <pre style="font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:11px;line-height:1.4;background:#f8fafc;border-top:1px solid #e2e8f0;border-radius:0 0 4px 4px;padding:10px 12px;white-space:pre-wrap;margin:0;">${e(row.apply_log)}</pre>
          </details>
        </div>`;
        })()
      : "";

    return `
      <details style="margin:6px 0;border:1px solid #e2e8f0;border-radius:6px;background:#ffffff;">
        <summary style="cursor:pointer;padding:10px 12px;font-size:13px;color:#0f172a;list-style:none;">${summaryLine}</summary>
        <div style="padding:0 12px 12px 12px;font-size:13px;">
          ${adviseSection}
          ${applyLogSection}
        </div>
      </details>`;
  };

  const sectionHtml = (cfg: SectionCfg): string => {
    if (cfg.rows.length === 0) return "";
    return `
      <div style="margin-top:18px;">
        <div style="display:inline-block;background:${cfg.bg};border:1px solid ${cfg.border};color:${cfg.rowColor};padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;margin-bottom:8px;">
          ${e(cfg.heading)} · ${cfg.rows.length}
        </div>
        ${cfg.rows.map(renderRow).join("")}
      </div>`;
  };

  const queueFooter = publicUrl
    ? `<p style="margin:24px 0 0 0;font-size:12px;color:#64748b;">Full queue: <a href="${e(publicUrl.replace(/\/+$/, "") + "/queue")}" style="color:#1d4ed8;">${e(publicUrl.replace(/\/+$/, "") + "/queue")}</a></p>`
    : "";

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f1f5f9;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f1f5f9;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="640" style="max-width:640px;background:#ffffff;border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f172a;">
<tr><td style="padding:24px;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 4px 0;">
    <tr>
      <td style="padding-right:10px;vertical-align:middle;">${BRAND_LOGO_INLINE}</td>
      <td style="vertical-align:middle;"><h2 style="margin:0;font-size:18px;color:#0f172a;">Bumpsight daily digest</h2></td>
    </tr>
  </table>
  <div style="font-size:12px;color:#64748b;">${e(label)}</div>
  ${cfgs.map(sectionHtml).join("")}
  ${queueFooter}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}
