import type { Notifier, NotifyMessage } from "./types.js";

export interface AppriseOptions {
  /** Full URL to POST to, e.g. https://apprise.example.com/notify/bumpsight */
  endpoint: string;
}

/**
 * Parse an `apprise://` or `apprises://` URI into the underlying HTTP/HTTPS
 * URL of an apprise-api endpoint. Examples:
 *
 *   apprise://apprise.example.com/notify/bumpsight
 *     → POST https://apprise.example.com/notify/bumpsight
 *   apprise://apprise.local:8000/notify/bumpsight
 *     → POST http://apprise.local:8000/notify/bumpsight
 *   apprises://apprise.example.com/notify/bumpsight
 *     → POST https://apprise.example.com/notify/bumpsight (forces https)
 */
export function parseAppriseUri(uri: string): AppriseOptions {
  const u = new URL(uri);
  if (u.protocol !== "apprise:" && u.protocol !== "apprises:") {
    throw new Error(`apprise notifier: unexpected scheme ${u.protocol}`);
  }
  const isLocal =
    u.hostname === "localhost" ||
    u.hostname === "127.0.0.1" ||
    u.hostname.endsWith(".local") ||
    u.hostname.endsWith(".lan") ||
    u.hostname.endsWith(".internal");
  const httpScheme = u.protocol === "apprises:" || !isLocal ? "https" : "http";
  const port = u.port ? `:${u.port}` : "";
  const endpoint = `${httpScheme}://${u.hostname}${port}${u.pathname}${u.search}`;
  return { endpoint };
}

export class AppriseNotifier implements Notifier {
  readonly name: string;
  private opts: AppriseOptions;
  private fetcher: typeof fetch;

  constructor(uri: string, fetcher: typeof fetch = fetch) {
    this.opts = parseAppriseUri(uri);
    this.name = `apprise:${new URL(this.opts.endpoint).host}`;
    this.fetcher = fetcher;
  }

  async send(msg: NotifyMessage): Promise<void> {
    const body = formatBody(msg);
    const res = await this.fetcher(this.opts.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: msg.subject,
        body,
        type: "info",
        format: "markdown",
      }),
    });
    if (!res.ok) {
      throw new Error(
        `apprise endpoint returned ${res.status} ${res.statusText}`,
      );
    }
  }
}

function formatBody(msg: NotifyMessage): string {
  let out = msg.body.trimEnd();
  if (msg.links && msg.links.length > 0) {
    out += "\n\n";
    for (const link of msg.links) {
      out += `[${link.label}](${link.url})\n`;
    }
  }
  return out;
}
