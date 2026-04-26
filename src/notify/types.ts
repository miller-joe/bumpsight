export interface NotifyLink {
  label: string;
  url: string;
}

export interface NotifyMessage {
  subject: string;
  /** Plain-text body. Always required — used as the fallback for non-HTML clients
   *  and as the body for non-email notifiers (Apprise, etc.). */
  body: string;
  /** Optional pre-rendered HTML body for email clients. When set, the SMTP
   *  notifier sends a multipart/alternative message; non-HTML notifiers
   *  ignore this field and fall back to `body`. */
  htmlBody?: string;
  /** Optional action links. When the body already includes the URLs inline,
   *  leave this undefined to avoid duplicate links at the bottom. */
  links?: NotifyLink[];
}

export interface Notifier {
  /** Identifier for logs and error messages, e.g. `smtp:mail.example.com`. */
  name: string;
  send(msg: NotifyMessage): Promise<void>;
}
