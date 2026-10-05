/**
 * AI client over the Workers AI binding, routed through AI Gateway (docs/discovery.md §3).
 *
 * `env.AI.run(model, { messages }, { gateway: { id } })` is pre-authenticated within the
 * account: no token, no URL, no headers. Third-party models (`anthropic/...`) use the
 * OpenAI chat-completions shape and come back as `choices[0].message.content`; Workers AI
 * models (`@cf/...`) may come back as `{ response }`. Both are handled.
 */

/** The slice of the `Ai` binding we use. Tests pass a fake. */
export interface AiRunner {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: { gateway?: { id: string; metadata?: Record<string, string | number | boolean> } },
  ): Promise<unknown>;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** OpenAI-style structured output request (`response_format`); Workers AI chat models accept both forms. */
export type ResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name: string; description?: string; schema: Record<string, unknown>; strict?: boolean } };

export interface CompletionRequest {
  /** Workers AI (`@cf/...`) or third-party (`anthropic/claude-opus-5-5`) model id. */
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Sent only when set (Claude Opus 5.5 rejects sampling parameters). */
  temperature?: number;
  /** JSON mode / JSON schema. Sent only when set; models that reject it make `complete` throw a 4xx. */
  responseFormat?: ResponseFormat;
  /** Extra model-specific body parameters (e.g. `reasoning_effort`). Never overrides messages/max_tokens. */
  extraParams?: Record<string, unknown>;
  /** Gateway log annotations. */
  metadata?: Record<string, string | number | boolean>;
}

export interface CompletionResult {
  text: string;
  /** The model that was requested. */
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** `stop`, `length`, `max_tokens`, ... when the provider reports one. */
  finishReason?: string;
}

