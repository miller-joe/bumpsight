import { describe, it, expect, vi } from "vitest";
import { parseSmtpUri, SmtpNotifier } from "../src/notify/smtp.js";
import { parseAppriseUri, AppriseNotifier } from "../src/notify/apprise.js";
import {
  buildNotifiers,
  parseNotifyEnv,
  notifyAll,
} from "../src/notify/index.js";
import type { Notifier } from "../src/notify/types.js";

describe("parseSmtpUri", () => {
  it("parses basic smtp URI with auth and recipients", () => {
    const opts = parseSmtpUri(
      "smtp://user:pa%40ss@mail.example.com:587/?to=admin@example.com&from=bumpsight@example.com",
    );
    expect(opts.host).toBe("mail.example.com");
    expect(opts.port).toBe(587);
    expect(opts.secure).toBe(false);
    expect(opts.user).toBe("user");
    expect(opts.pass).toBe("pa@ss");
    expect(opts.to).toEqual(["admin@example.com"]);
    expect(opts.from).toBe("bumpsight@example.com");
  });

  it("uses 465 by default for smtps and marks secure", () => {
    const opts = parseSmtpUri(
      "smtps://user:pass@mail.example.com/?to=admin@example.com&from=b@example.com",
    );
    expect(opts.port).toBe(465);
    expect(opts.secure).toBe(true);
  });

  it("supports multiple to= recipients", () => {
    const opts = parseSmtpUri(
      "smtp://mail.example.com/?to=a@example.com&to=b@example.com&from=c@example.com",
    );
    expect(opts.to).toEqual(["a@example.com", "b@example.com"]);
  });

  it("requires both to= and from=", () => {
    expect(() =>
      parseSmtpUri("smtp://mail.example.com/?from=c@example.com"),
    ).toThrow(/to=/);
    expect(() =>
      parseSmtpUri("smtp://mail.example.com/?to=c@example.com"),
    ).toThrow(/from=/);
  });
});

describe("SmtpNotifier", () => {
  it("sends a formatted message via the injected transport", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "x" }));
    const factory = () =>
      ({ sendMail }) as unknown as ReturnType<typeof import("nodemailer").createTransport>;
    const n = new SmtpNotifier(
      "smtp://u:p@mail.x.com:587/?to=admin@x.com&from=b@x.com",
      factory,
    );
    await n.send({
      subject: "test",
      body: "hello",
      links: [{ label: "Approve", url: "https://x/approve/1" }],
    });
    expect(sendMail).toHaveBeenCalledOnce();
    const call = sendMail.mock.calls[0]![0]!;
    expect(call.from).toBe("b@x.com");
    expect(call.to).toBe("admin@x.com");
    expect(call.subject).toBe("test");
    expect(call.text).toContain("hello");
    expect(call.text).toContain("Approve: https://x/approve/1");
  });
});

describe("parseAppriseUri", () => {
  it("maps apprise:// → http for *.local hosts", () => {
    const opts = parseAppriseUri("apprise://apprise.local:8000/notify/bumpsight");
    expect(opts.endpoint).toBe("http://apprise.local:8000/notify/bumpsight");
  });

  it("maps apprise:// → https for public hosts", () => {
    const opts = parseAppriseUri("apprise://apprise.example.com/notify/bumpsight");
    expect(opts.endpoint).toBe(
      "https://apprise.example.com/notify/bumpsight",
    );
  });

  it("apprises:// always forces https", () => {
    const opts = parseAppriseUri(
      "apprises://apprise.local:8000/notify/bumpsight",
    );
    expect(opts.endpoint).toBe("https://apprise.local:8000/notify/bumpsight");
  });
});

describe("AppriseNotifier", () => {
  it("POSTs JSON with title and body to the endpoint", async () => {
    const fetcher = vi.fn(
      async () => new Response("ok", { status: 200 }),
    );
    const n = new AppriseNotifier(
      "apprise://apprise.local/notify/bumpsight",
      fetcher as unknown as typeof fetch,
    );
    await n.send({
      subject: "subj",
      body: "body",
      links: [{ label: "View", url: "https://x/v" }],
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://apprise.local/notify/bumpsight");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.title).toBe("subj");
    expect(body.body).toContain("body");
    expect(body.body).toContain("[View](https://x/v)");
    expect(body.format).toBe("markdown");
  });

  it("throws on non-2xx", async () => {
    const fetcher = vi.fn(
      async () => new Response("nope", { status: 500, statusText: "boom" }),
    );
    const n = new AppriseNotifier(
      "apprise://apprise.local/notify/bumpsight",
      fetcher as unknown as typeof fetch,
    );
    await expect(
      n.send({ subject: "s", body: "b" }),
    ).rejects.toThrow(/500/);
  });
});

describe("parseNotifyEnv", () => {
  it("returns empty array for unset", () => {
    expect(parseNotifyEnv(undefined)).toEqual([]);
    expect(parseNotifyEnv("")).toEqual([]);
  });

  it("splits comma-separated values and trims", () => {
    expect(parseNotifyEnv("smtp://a , apprise://b ")).toEqual([
      "smtp://a",
      "apprise://b",
    ]);
  });
});

describe("buildNotifiers", () => {
  it("rejects unknown schemes loudly", () => {
    expect(() => buildNotifiers(["foo://bar"])).toThrow(/unknown notifier/);
  });
});

describe("notifyAll", () => {
  it("delivers to all notifiers and aggregates failures", async () => {
    const ok: Notifier = {
      name: "ok",
      send: vi.fn(async () => undefined),
    };
    const fail: Notifier = {
      name: "broken",
      send: vi.fn(async () => {
        throw new Error("nope");
      }),
    };
    const result = await notifyAll([ok, fail], { subject: "s", body: "b" });
    expect(result.delivered).toBe(1);
    expect(result.failed).toEqual([{ name: "broken", error: "nope" }]);
  });
});
