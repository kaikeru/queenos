import type { GoalChild, McpErrorCode } from "@queenos/queen-types";

/** A tool failure the agent sees as `{code, message}` (`isError: true`). Messages never carry tokens or input values. */
export class ToolError extends Error {
  constructor(
    readonly code: McpErrorCode,
    message: string,
    readonly items?: GoalChild[],
  ) {
    super(message.length <= 200 ? message : `${message.slice(0, 199)}…`);
    this.name = "ToolError";
  }
}

export const messageOf = (e: unknown): string => String((e as Error)?.message ?? e);

const QUEEN = /^(INVALID_INPUT|NOT_FOUND|CONFLICT|UNAVAILABLE): ([\s\S]*)$/;

/** A Queen RPC error (`CODE: detail`, apps/queen/src/errors.ts) as a tool error; anything else is retryable trouble. */
export function fromQueen(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  const m = QUEEN.exec(messageOf(e));
  if (m && (m[1] === "NOT_FOUND" || m[1] === "CONFLICT" || m[1] === "INVALID_INPUT")) return new ToolError(m[1] as McpErrorCode, m[2]!);
  return new ToolError("CONFLICT", "the hive is temporarily unavailable; retry");
}

/** ARTIFACTS_UNAVAILABLE with the upstream cf-ray when one was seen (forkRepo puts `cf-ray=<id>` in its errors). */
export function artifactsUnavailable(what: string, e: unknown): ToolError {
  const ray = /cf-ray=([A-Za-z0-9-]+)/.exec(messageOf(e))?.[1];
  return new ToolError("ARTIFACTS_UNAVAILABLE", `${what} failed after retries${ray ? ` (cf-ray ${ray})` : ""}; retry start_attempt`);
}
