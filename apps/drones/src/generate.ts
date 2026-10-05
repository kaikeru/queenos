/**
 * Live generation: model selection, structured output, one repair turn, model fallback.
 *
 * For each model in order (Queen's choice, then its fallbacks):
 *   1. ask for the change set (JSON schema `response_format` first; plain prompt if the model rejects it),
 *   2. parse + validate (tolerant extractor, caps, path safety, template fit),
 *   3. on invalid output, ONE repair turn that echoes the validation error,
 *   4. still invalid -> record the model in `failedModels` and try the next one.
 */
import type { DroneTask } from "@queenos/queen-types";
import { AiGatewayError, type ChatMessage, type CompletionResult } from "@queenos/hive-kit";
import { ChangeSetError, parseChangeSet, templateFitProblems, type ChangeSet } from "./change-set";
import type { DroneConfig } from "./config";
import type { LlmPort } from "./ports";
import { BUILDER_SYSTEM_PROMPT, CHANGE_SET_RESPONSE_FORMAT, buildBuilderMessages, buildRepairMessages, type RepoContext } from "./prompt";

export const MAX_OUTPUT_TOKENS = 20_000;
/** Models tried per build (the Queen sends the choice plus at most 3 fallbacks). */
export const MAX_MODELS = 5;
/** The generate step times out at 5 minutes: do not start another model call after this. */
export const DEFAULT_BUDGET_MS = 200_000;

export interface Generated {
  changeSet: ChangeSet;
  /** The model that produced the accepted change set. */
  model: string;
  /** Models tried before `model` that produced unusable output even after the repair turn. */
  failedModels: string[];
  /** True when the accepted change set came from the repair turn. */
  repaired: boolean;
  temperature: number;
  usage: { inputTokens: number; outputTokens: number };
}

/** Every model produced unusable output (or ran out of budget). Retrying the same models will not help. */
export class AllModelsFailedError extends ChangeSetError {
  override readonly name = "AllModelsFailedError";
  constructor(
    message: string,
    readonly failedModels: string[],
  ) {
    super(message);
  }
}

/** Ordered, de-duplicated model list for a task: `modelChoice.model`, its `fallbacks`, else the env default. */
export function modelsFor(task: Pick<DroneTask, "modelChoice">, config: Pick<DroneConfig, "aiGateway">): string[] {
  const c = task.modelChoice;
  const list = c ? [c.model, ...c.fallbacks] : [config.aiGateway.model];
  return [...new Set(list.map((m) => m.trim()).filter(Boolean))].slice(0, MAX_MODELS);
}

const FORMAT_REJECTED_RE = /response_format|json_schema|json mode|json_object|structured output|schema/i;

export interface GenerateOptions {
  llm: LlmPort;
  task: DroneTask;
  config: DroneConfig;
  context: RepoContext | null;
  now?: () => number;
  budgetMs?: number;
}

export async function generateLive(opts: GenerateOptions): Promise<Generated> {
  const { llm, task, config, context } = opts;
  const now = opts.now ?? Date.now;
  const started = now();
  const budget = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const models = modelsFor(task, config);
  const original = buildBuilderMessages(task, context ?? []);
  const repoFiles = context?.files ?? [];
  const failedModels: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let lastError: unknown = null;
  let onlyTransient = true;

  const call = async (model: string, messages: ChatMessage[], useFormat: boolean): Promise<CompletionResult> => {
    const res = await llm.complete({
      model,
      system: BUILDER_SYSTEM_PROMPT,
      messages,
      maxTokens: MAX_OUTPUT_TOKENS,
      ...(useFormat ? { responseFormat: CHANGE_SET_RESPONSE_FORMAT } : {}),
      ...(config.sendTemperature ? { temperature: config.temperature } : {}),
      metadata: { promptId: task.promptId, trainId: task.trainId, action: task.action, role: "builder" },
    });
    usage.inputTokens += res.usage?.inputTokens ?? 0;
    usage.outputTokens += res.usage?.outputTokens ?? 0;
    return res;
  };

  /** Ask with JSON schema; if the model/gateway rejects `response_format`, ask again without it. */
  const ask = async (model: string, messages: ChatMessage[]): Promise<CompletionResult> => {
    try {
      return await call(model, messages, true);
    } catch (e) {
      if (e instanceof AiGatewayError && e.status >= 400 && e.status < 500 && e.status !== 429 && FORMAT_REJECTED_RE.test(e.message)) {
        return call(model, messages, false);
      }
      throw e;
    }
  };

  const check = (res: CompletionResult): ChangeSet => {
    if (res.finishReason === "length" || res.finishReason === "max_tokens") {
      throw new ChangeSetError(`output was truncated at the token limit; produce a smaller change${res.text ? "" : " (the whole budget went into reasoning)"}`);
    }
    const cs = parseChangeSet(res.text);
    const problems = templateFitProblems(cs, repoFiles);
    if (problems.length) throw new ChangeSetError(`the change set does not fit the project template: ${problems.slice(0, 6).join("; ")}`);
    return cs;
  };

  for (const model of models) {
    if (now() - started > budget) {
      onlyTransient = false;
      failedModels.push(model);
      continue;
    }
    try {
      const first = await ask(model, original);
      let rejected = first.text;
      try {
        return { changeSet: check(first), model, failedModels, repaired: false, temperature: config.temperature, usage };
      } catch (e) {
        if (!(e instanceof ChangeSetError)) throw e;
        onlyTransient = false;
        lastError = e;
        // The single repair turn: send the validation error back, ask for corrected JSON only.
        const second = await ask(model, buildRepairMessages(original, rejected, e.message));
        rejected = second.text;
        return { changeSet: check(second), model, failedModels, repaired: true, temperature: config.temperature, usage };
      }
    } catch (e) {
      lastError = e;
      if (e instanceof ChangeSetError) onlyTransient = false;
      else if (!(e instanceof AiGatewayError) || !e.retryable) onlyTransient = false;
      failedModels.push(model);
      console.warn(`drone: model ${model} failed for ${task.trainId}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    }
  }

  // Every model transiently failed (429/5xx): let the step retry. Otherwise retrying cannot help.
  if (onlyTransient && lastError instanceof AiGatewayError) throw lastError;
  const why = String((lastError as Error | null)?.message ?? "no model available").slice(0, 400);
  throw new AllModelsFailedError(`no usable change set from ${failedModels.join(", ") || "any model"}: ${why}`, failedModels);
}
