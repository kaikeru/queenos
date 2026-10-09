/**
 * Fakes for the git Worker tests: an Artifacts binding, an Artifacts smart-HTTP server (the upstream
 * `fetch`), a Queen, and request builders. No network.
 */
import type { GateTarget, GitAborted, GitIntakeDecision, GitPushed, GitPushedResult, GitPushIntent, NotesProjection } from "@queenos/queen-types";
import type { GitDeps } from "../src/index";
import { notesHandlers, type NotesHandlers } from "../src/notes-pack";
import { band, concat, dec, demuxSideband, FLUSH, parsePkts, pkt, pktText } from "../src/pktline";
import type { QueenRpc } from "../src/receive";
import { TokenCache, type ArtifactsLike, type ArtifactsRepoLike } from "../src/tokens";

export const HIVE = "demo";
export const USER = "ada@kaikeru.com";
export const MAIN_SHA = "a".repeat(40);
export const OTHER_SHA = "b".repeat(40);
export const NEW_SHA = "c".repeat(40);
export const NOTES_SHA = "d".repeat(40);
export const ZERO = "0".repeat(40);
export const TRAIN_ID = "7a90c3e1-1111-4222-8333-944455556666";
export const TRAIN_REPO = "demo-train-7a90c3e11111";
const REMOTE_BASE = "https://acct.artifacts.cloudflare.net/git/queenos";

interface RepoState {
  main: string;
  commits: Map<string, string>;
}

class ArtifactsErr extends Error {
  constructor(
    readonly code: string,
    msg: string,
  ) {
    super(`${code}: ${msg}`);
  }
}

export interface ReceivedPush {
  repo: string;
  auth: string;
  commands: string[];
  caps: string[];
  packBytes: number;
  contentLength: string | null;
}

/** One world: repos, tokens, upstream behaviour and the Queen's answers, all inspectable. */
export class World {
  repos = new Map<string, RepoState>([[HIVE, { main: MAIN_SHA, commits: new Map([[MAIN_SHA, "Initial"]]) }]]);
  /** token plaintext (before `?expires=`) -> {repo, scope} */
  tokens = new Map<string, { repo: string; scope: string }>();
  forks: string[] = [];
  deleted: string[] = [];
  /** Fork names whose fork() throws this code once. */
  forkErrors = new Map<string, string>();
  /** Repos whose receive-pack advert (the readiness probe) answers 503. */
  sick = new Set<string>();
  /** `<repo> <endpoint>` -> number of 503s still to answer. */
  fail503 = new Map<string, number>();
  /** How receive-pack POST behaves. */
  receiveMode: "ok" | "500" | "throw" | "ng" = "ok";
  received: ReceivedPush[] = [];
  /** The message of the commit a push stores. */
  pushMessage = "Add a tip jar at /features/tip-jar\n\nAcceptance:\n- shows a jar\n\nQueen-Origin: agent:claude-code\nQueen-Replies-To: " + "e".repeat(40);
  requests: { repo: string; endpoint: string; method: string; scope: string; protocol: string | null; body: string }[] = [];
  sleeps: number[] = [];
  clock = 1_000_000;

  // Queen
  intent: GitIntakeDecision = { verdict: "accept", trainId: TRAIN_ID, repo: TRAIN_REPO, messages: [] };
  pushedResult: GitPushedResult = {
    disposition: "joined-race",
    itemId: "14",
    messages: ["submission received → item 14 (joined its race)", "train 7a90… · verdict in ~2 min", "git fetch origin '+refs/notes/*:refs/notes/*' && git log --notes=verdict -1"],
  };
  pushedError: Error | null = null;
  intentError: Error | null = null;
  calls: { intent: GitPushIntent[]; pushed: GitPushed[]; aborted: GitAborted[]; notesFor: string[]; gateTarget: string[] } = {
    intent: [],
    pushed: [],
    aborted: [],
    notesFor: [],
    gateTarget: [],
  };
  gateTargets = new Map<string, GateTarget>();

  artifacts(): ArtifactsLike {
    return {
      get: async (name) => {
        const st = this.repos.get(name);
        if (!st) throw new ArtifactsErr("NOT_FOUND", `repo ${name} not found`);
        return this.handle(name, st);
      },
      delete: async (name) => {
        this.deleted.push(name);
        return this.repos.delete(name);
      },
    };
  }

  private handle(name: string, st: RepoState): ArtifactsRepoLike {
    return {
      [Symbol.dispose]() {},
      createToken: async (scope = "write") => {
        const plain = `art_v1_${scope}_${name}_${this.tokens.size}`;
        this.tokens.set(plain, { repo: name, scope });
        return { plaintext: `${plain}?expires=1760000000` };
      },
      info: async () => ({ remote: `${REMOTE_BASE}/${name}.git`, defaultBranch: "main" }),
      readCommit: async (hash) => {
        const message = st.commits.get(hash);
        return message === undefined ? null : { hash, message, parents: [] };
      },
      log: async ({ ref } = {}) => (ref === "main" ? [{ hash: st.main }] : []),
      fork: async (fname) => {
        const err = this.forkErrors.get(fname);
        if (err) {
          this.forkErrors.delete(fname);
          throw new ArtifactsErr(err, "fork failed");
        }
        if (this.repos.has(fname)) throw new ArtifactsErr("ALREADY_EXISTS", fname);
        this.forks.push(fname);
        this.repos.set(fname, { main: st.main, commits: new Map(st.commits) });
        return {};
      },
    };
  }

