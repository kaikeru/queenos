/** In-memory stand-ins for Artifacts, git, Cloudflare and the Queen. */
import { NonRetryableError } from "cloudflare:workflows";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { CloudflareApiError, type DeploymentInfo, type DeploymentVersion, type PreviewDeploymentInput, type PreviewInfo, type WorkerVersionInput } from "@queenos/hive-kit";
import type { DeployCommand, DeployResult } from "@queenos/queen-types";
import type { StepRunner } from "../src/orchestrate";
import type { ArtifactsPort, CloneRequest, CloudflareApi, CloudflareCredentials, CredentialsPort, GitPort, GitSession, HeraldPorts, QueenPort, RepoAccess } from "../src/ports";

export const SHA = "c".repeat(40);
export const TOKEN = "cf-token-SECRET";
export const TRAIN = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
export const PREVIEW = "t-0a1b2c3d4e5f";

export const TEMPLATE_FILES: Record<string, string> = {
  ".queen/deploy.json": JSON.stringify({ main: "src/index.js", compatibility_date: "2026-10-02" }),
  "src/index.js": 'import { features } from "./features/index.js";\nexport default { fetch: () => Response.json({ features }) };\n',
  "src/features/index.js": "export const features = [];\n",
  "README.md": "# not a module\n",
  "test/x.js": "// not under src/\n",
};

export class FakeArtifacts implements ArtifactsPort {
  readonly calls: { repo: string; scope: string }[] = [];
  async access(repo: string, scope: "read" | "write"): Promise<RepoAccess> {
    this.calls.push({ repo, scope });
    return { remote: `https://acct.artifacts.cloudflare.net/git/queenos/${repo}.git`, token: "art_v1_secret" };
  }
}

export class FakeGit implements GitPort {
  readonly clones: CloneRequest[] = [];
  files: Record<string, string> = TEMPLATE_FILES;
  headOid = SHA;
  async clone(req: CloneRequest): Promise<GitSession> {
    this.clones.push(req);
    const files = this.files;
    const oid = this.headOid;
    return {
      head: async () => ({ oid, message: "", parents: [], tree: "", author: { name: "", email: "", timestamp: 0 } }),
      listFiles: async () => Object.keys(files),
      readFiles: async (paths?: string[]) => Object.fromEntries((paths ?? Object.keys(files)).filter((p) => p in files).map((p) => [p, files[p]!])),
    };
  }
}

export class FakeCredentials implements CredentialsPort {
  calls = 0;
  readonly requests: { hive: string; purpose?: string }[] = [];
  async cloudflare(hive: string, purpose?: string): Promise<CloudflareCredentials> {
    this.calls++;
    this.requests.push({ hive, ...(purpose ? { purpose } : {}) });
    return { accountId: "acct-test", token: TOKEN };
  }
}

export class FakeCloudflare implements CloudflareApi {
  readonly calls: string[] = [];
  readonly deployments: { worker: string; previewId: string; input: PreviewDeploymentInput }[] = [];
  readonly previews = new Map<string, PreviewInfo>();
  workerExists = false;
  /** Next REST failure, by method name. */
  failWith: { method: string; error: Error } | null = null;
  noUrls = false;

  private maybeFail(method: string) {
    if (this.failWith?.method === method) throw this.failWith.error;
  }

  async ensureWorker(name: string) {
    this.calls.push(`ensureWorker:${name}`);
    this.maybeFail("ensureWorker");
    const created = !this.workerExists;
    this.workerExists = true;
    return { created };
  }
  async getPreview(worker: string, name: string) {
    this.calls.push(`getPreview:${worker}/${name}`);
    this.maybeFail("getPreview");
    return this.previews.get(name) ?? null;
  }
  async createPreview(worker: string, name: string) {
    this.calls.push(`createPreview:${worker}/${name}`);
    this.maybeFail("createPreview");
    const info = { id: `id-${name}`, name, urls: this.noUrls ? [] : [`https://${name}-${worker}.sub.workers.dev`] };
    this.previews.set(name, info);
    return info;
  }
  async deployPreview(worker: string, previewId: string, input: PreviewDeploymentInput) {
    this.calls.push(`deployPreview:${worker}/${previewId}`);
    this.maybeFail("deployPreview");
    this.deployments.push({ worker, previewId, input });
    return { id: `dep-${this.deployments.length}`, urls: this.noUrls ? [] : [`https://dep${this.deployments.length}-${worker}.sub.workers.dev`] };
  }
  /** Per-script deployment history, newest first (as the real API lists it). */
  readonly scriptDeployments = new Map<string, DeploymentInfo[]>();
  readonly uploads: { script: string; input: WorkerVersionInput; versionId: string }[] = [];
  readonly created: { script: string; versions: DeploymentVersion[]; force: boolean }[] = [];
  /** Errors thrown by createDeployment, consumed one per call. */
  deploymentErrors: Error[] = [];

