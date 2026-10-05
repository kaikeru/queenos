/** In-memory stand-ins for the repo, LLM, vector memory and the Queen. */
import type { WorkflowStepConfig } from "cloudflare:workers";
import type { AnalyticsPoint, OracleCommand, OracleResult, SimilarItem } from "@queenos/queen-types";
import type { CompletionRequest, CompletionResult } from "@queenos/hive-kit";
import { AiGatewayError } from "@queenos/hive-kit";
import type { LlmPort, MemoryPort, OraclePorts, QueenPort, RepoPort } from "../src/ports";
import type { StepRunner } from "../src/orchestrate";

export class FakeRepo implements RepoPort {
  files: string[] = ["src/index.js", "src/features/index.js", "package.json"];
  error: Error | null = null;
  calls: string[] = [];
  async listFiles(hive: string): Promise<string[]> {
    this.calls.push(hive);
    if (this.error) throw this.error;
    return this.files;
  }
}

export class FakeLlm implements LlmPort {
  /** One entry per call: text, or an Error to throw. The last entry repeats. */
  script: (string | Error)[] = [];
  readonly requests: CompletionRequest[] = [];
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    const next = this.script[Math.min(this.requests.length - 1, this.script.length - 1)] ?? "";
    if (next instanceof Error) throw next;
    return { text: next, model: req.model, usage: { inputTokens: 100, outputTokens: 50 } };
  }
}

export const retryable = () => new AiGatewayError("503 overloaded", 503, true);
export const permanent = () => new AiGatewayError("400 bad request", 400, false);

export class FakeMemory implements MemoryPort {
  similar: SimilarItem[][] | SimilarItem[] = [];
  findError: Error | null = null;
  indexError: Error | null = null;
  readonly finds: { namespace: string; texts: string[]; opts: unknown }[] = [];
  readonly indexed: { namespace: string; items: { id: string; text: string; title?: string }[] }[] = [];
  async findSimilarItems(namespace: string, texts: string[], opts?: unknown): Promise<SimilarItem[][]> {
    this.finds.push({ namespace, texts, opts });
    if (this.findError) throw this.findError;
    return texts.map((_, n) => (Array.isArray(this.similar[0]) ? ((this.similar as SimilarItem[][])[n] ?? []) : (this.similar as SimilarItem[])));
  }
  async indexItems(namespace: string, items: { id: string; text: string; title?: string }[]): Promise<void> {
    if (this.indexError) throw this.indexError;
    this.indexed.push({ namespace, items });
  }
}

export class FakeQueen implements QueenPort {
  readonly results: OracleResult[] = [];
  error: Error | null = null;
  async reportOracleResult(r: OracleResult): Promise<unknown> {
    if (this.error) throw this.error;
    this.results.push(r);
    return { outcome: "applied" };
  }
}

export class FakeWorld {
  readonly repo = new FakeRepo();
  readonly llm = new FakeLlm();
  readonly memory = new FakeMemory();
  readonly queen = new FakeQueen();
  readonly queenHives: string[] = [];
  readonly metrics: AnalyticsPoint[] = [];
  withLlm = true;
  ports(): OraclePorts {
    return {
      repo: this.repo,
      llm: this.withLlm ? this.llm : null,
      memory: this.memory,
      queen: (hive) => (this.queenHives.push(hive), this.queen),
      metric: (p) => void this.metrics.push(p),
    };
  }
}

/** Step runner that runs inline, emulating Workflows retries (no delays). */
export class InlineSteps implements StepRunner {
  readonly log: { name: string; attempts: number; ok: boolean }[] = [];
  async do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T> {
    const limit = config.retries?.limit ?? 5;
    for (let attempt = 1; ; attempt++) {
      try {
        const value = await fn();
        this.log.push({ name, attempts: attempt, ok: true });
        return structuredClone(value);
      } catch (e) {
        if (attempt > limit) {
          this.log.push({ name, attempts: attempt, ok: false });
          throw e;
        }
      }
    }
  }
}

let world: FakeWorld | null = null;
export const setWorld = (w: FakeWorld | null) => void (world = w);
export function currentWorld(): FakeWorld {
  if (!world) throw new Error("no FakeWorld set");
  return world;
}

export const MODEL = { model: "@cf/test/planner", tier: "fast", role: "planner", reason: "test", fallbacks: ["@cf/test/fallback"] } as const;

export function decomposeCmd(over: Partial<Extract<OracleCommand, { op: "DECOMPOSE" }>> = {}): OracleCommand {
  return {
    op: "DECOMPOSE",
    commandId: "g1-decompose-1",
    hive: "demo",
    itemId: "g1",
    promptText: "Add a footer and a /about page",
    model: { ...MODEL, fallbacks: [...MODEL.fallbacks] },
    openItems: [{ itemId: "i9", title: "Fix header", status: "READY", paths: ["src/header.js"] }],
    limits: { maxChildren: 4 },
    ...over,
  };
}

export function triageCmd(): OracleCommand {
  return { op: "TRIAGE", commandId: "b1-triage-1", hive: "demo", itemId: "b1", kind: "bug", title: "Header overlaps", body: "On mobile the header overlaps." };
}
