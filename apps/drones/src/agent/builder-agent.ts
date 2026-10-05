/**
 * BuilderAgent: the drone's coding agent, a `@cloudflare/think` Durable Object. One object per
 * (Workflow instance, model), named "<instanceId>|<model>", so a retried Workflow step reaches the same
 * object and re-attaches to its submission instead of starting a second turn.
 *
 * Think supplies the durable workspace (DO SQLite), the read/write/edit/list/find/grep/delete tools,
 * the tool loop and turn recovery after evictions. We add verify + finish (tools.ts), the stop
 * conditions and the `build()` RPC the Workflow step calls.
 */
import { Think, type StepContext, type TurnConfig } from "@cloudflare/think";
import type { StopCondition, ToolSet } from "ai";
import type { AgentBuildInput, AgentBuildResult, AgentRunStatus, AgentTask, AgentUsage } from "./contract";
import { AGENT_SYSTEM_PROMPT, agentUserMessage } from "./prompt";
import { EMPTY_TOOL_STATE, droneTools, type ToolState, type ToolStateStore } from "./tools";
import { traceFromParts, type ToolPartLike } from "./trace";
import { MAX_SEED_FILE_CHARS } from "./limits";
import type { LoaderLike } from "./verify";

export const AGENT_MAX_STEPS = 16;
/** Cumulative input tokens per model run (the transcript is re-sent every step). */
export const AGENT_INPUT_TOKEN_BUDGET = 150_000;
/** Per model call, enforced by AI Gateway. */
export const MODEL_REQUEST_TIMEOUT_MS = 150_000;

interface RunMeta {
  model: string;
  task: AgentTask;
  skipCache: boolean;
}

const TERMINAL = new Set(["completed", "error", "aborted", "skipped"]);
const EMPTY_USAGE: AgentUsage = { inputTokens: 0, outputTokens: 0, steps: 0 };

export class BuilderAgent extends Think<Env> {
  override maxSteps = AGENT_MAX_STEPS;
  override workspaceBash = false;

  // ── tiny durable KV + base tree (DO SQLite) ────────────────────────────

  private ready = false;
  private db(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (!this.ready) {
      sql.exec("CREATE TABLE IF NOT EXISTS drone_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS drone_base (path TEXT PRIMARY KEY, content TEXT NOT NULL)");
      this.ready = true;
    }
    return sql;
  }
  private kvGet<T>(k: string): T | null {
    const row = this.db().exec<{ v: string }>("SELECT v FROM drone_kv WHERE k = ?", k).toArray()[0];
    return row ? (JSON.parse(row.v) as T) : null;
  }
  private kvPut(k: string, v: unknown): void {
    this.db().exec("INSERT INTO drone_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
  }
  private baseCache: Record<string, string> | null = null;
  private base(): Record<string, string> {
    if (!this.baseCache) {
      const rows = this.db().exec<{ path: string; content: string }>("SELECT path, content FROM drone_base").toArray();
      this.baseCache = Object.fromEntries(rows.map((r) => [r.path, r.content]));
    }
    return this.baseCache;
  }
  private meta(): RunMeta | null {
    return this.kvGet<RunMeta>("meta");
  }
  private readonly toolState: ToolStateStore = {
    get: () => this.kvGet<ToolState>("tools") ?? EMPTY_TOOL_STATE,
    put: (s) => this.kvPut("tools", s),
  };

  // ── Think overrides ──────────────────────────────────────────────────

  override getModel(): ReturnType<Think["getModel"]> {
    const m = this.meta();
    if (!m) throw new Error("BuilderAgent: build() has not seeded this run");
    return m.model;
  }

  override getGateway(): ReturnType<Think["getGateway"]> {
    const m = this.meta();
    return {
      id: this.env.AI_GATEWAY_ID || "queenos",
      skipCache: m?.skipCache ?? false,
      requestTimeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      metadata: { promptId: m?.task.promptId ?? "", trainId: m?.task.trainId ?? "", action: m?.task.action ?? "", role: "builder" },
    };
  }

  override getSystemPrompt(): string {
    return AGENT_SYSTEM_PROMPT;
  }

  /** The Worker Loader used by verify (overridable in tests). */
  protected loader(): LoaderLike | undefined {
    return this.env.LOADER as unknown as LoaderLike | undefined;
  }

  override getTools(): ToolSet {
    return droneTools({ snapshot: () => this.snapshot(), base: () => this.base(), loader: this.loader(), state: this.toolState });
  }

  override beforeTurn(): TurnConfig {
    const finished: StopCondition<ToolSet> = () => this.toolState.get().finish !== null;
    const overBudget: StopCondition<ToolSet> = ({ steps }) => steps.reduce((n, s) => n + (s.usage?.inputTokens ?? 0), 0) > AGENT_INPUT_TOKEN_BUDGET;
    return { maxSteps: AGENT_MAX_STEPS, stopWhen: [finished, overBudget] };
  }

  override onStepFinish(ctx: StepContext): void {
    const u = this.kvGet<AgentUsage>("usage") ?? EMPTY_USAGE;
    this.kvPut("usage", {
      inputTokens: u.inputTokens + (ctx.usage?.inputTokens ?? 0),
      outputTokens: u.outputTokens + (ctx.usage?.outputTokens ?? 0),
      steps: u.steps + 1,
    } satisfies AgentUsage);
  }

  // ── workspace helpers ────────────────────────────────────────────────

  async snapshot(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const f of await this.workspace.glob("/**")) {
      if (f.type !== "file") continue;
      const c = await this.workspace.readFile(f.path);
      if (c != null) out[f.path.replace(/^\/+/, "")] = c;
    }
    return out;
  }

