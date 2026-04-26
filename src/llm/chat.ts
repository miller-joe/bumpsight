/**
 * Minimal LLM client speaking the OpenAI Chat Completions API. Works
 * unchanged against:
 *   - Ollama (built-in OpenAI compat at /v1 since 0.1.40)
 *   - LiteLLM (the canonical OpenAI-compat router; use a model alias)
 *   - any other gateway that exposes /v1/chat/completions
 *
 * Configuration precedence (high → low):
 *   - explicit `opts` arguments
 *   - $BUMPSIGHT_LLM_URL  full base URL ending in /v1, e.g. http://localhost:11434/v1
 *   - $OLLAMA_HOST        Ollama-style base; we append /v1 when used
 *   - http://127.0.0.1:11434/v1
 */

export interface ChatOptions {
  /** OpenAI-compatible base URL ending in /v1. */
  baseUrl?: string;
  /** Optional bearer token. LiteLLM, OpenAI, Anthropic-compat all want it; Ollama ignores it. */
  apiKey?: string;
  /** Model name as the gateway expects it. For Ollama: `qwen2.5:14b-instruct`. For LiteLLM: an alias like `smart`. */
  model?: string;
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIChatResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason?: string | null;
  }>;
  model?: string;
}

function resolveBaseUrl(explicit?: string): string {
  if (explicit) return explicit.replace(/\/+$/, "");
  const env = process.env.BUMPSIGHT_LLM_URL;
  if (env) return env.replace(/\/+$/, "");
  const ollamaHost = process.env.OLLAMA_HOST;
  if (ollamaHost) return `${ollamaHost.replace(/\/+$/, "")}/v1`;
  return "http://127.0.0.1:11434/v1";
}

const DEFAULT_MODEL = process.env.BUMPSIGHT_MODEL ?? "llama3.2";

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const apiKey = opts.apiKey ?? process.env.BUMPSIGHT_LLM_KEY;
  const model = opts.model ?? DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 120_000,
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LLM ${res.status} (${baseUrl}): ${body.slice(0, 240)}`);
    }
    const body = (await res.json()) as OpenAIChatResponse;
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(
        `LLM response missing choices[0].message.content (model=${model})`,
      );
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}
