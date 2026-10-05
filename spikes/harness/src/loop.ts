/**
 * Option (a): an AI SDK tool loop where ONE model call = one turn. Between turns the full loop state
 * ({ messages, overlay }) is JSON round-tripped, exactly what a Workflow `step.do` per turn would persist.
 */
import { generateText, isStepCount, type ModelMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { MapWorkspace } from "./workspace";
import { droneTools, type FinishArgs } from "./tools";
import { LEGACY_RULES_TOOL_PROMPT, TOOL_SYSTEM_PROMPT } from "./prompt";
import type { VerifyResult } from "./verify";

export interface TurnRecord {
  turn: number;
  ms: number;
  finishReason: string;
  tools: { name: string; input: string; output: string }[];
  text: string;
  inputTokens: number;
  outputTokens: number;
  stateBytes: number;
}

export interface LoopResult {
  model: string;
  turns: TurnRecord[];
  finished: FinishArgs | null;
  stopReason: string;
  files: Record<string, string>;
  usage: { inputTokens: number; outputTokens: number };
  verifyCalls: VerifyResult[];
  loopMs: number;
}

const clip = (s: unknown, n = 300) => {
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return t == null ? "" : t.length > n ? `${t.slice(0, n)}…` : t;
};

export async function runToolLoop(opts: {
  env: Env;
  model: string;
  task: string;
  base: Record<string, string>;
  maxTurns?: number;
  budgetMs?: number;
  skipCache?: boolean;
  legacyRules?: boolean;
}): Promise<LoopResult> {
  const { env, model, task, base } = opts;
  const maxTurns = opts.maxTurns ?? 16;
  const budgetMs = opts.budgetMs ?? 240_000;
  const workersai = createWorkersAI({ binding: env.AI, gateway: { id: "queenos", skipCache: !!opts.skipCache } });
  const t0 = Date.now();

  // Durable loop state: what a Workflow step would return.
  let state: { messages: ModelMessage[]; overlay: Record<string, string | null> } = {
    messages: [{ role: "user", content: `<request>\n${task}\n</request>` }],
    overlay: {},
  };
  const turns: TurnRecord[] = [];
  const verifyCalls: VerifyResult[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let finished: FinishArgs | null = null;
  let stopReason = "max-turns";
  let nudged = false;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (Date.now() - t0 > budgetMs) {
      stopReason = "budget";
      break;
    }
    // Rehydrate the workspace: base tree + overlay (a step would do this from its inputs).
    const ws = new MapWorkspace(base);
    for (const [p, c] of Object.entries(state.overlay)) c == null ? await ws.rm(p) : await ws.writeFile(p, c);
    ws.touched.clear();

    const s = Date.now();
    const res = await generateText({
      model: workersai(model as never),
      system: opts.legacyRules ? LEGACY_RULES_TOOL_PROMPT : TOOL_SYSTEM_PROMPT,
      messages: state.messages,
      tools: droneTools(ws, env.LOADER, (r) => verifyCalls.push(r)),
      stopWhen: isStepCount(1),
      maxOutputTokens: 12_000,
    });
    const calls = res.toolCalls ?? [];
    const results = res.toolResults ?? [];
    const rec: TurnRecord = {
      turn,
      ms: Date.now() - s,
      finishReason: String(res.finishReason),
      tools: calls.map((c) => ({
        name: c.toolName,
        input: clip(c.input, 200),
        output: clip(results.find((r) => r.toolCallId === c.toolCallId)?.output, 300),
      })),
      text: clip(res.text, 300),
      inputTokens: res.usage?.inputTokens ?? 0,
      outputTokens: res.usage?.outputTokens ?? 0,
      stateBytes: 0,
    };
    usage.inputTokens += rec.inputTokens;
    usage.outputTokens += rec.outputTokens;

    // Fold this turn's file writes into the overlay.
    const overlay = { ...state.overlay };
    for (const p of ws.touched) overlay[p.slice(1)] = ws.files.get(p) ?? null;
    const messages = [...state.messages, ...res.response.messages];

    const fin = calls.find((c) => c.toolName === "finish");
    if (!calls.length && !nudged) {
      nudged = true;
      messages.push({ role: "user", content: "Continue working with the tools. When the change is done and verified, call finish." });
    }
    // JSON round trip = what step.do would persist (and the 1 MiB budget it must fit).
    const json = JSON.stringify({ messages, overlay });
    rec.stateBytes = json.length;
    state = JSON.parse(json);
    turns.push(rec);

    if (fin) {
      finished = fin.input as FinishArgs;
      stopReason = "finish";
      break;
    }
    if (!calls.length && nudged && turns.length > 1 && !turns[turns.length - 2]!.tools.length) {
      stopReason = "no-tool-calls";
      break;
    }
  }

  const ws = new MapWorkspace(base);
  for (const [p, c] of Object.entries(state.overlay)) c == null ? await ws.rm(p) : await ws.writeFile(p, c);
  return { model, turns, finished, stopReason, files: ws.snapshot(), usage, verifyCalls, loopMs: Date.now() - t0 };
}
