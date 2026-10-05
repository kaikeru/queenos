/**
 * The Oracle control flow (v2 design §3.3), written against a minimal
 * StepRunner and the OraclePorts seam so it is tested without Workflows,
 * Artifacts, Vectorize or the Queen. OracleWorkflow.run() is a thin adapter.
 *
 * One instance per command (id = commandId). We ALWAYS report an
 * OracleResult back, ok or not. LLM failure -> ok:false (the Queen falls back
 * to a single item); memory failure -> similar: [] (the Queen does not dedupe).
 */
import type { WorkflowStepConfig } from "cloudflare:workers";
import {
  OracleCommandSchema,
  OracleResultSchema,
  type DecomposedChild,
  type OracleCommand,
  type OracleResult,
  type SimilarItem,
} from "@queenos/queen-types";
import { AiGatewayError } from "@queenos/hive-kit";
import { decomposeSchema, parseDecomposition, systemPrompt, userPrompt } from "./prompt";
import type { OraclePorts } from "./ports";

export interface StepRunner {
  do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>;
}

export const LLM_STEP: WorkflowStepConfig = { retries: { limit: 1, delay: "5 seconds", backoff: "constant" }, timeout: "3 minutes" };
export const REPORT_STEP: WorkflowStepConfig = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" }, timeout: "30 seconds" };
/** Best effort: one retry, short timeout; the caller turns a final failure into a fallback. */
export const BEST_EFFORT_STEP: WorkflowStepConfig = { retries: { limit: 1, delay: "2 seconds", backoff: "constant" }, timeout: "60 seconds" };

/** Matches below this are noise; the Queen applies its own (higher) dedupe thresholds. */
export const SIMILAR_MIN_SCORE = 0.5;
const MAX_SUMMARY = 500;
const clip = (s: string, n = MAX_SUMMARY) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const messageOf = (e: unknown) => String((e as Error)?.message ?? e);

export class OracleFailedError extends Error {
  override readonly name = "OracleFailedError";
}

export type OracleRunResult = { commandId: string; op: OracleCommand["op"]; ok: boolean; summary: string; queenOutcome: string };

type DecomposeOutcome =
  | { ok: true; children: DecomposedChild[]; model: string; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; error: string };

