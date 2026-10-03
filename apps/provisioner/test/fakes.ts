/** In-memory stand-ins for Artifacts and the Queen. */
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { initRepo, type RemoteSpec } from "@queenos/hive-kit";
import type { HiveCreatedResult, ProvisionCommand, ProvisionResult } from "@queenos/queen-types";
import type { ArtifactsPort, ForkResult, GenesisPort, GitPort, ProvisionerPorts, QueenPort, RepoAccess, SeedSession } from "../src/ports";
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

  /** hive -> commits pushed to main (newest first), as the fake remote sees them. */
  readonly mains = new Map<string, { hash: string; message: string }[]>();
  /** Fail the first N ensureRepo attempts (transient). */
  ensureFailures = 0;

  async ensureRepo(name: string): Promise<void> {
    this.calls.push(`ensure:${name}`);
    if (this.ensureFailures > 0) {
      this.ensureFailures--;
      throw new Error("socket hang up");
    }
    if (this.existing.has(name)) return; // ALREADY_EXISTS is success
    this.existing.add(name);
  }

  async access(repo: string, scope: "read" | "write"): Promise<RepoAccess> {
    this.calls.push(`access:${repo}:${scope}`);
    return { remote: `https://fake.artifacts/git/${repo}.git`, token: "art_v2_x_FAKE" };
  }

  async findSeed(repo: string): Promise<string | null> {
    this.calls.push(`findSeed:${repo}`);
    return this.mains.get(repo)?.find((c) => /^Queen-Genesis: \S+/m.test(c.message))?.hash ?? null;
  }
}

/** Real isomorphic-git over MemFS; only the network push is replaced by a record on the fake remote. */
export class FakeGitPort implements GitPort {
  readonly pushes: { url: string; oid: string }[] = [];
  readonly files: Record<string, string>[] = [];
  /** Fail the first N pushes (transient). */
  pushFailures = 0;
  constructor(private readonly artifacts: FakeArtifactsPort) {}

  async init(remote: RemoteSpec): Promise<SeedSession> {
    const repo = await initRepo({ remote, defaultBranch: "main" });
    return {
      writeFiles: (c) => repo.writeFiles(c),
      commitAll: async (i) => {
        const oid = await repo.commitAll(i);
        this.files.push(await repo.readFiles());
        return oid;
      },
      push: async (i) => {
        if (this.pushFailures > 0) {
          this.pushFailures--;
          throw new Error("socket hang up");
        }
        const head = (await repo.head())!;
        const hive = remote.url.split("/").pop()!.replace(/\.git$/, "");
        this.pushes.push({ url: remote.url, oid: head.oid });
        this.artifacts.mains.set(hive, [{ hash: head.oid, message: head.message }, ...(this.artifacts.mains.get(hive) ?? [])]);
        return { ref: i.ref, remoteRef: i.remoteRef ?? i.ref, oid: head.oid };
      },
    };
  }
}

export class FakeGenesis implements GenesisPort {
  readonly results: HiveCreatedResult[] = [];
  error: Error | null = null;
  async reportHiveCreated(input: HiveCreatedResult) {
    if (this.error) throw this.error;
    this.results.push(input);
    return { outcome: "applied" };
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
  readonly git = new FakeGitPort(this.artifacts);
  readonly genesis = new FakeGenesis();
  readonly queenHives: string[] = [];
  ports(): ProvisionerPorts {
    return {
      artifacts: this.artifacts,
      queen: (hive) => {
        this.queenHives.push(hive);
        return this.queen;
      },
      git: this.git,
      genesis: () => this.genesis,
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

export const createHive = (o: Partial<Extract<ProvisionCommand, { op: "CREATE_HIVE" }>> = {}): ProvisionCommand => ({
  op: "CREATE_HIVE",
  commandId: "cmd-3",
  hive: "my-hive",
  template: "worker-starter",
  charterJson: JSON.stringify({ version: 1, hive: "my-hive", name: "My Hive" }),
  ...o,
});
