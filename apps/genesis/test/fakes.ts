/** In-memory stand-ins for every cross-script binding. */
import type { CompletionRequest, CompletionResult } from "@queenos/hive-kit";
import type { MergeTrain, Project, ProvisionCommand, VaultStatus } from "@queenos/queen-types";
import type { GenesisConfig, GenesisPorts, QueenPort } from "../src/ports";

export class FakeRegistry {
  readonly projects = new Map<string, Project>();
  readonly calls: string[] = [];
  conflict = false;
  async register(i: { hive: string; name: string; description: string; createdBy: string }): Promise<Project> {
    this.calls.push(`register:${i.hive}`);
    if (this.conflict) throw new Error(`CONFLICT: hive ${i.hive} already exists`);
    const p: Project = {
      ...i,
      status: "ONBOARDING",
      createdAt: 1,
      updatedAt: 1,
      urls: { prod: null, staging: null, preview: null },
    };
    this.projects.set(i.hive, p);
    return p;
  }
  async update(hive: string, patch: { status?: Project["status"]; name?: string; description?: string; urls?: Partial<Project["urls"]> }): Promise<Project> {
    this.calls.push(`update:${hive}:${JSON.stringify(patch)}`);
    const cur = this.projects.get(hive);
    if (!cur) throw new Error(`NOT_FOUND: hive ${hive}`);
    const next = { ...cur, ...patch, urls: { ...cur.urls, ...(patch.urls ?? {}) } } as Project;
    this.projects.set(hive, next);
    return next;
  }
}

export class FakeVault {
  connected = false;
  failing = false;
  async status(hive: string): Promise<VaultStatus> {
    if (this.failing) throw new Error("vault down");
    return {
      hive,
      secret: "cloudflare",
      connected: this.connected,
      accountId: this.connected ? "a".repeat(32) : null,
      verifiedAt: this.connected ? 1 : null,
      checks: [],
    };
  }
}

export class FakeQueen implements QueenPort {
  readonly prompts: { namespace: string; promptText: string }[] = [];
  trains: MergeTrain[] = [];
  promptError: Error | null = null;
  snapshotError: Error | null = null;
  async submitPrompt(input: { namespace: string; promptText: string }) {
    if (this.promptError) throw this.promptError;
    this.prompts.push(input);
    return { promptId: `p-${this.prompts.length}` };
  }
  async getSnapshot() {
    if (this.snapshotError) throw this.snapshotError;
    return { trains: this.trains };
  }
}

export class FakeLlm {
  readonly requests: CompletionRequest[] = [];
  reply = JSON.stringify({ reply: "What routes do you need?", charter: { description: "A todo app" } });
  fail = false;
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    if (this.fail) throw new Error("gateway 500");
    return { text: this.reply, model: req.model };
  }
}

export const train = (o: Partial<MergeTrain> = {}): MergeTrain => ({
  trainId: "t1",
  baseSha: "b".repeat(40),
  includedPrompts: ["p-1"],
  artifactRepo: "hive-train-1",
  status: "TESTING" as MergeTrain["status"],
  createdAt: 1,
  previewUrl: null,
  ...o,
});

export class FakeWorld {
  readonly registry = new FakeRegistry();
  readonly vault = new FakeVault();
  readonly queen = new FakeQueen();
  readonly llm = new FakeLlm();
  readonly commands: Extract<ProvisionCommand, { op: "CREATE_HIVE" }>[] = [];
  dispatchError: Error | null = null;
  clock = Date.now();
  ids = 0;
  config: Partial<GenesisConfig> = {};
  ports(): GenesisPorts {
    return {
      registry: this.registry,
      vault: this.vault,
      queen: () => this.queen,
      provisioner: {
        createHive: async (cmd) => {
          if (this.dispatchError) throw this.dispatchError;
          this.commands.push(cmd);
        },
      },
      llm: this.llm,
      now: () => this.clock,
      randomId: () => `${(++this.ids).toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`,
    };
  }
}

let current: FakeWorld | null = null;
export const setWorld = (w: FakeWorld | null) => void (current = w);
export function currentWorld(): FakeWorld {
  if (!current) throw new Error("no fake world installed (setWorld)");
  return current;
}
