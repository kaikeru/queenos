/**
 * Model router (pure: no I/O, no clock, no randomness). Every LLM call goes
 * through the Workers `ai` binding and AI Gateway, so any catalog model is one
 * string away; picking the right one for each drone task is a Queen decision.
 *
 * route() / chooseModel():
 * 1. Candidates: catalog models whose `roles` include the role and whose
 *    context window fits: ceil(promptChars / 3) + CONTEXT_HEADROOM_TOKENS.
 * 2. Starting tier:
 *    - first BUILD attempt (role builder, attempt 1): the hive's *floor* tier
 *      (see below), or one tier under it when a probe is due;
 *    - REWORK, or any attempt >= 2: `frontier` (escalation stays local to the
 *      prompt and never moves the floor).
 * 3. Value, not raw pass rate: expected cost per success. For each candidate
 *      rate  = (passes + 1) / (attempts + 2)                (Laplace-smoothed)
 *              - STREAK_PENALTY * min(failStreak, MAX_STREAK_PENALIZED)
 *      value = max(rate, MIN_RATE) / cost  (x SLOW_FACTOR for slow models)
 *    A model is slow when listed in SLOW_MODEL_HINTS (real-account bake-off:
 *    GLM-5.3 reasons for up to ~150 s against the drones' 200 s generation
 *    budget) or when its hive avgBuildMs exceeds SLOW_BUILD_MS.
 *    Candidates are every fitting model in the starting tier *or above*,
 *    ranked by value desc, then lower cost, then catalog order. So a cheap
 *    80% model beats an expensive 95% one, and a frontier model only wins a
 *    fast-floor build when the fast models' record makes it cheaper per
 *    success. A probe is restricted to its tier. If nothing fits at or above
 *    the starting tier, the nearest tier below is used; if nothing fits at
 *    all, the role model with the largest context window.
 * 4. Exploration: every EXPLORE_EVERY-th router decision in a hive
 *    (`dispatchIndex % EXPLORE_EVERY === 0`, 1-based) picks the least-tried
 *    candidate in the chosen model's tier (fewest attempts, then value order).
 * 5. Fallbacks: the next best candidates in the chosen tier, then the best one
 *    tier up, at most MAX_FALLBACKS.
 * 6. Pin (MODEL_ROUTER_PIN_BUILDER) forces the model for builder and rework
 *    tasks; fallbacks are still ranked, the floor's dispatch counters do not move.
 *
 * The floor (per hive, persisted; AIMD with probing). Only first-attempt
 * builder dispatches ("floor-routed") read or move it:
 * - starts at `fast`; never below the cheapest tier holding a builder model;
 * - a gate failure or an unusable change set on a floor-routed build raises
 *   it one tier (cap frontier) and resets both streaks;
 * - BACKOFF_STREAK consecutive passes routed at the floor tier lower it one tier;
 * - probe-down: while the floor sits above the cheapest builder tier, after
 *   PROBE_AFTER consecutive floor dispatches the next one tries one tier lower
 *   ("probe: trying fast tier again"); a pass there drops the floor to that
 *   tier at once, a failure leaves it (already raised) and the count restarts;
 * - a change leaves a `note` that prefixes the next floor-routed reason.
 */
import { MODEL_CATALOG, type CatalogModel, type ModelChoice, type ModelStats, type ModelTier, type RouterFloor } from "@queenos/queen-types";

export type RouterRole = "builder" | "rework";

/** ModelStats plus the Queen-internal consecutive-failure count. */
export type RouterStats = ModelStats & { failStreak?: number };

/** Per-hive tier floor for first-attempt builds (persisted; RouterFloor is its War Room view). */
export interface FloorState {
  tier: ModelTier;
  /** Consecutive gate passes routed at the floor tier. */
  passStreak: number;
  /** Consecutive floor dispatches while the floor is above the cheapest builder tier. */
  aboveStreak: number;
  /** Why the floor last changed; shown on the next floor-routed choice, then cleared. */
  note: string | null;
}

export interface RouterPolicy {
  /** K: clean builds at the floor before it backs off a tier. */
  backoffStreak: number;
  /** N: floor dispatches above the cheapest tier before a probe one tier lower. */
  probeAfter: number;
}

