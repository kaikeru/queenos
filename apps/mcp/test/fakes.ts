/** In-memory Artifacts (with the receive-pack probe), Queen, registry and identities. Only the network is faked. */
import type { AttemptAborted, AttemptBaseFailed, AttemptBaseReady, AttemptIntent, AttemptIntentDecision, AttemptOwnerAction, AttemptReady, AttemptResult, AttemptSyncBase, AttemptView, HiveStatus, ItemAttempts, ItemDetail, McpAgentIdentity, Project, Race, RejectRace, RejectRaceResult, WorkItem } from "@queenos/queen-types";
import { forkDepsFor } from "../src/fork";
import type { AttemptRef, IdentityPort, McpArtifacts, McpPorts, McpRepoHandle, QueenPort, RegistryPort, Snapshot } from "../src/ports";
import type { SessionPort } from "../src/tools";

export const OWNER = "ada@example.org";
export const OTHER = "eve@example.org";
export const HIVE = "demo";
export const MAIN_SHA = "a".repeat(40);
export const ATT = "att_0123456789ab";
export const ATT_REPO = `${HIVE}-att-0123456789ab`;
export const BASE_REPO = `${HIVE}-base-fedcba987654`;
export const REMOTE = (repo: string) => `https://acct.artifacts.cloudflare.net/git/queenos/${repo}.git`;

class CodeErr extends Error {
  constructor(readonly code: string, detail = "fake") {
    super(`${code}: ${detail}`);
  }
}

interface FakeRepo {
  main: string;
  readOnly: boolean;
  source: string | null;
  tokens: { id: string; state: string; scope: "read" | "write" }[];
}

export class FakeArtifacts implements McpArtifacts {
  repos = new Map<string, FakeRepo>([[HIVE, { main: MAIN_SHA, readOnly: false, source: null, tokens: [] }]]);
  forks: { name: string; source: string; readOnly: boolean }[] = [];
  deleted: string[] = [];
  /** Fork names whose fork() always throws this code. */
  forkErrors = new Map<string, string>();
  /** Repos whose receive-pack advert answers 503 with a cf-ray. */
  sick = new Set<string>();
  private n = 0;

  async get(name: string): Promise<McpRepoHandle> {
    const st = this.repos.get(name);
    if (!st) throw new CodeErr("NOT_FOUND", `repo ${name}`);
    return {
      [Symbol.dispose]() {},
      info: async () => ({ remote: REMOTE(name) }),
      createToken: async (scope, ttl) => {
        const id = `tok-${++this.n}`;
        st.tokens.push({ id, state: "active", scope });
        return { id, plaintext: `art_v1_${"f".repeat(40)}${this.n}?expires=${1_800_000_000 + ttl}`, expiresAt: new Date((1_800_000_000 + ttl) * 1000).toISOString() };
      },
      listTokens: async () => ({ tokens: st.tokens.map((t) => ({ id: t.id, state: t.state })) }),
      revokeToken: async (id) => {
        const t = st.tokens.find((x) => x.id === id);
        if (!t) return false;
        t.state = "revoked";
        return true;
      },
      log: async ({ ref } = {}) => (ref === "main" ? [{ hash: st.main }] : []),
      fork: async (fname, opts) => {
        const err = this.forkErrors.get(fname);
        if (err) throw new CodeErr(err);
        if (this.repos.has(fname)) throw new CodeErr("ALREADY_EXISTS");
        this.forks.push({ name: fname, source: name, readOnly: !!opts?.readOnly });
        this.repos.set(fname, { main: st.main, readOnly: !!opts?.readOnly, source: name, tokens: [] });
        return {};
      },
    };
  }

  async delete(name: string): Promise<boolean> {
    this.deleted.push(name);
    return this.repos.delete(name);
  }

  activeTokens(repo: string): string[] {
    return (this.repos.get(repo)?.tokens ?? []).filter((t) => t.state === "active").map((t) => t.id);
  }

  /** The fake Artifacts git server: only the receive-pack advertisement the readiness probe asks for. */
  fetch: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const repo = /\/git\/queenos\/([^/]+)\.git\/info\/refs$/.exec(url.pathname)?.[1] ?? "";
    if (this.sick.has(repo)) return new Response("busy", { status: 503, headers: { "cf-ray": "8f00ray" } });
    return new Response("ok", { status: 200 });
  };
}

export function viewOf(over: Partial<AttemptView> & { attemptId: string }): AttemptView {
  return {
    hive: HIVE,
    itemId: "item-1",
    raceId: null,
    trainId: "train-1",
    repo: `${HIVE}-att-${over.attemptId.slice(4)}`,
    baseSha: MAIN_SHA,
    agentId: `ag_${"1".padStart(32, "0")}`,
    agentName: "opus",
    model: "claude-opus-5-5",
    role: "worker",
    owner: OWNER,
    state: "READY",
    headSha: null,
    createdAt: 1,
    expiresAt: 2,
    train: null,
    race: null,
    verdict: "none",
    ...over,
  };
}

