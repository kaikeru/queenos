/**
 * Fetch-only Cloudflare REST client for deploys (docs/deploy-discovery.md §1-2).
 *
 * Request shapes are copied from wrangler 4.147's bundled client
 * (`deploy-helpers/src/preview/api.ts`). No Node built-ins: multipart bodies
 * use the web `FormData`/`File`, and `fetch` is injectable for tests.
 *
 * The token is only ever placed in the `Authorization` header. It is never
 * included in an error message, a `path`, or a response body snippet.
 */

export const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com/client/v4";

export type CloudflareFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Cloudflare API error codes that mean "that Preview does not exist". */
export const PREVIEW_NOT_FOUND_CODES: readonly number[] = [10025, 10222];
/** Cloudflare API error codes that mean "that Worker does not exist". */
export const WORKER_NOT_FOUND_CODES: readonly number[] = [10007, 10090];

export class CloudflareApiError extends Error {
  override readonly name = "CloudflareApiError";
  constructor(
    message: string,
    /** HTTP status (0 for network failures). */
    readonly status: number,
    /** API error codes from the `errors[]` envelope. */
    readonly codes: number[],
    /** 408/429/5xx and network failures are worth retrying; other 4xx are not. */
    readonly retryable: boolean,
    /** `METHOD /path` (no query string, no credentials). */
    readonly endpoint: string,
  ) {
    super(message);
  }

  /** HTTP 404 or an API code for a missing Worker/Preview. */
  get notFound(): boolean {
    return this.status === 404 || this.codes.some((c) => PREVIEW_NOT_FOUND_CODES.includes(c) || WORKER_NOT_FOUND_CODES.includes(c));
  }
}

export interface CloudflareClientOptions {
  accountId: string;
  /** API token (account-owned or user). Never logged. */
  token: string;
  /** Injectable for tests. Default: global fetch. */
  fetch?: CloudflareFetch;
  /** Override the API origin (tests). */
  origin?: string;
}

export interface TokenInfo {
  id: string;
  status: string;
  expiresOn?: string;
}

export interface WorkerInfo {
  id: string;
  name: string;
}

export interface DeployModule {
  /** Module name, e.g. `src/index.js`. Relative imports resolve against these names. */
  name: string;
  /** e.g. `application/javascript+module`. */
  contentType: string;
  content: string;
}

export const JS_MODULE_TYPE = "application/javascript+module";

export interface PreviewInfo {
  id: string;
  name: string;
  slug?: string;
  urls: string[];
}

export interface PreviewDeploymentInput {
  mainModule: string;
  modules: DeployModule[];
  compatibilityDate: string;
  compatibilityFlags?: string[];
  /** e.g. `{ "workers/commit_sha": sha, "workers/message": "…" }`. */
  annotations?: Record<string, string>;
  /** Plain-text env vars. */
  vars?: Record<string, string>;
}

export interface PreviewDeployment {
  id: string;
  urls: string[];
}

export interface WorkerVersionInput {
  mainModule: string;
  modules: DeployModule[];
  compatibilityDate: string;
  compatibilityFlags?: string[];
  annotations?: Record<string, string>;
  /** Inherit existing secret bindings (`keep_bindings`). */
  keepSecrets?: boolean;
}

export interface DeploymentVersion {
  versionId: string;
  percentage: number;
}

interface ApiEnvelope<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

const enc = encodeURIComponent;

export class CloudflareClient {
  readonly accountId: string;
  private readonly token: string;
  private readonly fetchFn: CloudflareFetch;
  private readonly origin: string;

  constructor(opts: CloudflareClientOptions) {
    if (!opts.accountId) throw new CloudflareApiError("accountId is required", 0, [], false, "init");
    if (!opts.token) throw new CloudflareApiError("API token is required", 0, [], false, "init");
    this.accountId = opts.accountId;
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.origin = opts.origin ?? CLOUDFLARE_API_ORIGIN;
  }

  // ── token ──────────────────────────────────────────────────────────────

