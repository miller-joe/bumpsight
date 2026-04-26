export interface NotifyLink {
  label: string;
  url: string;
}

export interface NotifyMessage {
  subject: string;
  /** Plain-text body. Notifiers that support HTML may also receive a basic upgrade. */
  body: string;
  /** Optional action links rendered into the message (approve / deny / view details). */
  links?: NotifyLink[];
}

export interface Notifier {
  /** Identifier for logs and error messages, e.g. `smtp:mail.example.com`. */
  name: string;
  send(msg: NotifyMessage): Promise<void>;
}