export const acceptCreate = (over: Partial<Extract<AttemptIntentDecision, { verdict: "accept" }>> = {}): AttemptIntentDecision => ({
  verdict: "accept",
  attemptId: ATT,
  trainId: "train-1",
  repo: ATT_REPO,
  itemId: "item-1",
  raceId: null,
  expiresAt: 9,
  base: { kind: "create", baseRepo: BASE_REPO },
  ...over,
});

export class FakeQueen implements QueenPort {
  calls: { method: string; input: unknown }[] = [];
  executors: "external" | "swarm" = "external";
  /** Successive attemptIntent answers (the last one repeats). */
  intents: AttemptIntentDecision[] = [acceptCreate()];
  views = new Map<string, AttemptView>();
  items: WorkItem[] = [];
  notes = new Map<string, string>();
  /** method -> error it throws */
  errors = new Map<string, Error>();
  readyRefusal: AttemptResult | null = null;

  private rec(method: string, input: unknown): void {
    this.calls.push({ method, input });
    const e = this.errors.get(method);
    if (e) throw e;
  }
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
  inputs<T>(method: string): T[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.input as T);
  }

  async hiveStatus() {
    this.rec("hiveStatus", null);
    return { hive: HIVE, settings: { executors: this.executors } } as unknown as HiveStatus;
  }
  async submitWork(input: unknown) {
    this.rec("submitWork", input);
    return { item: { itemId: "goal-1" } as WorkItem, promptRun: {} as never };
  }
  async getItemDetail(itemId: string) {
    this.rec("getItemDetail", itemId);
    return { item: { itemId, status: "READY", waitReason: "awaiting submissions" }, children: [{ itemId: `${itemId}-c1` }], trains: [], races: this.races, release: null, escalations: [] } as unknown as ItemDetail;
  }
  async getSnapshot() {
    this.rec("getSnapshot", null);
    return { type: "snapshot", promptRuns: [], trains: [], recentAudit: [], items: this.items } as Snapshot;
  }
  async attemptIntent(input: AttemptIntent) {
    this.rec("attemptIntent", input);
    return this.intents.length > 1 ? this.intents.shift()! : this.intents[0]!;
  }
  async attemptBaseReady(input: AttemptBaseReady) {
    this.rec("attemptBaseReady", input);
    return { outcome: "applied" };
  }
  async attemptBaseFailed(input: AttemptBaseFailed) {
    this.rec("attemptBaseFailed", input);
    return { outcome: "applied" };
  }
  async attemptReady(input: AttemptReady): Promise<AttemptResult> {
    this.rec("attemptReady", input);
    if (this.readyRefusal) return this.readyRefusal;
    const v = viewOf({ attemptId: input.attemptId, repo: input.repo, baseSha: input.baseSha, state: "READY", expiresAt: input.expiresAt });
    this.views.set(input.attemptId, v);
    return { ok: true, attempt: v, changed: true };
  }
  async attemptAborted(input: AttemptAborted) {
    this.rec("attemptAborted", input);
    return { outcome: "applied" };
  }
  async attemptRefresh(input: AttemptOwnerAction): Promise<AttemptResult> {
    this.rec("attemptRefresh", input);
    const v = this.views.get(input.attemptId);
    return v ? { ok: true, attempt: { ...v, expiresAt: v.expiresAt + 1 }, changed: true } : { ok: false, code: "NOT_FOUND", message: "no attempt" };
  }
  async attemptEnd(input: AttemptOwnerAction): Promise<AttemptResult> {
    this.rec("attemptEnd", input);
    const v = this.views.get(input.attemptId);
    if (!v) return { ok: false, code: "NOT_FOUND", message: "no attempt" };
    const ended = { ...v, state: "ABANDONED" as const };
    this.views.set(input.attemptId, ended);
    return { ok: true, attempt: ended, changed: true };
  }
  /** null = behave like a Queen without the RPC. */
  regate: ((input: AttemptOwnerAction) => AttemptResult) | null = null;
  async attemptRegate(input: AttemptOwnerAction): Promise<AttemptResult> {
    this.rec("attemptRegate", input);
    if (!this.regate) throw new Error('The RPC receiver does not implement the method "attemptRegate".');
    return this.regate(input);
  }
  /** Races getItemDetail answers (newest last). */
  races: Race[] = [];
  /** null = behave like a Queen without the RPC. */
  syncBase: ((input: AttemptSyncBase) => AttemptResult) | null = (input) => {
    const v = this.views.get(input.attemptId);
    if (!v) return { ok: false, code: "NOT_FOUND", message: "no attempt" };
    const next = { ...v, baseSha: input.baseSha };
    this.views.set(input.attemptId, next);
    return { ok: true, attempt: next, changed: true };
  };
  async attemptSyncBase(input: AttemptSyncBase): Promise<AttemptResult> {
    this.rec("attemptSyncBase", input);
    if (!this.syncBase) throw new Error('The RPC receiver does not implement the method "attemptSyncBase".');
    return this.syncBase(input);
  }
  /** null = behave like a Queen without the RPC. */
  reject: ((input: { hive: string; raceId: string; user: string; reject: RejectRace }) => RejectRaceResult) | null = (input) => ({
    outcome: "applied",
    race: { ...this.races.find((r) => r.raceId === input.raceId)!, state: "RACING", reopens: 1 },
    fallback: false,
  });
  async rejectRace(input: { hive: string; raceId: string; user: string; reject: RejectRace }): Promise<RejectRaceResult> {
    this.rec("rejectRace", input);
    if (!this.reject) throw new Error('The RPC receiver does not implement the method "rejectRace".');
    return this.reject(input);
  }
  async getAttempt(attemptId: string) {
    this.rec("getAttempt", attemptId);
    return this.views.get(attemptId) ?? null;
  }
  async attemptsForItem(itemId: string): Promise<ItemAttempts> {
    this.rec("attemptsForItem", itemId);
    return { itemId, baseSha: MAIN_SHA, basePending: false, attempts: [...this.views.values()] };
  }
  async verdictNote(sha: string) {
    this.rec("verdictNote", sha);
    return this.notes.get(sha) ?? null;
  }
  async closeRaceEntries(input: { hive: string; raceId: string; user: string }) {
    this.rec("closeRaceEntries", input);
    return { outcome: "applied", race: { raceId: input.raceId } as Race };
  }
  async pick(input: { hive: string; raceId: string; user: string; pick: { trainId: string } }) {
    this.rec("pick", input);
    return { outcome: "applied", race: { raceId: input.raceId } as Race };
  }
}

