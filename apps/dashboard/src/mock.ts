/**
 * In-browser mock of the Edge /api (VITE_MOCK_API=1). Replaces window.fetch for
 * /api/* only, so /hives and everything else behave normally. State survives
 * reloads (sessionStorage) so the wizard's resume behaviour can be demoed.
 * Never imported in production builds (see main.tsx).
 */
import {
  CharterSchema,
  ConnectCloudflareSchema,
  GenesisMessageSchema,
  StartGenesisSchema,
  type Project,
  type VaultStatus,
  type WizardState,
} from "@queenos/queen-types";

import { activeMockQueen } from "./mockQueen";

const KEY = "queenos-mock-v1";
const EMAIL = "kyle@example.com";
const CREATE_MS = 3500;
const FLIGHT_MS = 7000;

interface Db {
  projects: Project[];
  wizards: Record<string, WizardState & { launchedAt?: number; scriptIdx: number; failNext?: boolean }>;
}

const now = () => Date.now();

function seed(): Db {
  const t = now();
  return {
    projects: [
      {
        hive: "demo",
        name: "Demo Hive",
        description: "The sandbox hive: a tiny Worker that says hello, used for every demo run.",
        status: "ACTIVE",
        createdBy: EMAIL,
        createdAt: t - 86_400_000 * 3,
        updatedAt: t - 3_600_000,
        urls: { prod: "https://demo.example.workers.dev", staging: "https://demo-staging.example.workers.dev", preview: "https://pr-4-demo.example.workers.dev" },
      },
      {
        hive: "pixel-pulse",
        name: "Pixel Pulse",
        description: "Uptime pinger with a public status page.",
        status: "ONBOARDING",
        createdBy: EMAIL,
        createdAt: t - 7_200_000,
        updatedAt: t - 7_100_000,
        urls: { prod: null, staging: null, preview: null },
      },
      {
        hive: "ledger-lite",
        name: "Ledger Lite",
        description: "Double-entry bookkeeping API on Durable Objects.",
        status: "FAILED",
        createdBy: EMAIL,
        createdAt: t - 86_400_000,
        updatedAt: t - 80_000_000,
        urls: { prod: null, staging: null, preview: null },
      },
    ],
    wizards: {
      "pixel-pulse": blank("pixel-pulse"),
      "ledger-lite": {
        ...blank("ledger-lite"),
        step: "FAILED",
        lastError: "Provisioner: repo create failed (Artifacts quota exceeded). Retry to try again.",
        charterDraft: fullCharter("ledger-lite", "Ledger Lite"),
        vault: connectedVault("ledger-lite"),
      },
    },
  };
}

function blank(hive: string): Db["wizards"][string] {
  return { hive, step: "DESCRIBE", messages: [], charterDraft: null, vault: null, previewUrl: null, lastError: null, updatedAt: now(), scriptIdx: 0 };
}

function fullCharter(hive: string, name: string): Record<string, unknown> {
  return {
    version: 1,
    hive,
    name,
    description: "A Worker that answers pings and renders a status page.",
    stack: { target: "cloudflare-workers", template: "worker-starter", language: "javascript" },
    environments: { preview: true, staging: true, prod: true },
    policy: { allowedDeps: ["hono"], allowedHosts: ["api.cloudflare.com"] },
    secrets: ["cloudflare"],
    models: {},
    firstPrompt: "Add a /health endpoint that returns JSON with the current time.",
  };
}

const CHECKS = [
  { name: "token active", ok: true, detail: "Token verified against api.cloudflare.com" },
  { name: "account matches", ok: true, detail: "Token can see the account" },
  { name: "can upload Workers", ok: true, detail: "Workers Scripts: Edit" },
  { name: "can read Workers subdomain", ok: true },
];

function connectedVault(hive: string, accountId = "0123456789abcdef0123456789ab1234"): VaultStatus {
  return { hive, secret: "cloudflare", connected: true, accountId, verifiedAt: now(), checks: CHECKS };
}

const db: Db = load();

function load(): Db {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Db;
  } catch {
    // fall through to a fresh seed
  }
  return seed();
}
function save(): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    // storage unavailable: in-memory only
  }
}

