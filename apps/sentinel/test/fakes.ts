import type { WorkflowStepConfig } from "cloudflare:workers";
import type { SentinelCommandInput, SentinelVerdict } from "@queenos/queen-types";
import type { StepRunner } from "../src/orchestrate";
import type { QueenPort, SentinelPorts } from "../src/ports";

export interface Call {
  url: string;
  headers: Record<string, string>;
}

export type Responder = (call: Call, index: number) => { status: number; ms?: number } | "throw";

/** Fake prober + Queen. `ms` in a response is the reported latency. */
export class FakeWorld {
  /** Calls made by the readiness gate while `autoReady` is on (always 200). */
  readonly gateCalls: Call[] = [];
  readonly calls: Call[] = [];
  /**
   * On (default): the first 3 probes (the readiness gate) answer 200 and are kept out of
   * `calls`, so response indices and counts only describe measured traffic. Off: every
   * probe, gate included, goes to the responder and `calls`.
   */
  autoReady = true;
  readonly verdicts: SentinelVerdict[] = [];
  readonly hives: string[] = [];
  queenError: Error | null = null;
  queenFailures = 0;
  constructor(public responder: Responder = () => ({ status: 200, ms: 20 })) {}

  readonly queen: QueenPort = {
    reportSentinelVerdict: async (v) => {
      if (this.queenError) throw this.queenError;
      if (this.queenFailures > 0) {
        this.queenFailures--;
        throw new Error("transient");
      }
      this.verdicts.push(v);
      return { outcome: "applied" };
    },
  };

  ports(): SentinelPorts {
    return {
      probe: async (url, headers) => {
        const call = { url, headers };
        if (this.autoReady && this.gateCalls.length < 3 && this.calls.length === 0) {
          this.gateCalls.push(call);
          return { status: 200, ms: 20 };
        }
        const idx = this.calls.push(call) - 1;
        const r = this.responder(call, idx);
        if (r === "throw") return { status: null, ms: 5 };
        return { status: r.status, ms: r.ms ?? 20 };
      },
      queen: (hive) => {
        this.hives.push(hive);
        return this.queen;
      },
    };
  }
}

export class InlineSteps implements StepRunner {
  readonly log: { name: string; attempts: number; ok: boolean }[] = [];
  readonly sleeps: { name: string; ms: number }[] = [];
  readonly results: string[] = [];
  async do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T> {
    const limit = config.retries?.limit ?? 5;
    for (let attempt = 1; ; attempt++) {
      try {
        const value = await fn();
        this.log.push({ name, attempts: attempt, ok: true });
        this.results.push(JSON.stringify(value));
        return structuredClone(value);
      } catch (e) {
        if (attempt > limit) {
          this.log.push({ name, attempts: attempt, ok: false });
          throw e;
        }
      }
    }
  }
  async sleep(name: string, ms: number): Promise<void> {
    this.sleeps.push({ name, ms });
  }
}

export const staging = (over: Partial<SentinelCommandInput> = {}): SentinelCommandInput => ({
  commandId: "cmd-1",
  hive: "My Hive",
  releaseId: "rel-1",
  environment: "staging",
  scriptName: "my-hive-staging",
  url: "https://my-hive-staging.sub.workers.dev",
  minRequests: 60,
  windowSeconds: 30,
  ...over,
});

export const canary = (over: Partial<SentinelCommandInput> = {}): SentinelCommandInput => ({
  commandId: "cmd-2",
  hive: "My Hive",
  releaseId: "rel-1",
  environment: "canary",
  scriptName: "my-hive-app",
  url: "https://my-hive-app.sub.workers.dev",
  candidateVersionId: "cand-111",
  stableVersionId: "stab-222",
  canaryPercent: 10,
  minRequests: 60,
  windowSeconds: 30,
  ...over,
});

let current: FakeWorld | null = null;
export const setWorld = (w: FakeWorld | null) => void (current = w);
export function currentWorld(): FakeWorld {
  if (!current) throw new Error("no fake world installed (setWorld)");
  return current;
}