export class FakeIdentity implements IdentityPort {
  identity: McpAgentIdentity | null = null;
  refs: AttemptRef[] = [];
  async create(identity: McpAgentIdentity) {
    this.identity ??= identity;
    return this.identity;
  }
  async get() {
    return this.identity;
  }
  async attempts() {
    return this.refs.map((r) => ({ ...r }));
  }
  async addAttempt(ref: { hive: string; attemptId: string }) {
    this.refs = [...this.refs.filter((r) => r.attemptId !== ref.attemptId), { ...ref, open: true }];
  }
  async closeAttempt(attemptId: string) {
    this.refs = this.refs.map((r) => (r.attemptId === attemptId ? { ...r, open: false } : r));
  }
}

export class FakeRegistry implements RegistryPort {
  projects: Project[] = [{ hive: HIVE, name: "Demo", description: "", status: "ACTIVE", createdBy: OWNER, createdAt: 1, updatedAt: 1, urls: { prod: null, staging: null, preview: null } }];
  async list() {
    return this.projects;
  }
  async get(hive: string) {
    return this.projects.find((p) => p.hive === hive) ?? null;
  }
}

export class FakeSession implements SessionPort {
  constructor(
    public ownerEmail = OWNER,
    public id: McpAgentIdentity | null = null,
  ) {}
  owner() {
    return this.ownerEmail;
  }
  identity() {
    return this.id;
  }
  async bind(identity: McpAgentIdentity) {
    this.id = identity;
  }
}

export class FakeWorld {
  readonly artifacts = new FakeArtifacts();
  readonly queen = new FakeQueen();
  readonly registry = new FakeRegistry();
  readonly identities = new Map<string, FakeIdentity>();
  readonly sleeps: number[] = [];
  clock = 1_000_000;
  private n = 0;

  identity(agentId: string): FakeIdentity {
    let i = this.identities.get(agentId);
    if (!i) {
      i = new FakeIdentity();
      this.identities.set(agentId, i);
    }
    return i;
  }

  ports(): McpPorts {
    const sleep = async (ms: number) => {
      this.sleeps.push(ms);
      this.clock += ms;
    };
    const now = () => this.clock;
    return {
      queen: () => this.queen,
      registry: this.registry,
      identity: (agentId) => this.identity(agentId),
      artifacts: this.artifacts,
      fork: forkDepsFor(this.artifacts, this.artifacts.fetch, sleep, now),
      sleep,
      now,
      newAgentId: () => `ag_${(++this.n).toString(16).padStart(32, "0")}`,
    };
  }
}

// ── the shared world of the DO integration test (test/worker.ts) ──────────
let current: FakeWorld | null = null;
export function setWorld(w: FakeWorld | null): void {
  current = w;
}
export function currentWorld(): FakeWorld {
  if (!current) throw new Error("no fake world installed (setWorld)");
  return current;
}
