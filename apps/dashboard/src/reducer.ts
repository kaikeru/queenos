/**
 * War Room state: a pure reducer over Queen server messages, plus selectors
 * that derive swimlanes and audit cards. The dashboard is a dumb terminal:
 * nothing here decides anything, it only mirrors what the Queen broadcasts.
 *
 * Kept free of runtime imports (types only) so it can be unit-tested with
 * plain `node --test` (see test/reducer.test.ts).
 */
import type {
  AuditEvent,
  AuditStatus,
  DeployEnvironment,
  Deployment,
  DroneRole,
  GitNotesPayload,
  MergeTrain,
  PromptRun,
  QueenServerMessage,
} from "@queenos/queen-types";

export type TickerKind = "scribe" | "status" | "error" | "system";

export interface TickerItem {
  id: number;
  at: number;
  kind: TickerKind;
  text: string;
}

export interface LandedCommit {
  sha: string;
  trainId: string;
  promptId: string;
}

export interface State {
  loaded: boolean;
  prompts: Record<string, PromptRun>;
  /** Prompt ids in queue (submission) order. */
  promptOrder: string[];
  trains: Record<string, MergeTrain>;
  /** Train ids in creation order. */
  trainOrder: string[];
  /** Deployments by deploymentId (per-train previews; staging/canary/prod from P3). */
  deployments: Record<string, Deployment>;
  audit: AuditEvent[];
  /** Newest first. */
  ticker: TickerItem[];
  /** Commits on main, in landing order. */
  landed: LandedCommit[];
  tickerSeq: number;
}

export type Action =
  | { type: "server"; message: QueenServerMessage; at: number }
  | { type: "invalid_frame"; detail: string; at: number }
  | { type: "system"; text: string; at: number };

export const AUDIT_LIMIT = 600;
export const TICKER_LIMIT = 80;

export const initialState: State = {
  loaded: false,
  prompts: {},
  promptOrder: [],
  trains: {},
  trainOrder: [],
  deployments: {},
  audit: [],
  ticker: [],
  landed: [],
  tickerSeq: 0,
};

// ── helpers ───────────────────────────────────────────────────────────────

/** A, B, ... Z, AA, AB ... for the n-th prompt in the queue. */
export function letterFor(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function letterOf(state: Pick<State, "promptOrder">, promptId: string): string {
  const i = state.promptOrder.indexOf(promptId);
  return i < 0 ? "?" : letterFor(i);
}

export function excerpt(text: string, max = 48): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The prompt a train was provisioned for: the last of its cumulative prompts. */
export function tailOf(train: MergeTrain): string | undefined {
  return train.includedPrompts.at(-1);
}

function upsertOrdered(order: string[], id: string, createdAt: number, all: Record<string, { createdAt: number }>): string[] {
  if (order.includes(id)) return order;
  // Stable: insert after the last entry that is not newer.
  const next = [...order];
  let i = next.length;
  while (i > 0 && all[next[i - 1]!]!.createdAt > createdAt) i--;
  next.splice(i, 0, id);
  return next;
}

function pushTicker(s: State, kind: TickerKind, text: string, at: number): State {
  // Scribe lines can arrive twice (audit entry and train summary); show once.
  if (kind === "scribe" && s.ticker.slice(0, 12).some((t) => t.kind === "scribe" && t.text === text)) return s;
  const item: TickerItem = { id: s.tickerSeq + 1, at, kind, text };
  return { ...s, tickerSeq: item.id, ticker: [item, ...s.ticker].slice(0, TICKER_LIMIT) };
}

function withLanded(s: State, train: MergeTrain): State {
  const merged = train.phase === "MERGED" || train.status === "MERGED";
  if (!merged || s.landed.some((l) => l.trainId === train.trainId)) return s;
  const sha = train.landedSha ?? train.headSha ?? train.trainId.slice(0, 8);
  return { ...s, landed: [...s.landed, { sha, trainId: train.trainId, promptId: tailOf(train) ?? "" }] };
}

function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return "ejected";
  return reason.startsWith("superseded") ? "superseded by an upstream ejection" : reason.replace(/^failed:\s*/, "failed: ");
}

// ── reducer ───────────────────────────────────────────────────────────────

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "system":
      return pushTicker(state, "system", action.text, action.at);
    case "invalid_frame":
      return pushTicker(state, "error", `Dropped an invalid frame from the Queen: ${action.detail}`, action.at);
    case "server":
      return serverMessage(state, action.message, action.at);
  }
}

