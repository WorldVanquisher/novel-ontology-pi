/**
 * Work LLM client — an OpenAI-compatible chat-completions implementation
 * of the WorkModel interface (see ./llm.ts), configured from WORK_LLM_*
 * via src/config.ts.
 *
 * Scope: this is PLUMBING. It knows how to call an endpoint, retry
 * transient failures, enforce a timeout, and report token usage +
 * latency. It contains no prompts of its own and is deliberately NOT
 * wired into the block processor / ingest path — that step (with live
 * keys) happens separately. Smoke-test it with `novel llm ping|probe`,
 * which can be pointed at a local mock server via WORK_LLM_BASE_URL.
 *
 * The API key is used only for the Authorization header. It is never
 * logged, printed, or included in error messages.
 */
import { loadConfig } from "../config.js";
import type { WorkModel } from "./llm.js";

export interface WorkModelUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface WorkModelResult {
  text: string;
  model: string;
  usage: WorkModelUsage;
  /** Wall-clock latency of the whole call, retries included. */
  latencyMs: number;
  attempts: number;
}

export interface HttpWorkModelOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  thinking?: "enabled" | "disabled";
  /** Per-attempt request timeout. Default 30s. */
  timeoutMs?: number;
  /** Extra attempts after the first for transient failures. Default 2. */
  maxRetries?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 250;

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Work LLM request failed: ${status} ${detail}`);
  }
  /** 5xx is transient; 4xx is a caller/config problem — never retried. */
  get retryable(): boolean {
    return this.status >= 500;
  }
}

interface ChatCompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class HttpWorkModel implements WorkModel {
  readonly modelId: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HttpWorkModelOptions) {
    this.modelId = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async generate(request: {
    system: string;
    prompt: string;
    jsonSchema?: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<string> {
    return (await this.generateWithInfo(request)).text;
  }

  /** Like generate(), but also returns usage / latency / attempt count. */
  async generateWithInfo(request: {
    system: string;
    prompt: string;
    jsonSchema?: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<WorkModelResult> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
    };
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (this.opts.thinking) body.thinking = { type: this.opts.thinking };
    if (request.jsonSchema) {
      // OpenAI-compatible JSON mode: the endpoint guarantees a JSON
      // object; conformance to the caller's schema stays caller-side
      // (several compatible providers accept no schema parameter).
      body.response_format = { type: "json_object" };
    }

    const started = performance.now();
    let attempts = 0;
    let lastError: Error | null = null;
    while (attempts <= this.maxRetries) {
      attempts++;
      try {
        const res = await this.post(body);
        if (res.ok) {
          const data = (await res.json()) as ChatCompletionResponse;
          const text = data.choices?.[0]?.message?.content;
          if (typeof text !== "string") {
            throw new Error(
              "Work LLM response had no choices[0].message.content",
            );
          }
          return {
            text,
            model: data.model ?? this.opts.model,
            usage: {
              promptTokens: data.usage?.prompt_tokens ?? null,
              completionTokens: data.usage?.completion_tokens ?? null,
              totalTokens: data.usage?.total_tokens ?? null,
            },
            latencyMs: Math.round(performance.now() - started),
            attempts,
          };
        }
        const detail = (await res.text()).slice(0, 500);
        throw new HttpStatusError(res.status, detail);
      } catch (err) {
        if (err instanceof HttpStatusError && !err.retryable) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      if (attempts <= this.maxRetries) {
        await this.sleep(RETRY_BASE_DELAY_MS * 2 ** (attempts - 1));
      }
    }
    throw new Error(
      `Work LLM request failed after ${attempts} attempts: ${lastError?.message ?? "unknown error"}`,
    );
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "AbortError" || err.name === "TimeoutError")
      ) {
        throw new Error(
          `Work LLM request timed out after ${this.timeoutMs} ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build a client from the environment (WORK_LLM_* via src/config.ts).
 * Fails loudly and specifically on missing configuration — the callers
 * are smoke commands and the future live-wiring step, both of which
 * should surface config problems rather than guess around them.
 */
export function workModelFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HttpWorkModel {
  const cfg = loadConfig(env);
  if (cfg.workLlm.apiKey !== "configured") {
    throw new Error(
      "WORK_LLM_API_KEY is missing. Set it via environment / secure entry (see .env.example); `novel config` reports key status without values.",
    );
  }
  if (!cfg.workLlm.baseUrl) {
    throw new Error(
      `No base URL for work LLM provider "${cfg.workLlm.provider}". Set WORK_LLM_BASE_URL to an OpenAI-compatible API root.`,
    );
  }
  const model =
    cfg.workLlm.model ??
    (cfg.workLlm.provider === "deepseek" ? "deepseek-chat" : null);
  if (!model) {
    throw new Error(
      `WORK_LLM_MODEL is not set and provider "${cfg.workLlm.provider}" has no built-in default model. Set WORK_LLM_MODEL.`,
    );
  }
  return new HttpWorkModel({
    baseUrl: cfg.workLlm.baseUrl,
    apiKey: env.WORK_LLM_API_KEY!.trim(),
    model,
    thinking: cfg.workLlm.provider === "deepseek" && model === "deepseek-flash" ? "disabled" : undefined,
  });
}
