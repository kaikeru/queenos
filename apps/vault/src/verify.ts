/**
 * Verify a Cloudflare credential before the Vault stores it
 * (docs/deploy-discovery.md §6 "Validation"):
 *   (a) the token is active: `GET /accounts/{id}/tokens/verify` (account-owned
 *       tokens fail `/user/tokens/verify`), falling back to `/user/tokens/verify`
 *       for a user token;
 *   (b) write probe: `ensureWorker("<hive>-app")`, the Herald's parent Worker
 *       for Previews (apps/herald workerNameFor), so the probe is useful work;
 *   (c) informational: the account's workers.dev subdomain (Preview URLs need it).
 *
 * Every detail string is redacted: it never contains the token, a bearer
 * header or any other long credential-like run, and is clipped to 300 chars.
 */
import { CLOUDFLARE_API_ORIGIN, CloudflareApiError, CloudflareClient, type CloudflareFetch } from "@queenos/hive-kit";

export interface CloudflareCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyOutcome {
  /** True when every required check passed. */
  ok: boolean;
  checks: CloudflareCheck[];
}

export const CHECK_TOKEN = "token active";
export const CHECK_WRITE = "can upload Workers";
export const CHECK_SUBDOMAIN = "workers.dev subdomain";
const MAX_DETAIL = 300;

/** The Herald's parent Worker for a hive slug (apps/herald `workerNameFor`). */
export const parentWorkerName = (hive: string) => `${hive}-app`;

/**
 * Remove anything that could be (part of) a credential: the token itself, a
 * `Bearer …` header value, and any run of 32+ token-alphabet chars other than
 * the `keep` values (the public account id and Worker name).
 */
export function redact(text: string, token: string, keep: readonly string[] = []): string {
  let s = token ? text.split(token).join("[redacted]") : text;
  s = s.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]");
  s = s.replace(/[A-Za-z0-9_-]{32,}/g, (m) => (keep.includes(m) ? m : "[redacted]"));
  return s.length <= MAX_DETAIL ? s : `${s.slice(0, MAX_DETAIL - 1)}…`;
}

function describe(e: unknown): { status: number; text: string } {
  if (e instanceof CloudflareApiError) return { status: e.status, text: e.message };
  return { status: 0, text: String((e as Error)?.message ?? e) };
}

async function verifyUserToken(fetchFn: CloudflareFetch, token: string): Promise<{ status: string } | null> {
  const res = await fetchFn(`${CLOUDFLARE_API_ORIGIN}/user/tokens/verify`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => null)) as { success?: boolean; result?: { status?: string } } | null;
  if (!res.ok || !body?.success || !body.result?.status) return null;
  return { status: body.result.status };
}

export async function verifyCloudflare(
  hive: string,
  creds: { accountId: string; apiToken: string },
  fetchFn: CloudflareFetch = (input, init) => fetch(input, init),
): Promise<VerifyOutcome> {
  const { accountId, apiToken } = creds;
  const worker = parentWorkerName(hive);
  const clean = (s: string) => redact(s, apiToken, [accountId, worker]);
  const checks: CloudflareCheck[] = [];
  const cf = new CloudflareClient({ accountId, token: apiToken, fetch: fetchFn });

  // (a) token active
  let active = false;
  try {
    const info = await cf.verifyToken(accountId);
    active = info.status === "active";
    checks.push({
      name: CHECK_TOKEN,
      ok: active,
      detail: active ? `account token is active for account ${accountId}` : clean(`token status is "${info.status}"`),
    });
  } catch (e) {
    const { status, text } = describe(e);
    let user: { status: string } | null = null;
    if (status >= 400 && status < 500) user = await verifyUserToken(fetchFn, apiToken).catch(() => null);
    if (user) {
      active = user.status === "active";
      checks.push({ name: CHECK_TOKEN, ok: active, detail: active ? "user token is active" : clean(`user token status is "${user.status}"`) });
    } else {
      const hint =
        status === 401 || status === 403
          ? `Cloudflare rejected the token for account ${accountId}; create it from the QueenOS token template in that account`
          : `could not verify the token`;
      checks.push({ name: CHECK_TOKEN, ok: false, detail: clean(`${hint} (${text})`) });
    }
  }
  if (!active) {
    checks.push({ name: CHECK_WRITE, ok: false, detail: "skipped: the token is not active" });
    return { ok: false, checks };
  }

  // (b) write probe
  let writable = false;
  try {
    const r = await cf.ensureWorker(worker);
    writable = true;
    checks.push({ name: CHECK_WRITE, ok: true, detail: r.created ? `created Worker ${worker}` : `Worker ${worker} already exists` });
  } catch (e) {
    const { status, text } = describe(e);
    const hint = status === 403 || status === 401 ? `missing "Workers Scripts: Edit" on account ${accountId}` : `could not create Worker ${worker}`;
    checks.push({ name: CHECK_WRITE, ok: false, detail: clean(`${hint} (${text})`) });
  }
  if (!writable) return { ok: false, checks };

  // (c) informational
  try {
    const sub = await cf.getWorkersSubdomain();
    checks.push({ name: CHECK_SUBDOMAIN, ok: true, detail: clean(`${sub}.workers.dev`) });
  } catch (e) {
    checks.push({ name: CHECK_SUBDOMAIN, ok: false, detail: clean(`no workers.dev subdomain readable; Preview URLs need one (${describe(e).text})`) });
  }
  return { ok: true, checks };
}