  async enableSubdomain(script: string) {
    this.calls.push(`enableSubdomain:${script}`);
    this.maybeFail("enableSubdomain");
  }
  async workerUrl(script: string) {
    this.calls.push(`workerUrl:${script}`);
    return `https://${script}.sub.workers.dev`;
  }
  async uploadVersion(script: string, input: WorkerVersionInput) {
    this.calls.push(`uploadVersion:${script}`);
    this.maybeFail("uploadVersion");
    const versionId = `ver-${this.uploads.length + 1}`;
    this.uploads.push({ script, input, versionId });
    return { versionId };
  }
  async createDeployment(script: string, versions: DeploymentVersion[], opts: { annotations?: Record<string, string>; force?: boolean } = {}) {
    this.calls.push(`createDeployment:${script}${opts.force ? ":force" : ""}`);
    this.maybeFail("createDeployment");
    const err = this.deploymentErrors.shift();
    if (err) throw err;
    this.created.push({ script, versions, force: !!opts.force });
    const list = this.scriptDeployments.get(script) ?? [];
    const id = `dep-${this.created.length}`;
    list.unshift({ id, createdOn: "", versions });
    this.scriptDeployments.set(script, list);
    return { id };
  }
  async getCurrentDeployment(script: string) {
    this.calls.push(`getCurrentDeployment:${script}`);
    this.maybeFail("getCurrentDeployment");
    return this.scriptDeployments.get(script)?.[0] ?? null;
  }
  async deletePreview(worker: string, name: string) {
    this.calls.push(`deletePreview:${worker}/${name}`);
    this.maybeFail("deletePreview");
    return this.previews.delete(name);
  }
}

export class FakeQueen implements QueenPort {
  readonly results: DeployResult[] = [];
  error: Error | null = null;
  async reportDeployResult(input: DeployResult) {
    if (this.error) throw this.error;
    this.results.push(input);
    return { outcome: "applied" };
  }
}

export class FakeWorld {
  readonly artifacts = new FakeArtifacts();
  readonly git = new FakeGit();
  readonly credentials = new FakeCredentials();
  readonly cloudflare = new FakeCloudflare();
  readonly queen = new FakeQueen();
  readonly queenHives: string[] = [];
  ports(): HeraldPorts {
    return {
      artifacts: this.artifacts,
      git: this.git,
      credentials: this.credentials,
      cloudflare: () => this.cloudflare,
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
  /** Every step result, serialized: tests assert no secret ever lands here. */
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
        if (e instanceof NonRetryableError || attempt > limit) {
          this.log.push({ name, attempts: attempt, ok: false });
          throw e;
        }
      }
    }
  }
  async sleep(): Promise<void> {}
}

export const apiError = (status: number, code: number, retryable = false, message = "api error") =>
  new CloudflareApiError(`POST /x failed (HTTP ${status}): ${code}: ${message}`, status, [code], retryable, "POST /x");

export const deploy = (o: Partial<Extract<DeployCommand, { op: "DEPLOY" }>> = {}): DeployCommand => ({
  op: "DEPLOY",
  commandId: "cmd-1",
  hive: "My Hive",
  environment: "preview",
  trainId: TRAIN,
  artifactRepo: "hive-train-aaaaaaaaaaaa",
  commitSha: SHA,
  ...o,
});

export const teardown = (o: Partial<Extract<DeployCommand, { op: "TEARDOWN" }>> = {}): DeployCommand => ({
  op: "TEARDOWN",
  commandId: "cmd-2",
  hive: "My Hive",
  environment: "preview",
  trainId: TRAIN,
  ...o,
});

let current: FakeWorld | null = null;
export const setWorld = (w: FakeWorld | null) => void (current = w);
export function currentWorld(): FakeWorld {
  if (!current) throw new Error("no fake world installed (setWorld)");
  return current;
}
