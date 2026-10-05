import {
  ProjectSchema,
  VaultStatusSchema,
  WizardStateSchema,
  type Charter,
  type Project,
  type VaultStatus,
  type WizardState,
} from "@queenos/queen-types";

export const AUTH_MESSAGE = "Not signed in: reload to sign in with Cloudflare Access";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export const isAuthError = (e: unknown): boolean => e instanceof ApiError && e.isAuth;

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError && e.isAuth) return AUTH_MESSAGE;
  return e instanceof Error ? e.message : String(e);
}

interface Parser<T> {
  parse(v: unknown): T;
}

async function request<T>(method: string, path: string, parser: Parser<T>, body?: unknown, credentials: RequestCredentials = "same-origin"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError("Could not reach the server. Check your connection and retry.", 0);
  }
  if (res.status === 401 || res.status === 403) throw new ApiError(AUTH_MESSAGE, res.status);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body (e.g. an Access login page)
    if (res.ok) throw new ApiError("Unexpected response from the server. Reload to sign in again.", res.status);
  }
  if (!res.ok) {
    const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
    const msg = typeof o.error === "string" ? o.error : typeof o.message === "string" ? o.message : `Request failed (${res.status})`;
    throw new ApiError(msg, res.status, json);
  }
  try {
    return parser.parse(json);
  } catch {
    throw new ApiError("The server returned an unexpected response.", res.status, json);
  }
}

const enc = encodeURIComponent;
const MeParser: Parser<{ email: string }> = {
  parse(v) {
    const e = (v as { email?: unknown } | null)?.email;
    if (typeof e !== "string") throw new Error("bad me");
    return { email: e };
  },
};
const UrlParser: Parser<{ url: string }> = {
  parse(v) {
    const u = (v as { url?: unknown } | null)?.url;
    if (typeof u !== "string") throw new Error("bad url");
    return { url: u };
  },
};
const ProjectsParser: Parser<Project[]> = { parse: (v) => ProjectSchema.array().parse(v) };

const AnyParser: Parser<unknown> = { parse: (v) => v };

export const api = {
  /** The edge adds the signed-in user's identity; we only need to send the cookie. */
  tapRelease: (hive: string, releaseId: string) =>
    request("POST", `/hives/${enc(hive)}/releases/${enc(releaseId)}/tap`, AnyParser, { releaseId }, "include"),
  me: () => request("GET", "/api/me", MeParser),
  projects: () => request("GET", "/api/projects", ProjectsParser),
  startGenesis: (hive: string, name: string) => request("POST", "/api/genesis", WizardStateSchema, { hive, name }),
  wizard: (hive: string) => request("GET", `/api/genesis/${enc(hive)}`, WizardStateSchema),
  sendMessage: (hive: string, text: string) => request("POST", `/api/genesis/${enc(hive)}/messages`, WizardStateSchema, { text }),
  confirmCharter: (hive: string, charter: Charter): Promise<WizardState> =>
    request("PUT", `/api/genesis/${enc(hive)}/charter`, WizardStateSchema, { charter }),
  tokenTemplate: () => request("GET", "/api/vault/token-template", UrlParser),
  connectCloudflare: (hive: string, accountId: string, apiToken: string): Promise<VaultStatus> =>
    request("POST", `/api/vault/${enc(hive)}/cloudflare`, VaultStatusSchema, { accountId, apiToken }),
  launch: (hive: string) => request("POST", `/api/genesis/${enc(hive)}/launch`, WizardStateSchema),
};