  /**
   * `GET /accounts/{id}/tokens/verify`. Account-owned tokens fail
   * `/user/tokens/verify`, so this is the one to use.
   */
  async verifyToken(accountId: string = this.accountId): Promise<TokenInfo> {
    const r = await this.request<{ id: string; status: string; expires_on?: string }>("GET", `/accounts/${enc(accountId)}/tokens/verify`);
    return { id: r.id, status: r.status, ...(r.expires_on ? { expiresOn: r.expires_on } : {}) };
  }

  /** `GET /accounts/{id}/workers/subdomain`: the account's workers.dev subdomain. */
  async getWorkersSubdomain(): Promise<string> {
    const r = await this.request<{ subdomain: string }>("GET", `${this.acct()}/workers/subdomain`);
    return r.subdomain;
  }

  // ── parent Worker ──────────────────────────────────────────────────────

  /**
   * Create the parent Worker if it does not exist (Previews hang off it).
   * `POST /workers/workers {name, subdomain:{enabled, previews_enabled}}`.
   */
  async ensureWorker(name: string): Promise<{ created: boolean }> {
    try {
      await this.request("GET", `${this.acct()}/workers/workers/${enc(name)}`);
      return { created: false };
    } catch (e) {
      if (!(e instanceof CloudflareApiError && e.notFound)) throw e;
    }
    try {
      await this.request("POST", `${this.acct()}/workers/workers`, {
        json: { name, subdomain: { enabled: true, previews_enabled: true } },
      });
      return { created: true };
    } catch (e) {
      if (e instanceof CloudflareApiError && e.status === 409) return { created: false }; // raced
      throw e;
    }
  }

  async deleteWorker(name: string): Promise<boolean> {
    try {
      await this.request("DELETE", `${this.acct()}/workers/workers/${enc(name)}`);
      return true;
    } catch (e) {
      if (e instanceof CloudflareApiError && e.notFound) return false;
      throw e;
    }
  }

  // ── Worker Previews ────────────────────────────────────────────────────

  /** `GET …/workers/workers/{w}/previews/{name}`; null when missing. */
  async getPreview(worker: string, name: string): Promise<PreviewInfo | null> {
    try {
      return toPreview(await this.request("GET", this.previewPath(worker, name)));
    } catch (e) {
      if (e instanceof CloudflareApiError && e.notFound) return null;
      throw e;
    }
  }

  /** `POST …/previews {name}`. */
  async createPreview(worker: string, name: string): Promise<PreviewInfo> {
    return toPreview(await this.request("POST", `${this.acct()}/workers/workers/${enc(worker)}/previews`, { json: { name } }));
  }

  /**
   * `POST …/previews/{previewId}/deployments`: multipart `metadata` JSON plus one
   * `files` part per module (filename = module name, MIME = module type).
   * `previewId` is the Preview's `id` (wrangler passes `previewResource.id`).
   */
  async deployPreview(worker: string, previewId: string, input: PreviewDeploymentInput): Promise<PreviewDeployment> {
    const metadata: Record<string, unknown> = {
      main_module: input.mainModule,
      compatibility_date: input.compatibilityDate,
      ...(input.compatibilityFlags?.length ? { compatibility_flags: input.compatibilityFlags } : {}),
      ...(input.annotations && Object.keys(input.annotations).length ? { annotations: input.annotations } : {}),
      ...(input.vars && Object.keys(input.vars).length
        ? { env: Object.fromEntries(Object.entries(input.vars).map(([k, v]) => [k, { type: "plain_text", text: v }])) }
        : {}),
    };
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    for (const m of input.modules) form.append("files", new File([m.content], m.name, { type: m.contentType }));
    const r = await this.request<{ id: string; urls?: string[] }>("POST", `${this.previewPath(worker, previewId)}/deployments`, { form });
    return { id: r.id, urls: r.urls ?? [] };
  }

  /** `DELETE …/previews/{name}`; false when it did not exist. */
  async deletePreview(worker: string, name: string): Promise<boolean> {
    try {
      await this.request("DELETE", this.previewPath(worker, name));
      return true;
    } catch (e) {
      if (e instanceof CloudflareApiError && e.notFound) return false;
      throw e;
    }
  }

  // ── versions and deployments (P3: staging, canary, rollback) ───────────

