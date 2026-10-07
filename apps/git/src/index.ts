/**
 * queenos-git: the agent-native git proxy (docs/human-push-design.md rev 2). Plain git smart-HTTP in front
 * of Artifacts; a push becomes a Submission (receive.ts), reads are filtered to `main` (upload.ts), notes are
 * synthesized from the Queen's ledger (notes-pack.ts, T2n).
 *
 * Reachable only through the edge's service binding (no routes, `workers_dev:false`, `preview_urls:false`).
 * The edge authenticates the QueenOS git token and forwards with:
 *   - `x-queen-user`: the token owner's email (required; the only identity this Worker trusts),
 *   - `x-queen-scopes`: comma-separated token scopes (`read`, `push`); without `push`, pushes are refused.
 * The URL path is kept as the client sent it:
 *   /git/<hive>[.git]/info/refs?service=git-upload-pack|git-receive-pack
 *   /git/<hive>[.git]/git-upload-pack | git-receive-pack
 *   /git/<hive>/t/<trainId>[.git]/info/refs?service=git-upload-pack | git-upload-pack   (read-only, §3.4)
 */
import { HiveSlugSchema, type NotesRef } from "@queenos/queen-types";
import { notesHandlers, type NotesHandlers } from "./notes-pack.js";
import { DEFAULT_MAX_PACK_BYTES, handleReceivePack, type QueenRpc } from "./receive.js";
import { RepoNotFoundError, TokenCache, type ArtifactsLike } from "./tokens.js";
import { handleInfoRefs, handleUploadPack, type ReadTarget } from "./upload.js";
import type { ForkOptions, UpstreamDeps } from "./upstream.js";

export interface Env {
  ARTIFACTS?: Artifacts;
  QUEEN?: DurableObjectNamespace;
  ARTIFACTS_NAMESPACE?: string;
  MAX_PACK_BYTES?: string;
}

export interface GitDeps {
  upstream: UpstreamDeps;
  /** The hive's QueenNode (`QUEEN.idFromName(hive)`). */
  queen(hive: string): QueenRpc;
  notes: NotesHandlers;
  maxPackBytes: number;
  fork?: ForkOptions;
}

