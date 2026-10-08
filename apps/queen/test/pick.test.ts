/**
 * T9a "you pick" races (human-push design §10.1–10.3, tests §10.7 (a)–(g)): the pure rules in train/pick.ts,
 * the planner's PICKING state, pick / re-pick / deadline / cap, and the guardrail and settings clamps.
 */
import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PICK_WINDOW_DEFAULT_MS, PICK_WINDOW_MAX_MS, type QueenServerMessage, type Deployment, type EventDraft, type GateScore, type ProvisionCommand } from "@queenos/queen-types";
import type { RaceRecord } from "../src/records";
import { INITIAL_FLOOR, type FloorState, type RouterStats } from "../src/models/router";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  TrainPlanner,
  watchdogDeadline,
  type Effect,
  type PickDelta,
  type PlanResult,
  type PlannerContext,
  type PlannerItem,
  type PromptRecord,
  type QueueOptions,
  type TrainRecord,
} from "../src/train/planner";
import {
  LOSER_FORK_KEEP_MS,
  checkPick,
  decideMode,
  humanBy,
  judgeOf,
  keptLoser,
  maxPickingRaces,
  pickDeadline,
  pickDue,
  pickWindowMs,
  recommend,
  releaseLoser,
  type PickCandidate,
} from "../src/train/pick";
import { effectiveGuardrails, effectiveSettings } from "../src/work/guardrails";
import { simFilingHints } from "../src/sim/sim-v2";
import type { QueenNode } from "../src/queen-node";
import type { SimQueenNode } from "./worker";

const score = (over: Partial<GateScore> = {}): GateScore => ({ review: "approved", satisfied: 4, missing: 0, changedFiles: 2, changedBytes: 3000, checks: 5, ...over });

// ── pure rules ───────────────────────────────────────────────────────────

