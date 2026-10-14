/**
 * Race-true labels (dashboard redesign spec §4.4): the one module that turns a race and its trains into words and tones
 * for goal rows, race cards, Needs you and agent tiles. Nothing else derives a label from train status alone while a
 * race exists. Pure; no React.
 */
import { parseReworkReason, type MergeTrain, type Race, type WorkItem } from "@queenos/queen-types";

import type { ItemDetail } from "./api";
import { autonomyLabel, isExternal, itemPushCommand } from "./homeLogic";
import { isPushed, originBadge, type OriginBadge } from "./origin";
import { countdownText, entryState, pickRemainingMs } from "./raceLogic";
import type { State } from "./reducer";
import { landedCount, openEscalations } from "./status";
import { isBuildTrain, itemIdOf, itemSubState, type SubState } from "./swarm";

export type Tone = "cyan" | "gold" | "violet" | "green" | "red" | "muted";

export type RaceChipKind = "racing" | "picking" | "reworking" | "decided" | "landed" | "abandoned" | "awaiting" | "building" | "failed" | "cancelled";

export interface RaceStatus {
  kind: RaceChipKind;
  text: string;
  tone: Tone;
  /** Waiting on the human (you pick): the one steady pulse the design allows (spec §5). */
  pulse: boolean;
}

export type CandidateKind = "building" | "gating" | "passed" | "failed" | "reworking" | "won" | "lost";

export interface CandidateStatus {
  kind: CandidateKind;
  text: string;
  tone: Tone;
}

/** The reducer state this module reads. */
export type StatusSlice = Pick<State, "trains" | "trainOrder" | "items" | "itemOrder" | "races" | "events" | "landed" | "hive" | "escalations" | "escalationOrder">;

export interface RaceCtx {
  now: number;
  /** External hive: no race yet means "awaiting submissions", not a build sub-state. */
  external: boolean;
  /** Swarm hives without a race: the item's build sub-state (`itemSubState`), where "building" is true. */
  subState?: SubState | null;
}

const LANDED = new Set<string>(["LANDED", "SHIPPED"]);
const OPEN_RACE = new Set<string>(["RACING", "PICKING", "REWORKING"]);

const rs = (kind: RaceChipKind, text: string, tone: Tone): RaceStatus => ({ kind, text, tone, pulse: false });
const cs = (kind: CandidateKind, text: string, tone: Tone): CandidateStatus => ({ kind, text, tone });

export const isOpenRace = (r: Pick<Race, "state">): boolean => OPEN_RACE.has(r.state);

/** The chip of a race card or goal row. `trains` are the race's trains (the REWORKING winner's due time is read from them). */
export function raceStatus(race: Race | null, trains: readonly MergeTrain[], item: WorkItem, ctx: RaceCtx): RaceStatus {
  const { now } = ctx;
  if (race) {
    switch (race.state) {
      case "RACING": {
        const e = entryState(race, now);
        if (e?.kind === "open") return rs("racing", `racing · entries close ${countdownText(e.remainingMs)}`, "cyan");
        if (e?.kind === "closed") return rs("racing", "racing · entries closed", "cyan");
        if (race.deadlineAt != null && race.deadlineAt > now) return rs("racing", `racing · deciding in ${countdownText(race.deadlineAt - now)}`, "cyan");
        return rs("racing", "racing", "cyan");
      }
      case "PICKING": {
        const left = pickRemainingMs(race, now);
        return { kind: "picking", text: left == null ? "you pick" : `you pick · ${countdownText(left)} left`, tone: "gold", pulse: true };
      }
      case "REWORKING": {
        const winner = trains.find((t) => t.trainId === race.winnerTrainId);
        const r = parseReworkReason(winner?.reason);
        return rs("reworking", r ? `reworking · due in ${countdownText(r.dueAt - now)}` : "reworking", "violet");
      }
      case "DECIDED":
        return LANDED.has(item.status) ? rs("landed", "landed", "green") : rs("decided", "decided", "green");
      case "ABANDONED":
        return rs("abandoned", "abandoned", "red");
    }
  }
  if (LANDED.has(item.status)) return rs("landed", "landed", "green");
  if (item.status === "FAILED") return rs("failed", "failed", "red");
  if (item.status === "CANCELLED" || item.status === "DUPLICATE") return rs("cancelled", item.status.toLowerCase(), "muted");
  if (ctx.external) return rs("awaiting", "awaiting submissions", "muted");
  return rs("building", ctx.subState ?? item.status.toLowerCase(), "cyan");
}

