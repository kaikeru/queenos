import { MCP_ERROR_RETRYABLE, type GoalChild, type McpErrorCode } from "@queenos/queen-types";

export interface ToolErrorOptions {
  items?: GoalChild[];
  /** Overrides the default: `MCP_ERROR_RETRYABLE[code]`, or true when a `retryAfterMs` is given. */
  retryable?: boolean;
  retryAfterMs?: number;
}

/** A tool failure the agent sees as `{code, message, retryable, retryAfterMs?}` (`isError: true`). Messages never carry tokens or input values. */
export class ToolError extends Error {
  readonly items?: GoalChild[];
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(
    readonly code: McpErrorCode,
    message: string,
    opts: ToolErrorOptions = {},
  ) {
    super(message.length <= 200 ? message : `${message.slice(0, 199)}…`);
    this.name = "ToolError";
    if (opts.items) this.items = opts.items;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    this.retryable = opts.retryable ?? (opts.retryAfterMs !== undefined || MCP_ERROR_RETRYABLE[code]);
  }
}

export const messageOf = (e: unknown): string => String((e as Error)?.message ?? e);

const QUEEN = /^(INVALID_INPUT|NOT_FOUND|CONFLICT|UNAVAILABLE): ([\s\S]*)$/;

/** A Queen RPC error (`CODE: detail`, apps/queen/src/errors.ts) as a tool error; UNAVAILABLE and anything unrecognised is retryable trouble. */
export function fromQueen(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  const m = QUEEN.exec(messageOf(e));
  if (m && (m[1] === "NOT_FOUND" || m[1] === "CONFLICT" || m[1] === "INVALID_INPUT")) return new ToolError(m[1] as McpErrorCode, m[2]!);
  return new ToolError("UNAVAILABLE", "the hive is temporarily unavailable; retry", { retryAfterMs: 2000 });
}

/** A Queen refusal (`AttemptResult` ok:false) as a tool error, keeping its retryAfterMs. */
export const refusal = (r: { code: McpErrorCode; message: string; retryAfterMs?: number }): ToolError =>
  new ToolError(r.code, r.message, r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {});

/** ARTIFACTS_UNAVAILABLE with the upstream cf-ray when one was seen (forkRepo puts `cf-ray=<id>` in its errors). */
export function artifactsUnavailable(what: string, e: unknown): ToolError {
  const ray = /cf-ray=([A-Za-z0-9-]+)/.exec(messageOf(e))?.[1];
  return new ToolError("ARTIFACTS_UNAVAILABLE", `${what} failed after retries${ray ? ` (cf-ray ${ray})` : ""}; retry start_attempt`, { retryAfterMs: 5000 });
}