describe("pick.ts: pure rules", () => {
  it("judge: the item's, else the hive's, else auto", () => {
    expect(judgeOf(undefined, undefined)).toBe("auto");
    expect(judgeOf(undefined, "human")).toBe("human");
    expect(judgeOf("auto", "human")).toBe("auto");
    expect(judgeOf("human", "auto")).toBe("human");
  });

  it("pick window: default 15 min, clamped to [1 min, 2 h]; the deadline is now + window", () => {
    expect(pickWindowMs(undefined)).toBe(PICK_WINDOW_DEFAULT_MS);
    expect(pickWindowMs(null)).toBe(15 * 60_000);
    expect(pickWindowMs(5)).toBe(60_000);
    expect(pickWindowMs(3 * 3_600_000)).toBe(PICK_WINDOW_MAX_MS);
    expect(pickWindowMs(20 * 60_000)).toBe(20 * 60_000);
    expect(pickDeadline(1000, undefined)).toBe(1000 + 15 * 60_000);
    expect(pickDue({ state: "PICKING", pickDeadlineAt: 50 }, 49)).toBe(false);
    expect(pickDue({ state: "PICKING", pickDeadlineAt: 50 }, 50)).toBe(true);
    expect(pickDue({ state: "DECIDED", pickDeadlineAt: 50 }, 99)).toBe(false);
  });

  it("maxPickingRaces: default 2, clamped to [1, 5] (0 is raised to 1), in pick.ts and in effectiveGuardrails", () => {
    expect(maxPickingRaces(undefined)).toBe(2);
    expect(maxPickingRaces(0)).toBe(1);
    expect(maxPickingRaces(9)).toBe(5);
    expect(effectiveGuardrails({}).maxPickingRaces).toBe(2);
    expect(effectiveGuardrails({ maxPickingRaces: 0 }).maxPickingRaces).toBe(1);
    expect(effectiveGuardrails({ maxPickingRaces: 9 }).maxPickingRaces).toBe(5);
  });

  it("effectiveSettings: race judge (default auto) and pickWindowMs (default 15 min, max 2 h)", () => {
    expect(effectiveSettings(null).race).toEqual({ reworkWidth: 2, hardWidth: 3, judge: "auto", pickWindowMs: 15 * 60_000 });
    const s = effectiveSettings({ autonomy: "autonomous", overrides: { race: { judge: "human", pickWindowMs: 99 * 3_600_000 } }, budgetBoost: null });
    expect(s.race).toMatchObject({ judge: "human", pickWindowMs: PICK_WINDOW_MAX_MS });
  });

  it("decideMode: auto races rank; human races pick with ≥ 2 passes, single with 1, cap past maxPickingRaces", () => {
    expect(decideMode({ judge: "auto", passed: 3, picking: 0, maxPicking: 2 })).toBe("auto");
    expect(decideMode({ judge: "human", passed: 1, picking: 0, maxPicking: 2 })).toBe("single");
    expect(decideMode({ judge: "human", passed: 2, picking: 0, maxPicking: 2 })).toBe("pick");
    expect(decideMode({ judge: "human", passed: 2, picking: 1, maxPicking: 2 })).toBe("pick");
    expect(decideMode({ judge: "human", passed: 2, picking: 2, maxPicking: 2 })).toBe("cap");
    expect(decideMode({ judge: "human", passed: 2, picking: 0, maxPicking: 0 })).toBe("pick"); // 0 is clamped to 1
    expect(decideMode({ judge: "human", passed: 2, picking: 1, maxPicking: 0 })).toBe("cap");
  });

  it("recommend: the rankCandidates winner, with a reason", () => {
    const rec = recommend([
      { trainId: "a", candidate: 0, passed: true, score: score({ changedBytes: 9000 }) },
      { trainId: "b", candidate: 1, passed: true, score: score({ changedBytes: 3000 }) },
    ]);
    expect(rec).toEqual({ trainId: "b", reason: "recommended: reviewer approved (4/0), 2.9 KB vs 8.8 KB" });
    expect(recommend([])).toBeNull();
  });

  it("humanBy: human:<email>", () => {
    expect(humanBy("kyle@example.com")).toBe("human:kyle@example.com");
    expect(humanBy("x".repeat(500)).length).toBe(340);
  });

  it("checkPick: PICKING needs a live passed candidate; a DECIDED pick allows a re-pick only before the winner boards", () => {
    const race = { raceId: "r", state: "PICKING" as const, trainIds: ["a", "b", "c"], winnerTrainId: null, recommendedTrainId: "a", decidedBy: null };
    const cands: PickCandidate[] = [
      { trainId: "a", phase: "TESTING", raceOutcome: "PASSED", forkState: "READY", headSha: "h" },
      { trainId: "b", phase: "TESTING", raceOutcome: "PASSED", forkState: "READY", headSha: "h" },
      { trainId: "c", phase: "EJECTED", raceOutcome: "FAILED", forkState: "DELETING", headSha: "h" },
    ];
    expect(checkPick(race, "b", cands)).toEqual({ ok: true, mode: "pick" });
    expect(checkPick(race, "c", cands)).toMatchObject({ ok: false, status: 409 });
    expect(checkPick(race, "zz", cands)).toMatchObject({ ok: false, status: 409 });
    expect(checkPick({ ...race, state: "RACING" }, "a", cands)).toMatchObject({ ok: false, status: 409, message: "race r is RACING, not PICKING" });
    // An auto-decided race (no recommendation, no human) is never re-picked.
    expect(checkPick({ ...race, state: "DECIDED", winnerTrainId: "a", recommendedTrainId: null, decidedBy: null }, "b", cands)).toMatchObject({ ok: false, status: 409 });
    const decided = { ...race, state: "DECIDED" as const, winnerTrainId: "a", decidedBy: "human:k@x.io" };
    const after: PickCandidate[] = [
      { trainId: "a", phase: "PASSED", raceOutcome: "WON", forkState: "READY", headSha: "h", carId: null },
      { trainId: "b", phase: "EJECTED", raceOutcome: "LOST", forkState: "READY", headSha: "h" },
      { trainId: "c", phase: "EJECTED", raceOutcome: "FAILED", forkState: "DELETED", headSha: "h" },
    ];
    expect(checkPick(decided, "b", after)).toEqual({ ok: true, mode: "repick", winnerTrainId: "a" });
    expect(checkPick(decided, "a", after)).toMatchObject({ ok: false, status: 409 });
    expect(checkPick(decided, "c", after)).toMatchObject({ ok: false, status: 409 });
    expect(checkPick(decided, "b", [{ ...after[0]!, carId: "car1" }, after[1]!])).toMatchObject({ ok: false, message: expect.stringMatching(/boarded/) });
    expect(checkPick(decided, "b", [after[0]!, { ...after[1]!, forkState: "DELETING" }])).toMatchObject({ ok: false, status: 409 });
  });

  it("kept losers: LOST with a READY fork; released when the window ran out or the winner is terminal", () => {
    expect(keptLoser({ phase: "EJECTED", raceOutcome: "LOST", forkState: "READY" })).toBe(true);
    expect(keptLoser({ phase: "EJECTED", raceOutcome: "LOST", forkState: "DELETING" })).toBe(false);
    expect(keptLoser({ phase: "TESTING", raceOutcome: "PASSED", forkState: "READY" })).toBe(false);
    expect(releaseLoser({ deleteIssuedAt: 100 }, { phase: "PASSED" }, 50)).toBe(false);
    expect(releaseLoser({ deleteIssuedAt: 100 }, { phase: "PASSED" }, 100)).toBe(true);
    expect(releaseLoser({ deleteIssuedAt: 100 }, { phase: "MERGED" }, 50)).toBe(true);
    expect(releaseLoser({ deleteIssuedAt: 100 }, undefined, 50)).toBe(true);
  });

  it("sim: [race] races best-of-3; [you-pick] races best-of-3 with a human judge", () => {
    expect(simFilingHints("Add a tip jar [race]")).toEqual({ bestOf: 3 });
    expect(simFilingHints("Add a tip jar [race] [you-pick]")).toEqual({ bestOf: 3, judge: "human" });
    expect(simFilingHints("Add a tip jar [you-pick] [fail]")).toEqual({ bestOf: 3, judge: "human" });
    expect(simFilingHints("Add a tip jar")).toEqual({});
  });
});

