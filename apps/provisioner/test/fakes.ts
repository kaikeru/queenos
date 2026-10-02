/** In-memory stand-ins for Artifacts and the Queen. */
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import type { ProvisionCommand, ProvisionResult } from "@queenos/queen-types";
import type { ArtifactsPort, ForkResult, ProvisionerPorts, QueenPort } from "../src/ports";
import type { StepRunner } from "../src/orchestrate";

export const artifactsError = (code: string) => Object.assign(new Error(code), { name: "ArtifactsError", code });

export class FakeArtifactsPort implements ArtifactsPort {
  readonly calls: string[] = [];
  forkError: Error | null = null;
  /** Fail the first N fork attempts (transient). */
  transientFailures = 0;
  existing = new Set<string>();

  async forkTrain(source: string, name: string): Promise<ForkResult> {
    this.calls.push(`fork:${source}->${name}`);
    if (this.transientFailures > 0) {
      this.transientFailures--;
      throw new Error("socket hang up");
    }
    if (this.forkError) throw this.forkError;
    return { artifactRepo: name, baseSha: "a".repeat(40) };
  }

  async deleteRepo(name: string): Promise<boolean> {
    this.calls.push(`delete:${name}`);
    return this.existing.delete(name);
  }
}

export class FakeQueen implements QueenPort {
  readonly results: ProvisionResult[] = [];
  readonly hives: string[] = [];
  error: Error | null = null;
  async reportProvisionResult(input: ProvisionResult) {
    if (this.error) throw this.error;
    this.results.push(input);
    return { outcome: "applied" };
  }
}

export class FakeWorld {
  readonly artifacts = new FakeArtifactsPort();
  readonly queen = new FakeQueen();
  readonly queenHives: string[] = [];
  ports(): ProvisionerPorts {
    return {
      artifacts: this.artifacts,
      queen: (hive) => {
        this.queenHives.push(hive);
        return this.queen;
      },
    };
  }
}

/** Step runner that executes inline, emulating Workflows retries (no delays). */
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
        if (e instanceof NonRetryableError || attempt > limit) {
          this.log.push({ name, attempts: attempt, ok: false });
          throw e;
        }
      }
    }
  }
  async sleep(): Promise<void> {}
}

export const fork = (o: Partial<Extract<ProvisionCommand, { op: "FORK" }>> = {}): ProvisionCommand => ({
  op: "FORK",
  commandId: "cmd-1",
  hive: "hive",
  trainId: "train-1",
  sourceRepo: "hive",
  forkName: "hive-train-aaaaaaaaaaaa",
  ...o,
});

export const del = (o: Partial<Extract<ProvisionCommand, { op: "DELETE" }>> = {}): ProvisionCommand => ({
  op: "DELETE",
  commandId: "cmd-2",
  hive: "hive",
  trainId: "train-1",
  repo: "hive-train-aaaaaaaaaaaa",
  ...o,
});

let current: FakeWorld | null = null;
export const setWorld = (w: FakeWorld | null) => void (current = w);
export function currentWorld(): FakeWorld {
  if (!current) throw new Error("no fake world installed (setWorld)");
  return current;
}
