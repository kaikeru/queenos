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

export interface CompletionRequest {
  /** Workers AI (`@cf/...`) or third-party (`anthropic/claude-opus-5-5`) model id. */
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** Sent only when set (Claude Opus 5.5 rejects sampling parameters). */
  temperature?: number;
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
  BUILDER: "anthropic/claude-opus-5-5",
  SCRIBE: "anthropic/claude-haiku-4-5",
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
    messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
    max_tokens: req.maxTokens ?? 16_000,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
}

interface RunOutput {
  response?: unknown;
  choices?: { message?: { content?: unknown; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function parseOutput(model: string, out: unknown): CompletionResult {
  const r = (out ?? {}) as RunOutput;
  const choice = r.choices?.[0];
  if (choice?.message?.refusal) throw new AiGatewayError("model refused the request", 200, false);
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content : typeof r.response === "string" ? r.response : "";
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