const REPLIES = [
  (n: string) => `Nice, "${n}" it is. What should it do for its users, and does it need to talk to any outside services or databases?`,
  () => "Got it. I'll keep dependencies minimal (just hono for routing) and only allow calls to api.cloudflare.com unless you tell me otherwise. Should production deploys require a human tap? I'd recommend yes.",
  () => "Perfect. Here is the plan: staging and prod enabled, prod gated on a human. I drafted a first prompt for the merge train. Click Review charter when you are happy with the preview on the right.",
  () => "Updated the draft. Anything else, or shall we review the charter?",
];

type W = Db["wizards"][string];

function advanceDraft(w: W, hive: string, text: string): void {
  const draft = { ...(w.charterDraft ?? {}) } as Record<string, unknown>;
  const name = db.projects.find((p) => p.hive === hive)?.name ?? hive;
  if (w.scriptIdx === 0) {
    draft.hive = hive;
    draft.name = name;
    draft.description = text.length > 280 ? `${text.slice(0, 277)}...` : text;
  } else if (w.scriptIdx === 1) {
    draft.policy = { allowedDeps: ["hono"], allowedHosts: ["api.cloudflare.com"] };
  } else if (w.scriptIdx === 2) {
    draft.environments = { preview: true, staging: true, prod: true };
    draft.firstPrompt = `Create the first working version of ${name}: ${String(draft.description ?? "").slice(0, 200)} Add a /health endpoint and a README.`;
  }
  w.charterDraft = draft;
}

/** Time-based auto-advance for the first flight. */
function tick(w: W, hive: string): void {
  if (!w.launchedAt || (w.step !== "HIVE_CREATING" && w.step !== "FIRST_FLIGHT")) return;
  const el = now() - w.launchedAt;
  if (el >= CREATE_MS + FLIGHT_MS) {
    w.step = "ACTIVE";
    w.previewUrl = `https://pr-1-${hive}.example.workers.dev`;
    const p = db.projects.find((x) => x.hive === hive);
    if (p) {
      p.status = "ACTIVE";
      p.urls = { ...p.urls, preview: w.previewUrl };
      p.updatedAt = now();
    }
  } else if (el >= CREATE_MS) w.step = "FIRST_FLIGHT";
  w.updatedAt = now();
}

function snapshot(w: W): WizardState {
  return {
    hive: w.hive,
    step: w.step,
    messages: w.messages,
    charterDraft: w.charterDraft,
    vault: w.vault,
    previewUrl: w.previewUrl,
    lastError: w.lastError,
    updatedAt: w.updatedAt,
  };
}

class HttpError {
  constructor(
    readonly status: number,
    readonly error: string,
  ) {}
}