function serverMessage(state: State, msg: QueenServerMessage, at: number): State {
  switch (msg.type) {
    case "pong":
      return state;
    case "error":
      return pushTicker(state, "error", `Queen: ${msg.message}${msg.code ? ` (${msg.code})` : ""}`, at);
    case "snapshot": {
      const prompts: Record<string, PromptRun> = {};
      for (const p of msg.promptRuns) prompts[p.promptId] = p;
      const trains: Record<string, MergeTrain> = {};
      for (const t of msg.trains) trains[t.trainId] = t;
      const byCreated = <T extends { createdAt: number }>(rows: T[]) => [...rows].sort((a, b) => a.createdAt - b.createdAt);
      let next: State = {
        ...state,
        loaded: true,
        prompts,
        promptOrder: byCreated(msg.promptRuns).map((p) => p.promptId),
        trains,
        trainOrder: byCreated(msg.trains).map((t) => t.trainId),
        deployments: Object.fromEntries((msg.deployments ?? []).map((d) => [d.deploymentId, d])),
        audit: msg.recentAudit.slice(-AUDIT_LIMIT),
        landed: [],
      };
      for (const t of byCreated(msg.trains)) next = withLanded(next, t);
      return pushTicker(
        next,
        "system",
        `Linked to the Queen: ${msg.promptRuns.length} prompts, ${msg.trains.length} trains, ${msg.recentAudit.length} audit entries.`,
        at,
      );
    }
    case "prompt.updated": {
      const p = msg.promptRun;
      const prev = state.prompts[p.promptId];
      let next: State = {
        ...state,
        prompts: { ...state.prompts, [p.promptId]: p },
        promptOrder: upsertOrdered(state.promptOrder, p.promptId, p.createdAt, { ...state.prompts, [p.promptId]: p }),
      };
      const tag = `[${letterOf(next, p.promptId)}] ${excerpt(p.promptText)}`;
      if (!prev) next = pushTicker(next, "status", `Queued ${tag}`, at);
      else if (prev.status !== p.status) next = pushTicker(next, "status", `${tag} -> ${p.status}`, at);
      return next;
    }
    case "train.updated": {
      const t = msg.train;
      const prev = state.trains[t.trainId];
      let next: State = {
        ...state,
        trains: { ...state.trains, [t.trainId]: t },
        trainOrder: upsertOrdered(state.trainOrder, t.trainId, t.createdAt, { ...state.trains, [t.trainId]: t }),
      };
      next = withLanded(next, t);
      const tail = tailOf(t);
      const cars = t.includedPrompts.map((id) => letterOf(next, id)).join("+");
      if (!prev) next = pushTicker(next, "status", `Train ${cars} started`, at);
      else if (prev.status !== t.status || prev.phase !== t.phase) {
        const verb =
          t.status === "EJECTED"
            ? `ejected (${reasonLabel(t.reason)})`
            : t.status === "MERGED"
              ? `landed on main${t.landedSha ? ` @ ${t.landedSha.slice(0, 7)}` : ""}`
              : `${t.status}${t.phase ? ` / ${t.phase}` : ""}`;
        next = pushTicker(next, "status", `Train ${cars} ${verb}`, at);
      }
      if (t.summary && t.summary !== prev?.summary) {
        const who = tail ? `[${letterOf(next, tail)}] ` : "";
        next = pushTicker(next, "scribe", `${who}${t.summary}`, at);
      }
      return next;
    }
    case "deployment.updated": {
      const d = msg.deployment;
      const prev = state.deployments[d.deploymentId];
      if (prev && prev.updatedAt > d.updatedAt) return state; // out-of-order frame
      let next: State = { ...state, deployments: { ...state.deployments, [d.deploymentId]: d } };
      if (prev?.status !== d.status) {
        const train = d.trainId ? next.trains[d.trainId] : undefined;
        const who = train ? `Train ${train.includedPrompts.map((id) => letterOf(next, id)).join("+")} ` : "";
        const text =
          d.status === "PENDING"
            ? `${who}deploying ${d.environment}${d.commitSha ? ` @ ${d.commitSha.slice(0, 7)}` : ""}`
            : d.status === "LIVE"
              ? `${who}${d.environment} live${d.url ? ` at ${d.url}` : ""}`
              : d.status === "FAILED"
                ? `${who}${d.environment} failed${d.summary ? `: ${d.summary}` : ""}`
                : `${who}${d.environment} torn down`;
        next = pushTicker(next, d.status === "FAILED" ? "error" : "status", text, at);
      }
      return next;
    }
    case "audit.appended": {
      const e = msg.event;
      if (state.audit.some((x) => x.eventId === e.eventId)) return state;
      let next: State = { ...state, audit: [...state.audit, e].slice(-AUDIT_LIMIT) };
      const who = `[${letterOf(next, e.promptId)}]`;
      if (e.droneRole === "SCRIBE" && e.gitNotesPayload?.reasoningSteps[0]) {
        next = pushTicker(next, "scribe", `${who} ${e.gitNotesPayload.reasoningSteps[0]}`, e.createdAt);
      } else if (e.status === "REJECTED") {
        next = pushTicker(next, "status", `${who} ${e.droneRole} REJECTED`, e.createdAt);
      }
      return next;
    }
  }
}

// ── selectors ─────────────────────────────────────────────────────────────

