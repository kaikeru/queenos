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
  Escalation,
  GitNotesPayload,
  HiveStatus,
  MergeTrain,
  ModelStats,
  PromptRun,
  QueenEvent,
  QueenServerMessage,
  QueenServerUnitMessage,
  Race,
  RouterFloor,
  Release,
  SentinelVerdict,
  WorkItem,
} from "@queenos/queen-types";

import { isEscalation, modelLabel, tierRank } from "./models";

export type TickerKind = "scribe" | "status" | "error" | "system" | "sentinel" | "model";

export interface TickerItem {
  id: number;
  at: number;
  kind: TickerKind;
  text: string;
  /** Sentinel lines: how the verdict reads. */
  tone?: "ok" | "bad";
}

export interface LandedCommit {
  sha: string;
  trainId: string;
  promptId: string;
}

/** When this dashboard saw a train's phase change (frame receipt time); the merge graph's clock. */
export interface TrainTimes {
  phase: string;
  phaseAt: number;
  /** First frame showing the train MERGED or EJECTED. */
  endedAt: number | null;
}

export interface State {
  loaded: boolean;
  prompts: Record<string, PromptRun>;
  /** Prompt ids in queue (submission) order. */
  promptOrder: string[];
  trains: Record<string, MergeTrain>;
  /** Train ids in creation order. */
  trainOrder: string[];
  /** Observed phase-change times per train (live frames only; a snapshot cannot say when). */
  trainTimes: Record<string, TrainTimes>;
  /** Deployments by deploymentId (per-train previews; staging/canary/prod from P3). */
  deployments: Record<string, Deployment>;
  /** Releases by releaseId (P3). */
  releases: Record<string, Release>;
  /** Release ids, newest first. */
  releaseOrder: string[];
  /** Latest Sentinel verdict per release and environment (not part of the snapshot). */
  verdicts: Record<string, Partial<Record<SentinelVerdict["environment"], SentinelVerdict>>>;
  /** Highest canary percent ever seen per release (a rollback may reset `canaryPercent`). */
  canaryPeak: Record<string, number>;
  /** Model router track record (per model and role), replaced wholesale on each update. */
  modelStats: ModelStats[];
  /** Hive-wide builder tier floor (AIMD); null until the Queen reports one. */
  routerFloor: RouterFloor | null;
  audit: AuditEvent[];
  // v2 (empty against a v1 Queen).
  /** Work items by itemId (non-terminal plus recent terminal; `item.updated` upserts). */
  items: Record<string, WorkItem>;
  /** Item ids in creation order. */
  itemOrder: string[];
  /** Races by raceId. */
  races: Record<string, Race>;
  /** Escalations by escalationId. */
  escalations: Record<string, Escalation>;
  /** Escalation ids, newest first. */
  escalationOrder: string[];
  /** Hive status (autonomy, budget, SLO, counts, throughput, concurrency); null until the Queen reports one. */
  hive: HiveStatus | null;
  /** Event log tail by seq, oldest first, capped at EVENT_LIMIT. */
  events: QueenEvent[];
  /** Newest first. */
  ticker: TickerItem[];
  /** Commits on main, in landing order. */
  landed: LandedCommit[];
  tickerSeq: number;
  /** The Queen sent a frame type this build does not know: the dashboard is older than the Queen. */
  outdated: boolean;
}

export type Action =
  | { type: "server"; message: QueenServerMessage; at: number }
  | { type: "invalid_frame"; detail: string; at: number; /** Unknown `type`: this dashboard is outdated. */ outdated?: boolean }
  | { type: "system"; text: string; at: number };

export const AUDIT_LIMIT = 600;
export const TICKER_LIMIT = 80;
export const EVENT_LIMIT = 500;

export const initialState: State = {
  loaded: false,
  prompts: {},
  promptOrder: [],
  trains: {},
  trainOrder: [],
  trainTimes: {},
  deployments: {},
  releases: {},
  releaseOrder: [],
  verdicts: {},
  canaryPeak: {},
  modelStats: [],
  routerFloor: null,
  audit: [],
  items: {},
  itemOrder: [],
  races: {},
  escalations: {},
  escalationOrder: [],
  hive: null,
  events: [],
  ticker: [],
  landed: [],
  tickerSeq: 0,
  outdated: false,
};

/** The minimal slice of a zod issue needed to classify a rejected frame. */
export interface FrameIssue {
  code?: string;
  path?: readonly PropertyKey[];
  message?: string;
  note?: string;
}

