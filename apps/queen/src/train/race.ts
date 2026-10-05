/**
 * Best-of-N races (v2 design §2.3.6). Pure: no I/O, no clock, no randomness.
 *
 * A race is w BUILD trains of one item, all forked from hive main at the same
 * moment, each on a different model (router.routeRace). Only the winner boards
 * a merge-queue car. This module holds the policy pieces the planners share:
 * - raceWidth(): how many candidates an item gets (pin, bestOf, rework / hard
 *   defaults, guardrail cap, free slots, budget);
 * - rankCandidates(): the deterministic, lexicographic winner order;
 * - buildCredits() / EST_BUILD_CREDITS: credits (weighted tokens, §2.9).
 */
import {
  GENERATED_PATHS,
  GUARDRAIL_DEFAULTS,
  MODEL_CATALOG,
  pathsOverlap,
  type BuildUsage,
  type CatalogModel,
  type Difficulty,
  type GateScore,
  type ModelTier,
} from "@queenos/queen-types";

/** Tokens a typical Think tool-loop build spends (the transcript is re-sent every step, so input dominates). */
export const EST_BUILD_TOKENS = 100_000;

/**
 * Estimated credits of one build per model tier, for the race budget check:
 * EST_BUILD_TOKENS / 1000 × the dearest builder model's catalog cost in that
 * tier (light has no builder; priced at cost 1). Credits are weighted tokens,
 * a guardrail and not billing (§2.9, R18).
 */
export const EST_BUILD_CREDITS: Readonly<Record<ModelTier, number>> = { light: 100, fast: 300, frontier: 900 };

/** Defaults of HiveSettings.race (HIVE_SETTINGS_DEFAULTS). */
export const DEFAULT_RACE_WIDTHS = { reworkWidth: 2, hardWidth: 3 } as const;

export interface RaceWidthInput {
  action: "BUILD" | "REWORK";
  /** The item's explicit best-of-N (wins over the defaults). */
  bestOf?: number | null;
  difficulty?: Difficulty | null;
  /** MODEL_ROUTER_PIN_BUILDER: a pinned model cannot race. */
  modelPin?: string | null;
  /** HiveSettings.race. */
  race?: { reworkWidth: number; hardWidth: number };
  /** Guardrails.maxRaceWidth (default 3). */
  maxRaceWidth?: number;
  /** Build slots still free (absent = unlimited). */
  slotsFree?: number;
  /** Daily credits left (null / absent = no budget check). */
  remainingCredits?: number | null;
  /** Tier the candidates are priced at (default: frontier for REWORK, fast for BUILD). */
  tier?: ModelTier;
}

/**
 * The race width policy (§2.3.6):
 * ```
 * if modelPin → 1
 * w = bestOf ?? (REWORK ? reworkWidth : hard ? hardWidth : 1)
 * w = min(w, maxRaceWidth, slotsFree)        (minimum 1)
 * if remainingCredits < w × EST_BUILD_CREDITS[tier] → 1
 * ```
 */
export function raceWidth(input: RaceWidthInput): number {
  if (input.modelPin?.trim()) return 1;
  const race = input.race ?? DEFAULT_RACE_WIDTHS;
  let w = input.bestOf ?? (input.action === "REWORK" ? race.reworkWidth : input.difficulty === "hard" ? race.hardWidth : 1);
  w = Math.min(w, input.maxRaceWidth ?? GUARDRAIL_DEFAULTS.maxRaceWidth, input.slotsFree ?? Number.POSITIVE_INFINITY);
  w = Math.max(1, Math.floor(Number.isFinite(w) ? w : 1));
  if (w > 1 && input.remainingCredits !== null && input.remainingCredits !== undefined) {
    const tier = input.tier ?? (input.action === "REWORK" ? "frontier" : "fast");
    if (input.remainingCredits < w * EST_BUILD_CREDITS[tier]) return 1;
  }
  return w;
}

/** Credits of one build: (input + output tokens) / 1000 × the model's catalog cost; null when unknown. */
export function buildCredits(usage: BuildUsage | undefined | null, model: string | null | undefined, catalog: readonly CatalogModel[] = MODEL_CATALOG): number | null {
  if (!usage || !model) return null;
  const cost = catalog.find((m) => m.id === model)?.cost;
  if (cost === undefined) return null;
  return Math.round(((usage.inputTokens + usage.outputTokens) / 1000) * cost * 100) / 100;
}

/** What rankCandidates needs to know about a race candidate. */
export interface RaceCandidate {
  trainId: string;
  /** Index within the race (the final tie-break). */
  candidate: number;
  passed: boolean;
  score?: GateScore | null;
  /** The builder's Think `verify` tool passed. */
  verified?: boolean | null;
  /** Paths the build changed (BuildResult.changedPaths). */
  changedPaths?: readonly string[] | null;
  credits?: number | null;
  /** For the reason text. */
  model?: string | null;
}

/**
 * Claimed paths outside the item's predicted `paths` (merge risk). Generated
 * paths never count; an item with no prediction has no risk signal (0).
 */
export function pathRisk(changedPaths: readonly string[] | null | undefined, predicted: readonly string[]): number {
  if (!predicted.length || !changedPaths?.length) return 0;
  const generated: readonly string[] = GENERATED_PATHS;
  return changedPaths.filter((p) => !generated.includes(p) && pathsOverlap([p], predicted).length === 0).length;
}