  /**
   * `POST …/scripts/{s}/versions`: multipart `metadata` plus one part per module
   * (part name = module name). Returns the version id.
   */
  async uploadVersion(script: string, input: WorkerVersionInput): Promise<{ versionId: string }> {
    const metadata: Record<string, unknown> = {
      main_module: input.mainModule,
      compatibility_date: input.compatibilityDate,
      ...(input.compatibilityFlags?.length ? { compatibility_flags: input.compatibilityFlags } : {}),
      ...(input.annotations && Object.keys(input.annotations).length ? { annotations: input.annotations } : {}),
      ...(input.keepSecrets ? { keep_bindings: ["secret_text", "secret_key"] } : {}),
    };
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    for (const m of input.modules) form.append(m.name, new File([m.content], m.name, { type: m.contentType }));
    const r = await this.request<{ id: string }>("POST", `${this.acct()}/workers/scripts/${enc(script)}/versions`, {
      form,
      query: { bindings_inherit: "strict" },
    });
    return { versionId: r.id };
  }

  /**
   * `POST …/scripts/{s}/deployments {strategy:"percentage", versions}`.
   * Percentages must sum to 100; a deployment holds at most 2 versions.
   * `force` retries a rollback whose secrets changed.
   */
  async createDeployment(
    script: string,
    versions: DeploymentVersion[],
    opts: { annotations?: Record<string, string>; force?: boolean } = {},
  ): Promise<{ id: string }> {
    const sum = versions.reduce((n, v) => n + v.percentage, 0);
    if (versions.length < 1 || versions.length > 2 || Math.abs(sum - 100) > 1e-9) {
      throw new CloudflareApiError("a deployment needs 1-2 versions whose percentages sum to 100", 0, [], false, "createDeployment");
    }
    const r = await this.request<{ id: string }>("POST", `${this.acct()}/workers/scripts/${enc(script)}/deployments`, {
      json: {
        strategy: "percentage",
        versions: versions.map((v) => ({ version_id: v.versionId, percentage: v.percentage })),
        ...(opts.annotations ? { annotations: opts.annotations } : {}),
      },
      ...(opts.force ? { query: { force: "true" } } : {}),
    });
    return { id: r.id };
  }

  // ── plumbing ───────────────────────────────────────────────────────────

  private acct(): string {
    return `/accounts/${enc(this.accountId)}`;
  }

  private previewPath(worker: string, preview: string): string {
    return `${this.acct()}/workers/workers/${enc(worker)}/previews/${enc(preview)}`;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    opts: { json?: unknown; form?: FormData; query?: Record<string, string> } = {},
  ): Promise<T> {
    const endpoint = `${method} ${path}`;
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form; // fetch sets the multipart boundary
    }

    let res: Response;
    try {
      res = await this.fetchFn(`${this.origin}${path}${qs}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch (e) {
      throw new CloudflareApiError(`${endpoint}: network error: ${redact(String((e as Error)?.message ?? e), this.token)}`, 0, [], true, endpoint);
    }

    const text = await res.text().catch(() => "");
    let env: ApiEnvelope<T> | undefined;
    try {
      env = text ? (JSON.parse(text) as ApiEnvelope<T>) : undefined;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok || env?.success === false) {
      const codes = (env?.errors ?? []).map((x) => x.code).filter((c): c is number => typeof c === "number");
      const msgs = (env?.errors ?? []).map((x) => `${x.code ?? "?"}: ${x.message ?? ""}`).join("; ");
      const detail = msgs || redact(text.slice(0, 200), this.token) || res.statusText;
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      throw new CloudflareApiError(`${endpoint} failed (HTTP ${res.status}): ${detail}`, res.status, codes, retryable, endpoint);
    }
    return env?.result as T;
  }
}

function toPreview(r: unknown): PreviewInfo {
  const p = r as { id: string; name: string; slug?: string; urls?: string[] };
  return { id: p.id, name: p.name, ...(p.slug ? { slug: p.slug } : {}), urls: p.urls ?? [] };
}

function redact(s: string, token: string): string {
  return token ? s.split(token).join("[redacted]") : s;
}
