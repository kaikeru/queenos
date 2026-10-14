/** Fake Cloudflare API and test hooks for the VaultNode seams. */
import type { CloudflareFetch } from "@queenos/hive-kit";
import type { KeyringEnv } from "../src/envelope";

export const ACCOUNT = "0123456789abcdef0123456789abcdef";
export const TOKEN = "cfTOKEN_s3cr3t_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
/** Public test KEKs (wrangler.jsonc env.test uses KEK_A). */
export const KEK_A = "aDa34S694+tlkxHCVBK4v/2ch8QuPU6yaLv97FcAGxk=";
export const KEK_B = "pODGoVSEFwgffO2nVdfWZNOebceHoA/n6fxUGeJmd4g=";

const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
const fail = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], result: null }, { status });

export interface FakeCloudflareOptions {
  /** HTTP status for /accounts/{id}/tokens/verify (200 = active). */
  accountVerify?: number;
  /** Status reported by a successful verify. */
  tokenStatus?: string;
  /** HTTP status for /user/tokens/verify (200 = active). */
  userVerify?: number;
  /** HTTP status for the write probe POST (200 = created). */
  write?: number;
  workerExists?: boolean;
  subdomain?: string | null;
  /** Make every error message echo the Authorization header (a hostile/buggy API). */
  echoToken?: boolean;
}

export class FakeCloudflare {
  readonly calls: { method: string; path: string; auth: string | null; body: string | null }[] = [];
  constructor(public opts: FakeCloudflareOptions = {}) {}

  readonly fetch: CloudflareFetch = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const method = init.method ?? "GET";
    const auth = new Headers(init.headers).get("authorization");
    this.calls.push({ method, path, auth, body: typeof init.body === "string" ? init.body : null });
    const o = this.opts;
    const err = (status: number, code: number, message: string) => fail(status, code, o.echoToken ? `${message} (got ${auth})` : message);

    if (method === "GET" && path === `/accounts/${ACCOUNT}/tokens/verify`) {
      const s = o.accountVerify ?? 200;
      return s === 200 ? ok({ id: "tok-1", status: o.tokenStatus ?? "active" }) : err(s, 1000, "Invalid API Token");
    }
    if (method === "GET" && path === "/user/tokens/verify") {
      const s = o.userVerify ?? 401;
      return s === 200 ? ok({ id: "tok-u", status: o.tokenStatus ?? "active" }) : err(s, 1000, "Invalid API Token");
    }
    const worker = /^\/accounts\/[0-9a-f]{32}\/workers\/workers\/([^/]+)$/.exec(path);
    if (method === "GET" && worker) return o.workerExists ? ok({ id: "w1", name: worker[1] }) : err(404, 10007, "workers.api.error.script_not_found");
    if (method === "POST" && path === `/accounts/${ACCOUNT}/workers/workers`) {
      const s = o.write ?? 200;
      return s === 200 ? ok({ id: "w1", name: JSON.parse(String(init.body)).name }) : err(s, 10000, "Authentication error");
    }
    if (method === "GET" && path === `/accounts/${ACCOUNT}/workers/subdomain`) {
      return o.subdomain === null ? err(404, 10007, "no subdomain") : ok({ subdomain: o.subdomain ?? "example" });
    }
    return err(404, 7003, `no route for ${method} ${path}`);
  };
}

// ── hooks read by test/worker.ts (tests and DOs share one isolate) ─────────

export const hooks: { cloudflare: FakeCloudflare; keys: KeyringEnv | null } = { cloudflare: new FakeCloudflare(), keys: null };

export function resetHooks(opts: FakeCloudflareOptions = {}): FakeCloudflare {
  hooks.cloudflare = new FakeCloudflare(opts);
  hooks.keys = null;
  return hooks.cloudflare;
}
