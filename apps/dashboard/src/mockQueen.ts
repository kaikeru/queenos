/**
 * In-browser stand-in for the Queen's War Room socket (VITE_MOCK_API=1 only).
 * Scripts two releases so the release UI can be seen without a backend:
 *   release 1: STAGING -> VALIDATING -> AWAITING_TAP -> (tap) -> canary 1/10/50/100 -> SHIPPED
 *   release 2: same up to canary 50, where Sentinel says ROLLBACK -> ROLLED_BACK
 * Never imported in production builds (see useRoomSocket).
 */
import type { Dispatch } from "react";
import { GUARDRAIL_DEFAULTS } from "@queenos/queen-types";
import type {
  Escalation,
  HiveStatus,
  MergeTrain,
  ModelStats,
  PromptRun,
  QueenEvent,
  QueenServerMessage,
  QueenServerUnitMessage,
  Race,
  RecalledMemory,
  Release,
  RouterFloor,
  SentinelVerdict,
  WorkItem,
} from "@queenos/queen-types";
import { initialState, reducer, type Action, type State } from "./reducer";
import { itemIdOf } from "./swarm";

const STEP_MS = 2500;
const USER = "kyle@kaikeru.com";

const prompts = ["Add rate limiting middleware to the public API", "Add a dark mode toggle to the settings page", "Write a migration that indexes audit_trail by prompt", "Fix the flaky retry logic in the webhook sender"];

const GLM_FLASH = "@cf/zai-org/glm-5.3-flash";
const DEEPSEEK_FLASH = "@cf/deepseek-ai/deepseek-v4-flash-0731";
const QWEN = "@cf/qwen/qwen3.8-27b";
const KIMI = "@cf/moonshotai/kimi-k2.7-code";
const GLM = "@cf/zai-org/glm-5.3";
const GRANITE = "@cf/ibm-granite/granite-4.0-h-micro";

const stat = (model: string, role: ModelStats["role"], attempts: number, passes: number, avgBuildMs: number | null): ModelStats => ({
  model,
  role,
  attempts,
  passes,
  failures: attempts - passes,
  avgBuildMs,
  updatedAt: Date.now(),
});

/** Track record the mock Queen "has learned" before the scripted run starts. */
const baseStats = (): ModelStats[] => [
  stat(GLM_FLASH, "builder", 9, 6, 21_400),
  stat(DEEPSEEK_FLASH, "builder", 5, 4, 26_800),
  stat(QWEN, "builder", 3, 1, 33_100),
  stat(KIMI, "rework", 4, 4, 58_900),
  stat(GLM, "builder", 2, 1, 71_200),
  stat(GRANITE, "scribe", 12, 11, 2_300),
];

const memory = (n: number, outcome: RecalledMemory["outcome"], promptText: string, text: string, score: number, ageMs: number): RecalledMemory => ({
  memoryId: `t-old${n}:${n.toString(16).repeat(12)}`,
  trainId: `t-old${n}`,
  promptId: `p-old${n}`,
  outcome,
  promptText,
  text,
  score,
  createdAt: Date.now() - ageMs,
});

/** What the Provisioner "recalled" for the CSV export build: one reviewer rejection, one pass, one failure. */
const CSV_MEMORIES: RecalledMemory[] = [
  memory(1, "REJECTED_BY_REVIEW", "Add a JSON export to the audit log view", "Builder added a new /features/status route and a button on it.\nReviewer: the prompt asked to change the audit log view at /, not to add a new route. Rejected.\nLesson: edit the existing view in place; do not add routes.", 0.91, 86_400_000),
  memory(2, "PASSED", "Add CSV download to the settings page", "Builder read the loader, added exportCsv() beside the table and wired one button in the existing header.\nGate: build, typecheck and preview smoke test passed.", 0.84, 172_800_000),
  memory(3, "FAILED", "Export audit rows as a spreadsheet", "Builder returned a change set with malformed JSON (unterminated string in a template literal).\nGate: change set rejected before apply.", 0.72, 259_200_000),
];


// ── v2 swarm fixture ──────────────────────────────────────────────────────

const hex = (n: number, len: number) => (n + 1).toString(16).padStart(len, "0").slice(-len);
const traceOf = (n: number) => hex(n * 7919, 32);
const spanOf = (n: number) => hex(n * 104_729, 16);
const MAIN_SHA = "a1f2c3d4e5f60718293a4b5c6d7e8f9012345678";

const SWARM_TITLES = [
  "Pagination on /api/items", "CSV export for reports", "Rate limit headers", "Search box on the index", "Keyboard shortcuts",
  "Retry with backoff in the webhook sender", "Add /version endpoint", "Localise the date format", "Empty state for the dashboard",
  "Sticky table headers", "Copy-to-clipboard buttons", "Cache the status page", "Tooltip for the build badge", "Print stylesheet",
  "Audit log filters", "Favicon per environment", "Compress JSON responses", "Add robots.txt", "Breadcrumbs on detail pages",
  "Dismissible banner", "Sort by column", "Toast on save", "Skeleton loaders", "Humanise durations", "Sitemap.xml", "Error page copy",
  "Link previews", "Cookie notice", "Retry button on failures", "Flaky smoke on /api",
];