// ── planner ──────────────────────────────────────────────────────────────

type Del = Extract<ProvisionCommand, { op: "DELETE" }>;

/** A minimal hive persisting PlanResults like the DO (planner.test.ts's Sim, trimmed to races). */
class Hive {
  prompts = new Map<string, PromptRecord>();
  trains = new Map<string, TrainRecord>();
  deployments = new Map<string, Deployment>();
  races = new Map<string, RaceRecord>();
  effects: Effect[] = [];
  events: EventDraft[] = [];
  picks: PickDelta[] = [];
  stats: RouterStats[] = [];
  floor: FloorState = { ...INITIAL_FLOOR };
  now = 1000;
  items: PlannerItem[] = [{ itemId: "A", judge: "human" }];
  pick: PlannerContext["pick"] = { pickWindowMs: 15 * 60_000, maxPickingRaces: 2 };
  queue: QueueOptions | undefined;
  private ids = 0;
  private maxTrainSeq = 0;
  private maxPromptSeq = 0;
  private maxPassedSeq = 0;

  run(fn: (p: TrainPlanner) => PlanResult): PlanResult {
    const p = new TrainPlanner(
      {
        prompts: [...this.prompts.values()],
        trains: [...this.trains.values()],
        deployments: [...this.deployments.values()],
        maxTrainSeq: this.maxTrainSeq,
        maxPromptSeq: this.maxPromptSeq,
        modelStats: this.stats,
        routerDispatches: 0,
        routerFloor: this.floor,
        races: [...this.races.values()],
        items: this.items,
        maxPassedSeq: this.maxPassedSeq,
      },
      {
        namespace: "hive",
        now: this.now,
        newId: () => `t${++this.ids}`,
        ...(this.pick ? { pick: this.pick } : {}),
        ...(this.queue ? { queue: this.queue } : {}),
      },
    );
    const r = fn(p);
    for (const x of r.prompts) {
      this.prompts.set(x.promptId, x);
      this.maxPromptSeq = Math.max(this.maxPromptSeq, x.seq);
    }
    for (const t of r.trains) {
      this.trains.set(t.trainId, t);
      this.maxTrainSeq = Math.max(this.maxTrainSeq, t.seq);
      this.maxPassedSeq = Math.max(this.maxPassedSeq, t.passedSeq ?? 0);
    }
    for (const x of r.races) this.races.set(x.raceId, x);
    for (const d of r.deployments) this.deployments.set(d.deploymentId, d);
    this.events.push(...r.events);
    this.effects.push(...r.effects);
    this.picks.push(...(r.picks ?? []));
    return r;
  }

  /** Complete every pending FORK and preview DEPLOY. */
  settle(): void {
    for (;;) {
      const forks = this.effects.filter((e): e is Extract<Effect, { type: "provision" }> => e.type === "provision" && e.command.op === "FORK");
      const deploys = this.effects.filter((e): e is Extract<Effect, { type: "deploy" }> => e.type === "deploy" && e.command.op === "DEPLOY");
      if (!forks.length && !deploys.length) return;
      this.effects = this.effects.filter((e) => !forks.includes(e as never) && !deploys.includes(e as never));
      for (const f of forks) {
        const c = f.command as Extract<ProvisionCommand, { op: "FORK" }>;
        this.run((p) => p.provisionResult({ commandId: c.commandId, op: "FORK", trainId: c.trainId, ok: true, artifactRepo: c.forkName, baseSha: "base" }));
      }
      for (const d of deploys) {
        this.run((p) => p.deployResult({ commandId: d.command.commandId, op: "DEPLOY", environment: "preview", trainId: d.trainId, ok: true, url: `https://${d.trainId}.preview` }));
      }
    }
  }

  take(op: "DELETE" | "TEARDOWN"): string[] {
    const hit = this.effects.filter((e) => (e.type === "provision" || e.type === "deploy") && e.command.op === op);
    this.effects = this.effects.filter((e) => !hit.includes(e));
    return hit.map((e) => (e as Extract<Effect, { type: "provision" | "deploy" }>).trainId);
  }