export const DEFAULT_POLICY: RouterPolicy = { backoffStreak: 3, probeAfter: 4 };
export const INITIAL_FLOOR: FloorState = { tier: "fast", passStreak: 0, aboveStreak: 0, note: null };

export interface ChooseModelInput {
  role: RouterRole;
  /** 1 for a first BUILD; >= 2 for reworks and re-dispatches. */
  attempt: number;
  /** Prompt text plus any Scribe summary the drone will read. */
  promptChars: number;
  stats: readonly RouterStats[];
  catalog?: readonly CatalogModel[];
  pin?: string | null;
  /** 1-based count of router decisions in this hive, this one included (exploration cadence). */
  dispatchIndex?: number;
  floor?: FloorState;
  policy?: RouterPolicy;
}

export interface RouteResult {
  choice: ModelChoice;
  /** The floor after this dispatch (counters advanced, note consumed). */
  floor: FloorState;
  /** Whether this was a probe one tier under the floor. */
  probe: boolean;
  /** Whether this dispatch was routed by the floor (first-attempt builder). */
  floorRouted: boolean;
}

export const TIERS: readonly ModelTier[] = ["light", "fast", "frontier"];
export const CHARS_PER_TOKEN = 3;
export const CONTEXT_HEADROOM_TOKENS = 65_536;
export const STREAK_PENALTY = 0.05;
export const MAX_STREAK_PENALIZED = 3;
export const MIN_RATE = 0.01;
export const EXPLORE_EVERY = 5;
export const SLOW_FACTOR = 0.8;
export const SLOW_BUILD_MS = 120_000;
export const SLOW_MODEL_HINTS: ReadonlySet<string> = new Set(["@cf/zai-org/glm-5.3"]);
export const MAX_FALLBACKS = 2;

const tierIdx = (t: ModelTier) => TIERS.indexOf(t);

export function estimateTokens(promptChars: number): number {
  return Math.ceil(Math.max(0, promptChars) / CHARS_PER_TOKEN) + CONTEXT_HEADROOM_TOKENS;
}

/** Cheapest tier holding a builder model: the floor's lower bound. */
export function cheapestBuilderTier(catalog: readonly CatalogModel[] = MODEL_CATALOG): ModelTier {
  return TIERS.find((t) => catalog.some((m) => m.tier === t && m.roles.includes("builder"))) ?? "fast";
}

function clampFloor(tier: ModelTier, catalog: readonly CatalogModel[]): ModelTier {
  const min = cheapestBuilderTier(catalog);
  return tierIdx(tier) < tierIdx(min) ? min : tier;
}

interface Ranked {
  model: CatalogModel;
  index: number;
  attempts: number;
  passes: number;
  value: number;
}

function rank(models: { model: CatalogModel; index: number }[], role: RouterRole, stats: readonly RouterStats[]): Ranked[] {
  return models
    .map(({ model, index }) => {
      const s = stats.find((x) => x.model === model.id && x.role === role);
      const attempts = s?.attempts ?? 0;
      const passes = s?.passes ?? 0;
      const streak = Math.min(s?.failStreak ?? 0, MAX_STREAK_PENALIZED);
      const rate = Math.max(MIN_RATE, (passes + 1) / (attempts + 2) - STREAK_PENALTY * streak);
      const slow = SLOW_MODEL_HINTS.has(model.id) || (s?.avgBuildMs ?? 0) > SLOW_BUILD_MS;
      return { model, index, attempts, passes, value: (rate / model.cost) * (slow ? SLOW_FACTOR : 1) };
    })
    .sort((a, b) => b.value - a.value || a.model.cost - b.model.cost || a.index - b.index);
}

function floorLabel(floor: FloorState, policy: RouterPolicy, catalog: readonly CatalogModel[]): string {
  const lowest = tierIdx(floor.tier) <= tierIdx(cheapestBuilderTier(catalog));
  if (lowest) return `floor: ${floor.tier}`;
  const probeIn = Math.max(0, policy.probeAfter - floor.aboveStreak);
  return `floor: ${floor.tier} · ${floor.passStreak}/${policy.backoffStreak} to back off · probe in ${probeIn}`;
}