export class AiGatewayError extends Error {
  override readonly name = "AiGatewayError";
  constructor(
    message: string,
    /** HTTP-like status when one could be determined (0 otherwise). */
    readonly status: number,
    /** 408/409/429/5xx, capacity and unknown failures are worth retrying; 4xx and refusals are not. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

// --- role -> model -------------------------------------------------------

export const ROLE_MODEL_DEFAULTS = {
  BUILDER: "@cf/zai-org/glm-5.3-flash",
  SCRIBE: "@cf/zai-org/glm-4.7-flash",
} as const;
export type AiRole = keyof typeof ROLE_MODEL_DEFAULTS;

/** `MODEL_<ROLE>` from env, else the role's default. */
export function modelForRole(role: AiRole, env: object): string {
  const v = (env as Record<string, unknown>)[`MODEL_${role}`];
  return typeof v === "string" && v.trim() ? v.trim() : ROLE_MODEL_DEFAULTS[role];
}

// --- client --------------------------------------------------------------

export function buildInput(req: CompletionRequest): Record<string, unknown> {
  return {
    ...(req.extraParams ?? {}),
    messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
    max_tokens: req.maxTokens ?? 16_000,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
  };
}

interface RunOutput {
  response?: unknown;
  result?: { response?: unknown };
  choices?: {
    message?: { content?: unknown; refusal?: string | null; reasoning_content?: unknown; reasoning?: unknown };
    text?: unknown;
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Chat content as text: a string, an array of `{type:"text",text}` parts, or (JSON mode) an already-parsed object. */
function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && (p as { type?: string }).type !== "reasoning" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("");
  }
  if (v && typeof v === "object") return JSON.stringify(v);
  return "";
}

/** Drop inline chain-of-thought some models emit in the content itself (`<think>...</think>`). */
export function stripThinking(text: string): string {
  const closed = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  // An unclosed block means the model ran out of tokens while thinking: nothing usable follows it.
  return closed.replace(/<think(?:ing)?>[\s\S]*$/i, "").trim();
}

/**
 * Both response shapes: OpenAI-style `choices[0].message.content` and Workers AI `response`.
 * Reasoning models put chain-of-thought in `reasoning_content` / `reasoning`; it is ignored,
 * so a reply that only ever "thought" yields empty text (callers treat that as unusable output).
 */
export function parseOutput(model: string, out: unknown): CompletionResult {
  const r = (out ?? {}) as RunOutput;
  const choice = r.choices?.[0];
  if (choice?.message?.refusal) throw new AiGatewayError("model refused the request", 200, false);
  const raw = choice?.message?.content ?? choice?.text ?? r.response ?? r.result?.response;
  const text = stripThinking(textOf(raw));
  return {
    text,
    model,
    ...(r.usage ? { usage: { inputTokens: r.usage.prompt_tokens ?? 0, outputTokens: r.usage.completion_tokens ?? 0 } } : {}),
    ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
  };
}

/** Classify a thrown `AI.run` error. Workers AI errors carry a status or a "NNNN: message" string. */
export function classifyError(e: unknown): AiGatewayError {
  const err = e as { message?: string; status?: number; statusCode?: number } | null;
  const message = err?.message ?? String(e);
  const status = err?.status ?? err?.statusCode ?? Number(/(?:^|\D)([45]\d\d)(?:\D|$)/.exec(message)?.[1] ?? 0);
  const retryable =
    status === 408 || status === 409 || status === 429 || status >= 500
      ? true
      : status >= 400 || /unauthor|forbidden|not found|invalid|not authenticated/i.test(message)
        ? false
        : true;
  return new AiGatewayError(`AI run failed: ${message}`, status, retryable);
}

// --- rate limits ---------------------------------------------------------

const RATE_LIMIT_RE = /(?:^|\D)429(?:\D|$)|rate[\s_-]?limit|too many requests/i;

/**
 * True for a 429 / rate-limit failure, from an AiGatewayError, an error with a `status`, an error
 * message, or a plain string (e.g. the `error` of a failed agent run). A rate limit says nothing
 * about the model's output, so callers retry it and must NOT count the model as failed.
 */
export function isRateLimited(e: unknown): boolean {
  if (typeof e === "string") return RATE_LIMIT_RE.test(e);
  const err = e as { status?: number; statusCode?: number; message?: string } | null;
  if (err?.status === 429 || err?.statusCode === 429) return true;
  return RATE_LIMIT_RE.test(err?.message ?? "");
}

export interface BackoffOptions {
  /** Total tries including the first (default 4). */
  maxAttempts?: number;
  /** Backoff ceiling doubles from this (default 1000 ms). */
  baseMs?: number;
  /** Never wait longer than this (default 20_000 ms). */
  maxMs?: number;
  /** [0, 1); injectable for tests. */
  random?: () => number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Equal-jitter exponential backoff: half the ceiling plus a random half, so waits spread out but never collapse to 0. */
export function jitteredBackoffMs(attempt: number, opts: Pick<BackoffOptions, "baseMs" | "maxMs" | "random"> = {}): number {
  const ceiling = Math.min(opts.maxMs ?? 20_000, (opts.baseMs ?? 1_000) * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + ((opts.random ?? Math.random)() * ceiling) / 2);
}

/**
 * Run `fn(attempt)` (attempt counts from 0); on a rate limit wait with jittered backoff and retry.
 * Anything else, or the last attempt's rate limit, is rethrown unchanged.
 */
export async function withRateLimitRetry<T>(fn: (attempt: number) => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const max = Math.max(1, opts.maxAttempts ?? 4);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (!isRateLimited(e) || attempt + 1 >= max) throw e;
      await sleep(jitteredBackoffMs(attempt, opts));
    }
  }
}

export interface AiClientOptions {
  /** `env.AI`, or a fake. */
  ai: AiRunner;
  gatewayId: string;
}

export class AiClient {
  constructor(private readonly opts: AiClientOptions) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    let out: unknown;
    try {
      out = await this.opts.ai.run(req.model, buildInput(req), {
        gateway: { id: this.opts.gatewayId, ...(req.metadata ? { metadata: req.metadata } : {}) },
      });
    } catch (e) {
      throw classifyError(e);
    }
    return parseOutput(req.model, out);
  }
}

export function createAiClient(opts: AiClientOptions): AiClient {
  return new AiClient(opts);
}