/**
 * True when a frame failed only because its `type` discriminator is unknown
 * (a newer Queen), as opposed to a known type with a malformed body.
 */
export function isUnknownFrameType(issues: readonly FrameIssue[], frame: unknown): boolean {
  // A frame with no string `type` is malformed, not newer.
  if (typeof (frame as { type?: unknown } | null)?.type !== "string") return false;
  const first = issues[0];
  if (!first || issues.length !== 1) return false;
  const path = first.path ?? [];
  if (path.length !== 1 || path[0] !== "type") return false;
  return first.code === "invalid_union_discriminator" || /discriminator/i.test(`${first.message ?? ""} ${first.note ?? ""}`);
}

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

function pushTicker(s: State, kind: TickerKind, text: string, at: number, tone?: "ok" | "bad"): State {
  // Scribe lines can arrive twice (audit entry and train summary); show once.
  if (kind === "scribe" && s.ticker.slice(0, 12).some((t) => t.kind === "scribe" && t.text === text)) return s;
  const item: TickerItem = { id: s.tickerSeq + 1, at, kind, text, ...(tone ? { tone } : {}) };
  return { ...s, tickerSeq: item.id, ticker: [item, ...s.ticker].slice(0, TICKER_LIMIT) };
}

function withLanded(s: State, train: MergeTrain): State {
  const merged = train.phase === "MERGED" || train.status === "MERGED";
  if (!merged || s.landed.some((l) => l.trainId === train.trainId)) return s;
  const sha = train.landedSha ?? train.headSha ?? train.trainId.slice(0, 8);
  return { ...s, landed: [...s.landed, { sha, trainId: train.trainId, promptId: tailOf(train) ?? "" }] };
}

const isTerminal = (t: MergeTrain) => t.status === "MERGED" || t.status === "EJECTED";

function withTimes(s: State, prev: MergeTrain | undefined, t: MergeTrain, at: number): State {
  const phase = `${t.status}/${t.phase ?? ""}`;
  const seen = s.trainTimes[t.trainId];
  if (seen && seen.phase === phase) return s;
  const endedAt = seen?.endedAt ?? (isTerminal(t) && (!prev || !isTerminal(prev)) ? at : null);
  return { ...s, trainTimes: { ...s.trainTimes, [t.trainId]: { phase, phaseAt: at, endedAt } } };
}

function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return "ejected";
  return reason.startsWith("superseded") ? "superseded by an upstream ejection" : reason.replace(/^failed:\s*/, "failed: ");
}

function snapshotV2(msg: Extract<QueenServerUnitMessage, { type: "snapshot" }>): Partial<State> {
  const out: Partial<State> = {};
  if (msg.items) {
    out.items = Object.fromEntries(msg.items.map((i) => [i.itemId, i]));
    out.itemOrder = byCreatedAt(msg.items).map((i) => i.itemId);
  }
  if (msg.races) out.races = Object.fromEntries(msg.races.map((r) => [r.raceId, r]));
  if (msg.escalations) {
    out.escalations = Object.fromEntries(msg.escalations.map((e) => [e.escalationId, e]));
    out.escalationOrder = sortEscalations(out.escalations);
  }
  if (msg.hive) out.hive = msg.hive;
  if (msg.recentEvents) out.events = [...msg.recentEvents].sort((a, b) => a.seq - b.seq).slice(-EVENT_LIMIT);
  return out;
}

function hydrateVerdicts(list: SentinelVerdict[]): State["verdicts"] {
  const out: State["verdicts"] = {};
  for (const v of list) out[v.releaseId] = { ...out[v.releaseId], [v.environment]: v };
  return out;
}

// ── reducer ───────────────────────────────────────────────────────────────

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "system":
      return pushTicker(state, "system", action.text, action.at);
    case "invalid_frame":
      if (action.outdated) return state.outdated ? state : { ...state, outdated: true };
      return pushTicker(state, "error", `Dropped an invalid frame from the Queen: ${action.detail}`, action.at);
    case "server":
      return serverMessage(state, action.message, action.at);
  }
}

function byCreatedAt<T extends { createdAt: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.createdAt - b.createdAt);
}

function insertEvent(events: QueenEvent[], e: QueenEvent): QueenEvent[] {
  if (events.some((x) => x.eventId === e.eventId)) return events;
  const next = [...events];
  let i = next.length;
  while (i > 0 && next[i - 1]!.seq > e.seq) i--;
  next.splice(i, 0, e);
  return next.length > EVENT_LIMIT ? next.slice(next.length - EVENT_LIMIT) : next;
}