  pass(trainId: string, bytes: number): PlanResult {
    return this.run((p) => p.trainResult({ trainId, passed: true, summary: "ok", score: score({ changedBytes: bytes }) }));
  }

  fail(trainId: string): PlanResult {
    return this.run((p) => p.trainResult({ trainId, passed: false, summary: "tests failed" }));
  }

  t(id: string): TrainRecord {
    return this.trains.get(id)!;
  }

  race(id = "t1"): RaceRecord {
    return this.races.get(id)!;
  }

  decided(): EventDraft[] {
    return this.events.filter((e) => e.type === "race.decided");
  }
}

/** Item A races 3 candidates (race t1: t2, t3, t4), all built and live. */
function raceOf3(over: Partial<Pick<Hive, "items" | "pick" | "queue">> = {}): Hive {
  const h = new Hive();
  Object.assign(h, over);
  h.run((p) => p.submit({ promptId: "A", promptText: "do A", raceWidth: 3 }));
  h.settle();
  for (const id of ["t2", "t3", "t4"]) h.run((p) => p.buildResult({ trainId: id, headSha: `h-${id}` }));
  h.settle();
  h.effects = h.effects.filter((e) => e.type !== "dispatchDrone" && e.type !== "gate");
  return h;
}

/** raceOf3, then all three pass; t3 is the smallest diff (the recommendation). */
function picking(over: Partial<Pick<Hive, "items" | "pick" | "queue">> = {}): Hive {
  const h = raceOf3(over);
  h.pass("t2", 9000);
  h.pass("t3", 3000);
  h.pass("t4", 6000);
  return h;
}