function route(method: string, path: string, body: unknown): unknown {
  let m: RegExpMatchArray | null;
  if (method === "GET" && path === "/api/me") return { email: EMAIL };
  if (method === "GET" && path === "/api/projects") return [...db.projects].sort((a, b) => b.updatedAt - a.updatedAt);
  if (method === "GET" && path === "/api/vault/token-template") {
    return { url: "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=workers_scripts:edit&name=QueenOS" };
  }
  if (method === "POST" && path === "/api/genesis") {
    const r = StartGenesisSchema.safeParse(body);
    if (!r.success) throw new HttpError(400, "Invalid hive slug or name");
    if (db.projects.some((p) => p.hive === r.data.hive)) throw new HttpError(409, `A project named "${r.data.hive}" already exists`);
    const t = now();
    db.projects.push({ hive: r.data.hive, name: r.data.name, description: "", status: "ONBOARDING", createdBy: EMAIL, createdAt: t, updatedAt: t, urls: { prod: null, staging: null, preview: null } });
    db.wizards[r.data.hive] = blank(r.data.hive);
    return snapshot(db.wizards[r.data.hive]!);
  }
  if ((m = path.match(/^\/api\/genesis\/([^/]+)(?:\/(messages|charter|launch))?$/))) {
    const hive = decodeURIComponent(m[1]!);
    const sub = m[2];
    const w = db.wizards[hive] ?? (db.projects.find((p) => p.hive === hive)?.status === "ACTIVE" ? activeWizard(hive) : undefined);
    if (!w) throw new HttpError(404, `No such project: ${hive}`);
    db.wizards[hive] = w;
    tick(w, hive);
    if (!sub && method === "GET") return snapshot(w);
    if (sub === "messages" && method === "POST") {
      const r = GenesisMessageSchema.safeParse(body);
      if (!r.success) throw new HttpError(400, "Message must be 1-4000 characters");
      if (w.step !== "DESCRIBE") throw new HttpError(409, "The charter is already confirmed");
      w.messages.push({ role: "user", content: r.data.text, at: now() });
      advanceDraft(w, hive, r.data.text);
      const name = db.projects.find((p) => p.hive === hive)?.name ?? hive;
      const reply = REPLIES[Math.min(w.scriptIdx, REPLIES.length - 1)]!(name);
      w.messages.push({ role: "assistant", content: reply, at: now() });
      w.scriptIdx += 1;
      w.updatedAt = now();
      return snapshot(w);
    }
    if (sub === "charter" && method === "PUT") {
      const r = CharterSchema.safeParse((body as { charter?: unknown } | null)?.charter);
      if (!r.success) throw new HttpError(400, "Charter is invalid");
      if (w.step !== "DESCRIBE") throw new HttpError(409, "The charter is already confirmed");
      w.charterDraft = r.data as unknown as Record<string, unknown>;
      w.step = "CHARTER_READY";
      const p = db.projects.find((x) => x.hive === hive);
      if (p) {
        p.name = r.data.name;
        p.description = r.data.description;
      }
      w.updatedAt = now();
      return snapshot(w);
    }
    if (sub === "launch" && method === "POST") {
      if (w.step !== "DEPLOY_CONNECTED" && w.step !== "FAILED") throw new HttpError(409, `Cannot launch from ${w.step}`);
      w.step = "HIVE_CREATING";
      w.lastError = null;
      w.launchedAt = now();
      w.updatedAt = now();
      return snapshot(w);
    }
  }
  if ((m = path.match(/^\/api\/vault\/([^/]+)\/(cloudflare|status)$/))) {
    const hive = decodeURIComponent(m[1]!);
    const w = db.wizards[hive];
    if (!w) throw new HttpError(404, `No such project: ${hive}`);
    if (m[2] === "status" && method === "GET") return w.vault ?? { hive, secret: "cloudflare", connected: false, accountId: null, verifiedAt: null, checks: [] };
    if (m[2] === "cloudflare" && method === "POST") {
      const r = ConnectCloudflareSchema.safeParse(body);
      if (!r.success) throw new HttpError(400, "Account ID must be 32 hex chars and the token 20+ characters");
      // Any token starting with "bad" fails verification, so the failure UI can be demoed.
      if (r.data.apiToken.startsWith("bad")) {
        return {
          hive,
          secret: "cloudflare",
          connected: false,
          accountId: null,
          verifiedAt: null,
          checks: [
            { name: "token active", ok: true },
            { name: "account matches", ok: true },
            { name: "can upload Workers", ok: false, detail: "Missing permission: Workers Scripts: Edit" },
          ],
        } satisfies VaultStatus;
      }
      w.vault = connectedVault(hive, r.data.accountId);
      if (w.step === "CHARTER_READY") w.step = "DEPLOY_CONNECTED";
      w.updatedAt = now();
      return w.vault;
    }
  }
  throw new HttpError(404, `No mock for ${method} ${path}`);
}

function activeWizard(hive: string): W {
  return {
    ...blank(hive),
    step: "ACTIVE",
    charterDraft: fullCharter(hive, hive),
    vault: connectedVault(hive),
    previewUrl: `https://pr-4-${hive}.example.workers.dev`,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function installMockApi(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    const tap = url.pathname.match(/^\/hives\/[^/]+\/releases\/([^/]+)\/tap$/);
    if (tap && activeMockQueen()) {
      await sleep(250);
      const r = activeMockQueen()!.tap(decodeURIComponent(tap[1]!));
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }
    // v2 GET drill-downs, answered from the mock Queen's state.
    const v2 = url.pathname.match(/^\/hives\/[^/]+\/((?:items|traces)\/[^/]+|events|metrics|queue)$/);
    if (v2 && activeMockQueen() && (init?.method ?? "GET").toUpperCase() === "GET") {
      const r = activeMockQueen()!.rest(v2[1]!, url.searchParams);
      if (r) {
        await sleep(120);
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
      }
    }
    if (!url.pathname.startsWith("/api/")) return real(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    await sleep(200 + Math.random() * 350);
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    try {
      const out = route(method, url.pathname, body);
      save();
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      if (e instanceof HttpError) {
        return new Response(JSON.stringify({ error: e.error }), { status: e.status, headers: { "content-type": "application/json" } });
      }
      throw e;
    }
  };
  console.info("[queenos] mock /api enabled (VITE_MOCK_API=1)");
}