function sortEscalations(all: Record<string, Escalation>): string[] {
  return Object.values(all)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((e) => e.escalationId);
}

/** A `batch` frame is folded into one new state, so the UI never renders half a frame. */
function applyBatch(state: State, messages: readonly QueenServerUnitMessage[], at: number): State {
  return messages.reduce<State>((s, m) => serverMessage(s, m, at), state);
}

function serverMessage(state: State, msg: QueenServerMessage, at: number): State {
  switch (msg.type) {
    case "pong":
      return state;
    case "batch":
      return applyBatch(state, msg.messages, at);
    case "item.updated": {
      const it = msg.item;
      const prev = state.items[it.itemId];
      if (prev && prev.updatedAt > it.updatedAt) return state; // out-of-order frame
      const items = { ...state.items, [it.itemId]: it };
      let next: State = { ...state, items, itemOrder: upsertOrdered(state.itemOrder, it.itemId, it.createdAt, items) };
      if (prev && prev.status !== it.status && (it.status === "FAILED" || it.status === "SHIPPED")) {
        next = pushTicker(next, it.status === "FAILED" ? "error" : "status", `${it.kind} "${excerpt(it.title, 40)}" ${it.status}`, at);
      }
      return next;
    }
    case "race.updated": {
      const r = msg.race;
      const prev = state.races[r.raceId];
      let next: State = { ...state, races: { ...state.races, [r.raceId]: r } };
      if (prev?.state !== r.state && r.state !== "RACING") {
        const item = state.items[r.itemId];
        const what = item ? `"${excerpt(item.title, 40)}"` : r.itemId;
        next = pushTicker(next, "status", r.state === "DECIDED" ? `Race for ${what} decided${r.reason ? `: ${excerpt(r.reason, 80)}` : ""}` : `Race for ${what} abandoned`, at);
      }
      return next;
    }
    case "escalation.updated": {
      const e = msg.escalation;
      const prev = state.escalations[e.escalationId];
      const escalations = { ...state.escalations, [e.escalationId]: e };
      let next: State = { ...state, escalations, escalationOrder: sortEscalations(escalations) };
      if (!prev && e.status === "OPEN") next = pushTicker(next, "error", `Needs you: ${e.reason}: ${excerpt(e.summary, 100)}`, at);
      else if (prev?.status === "OPEN" && e.status === "RESOLVED") next = pushTicker(next, "system", `Resolved ${e.reason}${e.resolution ? `: ${excerpt(e.resolution, 80)}` : ""}`, at);
      return next;
    }
    case "hive.updated": {
      let next: State = { ...state, hive: msg.hive };
      if (state.hive && state.hive.effectiveAutonomy !== msg.hive.effectiveAutonomy) {
        next = pushTicker(next, "system", `Autonomy is now ${msg.hive.effectiveAutonomy}${msg.hive.degradedBy.length ? ` (${msg.hive.degradedBy.join(", ")})` : ""}`, at);
      }
      return next;
    }
    case "event.appended": {
      const events = insertEvent(state.events, msg.event);
      return events === state.events ? state : { ...state, events };
    }
    case "error":
      return pushTicker(state, "error", `Queen: ${msg.message}${msg.code ? ` (${msg.code})` : ""}`, at);
    case "snapshot": {
      const prompts: Record<string, PromptRun> = {};
      for (const p of msg.promptRuns) prompts[p.promptId] = p;
      const trains: Record<string, MergeTrain> = {};
      for (const t of msg.trains) trains[t.trainId] = t;
      const byCreated = byCreatedAt;
      let next: State = {
        ...state,
        loaded: true,
        prompts,
        promptOrder: byCreated(msg.promptRuns).map((p) => p.promptId),
        trains,
        trainOrder: byCreated(msg.trains).map((t) => t.trainId),
        deployments: Object.fromEntries((msg.deployments ?? []).map((d) => [d.deploymentId, d])),
        releases: Object.fromEntries((msg.releases ?? []).map((r) => [r.releaseId, r])),
        releaseOrder: [...(msg.releases ?? [])].sort((a, b) => b.createdAt - a.createdAt).map((r) => r.releaseId),
        canaryPeak: Object.fromEntries((msg.releases ?? []).map((r) => [r.releaseId, Math.max(state.canaryPeak[r.releaseId] ?? 0, r.canaryPercent ?? 0)])),
        audit: msg.recentAudit.slice(-AUDIT_LIMIT),
        // Older Queens omit modelStats: keep whatever live frames gave us.
        modelStats: msg.modelStats ?? state.modelStats,
        routerFloor: msg.routerFloor ?? state.routerFloor,
        landed: [],
        // v2 fields: an older Queen omits them, so keep what live frames gave us.
        ...snapshotV2(msg),
        // Older Queens omit verdicts: keep whatever live frames gave us.
        verdicts: msg.verdicts ? hydrateVerdicts(msg.verdicts) : state.verdicts,
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
      next = withTimes(next, prev, t, at);
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
      if (prev && t.model && prev.model !== t.model) {
        const who = tail ? `${letterOf(next, tail)}: ` : "";
        const from = prev.model ? `${modelLabel(prev.model)} → ` : "";
        const verb = !prev.model ? "routed to" : isEscalation(prev.model, t.model) ? "escalated to" : "fell back to";
        next = pushTicker(next, "model", `${who}${from}${verb} ${modelLabel(t.model)}${t.modelReason ? ` (${excerpt(t.modelReason, 90)})` : ""}`, at);
      }
      if (t.summary && t.summary !== prev?.summary) {
        const who = tail ? `[${letterOf(next, tail)}] ` : "";
        next = pushTicker(next, "scribe", `${who}${t.summary}`, at);
      }
      return next;
    }
    case "models.updated": {
      const prev = state.routerFloor;
      const floor = msg.floor ?? prev;
      let next: State = { ...state, modelStats: msg.stats, routerFloor: floor };
      if (prev && floor && prev.tier !== floor.tier) {
        const raised = tierRank(floor.tier) > tierRank(prev.tier);
        next = pushTicker(next, "model", `Router: ${raised ? "floor raised to" : "backed off to"} ${floor.tier}`, at);
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
    case "release.updated": {
      const r = msg.release;
      const prev = state.releases[r.releaseId];
      if (prev && prev.updatedAt > r.updatedAt) return state; // out-of-order frame
      const releases = { ...state.releases, [r.releaseId]: r };
      let next: State = {
        ...state,
        releases,
        releaseOrder: state.releaseOrder.includes(r.releaseId)
          ? state.releaseOrder
          : [...state.releaseOrder, r.releaseId].sort((x, y) => releases[y]!.createdAt - releases[x]!.createdAt),
        canaryPeak: { ...state.canaryPeak, [r.releaseId]: Math.max(state.canaryPeak[r.releaseId] ?? 0, r.canaryPercent ?? 0) },
      };
      const label = `Release ${r.headSha.slice(0, 7)}`;
      if (!prev) next = pushTicker(next, "status", `${label} created (${releaseLetters(next, r)})`, at);
      else if (prev.phase !== r.phase || prev.canaryPercent !== r.canaryPercent) {
        const tail = r.phase === "CANARY" && r.canaryPercent ? ` at ${r.canaryPercent}%` : "";
        const bad = r.phase === "ROLLED_BACK" || r.phase === "FAILED";
        next = pushTicker(next, bad ? "error" : "status", `${label} ${r.phase.replace("_", " ")}${tail}${bad && r.summary ? `: ${excerpt(r.summary, 80)}` : ""}${r.phase === "SHIPPED" && r.tappedBy ? ` (tapped by ${r.tappedBy})` : ""}`, at);
      }
      return next;
    }
    case "sentinel.verdict": {
      const v = msg.verdict;
      const prev = state.verdicts[v.releaseId]?.[v.environment];
      if (prev && prev.commandId === v.commandId && prev.verdict === v.verdict) return state;
      const next: State = { ...state, verdicts: { ...state.verdicts, [v.releaseId]: { ...state.verdicts[v.releaseId], [v.environment]: v } } };
      return pushTicker(next, "sentinel", `Sentinel ${v.verdict}: ${v.summary}`, at, v.verdict === "PROMOTE" ? "ok" : "bad");
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

/** Letters (queen-queue letters of each train's tail prompt) of the trains in a release, e.g. "A+B+C". */
export function releaseLetters(state: Pick<State, "trains" | "promptOrder">, release: Release): string {
  const letters: string[] = [];
  for (const id of release.trainIds) {
    const t = state.trains[id];
    const tail = t ? tailOf(t) : undefined;
    const l = tail ? letterOf(state, tail) : "?";
    if (!letters.includes(l)) letters.push(l);
  }
  return letters.length ? letters.join("+") : "no trains";
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
  /** A rebuild routed to a higher model tier than the previous attempt. */
  escalated: boolean;
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
        escalated: k > 0 && isEscalation(trains[k - 1]!.model, train.model),
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