  private async seed(input: AgentBuildInput): Promise<void> {
    const sql = this.db();
    for (const [path, content] of Object.entries(input.base)) {
      if (content.length > MAX_SEED_FILE_CHARS) continue;
      await this.workspace.writeFile(`/${path}`, content);
      sql.exec("INSERT OR REPLACE INTO drone_base (path, content) VALUES (?, ?)", path, content);
    }
    this.baseCache = null;
    // Written last: its presence means "seeded" (a crash mid-seed re-seeds on the retry).
    this.kvPut("meta", { model: input.model, task: input.task, skipCache: input.skipCache } satisfies RunMeta);
  }

  // ── RPC ──────────────────────────────────────────────────────────────

  /** Seed (once), submit the task (idempotent), wait for the turn, and report from durable state. */
  async build(input: AgentBuildInput): Promise<AgentBuildResult> {
    const deadline = Date.now() + Math.max(0, input.timeoutMs);
    if (this.meta() === null) await this.seed(input);

    const sub = await this.submitMessages(
      [{ id: `task-${input.idempotencyKey}`, role: "user", parts: [{ type: "text", text: agentUserMessage(input.task) }] }],
      { idempotencyKey: input.idempotencyKey },
    );
    const reattached = !sub.accepted;

    let status: string = sub.status;
    let error: string | undefined = sub.error;
    while (!TERMINAL.has(status) && Date.now() < deadline) {
      try {
        const r = await this.waitForSubmission(sub.submissionId, { timeoutMs: Math.max(1, deadline - Date.now()) });
        if (!r) {
          status = "error";
          error = "submission disappeared";
          break;
        }
        status = r.status;
        error = r.error;
      } catch {
        // The wait lives in memory and rejects if the object restarted; the submission is durable.
        await new Promise((res) => setTimeout(res, 500));
        const r = await this.inspectSubmission(sub.submissionId);
        if (r) {
          status = r.status;
          error = r.error;
        }
      }
    }
    let final: AgentRunStatus;
    if (TERMINAL.has(status)) final = status as AgentRunStatus;
    else {
      await this.cancelSubmission(sub.submissionId, "drone wall-time budget exhausted").catch(() => undefined);
      final = "timeout";
      error = `no finish within ${Math.round(input.timeoutMs / 1000)}s`;
    }
    return this.collect(final, error, reattached);
  }

  private async collect(status: AgentRunStatus, error: string | undefined, reattached: boolean): Promise<AgentBuildResult> {
    const messages = await this.getMessages();
    const parts = messages.flatMap((m) => m.parts as unknown as ToolPartLike[]);
    const tools = this.toolState.get();
    return {
      status,
      ...(error ? { error: error.slice(0, 500) } : {}),
      files: await this.snapshot(),
      finish: tools.finish,
      lastVerify: tools.lastVerify,
      trace: traceFromParts(parts),
      usage: this.kvGet<AgentUsage>("usage") ?? EMPTY_USAGE,
      reattached,
    };
  }
}