interface Key {
  name: string;
  /** Lower sorts first. */
  value: (c: RaceCandidate) => number;
  /** Why `a` beat `b` on this key. */
  why: (a: RaceCandidate, b: RaceCandidate) => string;
}

const reviewRank = (c: RaceCandidate) => (c.score?.review === "approved" ? 0 : 1);
const counts = (c: RaceCandidate) => (c.score ? `${c.score.satisfied}/${c.score.missing}` : "?");

export function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function keys(predicted: readonly string[]): Key[] {
  const bytes = (c: RaceCandidate) => c.score?.changedBytes ?? Number.POSITIVE_INFINITY;
  const credits = (c: RaceCandidate) => c.credits ?? Number.POSITIVE_INFINITY;
  return [
    { name: "gate", value: (c) => (c.passed ? 0 : 1), why: () => "gate passed" },
    { name: "review", value: reviewRank, why: (a) => `reviewer ${a.score?.review ?? "approved"} (${counts(a)})` },
    {
      name: "missing",
      value: (c) => c.score?.missing ?? Number.POSITIVE_INFINITY,
      why: (a, b) => `fewer missing criteria (${a.score?.missing ?? "?"} vs ${b.score?.missing ?? "?"})`,
    },
    {
      name: "satisfied",
      value: (c) => -(c.score?.satisfied ?? -1),
      why: (a, b) => `more satisfied criteria (${a.score?.satisfied ?? "?"} vs ${b.score?.satisfied ?? "?"})`,
    },
    { name: "verified", value: (c) => (c.verified ? 0 : 1), why: () => "builder verify passed" },
    {
      name: "pathRisk",
      value: (c) => pathRisk(c.changedPaths, predicted),
      why: (a, b) => `fewer paths outside the prediction (${pathRisk(a.changedPaths, predicted)} vs ${pathRisk(b.changedPaths, predicted)})`,
    },
    {
      name: "changedBytes",
      value: bytes,
      why: (a, b) => `${Number.isFinite(bytes(a)) ? kb(bytes(a)) : "?"} vs ${Number.isFinite(bytes(b)) ? kb(bytes(b)) : "?"}`,
    },
    { name: "credits", value: credits, why: (a, b) => `fewer credits (${a.credits ?? "?"} vs ${b.credits ?? "?"})` },
    { name: "candidate", value: (c) => c.candidate, why: (a) => `lower candidate index (${a.candidate})` },
  ];
}

export interface RaceRanking {
  /** Best first. */
  ranked: RaceCandidate[];
  winner: RaceCandidate | null;
  /** Why the winner won, e.g. `won: reviewer approved (4/0), 3.1 KB vs 9.8 KB; DeepSeek V4 Pro` (≤ 300 chars). */
  reason: string;
  /** Per loser trainId: why it lost to the winner (the first deciding key). */
  lostBecause: Record<string, string>;
}

/**
 * Deterministic, lexicographic ranking (§2.3.6):
 * 1. gate passed; 2. reviewer approved > skipped/off; 3. fewer missing, then
 * more satisfied; 4. builder verified; 5. fewer claimed paths outside the
 * item's predicted `paths`; 6. smaller changedBytes; 7. fewer credits;
 * 8. lower candidate index. Missing fields (a pre-v2 gate) rank last on their
 * key, so a pre-v2 race still decides on pass/fail and index.
 */
export function rankCandidates(
  candidates: readonly RaceCandidate[],
  opts: { predictedPaths?: readonly string[]; catalog?: readonly CatalogModel[] } = {},
): RaceRanking {
  const ks = keys(opts.predictedPaths ?? []);
  const cmp = (a: RaceCandidate, b: RaceCandidate) => {
    for (const k of ks) {
      const d = k.value(a) - k.value(b);
      if (d !== 0 && !Number.isNaN(d)) return d;
    }
    return 0;
  };
  const ranked = [...candidates].sort(cmp);
  const winner = ranked[0] ?? null;
  const lostBecause: Record<string, string> = {};
  if (!winner) return { ranked, winner, reason: "no candidates", lostBecause };
  const decidingKey = (loser: RaceCandidate) => ks.find((k) => k.value(winner) < k.value(loser)) ?? ks.at(-1)!;
  for (const l of ranked.slice(1)) lostBecause[l.trainId] = decidingKey(l).why(winner, l);

  const runnerUp = ranked[1];
  const parts: string[] = [];
  if (winner.score) parts.push(`reviewer ${winner.score.review} (${counts(winner)})`);
  if (runnerUp) {
    const k = decidingKey(runnerUp);
    const text = k.why(winner, runnerUp);
    if (!parts.includes(text)) parts.push(text);
    const wb = winner.score?.changedBytes;
    const rb = runnerUp.score?.changedBytes;
    if (k.name !== "changedBytes" && wb !== undefined && rb !== undefined) parts.push(`${kb(wb)} vs ${kb(rb)}`);
  } else {
    parts.push("only candidate");
  }
  const label = winner.model ? ((opts.catalog ?? MODEL_CATALOG).find((m) => m.id === winner.model)?.label ?? winner.model) : null;
  const reason = `won: ${parts.join(", ")}${label ? `; ${label}` : ""}`;
  return { ranked, winner, reason: clip(reason, 300), lostBecause };
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
