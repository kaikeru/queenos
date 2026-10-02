/**
 * Fetch-only AI Gateway client (docs/discovery.md §3).
 *
 * BYOK with stored provider keys: the only credential sent is
 * `cf-aig-authorization: Bearer <CF_AIG_TOKEN>`. No `x-api-key` and no
 * `Authorization` header — "AI Gateway substitutes the stored provider key only
 * when the provider authorization header is absent".
 */
import type { AiGatewayConfig } from "@queenos/queen-types";

export const AI_GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com";
export const ANTHROPIC_VERSION = "2023-06-01";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /**
   * Sent only when set. Claude Opus 5.5 (the default model) rejects sampling
   * parameters with a 400, so leave this undefined for it.
   */
  temperature?: number;
  /** Anthropic `output_config.effort` (low | medium | high | xhigh | max). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Sent as `cf-aig-metadata` (gateway log annotations). */
  metadata?: Record<string, string | number | boolean>;
}

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResult {
  text: string;
  usage: CompletionUsage;
  model: string;
  provider: AiGatewayConfig["provider"];
  stopReason: string | null;
}

export class AiGatewayError extends Error {
  override readonly name = "AiGatewayError";
  constructor(
    message: string,
    /** HTTP status (0 for network/parse failures). */
    readonly status: number,
    /** 408/409/429/5xx and network failures are worth retrying; 4xx and refusals are not. */
    readonly retryable: boolean,
    readonly body?: string,
  ) {
    super(message);
  }
}

export interface AiGatewayClientOptions {
  config: AiGatewayConfig;
  /** The gateway auth token (secret CF_AIG_TOKEN). */
  token: string;
  /** Injectable for tests. Default: global fetch. */
  fetch?: FetchLike;
  /** Non-default BYOK key alias (`cf-aig-byok-alias`). */
  byokAlias?: string;
  /** Override the origin (tests / staging). */
  origin?: string;
}

export function aiGatewayUrl(config: AiGatewayConfig, origin = AI_GATEWAY_ORIGIN): string {
  const base = `${origin}/v1/${encodeURIComponent(config.accountId)}/${encodeURIComponent(config.gatewayId)}`;
  return config.provider === "anthropic" ? `${base}/anthropic/v1/messages` : `${base}/openai/chat/completions`;
}

export function buildRequestBody(config: AiGatewayConfig, req: CompletionRequest): Record<string, unknown> {
  const maxTokens = req.maxTokens ?? 16_000;
  if (config.provider === "anthropic") {
    return {
      model: config.model,
      max_tokens: maxTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    };
  }
  return {
    model: config.model,
    max_completion_tokens: maxTokens,
    messages: [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages],
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
}

export function buildHeaders(opts: Pick<AiGatewayClientOptions, "config" | "token" | "byokAlias">, req?: CompletionRequest): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    "cf-aig-authorization": `Bearer ${opts.token}`,
  };
  if (opts.config.provider === "anthropic") h["anthropic-version"] = ANTHROPIC_VERSION;
  if (opts.byokAlias) h["cf-aig-byok-alias"] = opts.byokAlias;
  if (req?.metadata) h["cf-aig-metadata"] = JSON.stringify(req.metadata);
  return h;
}

interface AnthropicResponse {
  model?: string;
  stop_reason?: string | null;
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface OpenAiResponse {
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function parseResponse(config: AiGatewayConfig, json: unknown): CompletionResult {
  if (config.provider === "anthropic") {
    const r = json as AnthropicResponse;
    if (r.stop_reason === "refusal") throw new AiGatewayError("model refused the request", 200, false);
    const text = (r.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    return {
      text,
      usage: { inputTokens: r.usage?.input_tokens ?? 0, outputTokens: r.usage?.output_tokens ?? 0 },
      model: r.model ?? config.model,
      provider: "anthropic",
      stopReason: r.stop_reason ?? null,
    };
  }
  const r = json as OpenAiResponse;
  const choice = r.choices?.[0];
  if (choice?.message?.refusal) throw new AiGatewayError("model refused the request", 200, false);
  return {
    text: choice?.message?.content ?? "",
    usage: { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0 },
    model: r.model ?? config.model,
    provider: "openai",
    stopReason: choice?.finish_reason ?? null,
  };
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export class AiGatewayClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: AiGatewayClientOptions) {
    if (!opts.token) throw new AiGatewayError("AI Gateway token (CF_AIG_TOKEN) is not set", 0, false);
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  get url(): string {
    return aiGatewayUrl(this.opts.config, this.opts.origin);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: buildHeaders(this.opts, req),
        body: JSON.stringify(buildRequestBody(this.opts.config, req)),
      });
    } catch (e) {
      throw new AiGatewayError(`AI Gateway request failed: ${(e as Error)?.message ?? String(e)}`, 0, true);
    }
    const body = await res.text();
    if (!res.ok) {
      throw new AiGatewayError(
        `AI Gateway ${this.opts.config.provider} ${res.status}: ${body.slice(0, 500)}`,
        res.status,
        retryableStatus(res.status),
        body,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new AiGatewayError("AI Gateway returned non-JSON", res.status, true, body.slice(0, 500));
    }
    return parseResponse(this.opts.config, json);
  }
}

export function createAiGatewayClient(opts: AiGatewayClientOptions): AiGatewayClient {
  return new AiGatewayClient(opts);
}