  queen(): QueenRpc {
    return {
      gitIntent: async (i) => {
        this.calls.intent.push(i);
        if (this.intentError) throw this.intentError;
        return this.intent;
      },
      gitPushed: async (p) => {
        this.calls.pushed.push(p);
        if (this.pushedError) throw this.pushedError;
        return this.pushedResult;
      },
      gitAborted: async (a) => {
        this.calls.aborted.push(a);
        return { outcome: "applied" };
      },
      notesFor: async (hive, ref): Promise<NotesProjection> => {
        this.calls.notesFor.push(`${hive} ${ref}`);
        return { ref: ref as NotesProjection["ref"], version: 1, notes: [] };
      },
      getGateTarget: async (repo) => {
        this.calls.gateTarget.push(repo);
        return this.gateTargets.get(repo) ?? null;
      },
    };
  }

  /** The fake Artifacts git server. */
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const m = /^\/git\/queenos\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    if (!m) return new Response("nope", { status: 404 });
    const [, repo, endpoint] = m as unknown as [string, string, string];
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization") ?? "";
    const plain = atob(auth.replace(/^Basic /, "")).replace(/^x:/, "");
    const tok = this.tokens.get(plain);
    if (!tok || tok.repo !== repo) return new Response("bad credentials", { status: 401 });
    const protocol = headers.get("git-protocol");
    const service = url.searchParams.get("service");
    const key = `${repo} ${endpoint === "info/refs" ? `info/refs?${service}` : endpoint}`;
    const left = this.fail503.get(key) ?? 0;

    if (endpoint === "git-receive-pack") return this.receive(repo, auth, tok.scope, init);

    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array(0);
    this.requests.push({ repo, endpoint: endpoint === "info/refs" ? `info/refs?${service}` : endpoint, method: init?.method ?? "GET", scope: tok.scope, protocol, body: dec.decode(body) });
    if (left > 0) {
      this.fail503.set(key, left - 1);
      return new Response("upstream busy art_v1_leaky", { status: 503, headers: { "cf-ray": "ray123" } });
    }
    const st = this.repos.get(repo)!;
    if (endpoint === "info/refs") {
      if (service === "git-receive-pack") {
        if (this.sick.has(repo)) return new Response("sick", { status: 503 });
        return new Response(concat(pkt("# service=git-receive-pack\n"), FLUSH, pkt(`${st.main} refs/heads/main\0report-status delete-refs ofs-delta side-band-64k\n`), FLUSH));
      }
      if (protocol?.includes("version=2")) {
        return new Response(concat(pkt("# service=git-upload-pack\n"), FLUSH, pkt("version 2\n"), pkt("agent=gitty/1.0\n"), pkt("ls-refs=unborn\n"), pkt("fetch=shallow filter sideband-all\n"), pkt("object-format=sha1\n"), FLUSH));
      }
      return new Response(
        concat(
          pkt("# service=git-upload-pack\n"),
          FLUSH,
          pkt(`${st.main} HEAD\0multi_ack thin-pack side-band-64k ofs-delta allow-tip-sha1-in-want symref=HEAD:refs/heads/main object-format=sha1 agent=gitty/1.0\n`),
          pkt(`${OTHER_SHA} refs/heads/other\n`),
          pkt(`${st.main} refs/heads/main\n`),
          pkt(`${NOTES_SHA} refs/notes/queen\n`),
          pkt(`${OTHER_SHA} refs/tags/v1\n`),
          FLUSH,
        ),
      );
    }
    // upload-pack
    const text = dec.decode(body);
    if (text.includes("command=ls-refs")) {
      return new Response(
        concat(pkt(`${st.main} HEAD symref-target:refs/heads/main\n`), pkt(`${st.main} refs/heads/main\n`), pkt(`${OTHER_SHA} refs/heads/other\n`), pkt(`${NOTES_SHA} refs/notes/queen\n`), FLUSH),
      );
    }
    return new Response(concat(pkt("packfile\n"), band(1, new TextEncoder().encode("PACKDATA")), FLUSH), {
      headers: { "content-type": "application/x-git-upload-pack-result" },
    });
  };

  private async receive(repo: string, auth: string, scope: string, init: RequestInit | undefined): Promise<Response> {
    if (this.receiveMode === "throw") {
      // Read a little, then die mid-stream (the client's body is still coming).
      const r = (init!.body as ReadableStream<Uint8Array>).getReader();
      await r.read();
      await r.cancel("upstream died");
      throw new Error("network connection lost");
    }
    const raw = new Uint8Array(await new Response(init!.body as ReadableStream<Uint8Array>).arrayBuffer());
    // The command section, then the pack.
    let o = 0;
    const commands: string[] = [];
    let caps: string[] = [];
    for (;;) {
      const len = parseInt(dec.decode(raw.subarray(o, o + 4)), 16);
      if (len === 0) {
        o += 4;
        break;
      }
      let line = dec.decode(raw.subarray(o + 4, o + len)).replace(/\n$/, "");
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        caps = line.slice(nul + 1).split(" ");
        line = line.slice(0, nul);
      }
      commands.push(line);
      o += len;
    }
    const headers = new Headers(init?.headers);
    this.received.push({ repo, auth: scope, commands, caps, packBytes: raw.length - o, contentLength: headers.get("content-length") });
    void auth;
    if (this.receiveMode === "500") return new Response("internal art_v1_secret", { status: 500 });
    const ref = commands.find((c) => !c.startsWith("shallow "))!.split(" ")[2]!;
    const inner = concat(pkt("unpack ok\n"), pkt(this.receiveMode === "ng" ? `ng ${ref} failed to lock\n` : `ok ${ref}\n`), FLUSH);
    if (this.receiveMode === "ok") {
      const [, nu] = commands.find((c) => !c.startsWith("shallow "))!.split(" ");
      const st = this.repos.get(repo)!;
      st.main = nu!;
      st.commits.set(nu!, this.pushMessage);
    }
    const sideband = caps.includes("side-band-64k");
    return new Response(sideband ? concat(band(2, new TextEncoder().encode("Artifacts: stored\n")), band(1, inner), FLUSH) : inner);
  }

  deps(over: Partial<GitDeps> = {}, notes: NotesHandlers = notesHandlers): GitDeps {
    const artifacts = this.artifacts();
    return {
      upstream: {
        artifacts,
        tokens: new TokenCache(artifacts, () => this.clock),
        fetch: this.fetch,
        sleep: async (ms) => {
          this.sleeps.push(ms);
          this.clock += ms;
        },
        now: () => this.clock,
      },
      queen: () => this.queen(),
      notes,
      maxPackBytes: 50 * 1024 * 1024,
      fork: { probeBudgetMs: 3000 },
      ...over,
    };
  }
}

