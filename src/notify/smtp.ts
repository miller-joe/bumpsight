import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { Notifier, NotifyMessage } from "./types.js";

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string[];
}

/**
 * Parse an `smtp://` or `smtps://` URI. The `to` and `from` recipients
 * come from query string parameters: `?to=a@example.com&from=b@example.com`.
 * Multiple `to=` parameters are allowed.
 */
export function parseSmtpUri(uri: string): SmtpOptions {
  const u = new URL(uri);
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") {
    throw new Error(`smtp notifier: unexpected scheme ${u.protocol}`);
  }
  const secure = u.protocol === "smtps:";
  const port = u.port ? Number(u.port) : secure ? 465 : 587;
  const to = u.searchParams.getAll("to");
  if (to.length === 0) throw new Error("smtp notifier: ?to= is required");
  const from = u.searchParams.get("from");
  if (!from) throw new Error("smtp notifier: ?from= is required");
  return {
    host: u.hostname,
    port,
    secure,
    user: u.username ? decodeURIComponent(u.username) : undefined,
    pass: u.password ? decodeURIComponent(u.password) : undefined,
    from,
    to,
  };
}

export class SmtpNotifier implements Notifier {
  readonly name: string;
  private opts: SmtpOptions;
  private transport: Transporter;

  constructor(uri: string, transportFactory = nodemailer.createTransport) {
    this.opts = parseSmtpUri(uri);
    this.name = `smtp:${this.opts.host}`;
    this.transport = transportFactory({
      host: this.opts.host,
      port: this.opts.port,
      secure: this.opts.secure,
      auth: this.opts.user
        ? { user: this.opts.user, pass: this.opts.pass ?? "" }
        : undefined,
    });
  }

  async send(msg: NotifyMessage): Promise<void> {
    const text = formatBody(msg);
    await this.transport.sendMail({
      from: this.opts.from,
      to: this.opts.to.join(", "),
      subject: msg.subject,
      text,
    });
  }
}

function formatBody(msg: NotifyMessage): string {
  let out = msg.body.trimEnd();
  if (msg.links && msg.links.length > 0) {
    out += "\n\n";
    for (const link of msg.links) {
      out += `${link.label}: ${link.url}\n`;
    }
  }
  return out + "\n";
}