export interface SwarmFixture {
  items: WorkItem[];
  trains: MergeTrain[];
  races: Race[];
  escalations: Escalation[];
  hive: HiveStatus;
  events: QueenEvent[];
  /** Timed deltas the mock plays after the snapshot (`at` = ms after start). */
  steps: { at: number; messages: QueenServerUnitMessage[] }[];
}

/** A busy hive: 20+ parallel builds, 3 cars, waiting builds, a conflict, a bisect, a race and an open escalation. */
export function buildSwarmFixture(hive: string, now: number): SwarmFixture {
  const items: WorkItem[] = [];
  const trains: MergeTrain[] = [];
  let n = 0;
  const item = (over: Partial<WorkItem> & Pick<WorkItem, "itemId" | "title">): WorkItem => {
    n++;
    const it: WorkItem = {
      hive,
      kind: "feature",
      body: "",
      acceptance: [],
      priority: 2,
      status: "ACTIVE",
      parentId: null,
      rootId: over.parentId ?? over.itemId,
      depth: over.parentId ? 1 : 0,
      dependsOn: [],
      source: { kind: "oracle", actor: "oracle" },
      traceId: traceOf(1),
      spanId: spanOf(n),
      difficulty: "normal",
      bestOf: null,
      attempts: 0,
      conflicts: 0,
      paths: [],
      waitReason: null,
      duplicateOf: null,
      blockedReason: null,
      releaseId: null,
      escalationId: null,
      createdAt: now - 900_000 + n * 1000,
      updatedAt: now - 5000,
      ...over,
    };
    items.push(it);
    return it;
  };
  const train = (id: string, itemId: string, over: Partial<MergeTrain> = {}): MergeTrain => {
    const t = {
      trainId: id,
      baseSha: MAIN_SHA,
      includedPrompts: [itemId],
      artifactRepo: `${hive}-${id}`,
      status: "BUILDING",
      phase: "BUILDING",
      lane: "BUILD",
      createdAt: now - 70_000 - (trains.length % 9) * 9000,
      model: [GLM_FLASH, DEEPSEEK_FLASH, GLM_FLASH, QWEN][trains.length % 4]!,
      traceId: items.find((i) => i.itemId === itemId)?.traceId ?? null,
      ...over,
    } as MergeTrain;
    trains.push(t);
    return t;
  };

  // The goal: a race, a shipped child, a path-affinity wait and a blocked child.
  const G = "g1";
  item({ itemId: G, title: "Dark mode, a /health page, fix the footer", kind: "goal", status: "ACTIVE", source: { kind: "user", actor: USER }, createdAt: now - 1_200_000 });
  item({ itemId: `${G}-c1`, title: "/health JSON endpoint", parentId: G, status: "SHIPPED", releaseId: "rel-0" });
  train("t-g1c1", `${G}-c1`, { status: "MERGED", phase: "MERGED", landedSha: MAIN_SHA, headSha: MAIN_SHA, createdAt: now - 800_000 });
  item({ itemId: `${G}-c2`, title: "Dark mode toggle", parentId: G, bestOf: 3, difficulty: "hard", paths: ["src/lib/theme.js"] });
  item({ itemId: `${G}-c3`, title: "Theme tokens", kind: "chore", parentId: G, status: "READY", paths: ["src/lib/theme.js"], waitReason: "affinity: src/lib/theme.js held by Dark mode toggle" });
  item({ itemId: `${G}-c4`, title: "Footer year hardcoded", kind: "bug", parentId: G, status: "BLOCKED", dependsOn: [`${G}-c2`] });
  item({ itemId: `${G}-c5`, title: "Document the theme API", kind: "chore", parentId: G });
  train("t-g1c5", `${G}-c5`);
  // Race R1: two candidates passed, one still building.
  const race: Race = {
    raceId: "race-1",
    itemId: `${G}-c2`,
    width: 3,
    state: "RACING",
    trainIds: ["t-g1c2-0", "t-g1c2-1", "t-g1c2-2"],
    winnerTrainId: null,
    reason: null,
    deadlineAt: now + 41_000,
    createdAt: now - 130_000,
    decidedAt: null,
    entryClosesAt: now + 600_000,
  };
  const score = { review: "approved" as const, satisfied: 3, missing: 0, changedFiles: 2, changedBytes: 2400, checks: 3 };
  train("t-g1c2-0", `${G}-c2`, { raceId: "race-1", candidate: 0, raceOutcome: "PASSED", status: "TESTING", phase: "TESTING", model: KIMI, score });
  train("t-g1c2-1", `${G}-c2`, { raceId: "race-1", candidate: 1, raceOutcome: "PASSED", status: "TESTING", phase: "TESTING", model: GLM, score: { ...score, changedBytes: 3900 } });
  train("t-g1c2-2", `${G}-c2`, { raceId: "race-1", candidate: 2, raceOutcome: "RACING", model: DEEPSEEK_FLASH });

  // Race R2 ("you pick"): three candidates passed every gate; the Queen holds for a human until pickDeadlineAt.
  item({ itemId: "pk1", title: "Pricing page layout", judge: "human", bestOf: 3, source: { kind: "user", actor: USER }, traceId: traceOf(5), paths: ["src/pricing.js"] });
  const racePick: Race = {
    raceId: "race-pick",
    itemId: "pk1",
    width: 3,
    state: "PICKING",
    trainIds: ["t-pk1-0", "t-pk1-1", "t-pk1-2"],
    winnerTrainId: null,
    reason: null,
    deadlineAt: null,
    createdAt: now - 300_000,
    decidedAt: null,
    pickDeadlineAt: now + 11 * 60_000 + 3000,
    recommendedTrainId: "t-pk1-1",
    recommendReason: "t-pk1-1: smallest diff (1.9 KB) with every criterion satisfied",
    rejections: [],
  };
  [[KIMI, 2600, 3], [GLM, 1900, 3], [DEEPSEEK_FLASH, 4200, 2]].forEach(([m, b, sat], i) =>
    train(`t-pk1-${i}`, "pk1", {
      raceId: "race-pick",
      candidate: i,
      raceOutcome: "PASSED",
      status: "TESTING",
      phase: "TESTING",
      model: m as string,
      previewUrl: `https://pk1-${i}-${hive}.kaikeru.workers.dev`,
      summary: ["Adds a three-tier grid with a monthly/yearly toggle.", "Single-column cards, tier data in one array.", "Table layout with a sticky header; one criterion partly met."][i]!,
      score: { review: "approved", satisfied: sat as number, missing: 3 - (sat as number), changedFiles: 2 + (i % 2), changedBytes: b as number, checks: 3 },
    }),
  );

  // The swarm: 30 independent items, each on its own trace.
  let k = 0;
  const swarm = (status: MergeTrain["status"], phase: MergeTrain["phase"], extra: Partial<MergeTrain> = {}, itemOver: Partial<WorkItem> = {}) => {
    const id = `s${++k}`;
    item({ itemId: id, title: SWARM_TITLES[k - 1]!, kind: k % 5 === 0 ? "chore" : "feature", traceId: traceOf(10 + k), source: { kind: "user", actor: USER }, ...itemOver });
    return train(`t-${id}`, id, { status, phase, ...extra });
  };
  for (let i = 0; i < 12; i++) swarm("BUILDING", "BUILDING");
  for (let i = 0; i < 2; i++) swarm("BUILDING", "DEPLOYING");
  for (let i = 0; i < 5; i++) swarm("TESTING", "TESTING", { previewUrl: `https://pr-${k + 1}-${hive}.kaikeru.workers.dev` });
  // Boarded builds (passed, on a car).
  const boarded = (carId: string, seq: number) => swarm("TESTING", "PASSED", { carId, passedSeq: seq, score });
  const k41 = [boarded("c-k41", 1).trainId, boarded("c-k41", 2).trainId, boarded("c-k41", 3).trainId, boarded("c-k41", 4).trainId];
  const k42 = [boarded("c-k42", 5).trainId, boarded("c-k42", 6).trainId];
  const k43 = [boarded("c-k43", 7).trainId];
  // Waiting to board.
  swarm("TESTING", "PASSED", { passedSeq: 8, score });
  swarm("TESTING", "PASSED", { passedSeq: 9, score });
  // Conflict: s29 collided with K41, its first build is ejected and the rework waits for the car.
  const c29 = `s${++k}`;
  item({ itemId: c29, title: SWARM_TITLES[k - 1]!, traceId: traceOf(10 + k), conflicts: 1, attempts: 1, paths: ["src/lib/format.js"], source: { kind: "user", actor: USER } });
  const conflict = { trainId: "t-s29-a", kind: "content" as const, paths: ["src/lib/format.js"], summary: "Merge conflict in src/lib/format.js with the car K41" };
  train("t-s29-a", c29, { status: "EJECTED", phase: "TESTING", reason: "merge conflict", conflict, createdAt: now - 150_000 });
  train("t-s29-b", c29, { phase: "WAITING_PARENT", waitForCarSeq: 41, createdAt: now - 20_000 });
  // A failed item (the bisect culprit's sibling): FAILED rows show in blocked/failed.
  item({ itemId: "s30", title: SWARM_TITLES[29]!, kind: "bug", status: "FAILED", attempts: 3, traceId: traceOf(40), blockedReason: "smoke failed 3 times", escalationId: "esc-2" });
  // The cars. K41 forks main and is landing; K42 stacks on it; K43 is merging.
  const car = (id: string, members: string[], over: Partial<MergeTrain>) =>
    train(id, id, { lane: "QUEUE", members, includedPrompts: members.map((m) => m.replace(/^t-/, "")), model: null, ...over });
  car("c-k41", k41, { status: "TESTING", phase: "LANDING", createdAt: now - 60_000, previewUrl: `https://pr-41-${hive}.kaikeru.workers.dev`, score: { ...score, review: "skipped" } });
  car("c-k42", k42, { status: "TESTING", phase: "TESTING", createdAt: now - 40_000, score: null });
  car("c-k43", k43, { status: "BUILDING", phase: "BUILDING", createdAt: now - 15_000 });
  // The bisected car K39 and its halves are ancient history (EJECTED / MERGED).
  car("c-k39", ["t-b1", "t-b2", "t-b3", "t-b4"], { status: "EJECTED", phase: "TESTING", reason: "failed: integration smoke", createdAt: now - 500_000 });
  car("c-k40", ["t-b1", "t-b2"], { status: "MERGED", phase: "MERGED", landedSha: "bbbbbbbb11111111bbbbbbbb11111111bbbbbbbb", createdAt: now - 400_000 });

  const race1 = race;
  const ev = (seq: number, type: QueenEvent["type"], summary: string, over: Partial<QueenEvent> = {}): QueenEvent => ({
    seq,
    eventId: `ev-${seq}`,
    ts: now - (60 - seq) * 10_000,
    hive,
    type,
    severity: "info",
    actor: "queen",
    traceId: null,
    spanId: null,
    parentSpanId: null,
    itemId: null,
    trainId: null,
    releaseId: null,
    commandId: null,
    summary,
    data: null,
    ...over,
  });
  const events: QueenEvent[] = [
    ev(1, "item.filed", `Filed goal "Dark mode, a /health page, fix the footer"`, { actor: `user:${USER}`, itemId: G, traceId: traceOf(1) }),
    ev(2, "race.started", "Race of 3 for Dark mode toggle", { itemId: `${G}-c2`, traceId: traceOf(1) }),
    ev(3, "queue.car", "Car K39 formed with 4 members", { trainId: "c-k39", data: { members: ["t-b1", "t-b2", "t-b3", "t-b4"] } }),
    ev(4, "queue.bisect", "K39 [b1 b2 b3 b4] failed integration smoke: split into [b1 b2] and [b3 b4]", {
      severity: "warn",
      trainId: "c-k39",
      data: { carId: "c-k39", members: ["t-b1", "t-b2", "t-b3", "t-b4"], halves: [["t-b1", "t-b2"], ["t-b3", "t-b4"]] },
    }),
    ev(5, "queue.landed", "Car K40 landed 2 members", { trainId: "c-k40" }),
    ev(6, "queue.conflict", "c29 conflicts with K41 on src/lib/format.js: reworking, waits for K41", {
      severity: "warn",
      itemId: c29,
      trainId: "t-s29-a",
      traceId: traceOf(10 + 29),
      data: { paths: ["src/lib/format.js"], kind: "content", carId: "c-k41" },
    }),
    ev(7, "escalation.opened", "SENTINEL_INCONCLUSIVE: staging never became ready in 90s", { severity: "error", releaseId: "rel-1", actor: "sentinel" }),
  ];

  const esc: Escalation[] = [
    {
      escalationId: "esc-1",
      hive,
      reason: "SENTINEL_INCONCLUSIVE",
      status: "OPEN",
      subject: { type: "release", id: "rel-1" },
      traceId: null,
      summary: "Staging never became ready in 90s. The Queen parked the release at staging.",
      actions: ["ship", "hold"],
      createdAt: now - 30_000,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    },
  ];

  const hiveStatus: HiveStatus = {
    hive,
    settings: {
      autonomy: "autonomous",
      guardrails: { ...GUARDRAIL_DEFAULTS },
      budget: { dailyCredits: 50_000, dailyDispatches: 500 },
      slo: { changeSuccessTarget: 0.9, window: 20 },
      race: { reworkWidth: 2, hardWidth: 3 },
      executors: "swarm",
    },
    effectiveAutonomy: "autonomous",
    degradedBy: [],
    headline: "NEEDS_YOU",
    budget: { day: new Date(now).toISOString().slice(0, 10), creditsUsed: 31_000, creditsLimit: 50_000, dispatches: 212, dispatchLimit: 500 },
    slo: { window: 20, attempted: 18, failed: 1, target: 0.9, errorBudgetRemaining: 1, exhausted: false },
    counts: { READY: 1, BLOCKED: 1, ACTIVE: 33, LANDED: 0, SHIPPED: 27, FAILED: 1 },
    throughput: { shipped24h: 27, landed24h: 31, leadTimeP50Ms: 660_000, firstTryPassRate: 0.82 },
    concurrency: { activeBuilds: 24, slots: 24, leasedSlots: 24, affinityWaits: 1, queueDepth: 3, waitingToBoard: 2, landed1h: 9, conflicts24h: 3, bisects24h: 1, queueWaitP50Ms: 120_000 },
  };

  // Deltas: builds advance, K41 lands, the race is decided.
  const T = (id: string) => trains.find((t) => t.trainId === id)!;
  const tu = (id: string, over: Partial<MergeTrain>): QueenServerUnitMessage => ({ type: "train.updated", train: { ...T(id), ...over } });
  const iu = (id: string, over: Partial<WorkItem>, at: number): QueenServerUnitMessage => ({
    type: "item.updated",
    item: { ...items.find((i) => i.itemId === id)!, ...over, updatedAt: at },
  });
  const steps: SwarmFixture["steps"] = [
    { at: 1500, messages: ["t-s1", "t-s2", "t-s3", "t-s4"].map((id) => tu(id, { phase: "DEPLOYING" })) },
    {
      at: 3200,
      messages: [
        ...["t-s13", "t-s14"].map((id) => tu(id, { status: "TESTING", phase: "TESTING" })),
        ...["t-s15", "t-s16", "t-s17"].map((id) => tu(id, { status: "TESTING", phase: "PASSED", passedSeq: 10 + Number(id.slice(3)), score })),
        { type: "event.appended", event: ev(8, "queue.car", "Car K44 not formed yet: 3 builds waiting to board", { ts: now + 3200 }) },
      ],
    },
    {
      at: 5500,
      messages: [
        tu("c-k41", { status: "MERGED", phase: "MERGED", landedSha: "c0ffee1234567890c0ffee1234567890c0ffee12" }),
        ...k41.flatMap((id) => [tu(id, { status: "MERGED", phase: "MERGED", landedSha: "c0ffee1234567890c0ffee1234567890c0ffee12" }), iu(id.slice(2), { status: "LANDED" }, now + 5500)]),
        tu("c-k42", { phase: "LANDING" }),
        tu("c-k43", { status: "TESTING", phase: "TESTING" }),
        { type: "event.appended", event: ev(9, "queue.landed", "Car K41 landed 4 members", { ts: now + 5500, trainId: "c-k41" }) },
      ],
    },
    {
      at: 8000,
      messages: [
        { type: "race.updated", race: { ...race1, state: "DECIDED", winnerTrainId: "t-g1c2-0", reason: "t-g1c2-0: smaller diff (2.4 KB vs 3.9 KB), same score", deadlineAt: null, decidedAt: now + 8000 } },
        tu("t-g1c2-0", { raceOutcome: "WON", phase: "PASSED", passedSeq: 30 }),
        tu("t-g1c2-1", { raceOutcome: "LOST", status: "EJECTED", reason: "lost race to t-g1c2-0" }),
        tu("t-g1c2-2", { raceOutcome: "LOST", status: "EJECTED", reason: "lost race to t-g1c2-0" }),
        { type: "event.appended", event: ev(10, "race.decided", "Race for Dark mode toggle decided: candidate 0 won", { ts: now + 8000, itemId: `${G}-c2`, traceId: traceOf(1) }) },
      ],
    },
  ];

  return { items, trains, races: [race1, racePick], escalations: esc, hive: hiveStatus, events, steps };
}