describe("planner: PICKING (judge human)", () => {
  it("≥ 2 passes enter PICKING: candidates stay TESTING with live previews and forks, the Queen recommends, race.picking fires", () => {
    const h = picking();
    expect(h.race()).toMatchObject({ state: "PICKING", recommendedTrainId: "t3", pickDeadlineAt: 1000 + 15 * 60_000, winnerTrainId: null });
    expect(h.race().recommendReason).toMatch(/^recommended: reviewer approved \(4\/0\)/);
    for (const id of ["t2", "t3", "t4"]) {
      expect(h.t(id)).toMatchObject({ phase: "TESTING", raceOutcome: "PASSED", forkState: "READY", deployState: "LIVE" });
      expect(h.t(id).passedSeq ?? null).toBeNull();
    }
    expect(h.take("DELETE")).toEqual([]);
    expect(h.take("TEARDOWN")).toEqual([]);
    const ev = h.events.filter((e) => e.type === "race.picking");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ raceId: "t1", recommended: "t3", pickDeadlineAt: 1000 + 15 * 60_000 });
    expect((ev[0]!.data as { candidates: { trainId: string; previewUrl: string }[] }).candidates.map((c) => c.previewUrl)).toEqual([
      "https://t2.preview",
      "https://t3.preview",
      "https://t4.preview",
    ]);
    expect(h.decided()).toHaveLength(0);
  });

  it("the hive's judge applies when the item has none; an item's `auto` overrides a human hive", () => {
    const hiveHuman = picking({ items: [{ itemId: "A" }], pick: { judge: "human" } });
    expect(hiveHuman.race().state).toBe("PICKING");
    const itemAuto = picking({ items: [{ itemId: "A", judge: "auto" }], pick: { judge: "human" } });
    expect(itemAuto.race()).toMatchObject({ state: "DECIDED", winnerTrainId: "t3" });
    expect(itemAuto.race().decidedBy ?? null).toBeNull(); // auto races keep their pre-T9a shape
  });

  it("(a) a pick of the non-recommended candidate lands it; the others are LOST (previews down, forks kept); race.decided by human, agreed false; picks counted", () => {
    const h = picking();
    const r = h.run((p) => p.pick({ raceId: "t1", trainId: "t2", by: "human:kyle@example.com", reason: "nicer copy" }));
    expect(r.outcome).toBe("applied");
    expect(r.refused).toBeUndefined();
    expect(h.t("t2")).toMatchObject({ raceOutcome: "WON", passedSeq: 1, reason: "picked by kyle@example.com: nicer copy" });
    expect(h.t("t2").phase).toBe("LANDING"); // no queue: lands directly
    for (const id of ["t3", "t4"]) {
      expect(h.t(id)).toMatchObject({ phase: "EJECTED", raceOutcome: "LOST", forkState: "READY", deleteIssuedAt: h.now + LOSER_FORK_KEEP_MS });
      expect(h.t(id).reason).toMatch(/^lost race to t2: not picked \(kyle@example.com: nicer copy\)/);
    }
    expect(h.take("TEARDOWN").sort()).toEqual(["t3", "t4"]);
    expect(h.take("DELETE")).toEqual([]);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: "t2", decidedBy: "human:kyle@example.com", reason: "picked by kyle@example.com: nicer copy" });
    const ev = h.decided();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toMatchObject({ raceId: "t1", by: "human:kyle@example.com", recommended: "t3", agreed: false, reason: "nicer copy", winner: "t2" });
    expect(h.picks).toEqual([{ model: h.t("t2").model, role: "builder", againstRecommendation: true }]);
  });

  it("a pick of the recommendation is agreed: true", () => {
    const h = picking();
    h.run((p) => p.pick({ raceId: "t1", trainId: "t3", by: "human:k@x.io" }));
    expect(h.decided()[0]!.data).toMatchObject({ by: "human:k@x.io", agreed: true });
    expect(h.picks).toEqual([{ model: h.t("t3").model, role: "builder", againstRecommendation: false }]);
  });

  it("(b) at pickDeadlineAt the Queen picks its recommendation (queen:deadline); no pick is counted", () => {
    const h = picking();
    h.now = h.race().pickDeadlineAt! - 1;
    h.run((p) => p.reconcile());
    expect(h.race().state).toBe("PICKING");
    h.now += 1;
    h.run((p) => p.reconcile());
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: "t3", decidedBy: "queen:deadline" });
    expect(h.t("t3")).toMatchObject({ raceOutcome: "WON" });
    expect(h.decided()[0]!.data).toMatchObject({ by: "queen:deadline", recommended: "t3", agreed: true });
    expect(h.picks).toEqual([]);
    for (const id of ["t2", "t4"]) expect(h.t(id)).toMatchObject({ raceOutcome: "LOST", forkState: "READY" });
  });

  it("(c) a pick on a DECIDED (auto) race, a RACING race, a failed candidate or an unknown race is refused", () => {
    const auto = picking({ items: [{ itemId: "A", judge: "auto" }] });
    expect(auto.run((p) => p.pick({ raceId: "t1", trainId: "t4", by: "human:k@x.io" })).refused).toMatchObject({ status: 409 });
    expect(auto.t("t4").raceOutcome).toBe("LOST");

    const racing = raceOf3();
    racing.pass("t2", 9000);
    expect(racing.run((p) => p.pick({ raceId: "t1", trainId: "t2", by: "human:k@x.io" })).refused).toMatchObject({ status: 409, message: "race t1 is RACING, not PICKING" });

    const h = raceOf3();
    h.pass("t2", 9000);
    h.pass("t3", 3000);
    h.fail("t4");
    expect(h.race().state).toBe("PICKING");
    const r = h.run((p) => p.pick({ raceId: "t1", trainId: "t4", by: "human:k@x.io" }));
    expect(r.refused).toMatchObject({ status: 409 });
    expect(r.trains).toEqual([]);
    expect(h.run((p) => p.pick({ raceId: "nope", trainId: "t2", by: "human:k@x.io" })).refused).toMatchObject({ status: 404 });
    // A human-decided race whose winner already left PASSED (landing) cannot be re-picked.
    h.run((p) => p.pick({ raceId: "t1", trainId: "t2", by: "human:k@x.io" }));
    expect(h.t("t2").phase).toBe("LANDING");
    expect(h.run((p) => p.pick({ raceId: "t1", trainId: "t3", by: "human:k@x.io" })).refused).toMatchObject({ status: 409 });
  });

  it("(d) past maxPickingRaces a human race auto-decides at once, by queen:cap", () => {
    const h = picking({ pick: { maxPickingRaces: 1 } });
    expect(h.race("t1").state).toBe("PICKING");
    // A second human-judged item races while t1 is held.
    h.items = [...h.items, { itemId: "B", judge: "human" }];
    h.run((p) => p.submit({ promptId: "B", promptText: "do B", raceWidth: 2 }));
    const raceB = [...h.races.values()].find((r) => r.itemId === "B")!;
    h.settle();
    for (const id of raceB.trainIds) h.run((p) => p.buildResult({ trainId: id, headSha: `h-${id}` }));
    h.settle();
    h.pass(raceB.trainIds[0]!, 5000);
    h.pass(raceB.trainIds[1]!, 4000);
    expect(h.race(raceB.raceId)).toMatchObject({ state: "DECIDED", decidedBy: "queen:cap", winnerTrainId: raceB.trainIds[1] });
    expect(h.race(raceB.raceId).reason).toMatch(/maxPickingRaces/);
    expect(h.decided().at(-1)!.data).toMatchObject({ by: "queen:cap" });
    expect(h.race("t1").state).toBe("PICKING");
  });

  it("(e) a re-pick before the winner boards a car swaps the winner; after boarding it is refused", () => {
    const h = picking({ queue: { settings: { maxQueueBatch: 4, maxQueueDepth: 3 }, paused: true } });
    h.run((p) => p.pick({ raceId: "t1", trainId: "t3", by: "human:k@x.io" }));
    expect(h.t("t3")).toMatchObject({ phase: "PASSED", raceOutcome: "WON", passedSeq: 1 });
    expect(h.t("t3").carId ?? null).toBeNull();
    h.take("TEARDOWN");
    const r = h.run((p) => p.pick({ raceId: "t1", trainId: "t4", by: "human:k@x.io", reason: "changed my mind" }));
    expect(r.refused).toBeUndefined();
    expect(h.t("t4")).toMatchObject({ phase: "PASSED", raceOutcome: "WON", passedSeq: 2, deleteIssuedAt: null, reason: "picked by k@x.io: changed my mind" });
    expect(h.t("t3")).toMatchObject({ phase: "EJECTED", raceOutcome: "LOST", forkState: "READY", reason: "lost race to t4: re-picked by k@x.io" });
    expect(h.take("TEARDOWN")).toEqual(["t3"]);
    expect(h.take("DELETE")).toEqual([]);
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: "t4", decidedBy: "human:k@x.io" });
    expect(h.decided().at(-1)!.data).toMatchObject({ repick: true, previous: "t3", winner: "t4", agreed: false });
    expect(h.prompts.get("A")!.attempts).toBe(0); // no attempt charged
    // Once the winner boards a car, a re-pick is refused (the targeted-submission path is not built).
    h.queue = { settings: { maxQueueBatch: 4, maxQueueDepth: 3 } };
    h.run((p) => p.reconcile());
    expect(h.t("t4").carId).toBeTruthy();
    expect(h.run((p) => p.pick({ raceId: "t1", trainId: "t2", by: "human:k@x.io" })).refused).toMatchObject({ status: 409, message: expect.stringMatching(/boarded/) });
  });

  it("(f) one pass under a human judge auto-decides (queen:single, no PICKING); no pass reworks with no human", () => {
    const one = raceOf3();
    one.pass("t2", 3000);
    one.fail("t3");
    one.fail("t4");
    expect(one.race()).toMatchObject({ state: "DECIDED", winnerTrainId: "t2", decidedBy: "queen:single" });
    expect(one.events.filter((e) => e.type === "race.picking")).toHaveLength(0);

    const none = raceOf3();
    for (const id of ["t2", "t3", "t4"]) none.fail(id);
    expect(none.race().state).toBe("ABANDONED");
    expect(none.events.filter((e) => e.type === "race.picking")).toHaveLength(0);
    expect([...none.trains.values()].filter((t) => t.action === "REWORK" && t.phase !== "EJECTED").length).toBeGreaterThan(0);
  });

  it("a held candidate's late verdict is ignored; when held candidates drop out, the last one standing wins (queen:single)", () => {
    const h = raceOf3();
    h.pass("t2", 3000);
    h.pass("t3", 9000);
    h.fail("t4");
    expect(h.race().state).toBe("PICKING");
    expect(h.run((p) => p.trainResult({ trainId: "t2", passed: false, summary: "late" })).outcome).toBe("ignored:duplicate");
    expect(h.race().state).toBe("PICKING");
    // t2 drops out (e.g. its contributor re-pushed): the reconcile decides the race for t3.
    h.trains.set("t2", { ...h.t("t2"), phase: "EJECTED", raceOutcome: "LOST" });
    h.run((p) => p.reconcile());
    expect(h.race()).toMatchObject({ state: "DECIDED", winnerTrainId: "t3", decidedBy: "queen:single" });
  });

  it("(g) watchdogDeadline includes a PICKING race's pickDeadlineAt, and a kept loser's delete-after deadline", () => {
    const h = picking();
    const trains = [...h.trains.values()];
    const races = [...h.races.values()];
    const at = watchdogDeadline(trains, DEFAULT_COMMAND_TIMEOUT_MS, h.now, races);
    expect(at).toBe(h.race().pickDeadlineAt);
    expect(watchdogDeadline(trains, DEFAULT_COMMAND_TIMEOUT_MS, h.now, [])).not.toBe(h.race().pickDeadlineAt);

    const queued = picking({ queue: { settings: { maxQueueBatch: 4, maxQueueDepth: 3 }, paused: true } });
    queued.run((p) => p.pick({ raceId: "t1", trainId: "t2", by: "human:k@x.io" }));
    const kept = [...queued.trains.values()].filter((t) => keptLoser(t));
    expect(kept.map((t) => t.trainId).sort()).toEqual(["t3", "t4"]);
    // Teardowns are outstanding too; the loser's own deadline is in the set.
    queued.take("TEARDOWN");
    for (const id of ["t3", "t4"]) queued.trains.set(id, { ...queued.t(id), deployState: "TORN_DOWN", teardownIssuedAt: null });
    expect(watchdogDeadline([...queued.trains.values()], DEFAULT_COMMAND_TIMEOUT_MS, queued.now, [])).toBe(queued.now + LOSER_FORK_KEEP_MS);
  });

  it("kept loser forks are deleted when the window runs out, or once the winner is terminal", () => {
    const h = picking({ queue: { settings: { maxQueueBatch: 4, maxQueueDepth: 3 }, paused: true } });
    h.run((p) => p.pick({ raceId: "t1", trainId: "t2", by: "human:k@x.io" }));
    h.take("DELETE");
    h.run((p) => p.reconcile());
    expect(h.take("DELETE")).toEqual([]);
    h.now += LOSER_FORK_KEEP_MS;
    h.run((p) => p.reconcile());
    expect(h.take("DELETE").sort()).toEqual(["t3", "t4"]);
    expect(h.t("t3").forkState).toBe("DELETING");

    const merged = picking({ queue: { settings: { maxQueueBatch: 4, maxQueueDepth: 3 }, paused: true } });
    merged.run((p) => p.pick({ raceId: "t1", trainId: "t2", by: "human:k@x.io" }));
    merged.trains.set("t2", { ...merged.t("t2"), phase: "MERGED" });
    merged.run((p) => p.reconcile());
    const dels = merged.effects.filter((e): e is Extract<Effect, { type: "provision" }> => e.type === "provision" && e.command.op === "DELETE").map((e) => (e.command as Del).trainId);
    expect(dels.sort()).toEqual(["t3", "t4"]);
  });

});