/** The body of a git push (`old new ref\0caps`, flush, pack). */
export function pushBody(cmds: [string, string, string][], pack: Uint8Array, caps = "report-status side-band-64k agent=git/2.50.1", shallow: string[] = []): Uint8Array {
  return concat(...shallow.map((s) => pkt(`shallow ${s}\n`)), ...cmds.map(([o, n, r], i) => pkt(`${o} ${n} ${r}${i === 0 ? `\0${caps}` : ""}\n`)), FLUSH, pack);
}

/** A fake pack of `n` bytes. */
export function fakePack(n: number): Uint8Array {
  const b = new Uint8Array(n);
  b.set(new TextEncoder().encode("PACK").subarray(0, Math.min(4, n)));
  for (let i = 4; i < n; i++) b[i] = i % 251;
  return b;
}

/** A stream that delivers `bytes` in chunks (chunked transfer: no content-length). */
export function chunked(bytes: Uint8Array, size = 7): ReadableStream<Uint8Array> {
  let o = 0;
  return new ReadableStream({
    pull(c) {
      if (o >= bytes.length) return c.close();
      c.enqueue(bytes.slice(o, o + size));
      o += size;
    },
  });
}

export function gitRequest(path: string, init: RequestInit & { scopes?: string; user?: string | null; agent?: string; model?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.agent !== undefined) headers.set("x-queen-agent", init.agent);
  if (init.model !== undefined) headers.set("x-queen-agent-model", init.model);
  if (init.user !== null) headers.set("x-queen-user", init.user ?? USER);
  headers.set("x-queen-scopes", init.scopes ?? "read,push");
  return new Request(`https://git.internal${path}`, { ...init, headers });
}

export function pushRequest(body: Uint8Array, opts: { chunkedBody?: boolean; scopes?: string; agent?: string; model?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/x-git-receive-pack-request" };
  if (!opts.chunkedBody) headers["content-length"] = String(body.length);
  return gitRequest(`/git/${HIVE}/git-receive-pack`, { method: "POST", body: opts.chunkedBody ? chunked(body) : body, headers, scopes: opts.scopes, agent: opts.agent, model: opts.model });
}

/** A receive-pack response decoded the way git reads it. */
export async function readReport(res: Response, sideband = true): Promise<{ remote: string[]; lines: string[] }> {
  const raw = new Uint8Array(await res.arrayBuffer());
  if (!sideband) return { remote: [], lines: parsePkts(raw).filter((p): p is Uint8Array => p instanceof Uint8Array).map(pktText) };
  const d = demuxSideband(raw);
  const remote = d.progress.map((p) => dec.decode(p).replace(/\n$/, ""));
  const lines = parsePkts(d.data)
    .filter((p): p is Uint8Array => p instanceof Uint8Array)
    .map(pktText);
  return { remote, lines };
}