const PATH_RE = /^\/git\/([a-z0-9-]+?)(?:\.git)?(?:\/t\/([A-Za-z0-9-]{1,64})(?:\.git)?)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
/** Same shape as GitPushIntentSchema.user (`z.string().email()`), checked before any work. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
}

/** The Queen's repo name for a train (apps/queen planner.ts `trainRepoName`); keep in sync. */
export function trainRepoName(hive: string, trainId: string): string {
  return `${hive}-train-${trainId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
}

/**
 * The repo behind `/t/<trainId>`: only a BUILD train the Queen knows (validated with `getGateTarget`),
 * under its name or a `-rN` re-fork of it. Never a name taken from the URL as is.
 */
async function trainRepo(queen: QueenRpc, hive: string, trainId: string): Promise<string | null> {
  const base = trainRepoName(hive, trainId);
  for (const repo of [base, `${base}-r2`, `${base}-r3`, `${base}-r4`]) {
    const target = await queen.getGateTarget(repo);
    if (target) return target.trainId === trainId && target.lane === "BUILD" ? repo : null;
  }
  return null;
}

/** The request handler with its ports injected (tests pass fakes; the default export wires the bindings). */
export async function handleGit(req: Request, deps: GitDeps): Promise<Response> {
  const url = new URL(req.url);
  const m = PATH_RE.exec(url.pathname);
  if (!m) return text(404, "QueenOS: not a git endpoint (use https://<host>/git/<hive>)");
  const [, hive, trainId, endpoint] = m as unknown as [string, string, string | undefined, string];
  if (!HiveSlugSchema.safeParse(hive).success) return text(404, `QueenOS: no hive ${hive}`);
  const user = (req.headers.get("x-queen-user") ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(user)) return text(401, "QueenOS: unauthenticated (the edge must forward x-queen-user)");
  const scopes = (req.headers.get("x-queen-scopes") ?? "").split(",").map((s) => s.trim());
  const canPush = scopes.includes("push");

  const log: string[] = [];
  const started = deps.upstream.now();
  const queen = deps.queen(hive);
  try {
    let res: Response;
    if (endpoint === "info/refs") {
      if (req.method !== "GET" && req.method !== "HEAD") return text(405, "QueenOS: method not allowed");
      const service = url.searchParams.get("service");
      if (service !== "git-upload-pack" && service !== "git-receive-pack") return text(403, "QueenOS: dumb HTTP is not supported; use git >= 2.0");
      if (trainId && service === "git-receive-pack") return text(403, "QueenOS: /t/<trainId> is read-only; push to the hive remote");
      const target = await readTarget(deps, queen, hive, trainId, log);
      if (target instanceof Response) return target;
      res = await handleInfoRefs(target, service, req);
    } else if (req.method !== "POST") {
      return text(405, "QueenOS: method not allowed");
    } else if (endpoint === "git-upload-pack") {
      const target = await readTarget(deps, queen, hive, trainId, log);
      if (target instanceof Response) return target;
      res = await handleUploadPack(target, req);
    } else {
      if (trainId) return text(403, "QueenOS: /t/<trainId> is read-only; push to the hive remote");
      res = await handleReceivePack({ deps: deps.upstream, hive, user, canPush, queen, maxPackBytes: deps.maxPackBytes, fork: deps.fork, log }, req);
    }
    console.log(`git ${req.method} ${url.pathname} user=${user} ${res.status} ${deps.upstream.now() - started}ms | ${log.join(" | ")}`);
    return res;
  } catch (e) {
    if (e instanceof RepoNotFoundError) return text(404, trainId ? `QueenOS: no train ${trainId} in ${hive}` : `QueenOS: no hive ${hive}`);
    const id = crypto.randomUUID().slice(0, 8);
    console.error(`git ERROR ${id} ${req.method} ${url.pathname} user=${user}: ${e instanceof Error ? e.message : String(e)} | ${log.join(" | ")}`);
    return text(502, `QueenOS: proxy error ${id}; retry`);
  }
}

async function readTarget(deps: GitDeps, queen: QueenRpc, hive: string, trainId: string | undefined, log: string[]): Promise<ReadTarget | Response> {
  let repo = hive;
  if (trainId) {
    const found = await trainRepo(queen, hive, trainId);
    if (!found) return text(404, `QueenOS: no train ${trainId} in ${hive}`);
    repo = found;
  }
  const { defaultBranch } = await deps.upstream.tokens.auth(repo, "read", hive);
  return {
    deps: deps.upstream,
    hive,
    repo,
    branch: defaultBranch,
    notes: trainId
      ? null
      : { handlers: deps.notes, ctx: { hive, notesFor: (ref: NotesRef) => queen.notesFor(hive, ref) } },
    log,
  };
}

// ── production wiring ───────────────────────────────────────────────────

/** Module memory: tokens survive across requests in one isolate (≤ 50 min), never leave it. */
let tokenCache: TokenCache | null = null;

export function depsFromEnv(env: Env): GitDeps {
  if (!env.ARTIFACTS || !env.QUEEN) throw new Error("queenos-git needs the ARTIFACTS and QUEEN bindings");
  const artifacts = env.ARTIFACTS as unknown as ArtifactsLike;
  tokenCache ??= new TokenCache(artifacts);
  const ns = env.QUEEN;
  const max = Number(env.MAX_PACK_BYTES);
  return {
    upstream: {
      artifacts,
      tokens: tokenCache,
      fetch: (input, init) => fetch(input, init),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    },
    queen: (hive) => ns.get(ns.idFromName(hive)) as unknown as QueenRpc,
    notes: notesHandlers,
    maxPackBytes: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_PACK_BYTES,
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    let deps: GitDeps;
    try {
      deps = depsFromEnv(env);
    } catch (e) {
      console.error(`git: ${e instanceof Error ? e.message : String(e)}`);
      return text(503, "QueenOS: git is not configured");
    }
    return handleGit(req, deps);
  },
} satisfies ExportedHandler<Env>;
