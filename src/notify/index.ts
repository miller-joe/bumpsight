import type { Notifier, NotifyMessage } from "./types.js";
import { SmtpNotifier } from "./smtp.js";
import { AppriseNotifier } from "./apprise.js";

export type { Notifier, NotifyMessage } from "./types.js";

/**
 * Build the notifier list from a list of URIs. Unknown schemes throw at
 * startup so misconfigured deployments fail loudly rather than silently
 * eating notifications.
 */
export function buildNotifiers(uris: string[]): Notifier[] {
  return uris.map((uri) => {
    const u = new URL(uri);
    switch (u.protocol) {
      case "smtp:":
      case "smtps:":
        return new SmtpNotifier(uri);
      case "apprise:":
      case "apprises:":
        return new AppriseNotifier(uri);
      default:
        throw new Error(
          `unknown notifier scheme: ${u.protocol} (supported: smtp, smtps, apprise, apprises)`,
        );
    }
  });
}

/**
 * Parse the `BUMPSIGHT_NOTIFY` env var. Comma-separated list of notifier
 * URIs. Empty / unset returns an empty list (notifications disabled).
 */
export function parseNotifyEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface NotifyResult {
  delivered: number;
  failed: { name: string; error: string }[];
}

/**
 * Fan out a message to every notifier. Failures in one notifier never
 * abort delivery to others — daemon-mode robustness above all else.
 */
export async function notifyAll(
  notifiers: Notifier[],
  msg: NotifyMessage,
): Promise<NotifyResult> {
  const settled = await Promise.allSettled(
    notifiers.map((n) => n.send(msg).then(() => n.name)),
  );
  let delivered = 0;
  const failed: { name: string; error: string }[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    if (result.status === "fulfilled") {
      delivered += 1;
    } else {
      failed.push({
        name: notifiers[i]!.name,
        error: (result.reason as Error)?.message ?? String(result.reason),
      });
    }
  }
  return { delivered, failed };
}