/** Hourly rollups for the mock metrics endpoint: 24 buckets of plausible numbers. */
function mockRollups(now: number, hours: number) {
  const out: { bucket: number; name: string; labels: Record<string, string>; count: number; sum: number; min: number; max: number }[] = [];
  const top = now - (now % 3_600_000);
  for (let h = hours - 1; h >= 0; h--) {
    const bucket = top - h * 3_600_000;
    const wave = 1 + Math.sin((hours - h) / 3);
    const row = (name: string, count: number, sum = count, max = count) => out.push({ bucket, name, labels: {}, count, sum, min: 0, max });
    row("item_filed", Math.round(4 * wave + 2));
    row("item_landed", Math.round(3 * wave + 1));
    row("item_shipped", Math.round(2.5 * wave + 1));
    row("active_builds", 1, 0, Math.round(12 * wave + 6));
    row("queue_conflicts", h % 7 === 0 ? 1 : 0);
    row("queue_bisects", h === 5 ? 1 : 0);
    row("queue_wait_ms", 4, 4 * Math.round(100_000 * wave + 30_000), 260_000);
  }
  return out;
}

export class MockQueen {
  private stats: ModelStats[] = baseStats();
  private floor: RouterFloor = { tier: "fast", streak: 1, backoffAfter: 3, probeIn: 4 };
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private releases: Record<string, Release> = {};
  private stopped = false;
  constructor(
    private readonly hive: string,
    private readonly dispatch: Dispatch<Action>,
  ) {}

