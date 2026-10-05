/**
 * Option (b): the same task on @cloudflare/think. A Think DO with its built-in SQLite workspace
 * (workspace tools auto-merged), plus our verify/finish tools, driven one-shot over RPC.
 */
import { Think, type StepContext } from "@cloudflare/think";
import { tool } from "ai";
import { z } from "zod";
import { TOOL_SYSTEM_PROMPT } from "./prompt";
import { verifyWorker, type VerifyResult } from "./verify";

export class SpikeThink extends Think<Env> {
  override maxSteps = 16;
  override workspaceBash = false;
  private modelId = "@cf/moonshotai/kimi-k2.7-code";
  private steps: { ms: number; tools: string[]; inputTokens: number; outputTokens: number; finishReason: string }[] = [];
  private lastStepAt = 0;
  private verifyCalls: VerifyResult[] = [];

  override getModel() {
    return this.modelId;
  }
  private skipCache = false;
  override getGateway() {
    return { id: "queenos", skipCache: this.skipCache };
  }
  override getSystemPrompt() {
    return TOOL_SYSTEM_PROMPT;
  }
  override getTools() {
    return {
      verify: tool({
        description: "Load the current workspace as a Worker in an isolated sandbox (no network) and GET / and /health plus any given paths.",
        inputSchema: z.object({ paths: z.array(z.string()).max(5).optional() }),
        execute: async ({ paths }) => {
          const r = await verifyWorker(this.env.LOADER, await this.snapshot(), [...new Set(["/", "/health", ...(paths ?? [])])]);
          this.verifyCalls.push(r);
          return r;
        },
      }),
      finish: tool({
        description: "Call once when the change is done and verified. Ends the task.",
        inputSchema: z.object({ summary: z.string().max(500), reasoningSteps: z.array(z.string().max(300)).min(1).max(6) }),
        execute: async () => ({ ok: true }),
      }),
    };
  }
  override onStepFinish(ctx: StepContext) {
    const now = Date.now();
    this.steps.push({
      ms: now - this.lastStepAt,
      tools: (ctx.toolCalls ?? []).map((c) => c.toolName),
      inputTokens: ctx.usage?.inputTokens ?? 0,
      outputTokens: ctx.usage?.outputTokens ?? 0,
      finishReason: String(ctx.finishReason),
    });
    this.lastStepAt = now;
  }

  async snapshot(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const f of await this.workspace.glob("/**")) {
      if (f.type !== "file") continue;
      const c = await this.workspace.readFile(f.path);
      if (c != null) out[f.path.replace(/^\//, "")] = c;
    }
    return out;
  }

  /** One-shot task: seed the workspace, run one turn (up to maxSteps tool rounds), return the result. */
  async runTask(input: { model: string; files: Record<string, string>; task: string; skipCache?: boolean }) {
    this.modelId = input.model;
    this.skipCache = !!input.skipCache;
    this.steps = [];
    this.verifyCalls = [];
    for (const [p, c] of Object.entries(input.files)) await this.workspace.writeFile(`/${p}`, c);
    const t0 = Date.now();
    this.lastStepAt = t0;
    const res = await this.saveMessages([{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: `<request>\n${input.task}\n</request>` }] }]);
    const loopMs = Date.now() - t0;
    const messages = await this.getMessages();
    const toolParts = messages.flatMap((m) =>
      m.parts
        .filter((p) => p.type.startsWith("tool-"))
        .map((p) => {
          const q = p as { type: string; input?: unknown; state?: string };
          return { tool: q.type.slice(5), state: q.state, input: JSON.stringify(q.input ?? null).slice(0, 200) };
        }),
    );
    const finish = toolParts.find((t) => t.tool === "finish");
    return { saveResult: res, loopMs, steps: this.steps, toolParts, finished: finish ?? null, files: await this.snapshot(), verifyCalls: this.verifyCalls };
  }
}