/** The War Room view of the floor (snapshot.routerFloor / models.updated.floor). */
export function toRouterFloor(state: FloorState, policy: RouterPolicy = DEFAULT_POLICY, catalog: readonly CatalogModel[] = MODEL_CATALOG): RouterFloor {
  const tier = clampFloor(state.tier, catalog);
  const above = tierIdx(tier) > tierIdx(cheapestBuilderTier(catalog));
  return {
    tier,
    streak: state.passStreak,
    backoffAfter: policy.backoffStreak,
    probeIn: above ? Math.max(0, policy.probeAfter - state.aboveStreak) : null,
  };
}

/** Whether the router tracks this model (scripted drones and unknown pins are not catalog models). */
export function isCatalogModel(id: string, catalog: readonly CatalogModel[] = MODEL_CATALOG): boolean {
  return catalog.some((m) => m.id === id);
}

export function chooseModel(input: ChooseModelInput): ModelChoice {
  return route(input).choice;
}

export function route(input: ChooseModelInput): RouteResult {
  const catalog = input.catalog ?? MODEL_CATALOG;
  const policy = input.policy ?? DEFAULT_POLICY;
  const { role, attempt, stats } = input;
  const pin = input.pin?.trim() || null;
  const floorIn: FloorState = { ...(input.floor ?? INITIAL_FLOOR) };
  floorIn.tier = clampFloor(floorIn.tier, catalog);

  // ── starting tier (floor / probe / escalation) ──
  const floorRouted = role === "builder" && attempt <= 1;
  let wanted: ModelTier = "frontier";
  let probe = false;
  let floor = floorIn;
  let note: string | null = null;
  if (floorRouted) {
    wanted = floorIn.tier;
    const above = tierIdx(floorIn.tier) > tierIdx(cheapestBuilderTier(catalog));
    if (!pin) {
      if (above && floorIn.aboveStreak >= policy.probeAfter) {
        probe = true;
        wanted = TIERS[tierIdx(floorIn.tier) - 1]!;
        floor = { ...floorIn, aboveStreak: 0, note: null };
      } else {
        floor = { ...floorIn, aboveStreak: above ? floorIn.aboveStreak + 1 : 0, note: null };
      }
      note = floorIn.note;
    }
  }
  const escalation = role === "rework" ? "rework → escalated to frontier" : attempt >= 2 ? `attempt ${attempt} → escalated to frontier` : null;

  // ── candidates ──
  const need = estimateTokens(input.promptChars);
  const fits = catalog.map((model, index) => ({ model, index })).filter(({ model }) => model.roles.includes(role) && model.contextWindow >= need);
  const w = tierIdx(wanted);
  let pool = probe ? fits.filter((c) => c.model.tier === wanted) : fits.filter((c) => tierIdx(c.model.tier) >= w);
  if (probe && pool.length === 0) {
    probe = false;
    pool = fits.filter((c) => tierIdx(c.model.tier) >= tierIdx(floorIn.tier));
  }
  if (pool.length === 0) {
    const below = TIERS.slice(0, w).reverse().find((t) => fits.some((c) => c.model.tier === t));
    pool = below ? fits.filter((c) => c.model.tier === below) : [];
  }
  const floorText = floorRouted && !pin ? floorLabel(floor, policy, catalog) : null;
  const join = (...parts: (string | null)[]) => clip(parts.filter(Boolean).join(" · "));

  if (pool.length === 0) {
    const roleModels = catalog.filter((m) => m.roles.includes(role));
    const biggest = [...(roleModels.length ? roleModels : catalog)].sort((a, b) => b.contextWindow - a.contextWindow)[0]!;
    const model = pin ?? biggest.id;
    return {
      choice: {
        model,
        tier: catalog.find((m) => m.id === model)?.tier ?? biggest.tier,
        role,
        reason: join(pin ? "pinned by MODEL_ROUTER_PIN_BUILDER" : `no model fits ~${Math.round(need / 1000)}k tokens; largest context window`, floorText),
        fallbacks: [],
      },
      floor,
      probe: false,
      floorRouted,
    };
  }

  const ranked = rank(pool, role, stats);
  let pick = ranked[0]!;
  const tierOf = (r: Ranked) => r.model.tier;
  let detail = pick.attempts > 0 ? `best value ${pick.passes}/${pick.attempts} @ cost ${pick.model.cost}` : "no track record yet; lowest cost";
  const explore = !pin && (input.dispatchIndex ?? 0) > 0 && input.dispatchIndex! % EXPLORE_EVERY === 0;
  if (explore) {
    const sameTier = ranked.filter((r) => tierOf(r) === tierOf(pick));
    const least = [...sameTier].sort((a, b) => a.attempts - b.attempts || ranked.indexOf(a) - ranked.indexOf(b))[0]!;
    if (least !== pick) {
      pick = least;
      detail = `exploring least-tried (${least.attempts} attempt${least.attempts === 1 ? "" : "s"}; every ${EXPLORE_EVERY}th dispatch)`;
    }
  }
  const tier = tierOf(pick);
  const shift =
    tier === wanted
      ? null
      : tierIdx(tier) > w && fits.some((c) => c.model.tier === wanted)
        ? `${tier} beats ${wanted} on cost per success`
        : `${wanted} tier has no fit → ${tier}`;

  const chosen = pin ?? pick.model.id;
  const up = TIERS[tierIdx(tier) + 1];
  const upRanked = up ? rank(fits.filter((c) => c.model.tier === up), role, stats) : [];
  const fallbacks = [
    ...ranked.filter((r) => tierOf(r) === tier && r.model.id !== chosen).map((r) => r.model.id),
    ...upRanked.filter((r) => r.model.id !== chosen).slice(0, 1).map((r) => r.model.id),
  ].slice(0, MAX_FALLBACKS);

  if (pin) {
    return {
      choice: {
        model: pin,
        tier: catalog.find((m) => m.id === pin)?.tier ?? tier,
        role,
        reason: join(`pinned by MODEL_ROUTER_PIN_BUILDER${escalation ? ` (${escalation})` : ""}`),
        fallbacks,
      },
      floor,
      probe: false,
      floorRouted,
    };
  }
  const head = probe ? `probe: trying ${tier} tier again` : `${tier} tier`;
  return {
    choice: { model: chosen, tier, role, reason: join(note, escalation, shift, head, detail, floorText), fallbacks },
    floor,
    probe,
    floorRouted,
  };
}