// ── the Queen: sim e2e and the user route ────────────────────────────────

const worker = exports.default;
const simNs = () => (env as unknown as { SIM_QUEEN: DurableObjectNamespace<SimQueenNode> }).SIM_QUEEN;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Row = Record<string, unknown>;
const rows = (stub: DurableObjectStub<SimQueenNode>, q: string, ...args: (string | number)[]) =>
  runInDurableObject(stub as unknown as DurableObjectStub<QueenNode>, (n: QueenNode) => n.sql.exec(q, ...args).toArray() as Row[]);

async function pump(stub: DurableObjectStub<SimQueenNode>, done: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await done()) return;
    await runDurableObjectAlarm(stub);
    await sleep(5);
  }
  throw new Error(`pump: timed out waiting for ${what}`);
}

type Snapshot = Extract<QueenServerMessage, { type: "snapshot" }>;

/** Settle an RPC promise into its error message (`expect(rpc).rejects` leaves the RPC thenable flagged as unhandled). */
async function rpcError(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const raceRow = async (stub: DurableObjectStub<SimQueenNode>, itemId: string) => (await rows(stub, "SELECT * FROM races WHERE item_id = ? ORDER BY created_at DESC", itemId))[0];

describe("Queen: you-pick races (sim)", () => {
  it("[race] [you-pick]: all 3 pass → PICKING; snapshot and item detail carry the Pick view; a human pick lands the non-recommended one", async () => {
    const hive = `pick-${crypto.randomUUID().slice(0, 8)}`;
    const stub = simNs().get(simNs().idFromName(hive));
    const { item } = await stub.submitWork({ namespace: hive, promptText: "Add a /features/otter endpoint returning otter facts [race] [you-pick]" });
    expect(item).toMatchObject({ bestOf: 3, judge: "human" });
    await pump(stub, async () => (await raceRow(stub, item.itemId))?.state === "PICKING", "the race to enter PICKING");
    const race = (await raceRow(stub, item.itemId))!;
    const trainIds = JSON.parse(String(race.train_ids)) as string[];
    expect(trainIds).toHaveLength(3);
    expect(race.recommended_train_id).toBeTruthy();
    expect(Number(race.pick_deadline_at)).toBeGreaterThan(Date.now());

    // The Pick view's data: the race (state, recommendation, deadline) and every candidate train (model, preview, score).
    const snap = (await stub.getSnapshot()) as unknown as Snapshot;
    const r = snap.races!.find((x) => x.raceId === race.race_id)!;
    expect(r).toMatchObject({ state: "PICKING", recommendedTrainId: race.recommended_train_id, pickDeadlineAt: race.pick_deadline_at });
    expect(r.recommendReason).toMatch(/^recommended: /);
    const cands = snap.trains.filter((t) => r.trainIds.includes(t.trainId));
    expect(cands).toHaveLength(3);
    for (const t of cands) {
      expect(t).toMatchObject({ raceId: r.raceId, raceOutcome: "PASSED", status: "TESTING" });
      expect(t.previewUrl).toBeTruthy();
      expect(t.model).toBeTruthy();
      expect(t.score).toMatchObject({ checks: expect.any(Number), satisfied: expect.any(Number), missing: expect.any(Number), changedBytes: expect.any(Number) });
    }
    const detail = await stub.getItemDetail(item.itemId);
    expect(detail.races[0]).toMatchObject({ state: "PICKING", recommendedTrainId: race.recommended_train_id });
    expect(detail.item.judge).toBe("human");

    // A pick of a failed / unknown train is a 409; a human picks a non-recommended candidate.
    expect(await rpcError(stub.pick({ hive, raceId: String(race.race_id), user: "kyle@example.com", pick: { trainId: "nope" } }))).toMatch(/^CONFLICT: /);
    const choice = trainIds.find((id) => id !== race.recommended_train_id)!;
    const res = await stub.pick({ hive, raceId: String(race.race_id), user: "kyle@example.com", pick: { trainId: choice, reason: "I like its copy" } });
    expect(res.race).toMatchObject({ state: "DECIDED", winnerTrainId: choice, decidedBy: "human:kyle@example.com" });
    await pump(stub, async () => {
      const st = (await rows(stub, "SELECT status FROM work_items WHERE item_id = ?", item.itemId))[0]?.status;
      return st === "LANDED" || st === "SHIPPED";
    }, "the pick to land");
    const decided = (await rows(stub, "SELECT data FROM event_log WHERE type = 'race.decided' AND item_id = ?", item.itemId)).map((e) => JSON.parse(String(e.data)));
    expect(decided).toEqual([expect.objectContaining({ by: "human:kyle@example.com", agreed: false, recommended: race.recommended_train_id, reason: "I like its copy" })]);
    expect(await rows(stub, "SELECT type FROM event_log WHERE type = 'race.picking' AND item_id = ?", item.itemId)).toHaveLength(1);
    const losers = await rows(stub, "SELECT race_outcome, phase FROM merge_trains WHERE race_id = ? AND train_id != ?", String(race.race_id), choice);
    expect(losers.every((l) => l.race_outcome === "LOST" && l.phase === "EJECTED")).toBe(true);
    const stats = await rows(stub, "SELECT picks, picks_against_recommendation FROM model_stats WHERE picks > 0");
    expect(stats).toEqual([{ picks: 1, picks_against_recommendation: 1 }]);
    // Decided and landed: another pick is a 409.
    expect(await rpcError(stub.pick({ hive, raceId: String(race.race_id), user: "kyle@example.com", pick: { trainId: race.recommended_train_id as string } }))).toMatch(/^CONFLICT: /);
  });

  it("[you-pick] [fail]: candidate 0 fails, the 2 passed candidates are held for the pick", async () => {
    const hive = `pick-${crypto.randomUUID().slice(0, 8)}`;
    const stub = simNs().get(simNs().idFromName(hive));
    const { item } = await stub.submitWork({ namespace: hive, promptText: "Add a /features/falcon endpoint returning falcon facts [you-pick] [fail]" });
    await pump(stub, async () => (await raceRow(stub, item.itemId))?.state === "PICKING", "the race to enter PICKING");
    const outcomes = (await rows(stub, "SELECT race_outcome FROM merge_trains WHERE prompt_id = ? AND lane = 'BUILD' ORDER BY seq", item.itemId)).map((t) => t.race_outcome);
    expect(outcomes).toEqual(["FAILED", "PASSED", "PASSED"]);
  });
});

describe("Queen: POST /hives/:hive/races/:raceId/pick", () => {
  const pickRoute = (hive: string, raceId: string, body: unknown, user?: string) =>
    worker.fetch(`http://queen.test/hives/${hive}/races/${raceId}/pick`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(user === undefined ? {} : { "x-queen-user": user }) },
      body: JSON.stringify(body),
    });

  it("is a user route: 401 without x-queen-user, 400 on a bad body, 404 for an unknown race", async () => {
    const hive = `route-${crypto.randomUUID().slice(0, 8)}`;
    expect((await pickRoute(hive, "r1", { trainId: "t" })).status).toBe(401);
    expect((await pickRoute(hive, "r1", { trainId: "" }, "kyle@example.com")).status).toBe(400);
    expect((await pickRoute(hive, "r1", { trainId: "t", reason: "x".repeat(301) }, "kyle@example.com")).status).toBe(400);
    const res = await pickRoute(hive, "r1", { trainId: "t" }, "kyle@example.com");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