/** One drone run: a RUNNING event, resolved by the next terminal event of the same role. */
export interface AuditCard {
  key: string;
  role: DroneRole;
  status: AuditStatus;
  /** 1-based attempt (a new BUILDER card starts a new attempt). */
  attempt: number;
  startedAt: number;
  endedAt: number | null;
  payload: GitNotesPayload | null;
}

export function buildCards(audit: AuditEvent[]): Map<string, AuditCard[]> {
  const out = new Map<string, AuditCard[]>();
  const attempts = new Map<string, number>();
  for (const e of audit) {
    const cards = out.get(e.promptId) ?? [];
    out.set(e.promptId, cards);
    if (e.droneRole === "BUILDER" && e.status === "RUNNING") attempts.set(e.promptId, (attempts.get(e.promptId) ?? 0) + 1);
    const attempt = Math.max(attempts.get(e.promptId) ?? 1, 1);
    if (e.status !== "RUNNING") {
      // FIFO: a rebuilt train's older drone may finish after its replacement started.
      const open = cards.find((c) => c.role === e.droneRole && c.status === "RUNNING");
      if (open) {
        open.status = e.status;
        open.endedAt = e.createdAt;
        open.payload = e.gitNotesPayload;
        continue;
      }
    }
    cards.push({
      key: e.eventId,
      role: e.droneRole,
      status: e.status,
      attempt,
      startedAt: e.createdAt,
      endedAt: e.status === "RUNNING" ? null : e.createdAt,
      payload: e.gitNotesPayload,
    });
  }
  return out;
}

export interface LaneTrain {
  train: MergeTrain;
  /** Cumulative cars, as queue letters: train C holds ["A","B","C"]. */
  cars: string[];
  /** 1 for the first train built for this prompt, 2+ for rebuilds. */
  generation: number;
  /** The newest train for the lane's prompt. */
  current: boolean;
  /** Why an ejected train ended: it failed itself, or was superseded. */
  ejectKind: "failed" | "superseded" | null;
  /** The train's Worker Preview row, if it was ever deployed. */
  preview: Deployment | null;
}

export interface Lane {
  prompt: PromptRun;
  letter: string;
  trains: LaneTrain[];
  cards: AuditCard[];
}

export function buildLanes(state: State): Lane[] {
  const cards = buildCards(state.audit);
  const byPrompt = new Map<string, MergeTrain[]>();
  for (const id of state.trainOrder) {
    const t = state.trains[id]!;
    const tail = tailOf(t);
    if (!tail) continue;
    byPrompt.set(tail, [...(byPrompt.get(tail) ?? []), t]);
  }
  return state.promptOrder.map((promptId, i) => {
    const trains = byPrompt.get(promptId) ?? [];
    return {
      prompt: state.prompts[promptId]!,
      letter: letterFor(i),
      cards: cards.get(promptId) ?? [],
      trains: trains.map((train, k) => ({
        train,
        cars: train.includedPrompts.map((id) => letterOf(state, id)),
        generation: k + 1,
        current: k === trains.length - 1,
        ejectKind:
          train.status !== "EJECTED" ? null : train.reason?.startsWith("superseded") ? "superseded" : "failed",
        preview: state.deployments[`preview-${train.trainId}`] ?? null,
      })),
    };
  });
}

export const PHASE_FLOW = ["WAITING_PARENT", "BUILDING", "DEPLOYING", "TESTING", "PASSED", "LANDING", "MERGED"] as const;

/** How a train card shows its preview. */
export type PreviewView =
  | { kind: "none" }
  | { kind: "deploying" }
  | { kind: "live"; url: string }
  | { kind: "failed"; summary: string | null }
  | { kind: "gone"; url: string | null };

export function previewView(train: MergeTrain, preview: Deployment | null): PreviewView {
  if (preview?.status === "TORN_DOWN") return { kind: "gone", url: train.previewUrl ?? preview.url };
  if (preview?.status === "FAILED") return { kind: "failed", summary: preview.summary };
  const url = train.previewUrl ?? preview?.url ?? null;
  if (train.phase === "DEPLOYING" || (preview?.status === "PENDING" && !url)) return { kind: "deploying" };
  return url ? { kind: "live", url } : { kind: "none" };
}

export const ENVIRONMENTS: readonly DeployEnvironment[] = ["preview", "staging", "canary", "prod"];

export interface SiteRow {
  environment: DeployEnvironment;
  /** Staging, canary and prod are not wired up until P3. */
  configured: boolean;
  /** For preview: active (non-torn-down) previews, newest first. Others: the env row. */
  deployments: Deployment[];
  /** Torn-down previews (counted only). */
  retired: number;
}

export function buildSites(state: Pick<State, "deployments">): SiteRow[] {
  const all = Object.values(state.deployments);
  return ENVIRONMENTS.map((environment) => {
    const rows = all.filter((d) => d.environment === environment).sort((a, b) => b.updatedAt - a.updatedAt);
    const active = rows.filter((d) => d.status !== "TORN_DOWN");
    return {
      environment,
      configured: environment === "preview" || rows.length > 0,
      deployments: active,
      retired: rows.length - active.length,
    };
  });
}