  /** The mock's own view of the world (the same reducer the dashboard runs), used to answer REST drill-downs. */
  private mirror: State = initialState;

  private emit(message: QueenServerMessage) {
    if (this.stopped) return;
    const at = Date.now();
    this.mirror = reducer(this.mirror, { type: "server", message, at });
    this.dispatch({ type: "server", message, at });
  }
  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(t);
  }

  start() {
    const t0 = Date.now() - 600_000;
    const promptRuns: PromptRun[] = prompts.map((promptText, i) => ({ promptId: `p${i + 1}`, namespace: this.hive, promptText, status: "MERGED", createdAt: t0 + i * 1000 }) as PromptRun);
    const trains: MergeTrain[] = promptRuns.map(
      (p, i) =>
        ({
          trainId: `t${i + 1}`,
          baseSha: "base",
          includedPrompts: promptRuns.slice(0, i + 1).map((x) => x.promptId),
          artifactRepo: `${this.hive}-train-${i + 1}`,
          status: "MERGED",
          phase: "MERGED",
          headSha: `${(i + 1).toString(16).repeat(40)}`.slice(0, 40),
          landedSha: `${(i + 1).toString(16).repeat(40)}`.slice(0, 40),
          createdAt: p.createdAt,
          model: [GLM_FLASH, DEEPSEEK_FLASH, GLM_FLASH, KIMI][i],
          modelReason: ["best pass rate in fast tier", "fast tier: GLM-5.3 Flash cooling down", "best pass rate in fast tier", "rework → escalated to frontier"][i],
        }) as MergeTrain,
    );
    const fx = buildSwarmFixture(this.hive, Date.now());
    this.emit({
      type: "snapshot",
      promptRuns,
      trains: [...trains, ...fx.trains],
      recentAudit: [],
      releases: [],
      modelStats: this.stats,
      routerFloor: this.floor,
      items: fx.items,
      races: fx.races,
      escalations: fx.escalations,
      hive: fx.hive,
      recentEvents: fx.events,
    } as QueenServerMessage);
    // Deltas arrive as coalesced batch frames, like the real Queen's.
    for (const step of fx.steps) this.later(step.at, () => this.emit({ type: "batch", messages: step.messages }));
    this.scriptBuild();
    this.later(1200, () => this.cut("rel-1", ["t1", "t2"], "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "ver-aaaa1111", "ver-0000stbl", false));
  }

  private bump(model: string, role: ModelStats["role"], passed: boolean, ms: number) {
    const cur = this.stats.find((x) => x.model === model && x.role === role) ?? stat(model, role, 0, 0, null);
    const attempts = cur.attempts + 1;
    const next: ModelStats = {
      ...cur,
      attempts,
      passes: cur.passes + (passed ? 1 : 0),
      failures: cur.failures + (passed ? 0 : 1),
      avgBuildMs: Math.round(((cur.avgBuildMs ?? ms) * cur.attempts + ms) / attempts),
      updatedAt: Date.now(),
    };
    this.stats = [...this.stats.filter((x) => x !== cur), next];
    this.emit({ type: "models.updated", stats: this.stats, floor: this.floor });
  }

  private setFloor(patch: Partial<RouterFloor>) {
    this.floor = { ...this.floor, ...patch };
    this.emit({ type: "models.updated", stats: this.stats, floor: this.floor });
  }

  /** A build that falls back, fails, is rebuilt on a frontier model and lands; stats evolve along the way. */
  private scriptBuild() {
    const now = Date.now();
    const prompt = (status: PromptRun["status"]) =>
      this.emit({ type: "prompt.updated", promptRun: { promptId: "p5", namespace: this.hive, promptText: "Add CSV export to the audit log view", status, createdAt: now } });
    const train = (patch: Partial<MergeTrain> & Pick<MergeTrain, "trainId" | "status">) =>
      this.emit({
        type: "train.updated",
        train: { baseSha: "base", includedPrompts: ["p1", "p2", "p3", "p4", "p5"], artifactRepo: `${this.hive}-${patch.trainId}`, createdAt: now, ...patch } as MergeTrain,
      });
    const audit = (id: string, status: "RUNNING" | "PASSED" | "REJECTED", model: string, result: "success" | "failure", ms: number) =>
      this.emit({
        type: "audit.appended",
        event: {
          eventId: id,
          promptId: "p5",
          droneRole: "BUILDER",
          status,
          createdAt: Date.now(),
          gitNotesPayload:
            status === "RUNNING"
              ? null
              : {
                  taskPrompt: "Add CSV export to the audit log view",
                  model,
                  temperature: 0.2,
                  reasoningSteps: ["Read the audit view and its data loader", result === "success" ? "Added exportCsv() and a button" : "Model returned malformed JSON change set"],
                  result,
                  executionTimeMs: ms,
                  discardedPaths: [],
                },
        },
      });
    this.later(2500, () => {
      prompt("BUILDING");
      train({ trainId: "t5", status: "BUILDING", phase: "BUILDING", model: GLM_FLASH, modelReason: "best pass rate in fast tier", memories: CSV_MEMORIES });
      audit("m-e1", "RUNNING", GLM_FLASH, "success", 0);
    });
    this.later(6500, () => {
      this.bump(GLM_FLASH, "builder", false, 9_000);
      train({ trainId: "t5", status: "BUILDING", phase: "BUILDING", model: DEEPSEEK_FLASH, modelReason: "GLM-5.3 Flash failed JSON → fell back to DeepSeek V4 Flash", memories: CSV_MEMORIES });
    });
    this.later(11_000, () => {
      this.bump(DEEPSEEK_FLASH, "builder", false, 24_000);
      this.setFloor({ tier: "frontier", streak: 0, probeIn: 3 });
      audit("m-e2", "REJECTED", DEEPSEEK_FLASH, "failure", 24_000);
      train({ trainId: "t5", status: "EJECTED", phase: "TESTING", reason: "failed: preview smoke test", model: DEEPSEEK_FLASH, modelReason: "fallback after JSON failure", memories: CSV_MEMORIES });
      prompt("EJECTED");
    });
    this.later(12_500, () => {
      prompt("BUILDING");
      train({ trainId: "t6", status: "BUILDING", phase: "BUILDING", createdAt: now + 10_000, model: KIMI, modelReason: "rework → escalated to frontier", memories: CSV_MEMORIES });
      audit("m-e3", "RUNNING", KIMI, "success", 0);
    });
    this.later(18_000, () => {
      this.bump(KIMI, "rework", true, 52_000);
      this.setFloor({ streak: 1, probeIn: 2 });
      audit("m-e4", "PASSED", KIMI, "success", 52_000);
      train({ trainId: "t6", status: "TESTING", phase: "TESTING", createdAt: now + 10_000, model: KIMI, modelReason: "rework → escalated to frontier", memories: CSV_MEMORIES });
      prompt("IN_TRAIN");
    });
    this.later(21_500, () => {
      train({ trainId: "t6", status: "MERGED", phase: "MERGED", createdAt: now + 10_000, landedSha: "c0ffee1234567890c0ffee1234567890c0ffee12", model: KIMI, modelReason: "rework → escalated to frontier", memories: CSV_MEMORIES });
      prompt("MERGED");
      this.setFloor({ streak: 2, probeIn: 1 });
    });
    this.later(26_000, () => {
      this.bump(KIMI, "builder", true, 49_000);
      this.setFloor({ tier: "fast", streak: 0, probeIn: null });
    });
  }

  /**
   * Answers the Queen's v2 GET routes from the mock's state: `/items/:id`,
   * `/events`, `/traces/:id`, `/metrics`, `/queue`. Null = not a mock route.
   */
  rest(path: string, search: URLSearchParams): { status: number; body: unknown } | null {
    const m = this.mirror;
    const now = Date.now();
    const ok = (body: unknown) => ({ status: 200, body });
    const by = <T,>(rows: T[], f: (r: T) => boolean) => rows.filter(f);
    const item = path.match(/^items\/([^/]+)$/);
    if (item) {
      const it = m.items[decodeURIComponent(item[1]!)];
      if (!it) return { status: 404, body: { error: `NOT_FOUND: item ${item[1]}` } };
      const trains = Object.values(m.trains).filter((t) => itemIdOf(t) === it.itemId && t.lane !== "QUEUE");
      return ok({
        item: it,
        children: by(Object.values(m.items), (i) => i.parentId === it.itemId),
        trains,
        races: by(Object.values(m.races), (r) => r.itemId === it.itemId),
        release: it.releaseId ? (m.releases[it.releaseId] ?? null) : null,
        escalations: by(Object.values(m.escalations), (e) => e.subject.id === it.itemId || e.escalationId === it.escalationId),
      });
    }
    if (path === "events") {
      const before = search.get("before");
      const type = search.get("type");
      const limit = Math.min(Number(search.get("limit") ?? 100) || 100, 500);
      const rows = m.events
        .filter((e) => (before ? e.seq < Number(before) : true))
        .filter((e) => (type ? e.type === type || e.type.startsWith(`${type}.`) : true))
        .filter((e) => (search.get("item") ? e.itemId === search.get("item") : true))
        .filter((e) => (search.get("trace") ? e.traceId === search.get("trace") : true))
        .filter((e) => (search.get("release") ? e.releaseId === search.get("release") : true));
      return ok(rows.slice(-limit).reverse());
    }
    const trace = path.match(/^traces\/([^/]+)$/);
    if (trace) {
      const traceId = trace[1]!;
      const itemsOf = Object.values(m.items).filter((i) => i.traceId === traceId);
      if (!itemsOf.length) return { status: 404, body: { error: `NOT_FOUND: trace ${traceId}` } };
      const spans = itemsOf.map((i) => ({
        spanId: i.spanId,
        parentSpanId: i.parentId ? (m.items[i.parentId]?.spanId ?? null) : null,
        name: `${i.kind} ${i.title}`,
        kind: "item" as const,
        startTs: i.createdAt,
        endTs: i.status === "SHIPPED" || i.status === "LANDED" ? i.updatedAt : null,
        outcome: i.status === "SHIPPED" || i.status === "LANDED" ? "ok" : null,
      }));
      return ok({
        traceId,
        spans,
        events: m.events.filter((e) => e.traceId === traceId),
        links: [],
      });
    }
    if (path === "metrics") {
      const hours = search.get("window") === "7d" ? 168 : 24;
      return ok({ rollups: mockRollups(now, hours), hive: m.hive, source: "mock rollups" });
    }
    if (path === "queue") {
      const cars = Object.values(m.trains).filter((t) => t.lane === "QUEUE" && t.status !== "EJECTED" && t.status !== "MERGED");
      const waiting = Object.values(m.trains).filter((t) => t.lane !== "QUEUE" && t.phase === "PASSED" && !t.carId && t.status !== "EJECTED" && t.status !== "MERGED");
      return ok({
        cars,
        waiting,
        conflicts: m.events.filter((e) => e.type === "queue.conflict").reverse().slice(0, 20),
        bisects: m.events.filter((e) => e.type === "queue.bisect").reverse().slice(0, 20),
      });
    }
    return null;
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private set(id: string, patch: Partial<Release>) {
    const next = { ...this.releases[id]!, ...patch, updatedAt: Date.now() } as Release;
    this.releases[id] = next;
    this.emit({ type: "release.updated", release: next });
  }

  private verdict(id: string, environment: "staging" | "canary", ok: boolean, summary: string) {
    const v: SentinelVerdict = {
      commandId: `${id}-${environment}-${Date.now()}`,
      releaseId: id,
      environment,
      verdict: ok ? "PROMOTE" : "ROLLBACK",
      metrics: { requests: 112, errorRate: ok ? 0 : 0.125, p99Ms: ok ? 84 : 2410, baselineErrorRate: environment === "canary" ? 0 : null },
      summary,
    };
    this.emit({ type: "sentinel.verdict", verdict: v });
  }

  private cut(id: string, trainIds: string[], headSha: string, candidate: string, stable: string, willFail: boolean) {
    const now = Date.now();
    this.releases[id] = {
      releaseId: id,
      hive: this.hive,
      headSha,
      trainIds,
      phase: "STAGING",
      canaryPercent: null,
      stagingUrl: null,
      prodUrl: null,
      candidateVersionId: null,
      stableVersionId: null,
      tappedBy: null,
      tappedAt: null,
      summary: null,
      createdAt: now,
      updatedAt: now,
    };
    this.emit({ type: "release.updated", release: this.releases[id]! });
    this.later(STEP_MS, () => {
      this.set(id, { phase: "VALIDATING", stagingUrl: `https://${this.hive}-staging.kaikeru.workers.dev`, candidateVersionId: candidate });
      this.later(STEP_MS * 1.4, () => {
        this.verdict(id, "staging", true, "Staging: 0/60 errors; p99 71ms → promote");
        this.set(id, { phase: "AWAITING_TAP", summary: "Staging is healthy. Tap to ship." });
      });
    });
    this.willFail = { ...this.willFail, [id]: willFail };
    this.stable = { ...this.stable, [id]: stable };
  }
  private willFail: Record<string, boolean> = {};
  private stable: Record<string, string> = {};

  /** POST .../tap. Throws like the Queen: 404 unknown, 409 not awaiting a tap. */
  tap(releaseId: string): { status: number; body: unknown } {
    const r = this.releases[releaseId];
    if (!r) return { status: 404, body: { error: `NOT_FOUND: release ${releaseId}` } };
    if (r.phase !== "AWAITING_TAP") return { status: 409, body: { error: `CONFLICT: release is ${r.phase}, not AWAITING_TAP` } };
    this.set(releaseId, { phase: "CANARY", canaryPercent: 1, tappedBy: USER, tappedAt: Date.now(), stableVersionId: this.stable[releaseId] ?? null, summary: null });
    this.step(releaseId, [1, 10, 50, 100]);
    return { status: 200, body: { ok: true } };
  }

  private step(id: string, steps: number[]) {
    const [pct, ...rest] = steps;
    this.later(STEP_MS * 1.6, () => {
      const fail = this.willFail[id] && pct === 50;
      if (fail) {
        this.verdict(id, "canary", false, "Canary 50%: 14/112 errors vs baseline 0/108; p99 2410ms vs 80ms (error rate 12.5% > 1%) → rollback");
        this.set(id, { phase: "ROLLED_BACK", summary: "Sentinel rolled back at 50%: error rate 12.5%." });
        return;
      }
      this.verdict(id, "canary", true, `Canary ${pct}%: 0/${100 + (pct ?? 0)} errors vs baseline 0/108; p99 84ms vs 80ms → promote`);
      if (rest.length === 0) {
        this.set(id, { phase: "SHIPPED", canaryPercent: 100, prodUrl: `https://${this.hive}.kaikeru.workers.dev`, summary: null });
        if (id === "rel-1") this.later(5000, () => this.cut("rel-2", ["t1", "t2", "t3", "t4"], "f00dbabef00dbabef00dbabef00dbabef00dbabe", "ver-bbbb2222", "ver-aaaa1111", true));
        return;
      }
      this.set(id, { canaryPercent: rest[0]! });
      this.step(id, rest);
    });
  }
}

let active: MockQueen | null = null;
export const setActiveMockQueen = (q: MockQueen | null) => void (active = q);
export const activeMockQueen = () => active;