export async function runOracle(payload: unknown, step: StepRunner, ports: OraclePorts): Promise<OracleRunResult> {
  const parsed = OracleCommandSchema.safeParse(payload);
  if (!parsed.success) {
    throw new OracleFailedError(`invalid OracleCommand: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const cmd = parsed.data;
  const started = Date.now();
  const result = cmd.op === "DECOMPOSE" ? await decompose(cmd, step, ports) : await triage(cmd, step, ports);

  const queenOutcome = await step.do("report", REPORT_STEP, async () => {
    try {
      const r = (await ports.queen(cmd.hive).reportOracleResult(result)) as { outcome?: unknown } | null | undefined;
      return String(r?.outcome ?? "reported");
    } catch (e) {
      // The Queen's stale / unknown / invalid replies will not get better on retry.
      if (/^(INVALID_INPUT|NOT_FOUND|CONFLICT): /.test(messageOf(e))) return `rejected: ${clip(messageOf(e), 200)}`;
      throw e;
    }
  });

  try {
    ports.metric({
      type: "oracle",
      hive: cmd.hive,
      kindOrRole: cmd.op,
      ...(result.model ? { model: result.model } : {}),
      outcome: result.ok ? "ok" : "failed",
      itemId: cmd.itemId,
      ...(cmd.trace ? { traceId: cmd.trace.traceparent.split("-")[1] ?? "" } : {}),
      valueMs: Date.now() - started,
      ...(result.usage ? { tokensIn: result.usage.inputTokens, tokensOut: result.usage.outputTokens } : {}),
    });
  } catch {
    /* metrics never fail a command */
  }
  return { commandId: cmd.commandId, op: cmd.op, ok: result.ok, summary: result.summary, queenOutcome };
}

async function decompose(cmd: Extract<OracleCommand, { op: "DECOMPOSE" }>, step: StepRunner, ports: OraclePorts): Promise<OracleResult> {
  const { commandId, itemId, hive } = cmd;
  const maxChildren = cmd.limits.maxChildren;

  // 0. Repo listing (best effort; [] only weakens the path predictions).
  let files: string[] = [];
  try {
    files = await step.do("repo: list files", BEST_EFFORT_STEP, () => ports.repo.listFiles(hive));
  } catch (e) {
    console.warn(`repo listing failed for ${hive}: ${messageOf(e)}`);
  }

  // 1. The LLM call. Failure is a result (ok: false), never a thrown step.
  const outcome = await step.do("decompose: llm", LLM_STEP, async (): Promise<DecomposeOutcome> => {
    if (!ports.llm) return { ok: false, error: "no AI binding" };
    const models = [cmd.model.model, ...cmd.model.fallbacks];
    const errors: string[] = [];
    for (const model of models) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await ports.llm.complete({
            model,
            system: systemPrompt(maxChildren),
            messages: [{ role: "user", content: userPrompt({ promptText: cmd.promptText, files, openItems: cmd.openItems }) }],
            temperature: 0,
            maxTokens: 6_000,
            responseFormat: { type: "json_schema", json_schema: { name: "decomposition", schema: decomposeSchema(maxChildren), strict: true } },
            metadata: { role: "planner", hive, commandId },
          });
          const children = parseDecomposition(res.text, maxChildren);
          if (children.length === 0) {
            errors.push(`${model}: no usable children`);
            break; // a bad answer at temperature 0 will not improve; next model
          }
          return { ok: true, children, model, usage: res.usage ?? { inputTokens: 0, outputTokens: 0 } };
        } catch (e) {
          errors.push(`${model}: ${messageOf(e)}`);
          if (!(e instanceof AiGatewayError && e.retryable)) break;
        }
      }
    }
    return { ok: false, error: errors.join("; ") };
  });

  if (!outcome.ok) {
    return OracleResultSchema.parse({ commandId, op: "DECOMPOSE", itemId, ok: false, summary: clip(`Decompose failed: ${outcome.error}`) });
  }

  // 2. Dedupe (best effort): similar items per child, then index the children.
  const ids = outcome.children.map((c) => `${itemId}-${c.key}`);
  const texts = outcome.children.map((c) => `${c.title}\n\n${c.body}`);
  let similar: SimilarItem[][] = outcome.children.map(() => []);
  try {
    const found = await step.do("dedupe: children", BEST_EFFORT_STEP, () =>
      ports.memory.findSimilarItems(hive, texts, { topK: 3, minScore: SIMILAR_MIN_SCORE, excludeIds: ids }),
    );
    if (found.length === outcome.children.length) similar = found;
  } catch (e) {
    console.warn(`similar-item search failed for ${hive}: ${messageOf(e)}`);
  }
  try {
    await step.do("index: children", BEST_EFFORT_STEP, () =>
      ports.memory.indexItems(hive, outcome.children.map((c, n) => ({ id: ids[n]!, text: texts[n]!, title: c.title }))),
    );
  } catch (e) {
    console.warn(`child indexing failed for ${hive}: ${messageOf(e)}`);
  }

  const children = outcome.children.map((c, n) => ({ ...c, similar: (similar[n] ?? []).slice(0, 3) }));
  return OracleResultSchema.parse({
    commandId,
    op: "DECOMPOSE",
    itemId,
    ok: true,
    children,
    model: outcome.model,
    usage: outcome.usage,
    summary: clip(`Decomposed into ${children.length} item${children.length === 1 ? "" : "s"} with ${outcome.model}.`),
  });
}

async function triage(cmd: Extract<OracleCommand, { op: "TRIAGE" }>, step: StepRunner, ports: OraclePorts): Promise<OracleResult> {
  const { commandId, itemId, hive } = cmd;
  const text = `${cmd.title}\n\n${cmd.body}`;
  let similar: SimilarItem[] = [];
  try {
    const found = await step.do("triage: similar", BEST_EFFORT_STEP, () =>
      ports.memory.findSimilarItems(hive, [text], { topK: 5, minScore: SIMILAR_MIN_SCORE, excludeIds: [itemId] }),
    );
    similar = (found[0] ?? []).slice(0, 5);
  } catch (e) {
    console.warn(`triage search failed for ${hive}: ${messageOf(e)}`);
  }
  try {
    await step.do("triage: index", BEST_EFFORT_STEP, () => ports.memory.indexItems(hive, [{ id: itemId, text, title: cmd.title }]));
  } catch (e) {
    console.warn(`triage indexing failed for ${hive}: ${messageOf(e)}`);
  }
  return OracleResultSchema.parse({
    commandId,
    op: "TRIAGE",
    itemId,
    ok: true,
    similar,
    summary: clip(similar.length ? `${similar.length} similar item(s); best ${similar[0]!.score.toFixed(2)}.` : "No similar items."),
  });
}