/** The first line of a failed train's summary (else its reason), without a "failed:" prefix, ≤ 80 chars. */
export function firstFinding(t: Pick<MergeTrain, "summary" | "reason">): string | null {
  const line = (t.summary || t.reason || "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const text = line.replace(/^failed(?: in race)?:\s*/i, "").trim();
  if (!text) return null;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** One candidate's verdict chip. Never "building" outside a RACING race, so PICKING never reads as a build. */
export function candidateStatus(t: MergeTrain, race: Race, now: number): CandidateStatus {
  if (t.raceOutcome === "REWORK") {
    const r = parseReworkReason(t.reason);
    return cs("reworking", r ? `reworking · ${r.reason} · due in ${countdownText(r.dueAt - now)}` : "reworking", "violet");
  }
  if (race.winnerTrainId === t.trainId && (race.state === "DECIDED" || t.raceOutcome === "WON" || t.status === "MERGED")) return cs("won", "won ★", "gold");
  const rejected = race.rejections?.find((r) => r.trainId === t.trainId);
  if (rejected) return cs("lost", `rejected: ${rejected.reason}`, "muted");
  if (t.raceOutcome === "WON") return cs("won", "won ★", "gold");
  if (t.raceOutcome === "LOST") return cs("lost", "lost", "muted");
  if (t.raceOutcome === "FAILED" || t.status === "EJECTED") {
    const f = firstFinding(t);
    return cs("failed", f ? `failed: ${f}` : "failed", "red");
  }
  if (t.raceOutcome === "PASSED") return cs("passed", race.state === "PICKING" ? "passed · waiting for your pick" : "passed", "green");
  if (race.state === "RACING" && !isPushed(t) && t.status === "BUILDING" && (t.phase == null || t.phase === "WAITING_PARENT" || t.phase === "BUILDING")) return cs("building", "building", "cyan");
  return cs("gating", "gating", "cyan");
}

/**
 * Who a candidate is (spec §4.3): MCP attempts are one contributor per attempt, git pushes one per agent identity, drone
 * trains (no origin, or kind drone) each their own.
 */
export function contributorKey(t: Pick<MergeTrain, "trainId" | "origin" | "attemptId">): string {
  const o = t.origin;
  if (!o || o.kind === "drone") return `train:${t.trainId}`;
  return t.attemptId ? `${o.kind}:${o.id}#${t.attemptId}` : `${o.kind}:${o.id}`;
}

const byAge = (a: MergeTrain, b: MergeTrain): number => a.createdAt - b.createdAt || (a.candidate ?? 0) - (b.candidate ?? 0) || a.trainId.localeCompare(b.trainId);

export interface CurrentCandidates {
  /** Each contributor's newest train in the race, in order of the contributor's first entry. */
  heads: MergeTrain[];
  /** Superseded heads (older trains of the same contributor), oldest first: "details" only. */
  old: MergeTrain[];
}

/** One head per contributor. The candidate index is not stable (every push that joins gets a new one), so it is not used. */
export function currentCandidates(race: Pick<Race, "raceId">, trains: readonly MergeTrain[]): CurrentCandidates {
  const groups = new Map<string, MergeTrain[]>();
  for (const t of trains) {
    if (t.raceId !== race.raceId) continue;
    const k = contributorKey(t);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const ordered = [...groups.values()].map((g) => [...g].sort(byAge)).sort((a, b) => byAge(a[0]!, b[0]!));
  return { heads: ordered.map((g) => g.at(-1)!), old: ordered.flatMap((g) => g.slice(0, -1)).sort(byAge) };
}

/** "w1@kyle" for agent `w1@kyle@kaikeru.com` (claim: its model), "kyle" for a human push, the model (or "c2") for drones. */
export function whoOf(t: Pick<MergeTrain, "origin" | "model" | "candidate">): { who: string; claim: string | null } {
  const o = t.origin;
  if (o?.kind === "agent") {
    const at = o.id.indexOf("@");
    const name = at > 0 ? o.id.slice(0, at) : o.id;
    const owner = at > 0 ? (o.id.slice(at + 1).split("@")[0] ?? "") : "";
    return { who: owner ? `${name}@${owner}` : name, claim: o.model ?? null };
  }
  if (o?.kind === "human") return { who: o.id.split("@")[0] || o.id, claim: null };
  return { who: t.model ?? `c${(t.candidate ?? 0) + 1}`, claim: null };
}

export interface CandidateRow {
  train: MergeTrain;
  key: string;
  /** "c2" */
  tag: string;
  who: string;
  claim: string | null;
  origin: OriginBadge;
  status: CandidateStatus;
  /** http(s) only, and never for a rejected (lost, reworking) head. */
  previewUrl: string | null;
  /** PICKING and passed: Pick / Reject apply. */
  pickable: boolean;
}

const PREVIEW_KINDS = new Set<CandidateKind>(["building", "gating", "passed", "failed", "won"]);
const httpUrl = (u: string | null | undefined): string | null => (u && /^https?:\/\//i.test(u) ? u : null);

export function candidateRows(race: Race, trains: readonly MergeTrain[], now: number): { heads: CandidateRow[]; old: MergeTrain[] } {
  const { heads, old } = currentCandidates(race, trains);
  return {
    heads: heads.map((t) => {
      const status = candidateStatus(t, race, now);
      const { who, claim } = whoOf(t);
      return {
        train: t,
        key: contributorKey(t),
        tag: `c${(t.candidate ?? 0) + 1}`,
        who,
        claim,
        origin: originBadge(t.origin, t.attemptId),
        status,
        previewUrl: PREVIEW_KINDS.has(status.kind) ? httpUrl(t.previewUrl) : null,
        pickable: race.state === "PICKING" && status.kind === "passed",
      };
    }),
    old,
  };
}

/** An item's races: open ones first, then newest first. The card uses the first; the rest go to "details". */
export function racesForItem(races: Readonly<Record<string, Race>>, itemId: string): Race[] {
  return Object.values(races)
    .filter((r) => r.itemId === itemId)
    .sort((a, b) => Number(isOpenRace(b)) - Number(isOpenRace(a)) || b.createdAt - a.createdAt);
}

/** The root of an item: its `rootId` when known, else the highest ancestor the state holds. Null when the item is unknown. */
export function rootOf(items: Readonly<Record<string, WorkItem>>, id: string): WorkItem | null {
  let cur = items[id];
  if (!cur) return null;
  const byRoot = items[cur.rootId];
  if (byRoot && !byRoot.parentId) return byRoot;
  for (let i = 0; i < 8 && cur.parentId && items[cur.parentId]; i++) cur = items[cur.parentId]!;
  return cur;
}

/** The items that get a race card: the root's children in filed order, or the root itself (a loose item, a goal not split yet). */
export function cardItems(state: Pick<State, "items" | "itemOrder">, root: WorkItem): WorkItem[] {
  const children = state.itemOrder.map((id) => state.items[id]).filter((i): i is WorkItem => !!i && i.parentId === root.itemId);
  return children.length ? children : [root];
}

export interface CardSummary {
  item: WorkItem;
  /** The newest (open first) race, or null. */
  race: Race | null;
  /** The item's other races (ABANDONED and older): "details" only. */
  olderRaces: Race[];
  status: RaceStatus;
  heads: CandidateRow[];
  old: MergeTrain[];
  /** Every BUILD train of the item, in creation order (attempt history). */
  trains: MergeTrain[];
}

export function cardSummary(state: StatusSlice, item: WorkItem, now: number): CardSummary {
  const [race = null, ...olderRaces] = racesForItem(state.races, item.itemId);
  const all = state.trainOrder.map((id) => state.trains[id]).filter((t): t is MergeTrain => !!t);
  const trains = all.filter((t) => isBuildTrain(t) && itemIdOf(t) === item.itemId);
  const raceTrains = race ? all.filter((t) => t.raceId === race.raceId) : [];
  const { heads, old } = race ? candidateRows(race, raceTrains, now) : { heads: [], old: [] };
  const status = raceStatus(race, raceTrains, item, { now, external: isExternal(state.hive), subState: itemSubState(state, item) });
  return { item, race, olderRaces, status, heads, old, trains };
}

const RANK: Record<RaceChipKind, number> = { picking: 0, reworking: 1, racing: 2, building: 3, awaiting: 4, failed: 5, abandoned: 6, decided: 7, landed: 8, cancelled: 9 };

/** A goal row's chip: the most urgent card (you pick first), unless the root itself landed or was cancelled. */
export function goalStatus(root: WorkItem, cards: readonly Pick<CardSummary, "status">[]): RaceStatus {
  if (LANDED.has(root.status)) return rs("landed", "landed", "green");
  if (root.status === "CANCELLED" || root.status === "DUPLICATE") return rs("cancelled", root.status.toLowerCase(), "muted");
  let best: RaceStatus | null = null;
  for (const c of cards) if (!best || RANK[c.status.kind] < RANK[best.kind]) best = c.status;
  return best ?? rs("building", root.status.toLowerCase(), "cyan");
}

const COUNT_ORDER: [CandidateKind, string][] = [["passed", "passed"], ["building", "building"], ["gating", "gating"], ["reworking", "rework"], ["failed", "failed"]];

/** "2 passed, 1 rework" over the heads of open races; "1 of 3 landed" for a split goal with none; "" otherwise. */
export function goalSummary(cards: readonly CardSummary[]): string {
  const n = new Map<CandidateKind, number>();
  for (const c of cards) {
    if (!c.race || !isOpenRace(c.race)) continue;
    for (const h of c.heads) n.set(h.status.kind, (n.get(h.status.kind) ?? 0) + 1);
  }
  const parts = COUNT_ORDER.filter(([k]) => n.get(k)).map(([k, label]) => `${n.get(k)} ${label}`);
  if (parts.length) return parts.join(", ");
  if (cards.length > 1) return `${cards.filter((c) => c.status.kind === "landed").length} of ${cards.length} landed`;
  return "";
}

export interface AgentTile {
  /** `${trainId}:${kind}`: a new key per state change, so the tile remounts and its CSS animation plays. */
  key: string;
  trainId: string;
  kind: CandidateKind;
  /** Passed or won; hollow = gating, building, reworking or failed. */
  filled: boolean;
  /** Hover text: who, the claimed model, the verdict. */
  title: string;
}

export interface AgentTileGroup {
  raceId: string;
  /** The race's next deadline (entries, decision or pick) is under a minute away: the outline rings. */
  lastMinute: boolean;
  tiles: AgentTile[];
}

function nextDeadline(race: Race, now: number): number | null {
  if (race.state === "PICKING") return race.pickDeadlineAt ?? null;
  if (race.state === "RACING") return race.entryClosesAt != null && race.entryClosesAt > now ? race.entryClosesAt : race.deadlineAt;
  return null;
}

/** One tile per live candidate of each open race, grouped per race (spec §3.5). Lost heads get no tile. */
export function agentTiles(cards: readonly CardSummary[], now: number): AgentTileGroup[] {
  const out: AgentTileGroup[] = [];
  for (const c of cards) {
    if (!c.race || !isOpenRace(c.race)) continue;
    const tiles = c.heads
      .filter((h) => h.status.kind !== "lost")
      .map((h) => ({
        key: `${h.train.trainId}:${h.status.kind}`,
        trainId: h.train.trainId,
        kind: h.status.kind,
        filled: h.status.kind === "passed" || h.status.kind === "won",
        title: `${h.who}${h.claim ? ` · claims ${h.claim}` : ""} · ${h.status.text}`,
      }));
    if (!tiles.length) continue;
    const d = nextDeadline(c.race, now);
    out.push({ raceId: c.race.raceId, lastMinute: d != null && d > now && d - now <= 60_000, tiles });
  }
  return out;
}

/** Follow-ups and self-filed bugs: a loose item the swarm filed, not a person. */
export const isFollowUp = (item: Pick<WorkItem, "parentId" | "source">): boolean =>
  !item.parentId && (item.source.kind === "drone" || item.source.kind === "gatekeeper" || item.source.kind === "sentinel");

export interface GoalRow {
  root: WorkItem;
  cards: CardSummary[];
  status: RaceStatus;
  summary: string;
  tiles: AgentTileGroup[];
  followUp: boolean;
  /** Landed or cancelled: sorted after the active rows. */
  done: boolean;
}

export function goalRow(state: StatusSlice, root: WorkItem, now: number): GoalRow {
  const cards = cardItems(state, root).map((i) => cardSummary(state, i, now));
  const status = goalStatus(root, cards);
  return { root, cards, status, summary: goalSummary(cards), tiles: agentTiles(cards, now), followUp: isFollowUp(root), done: status.kind === "landed" || status.kind === "cancelled" };
}

/** The home GOALS list: one row per root (loose items are their own roots), active before done, newest first. */
export function goalRows(state: StatusSlice, now: number): GoalRow[] {
  return state.itemOrder
    .map((id) => state.items[id])
    .filter((i): i is WorkItem => !!i && (!i.parentId || !state.items[i.parentId]))
    .map((root) => goalRow(state, root, now))
    .sort((a, b) => Number(a.done) - Number(b.done) || b.root.createdAt - a.root.createdAt);
}

export interface PickRow {
  race: Race;
  item: WorkItem;
  root: WorkItem;
  status: RaceStatus;
  /** The pickable heads (passed, not rejected). */
  heads: CandidateRow[];
}

/** Every PICKING race for Needs you, the soonest auto-pick first. Races whose item the state does not hold are skipped. */
export function pickingRows(state: StatusSlice, now: number): PickRow[] {
  const all = state.trainOrder.map((id) => state.trains[id]).filter((t): t is MergeTrain => !!t);
  return Object.values(state.races)
    .filter((r) => r.state === "PICKING" && state.items[r.itemId])
    .sort((a, b) => (a.pickDeadlineAt ?? Infinity) - (b.pickDeadlineAt ?? Infinity) || a.createdAt - b.createdAt)
    .map((race) => {
      const item = state.items[race.itemId]!;
      const trains = all.filter((t) => t.raceId === race.raceId);
      return { race, item, root: rootOf(state.items, item.itemId) ?? item, status: raceStatus(race, trains, item, { now, external: isExternal(state.hive) }), heads: candidateRows(race, trains, now).heads.filter((h) => h.pickable) };
    });
}

export type HiveMood = "calm" | "racing" | "needs-you" | "degraded";

export interface HomeHeadline {
  mood: HiveMood;
  /** "2 races running, 1 waiting for your pick" / "All quiet · landed 4 today". */
  text: string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function homeHeadline(state: StatusSlice): HomeHeadline {
  const races = Object.values(state.races);
  const racing = races.filter((r) => r.state === "RACING").length;
  const picking = races.filter((r) => r.state === "PICKING").length;
  const reworking = races.filter((r) => r.state === "REWORKING").length;
  const escalations = openEscalations(state).length;
  const h = state.hive;
  const degraded = !!h && (h.effectiveAutonomy !== h.settings.autonomy || h.effectiveAutonomy === "paused");
  const raced = new Set(races.filter(isOpenRace).map((r) => r.itemId));
  const busy = Object.values(state.items).filter((i) => (i.status === "ACTIVE" || i.status === "DECOMPOSING") && !raced.has(i.itemId)).length;
  const parts: string[] = [];
  if (racing) parts.push(`${plural(racing, "race")} running`);
  if (picking) parts.push(`${picking} waiting for your pick`);
  if (reworking) parts.push(`${reworking} reworking`);
  if (escalations) parts.push(plural(escalations, "escalation"));
  if (busy) parts.push(`${plural(busy, "item")} in progress`);
  if (degraded && h) parts.push(`autonomy ${autonomyLabel(h)}`);
  const mood: HiveMood = picking || escalations ? "needs-you" : degraded ? "degraded" : racing || reworking || busy ? "racing" : "calm";
  const landed = h?.throughput.landed24h ?? landedCount(state);
  return { mood, text: parts.length ? parts.join(", ") : `All quiet · landed ${landed} today` };
}

/** Live state with an item's REST detail folded in; live rows win (they are newer). */
export function withDetail<S extends Pick<State, "trains" | "trainOrder" | "items" | "itemOrder" | "races">>(state: S, detail: Pick<ItemDetail, "item" | "children" | "trains" | "races"> | null | undefined): S {
  if (!detail) return state;
  const trains: Record<string, MergeTrain> = { ...Object.fromEntries(detail.trains.map((t) => [t.trainId, t])), ...state.trains };
  const trainOrder = [...state.trainOrder, ...detail.trains.map((t) => t.trainId).filter((id) => !state.trains[id])].sort((a, b) => trains[a]!.createdAt - trains[b]!.createdAt);
  const fetched = [detail.item, ...detail.children];
  const items: Record<string, WorkItem> = { ...Object.fromEntries(fetched.map((i) => [i.itemId, i])), ...state.items };
  const itemOrder = [...state.itemOrder, ...[...new Set(fetched.map((i) => i.itemId))].filter((id) => !state.items[id])].sort((a, b) => items[a]!.createdAt - items[b]!.createdAt);
  const races: Record<string, Race> = { ...Object.fromEntries(detail.races.map((r) => [r.raceId, r])), ...state.races };
  return { ...state, trains, trainOrder, items, itemOrder, races };
}

/** The Queen's `goal/<slug>` addressing (apps/queen/src/work/inbox.ts `slugify`): lowercase `[a-z0-9-]`, ≤ 64. */
export function titleSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** The goal page's push command: `goal/<slug>/<your-agent-name>` for a goal with a sluggable title, else `item/<id>/<your-agent-name>`. */
export function pushCommand(item: Pick<WorkItem, "itemId" | "kind" | "title">): string {
  const slug = item.kind === "goal" ? titleSlug(item.title) : "";
  return slug ? `git push origin HEAD:goal/${slug}/<your-agent-name>` : itemPushCommand(item.itemId);
}

/**
 * Keys that appeared after the first call (state changes, never the page load). Stays fresh for the session, so a class
 * built from it never flips back mid-animation. Mutates and returns `memo.fresh`; keep `memo` in a `useRef`.
 */
export function trackFresh(memo: { seen: Set<string> | null; fresh: Set<string> }, keys: readonly string[]): ReadonlySet<string> {
  if (memo.seen) for (const k of keys) if (!memo.seen.has(k)) memo.fresh.add(k);
  memo.seen = new Set([...(memo.seen ?? []), ...keys]);
  return memo.fresh;
}

export const raceChipClass = (s: Pick<RaceStatus, "tone" | "pulse">): string => `race-chip race-chip--${s.tone}${s.pulse ? " race-chip--pulse" : ""}`;
export const candChipClass = (s: Pick<CandidateStatus, "kind">): string => `cand-chip cand-chip--${s.kind}`;