export type FloorOutcome = "pass" | "gate-fail" | "unusable";

/**
 * Move the floor after a floor-routed build's outcome. `tier` is the tier the
 * build was routed to; `probe` whether it was a probe under the floor.
 */
export function floorAfter(
  floorIn: FloorState,
  outcome: FloorOutcome,
  tier: ModelTier,
  probe: boolean,
  policy: RouterPolicy = DEFAULT_POLICY,
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
): FloorState {
  const floor = { ...floorIn, tier: clampFloor(floorIn.tier, catalog) };
  const i = tierIdx(floor.tier);
  if (outcome !== "pass") {
    const raised = TIERS[Math.min(i + 1, TIERS.length - 1)]!;
    const why = outcome === "gate-fail" ? "a gate failure" : "an unusable change set";
    return {
      tier: raised,
      passStreak: 0,
      aboveStreak: 0,
      note: raised !== floor.tier ? `raised to ${raised} after ${why}` : floor.note,
    };
  }
  if (probe && tierIdx(tier) < i) {
    const dropped = clampFloor(tier, catalog);
    return { tier: dropped, passStreak: 0, aboveStreak: 0, note: `dropped to ${dropped} after a probe passed` };
  }
  if (tier !== floor.tier) return floor;
  const passStreak = floor.passStreak + 1;
  const min = cheapestBuilderTier(catalog);
  if (passStreak >= policy.backoffStreak && i > tierIdx(min)) {
    const lowered = TIERS[i - 1]!;
    return { tier: lowered, passStreak: 0, aboveStreak: 0, note: `backed off to ${lowered} after ${policy.backoffStreak} clean builds` };
  }
  return { ...floor, passStreak: Math.min(passStreak, policy.backoffStreak) };
}

function clip(s: string): string {
  return s.length <= 200 ? s : `${s.slice(0, 199)}…`;
}
