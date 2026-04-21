/**
 * Minimal Ollama client. Calls /api/chat non-streaming for simplicity.
 * Matches the request/response shape documented at
 * https://github.com/ollama/ollama/blob/main/docs/api.md
 */

export interface OllamaOptions {
  host?: string;
  model?: string;
  timeoutMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
}

const DEFAULT_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.BUMPSIGHT_MODEL ?? "llama3.2";

export async function chat(
  messages: ChatMessage[],
  opts: OllamaOptions = {},
): Promise<string> {
  const host = opts.host ?? DEFAULT_HOST;
  const model = opts.model ?? DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);

  try {
    const res = await fetch(`${host.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: { temperature: 0.2 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
    }
    const body = (await res.json()) as OllamaChatResponse;
    return body.message.content;
  } finally {
    clearTimeout(timeout);
  }
}
