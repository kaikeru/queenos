/**
 * A pure planner hive for the rework loop (rework-loop spec §5, §7): external mode, attempt-tagged pushed trains, slots
 * persisted between plans like the Queen does (v19 attempts columns). Swarm races (drone candidates) for T9b too.
 */
import type { Deployment, EventDraft, GateScore, MergeResult, ProvisionCommand, SubmissionOrigin } from "@queenos/queen-types";
import type { RaceRecord } from "../src/records";
import { TrainPlanner, type Effect, type PlanResult, type PlannerItem, type PromptRecord, type QueueOptions, type TrainRecord } from "../src/train/planner";
import type { AttemptSlot, ReworkSettings } from "../src/train/rework";

export const MIN = 60_000;
export const A1 = "att_aaaaaaaaaaaa";
export const B1 = "att_bbbbbbbbbbbb";
export const C1 = "att_cccccccccccc";
export const ORIGIN: SubmissionOrigin = { kind: "agent", id: "opus@ada@example.com" };
const SCORE: GateScore = { review: "approved", satisfied: 3, missing: 0, changedFiles: 1, changedBytes: 400, checks: 4 };
let shaN = 0;
const sha = () => (0xfeed00 + ++shaN).toString(16).padStart(40, "0");

export class ReworkHive {
  prompts = new Map<string, PromptRecord>();
  trains = new Map<string, TrainRecord>();
  deployments = new Map<string, Deployment>();
  races = new Map<string, RaceRecord>();
  slots = new Map<string, AttemptSlot>();
  effects: Effect[] = [];
  events: EventDraft[] = [];
  /** Items that went FAILED "awaiting contributor" (the fallback), in order. */
  awaiting: string[] = [];
  /** Wait reasons the planner set (`awaiting rework ...`) or cleared (null), per item (Task 3). */
  waits = new Map<string, string | null>();
  now = 1_000_000;
  graceMs = 90_000;
  entryWindowMs = 0;
  judge: "auto" | "human" = "auto";
  external = true;
  rework: ReworkSettings | undefined = { windowMs: 30 * MIN, holdMs: 10 * MIN, maxPerAttempt: 3, maxRaceReopens: 3 };
  queue: QueueOptions | undefined;
  items: PlannerItem[] = [{ itemId: "A", status: "ACTIVE" }];
  last: PlanResult | null = null;
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
        races: [...this.races.values()],
        items: this.items,
        maxPassedSeq: this.maxPassedSeq,
        slots: [...this.slots.values()],
      },
      {
        namespace: "hive",
        now: this.now,
        newId: () => `t${++this.ids}`,
        external: this.external,
        entryWindowMs: this.entryWindowMs,
        raceGraceMs: this.graceMs,
        pick: { judge: this.judge, pickWindowMs: 15 * MIN, maxPickingRaces: 2 },
        ...(this.rework ? { rework: this.rework } : {}),
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
    for (const s of r.slots) this.slots.set(s.attemptId, s);
    for (const w of r.reworkWaits) this.waits.set(w.itemId, w.waitReason);
    this.awaiting.push(...(r.awaitingContributor ?? []).map((a) => a.promptId));
    this.events.push(...r.events);
    this.effects.push(...r.effects);
    this.last = r;
    return r;
  }

  /** Attempt `attemptId` pushes a new head to `itemId` (a new train `<attemptId>-<n>`); joins the item's RACING race, else opens one. */
  push(attemptId: string, opts: { itemId?: string; rejoin?: boolean } = {}): string {
    const itemId = opts.itemId ?? "A";
    const trainId = `${attemptId}-${++this.ids}`;
    const race = [...this.races.values()].filter((r) => r.itemId === itemId && (r.state === "RACING" || (opts.rejoin && r.state === "REWORKING"))).at(-1);
    this.run((p) => p.intent({ trainId, promptId: itemId, origin: ORIGIN, promptText: `do ${itemId}`, attemptId }));
    this.run((p) =>
      p.pushed({
        trainId,
        headSha: sha(),
        baseSha: "b".repeat(40),
        origin: ORIGIN,
        promptId: itemId,
        promptText: `do ${itemId}`,
        attempts: 0,
        item: this.items.find((i) => i.itemId === itemId)!,
        race: race ? { join: race.raceId } : { create: true },
        resume: true,
        ...(opts.rejoin ? { rejoin: true as const } : {}),
      }),
    );
    return trainId;
  }

  /** The train's newest preview DEPLOY reports live (→ TESTING, a gate issued). No-op once it is TESTING. */
  live(trainId: string): void {
    if (this.t(trainId).phase !== "DEPLOYING") return;
    const d = this.effects.filter((e): e is Extract<Effect, { type: "deploy" }> => e.type === "deploy" && e.trainId === trainId && e.command.op === "DEPLOY").at(-1)!;
    this.run((p) => p.deployResult({ commandId: d.command.commandId, op: "DEPLOY", environment: "preview", trainId, ok: true, url: `https://${trainId}.preview` }));
  }

  pass(trainId: string): PlanResult {
    this.live(trainId);
    return this.run((p) => p.trainResult({ trainId, passed: true, summary: "green", score: SCORE }));
  }

  fail(trainId: string, summary = "lint: unused variable x"): PlanResult {
    this.live(trainId);
    return this.run((p) => p.trainResult({ trainId, passed: false, summary }));
  }

  /** Move the clock and run the alarm's reconcile (watchdogs, race deadlines, slot expiry). */
  at(ms: number): PlanResult {
    this.now += ms;
    return this.run((p) => p.reconcile());
  }

  /** The winner's car forks (Provisioner FORK ok): the car is BUILDING with its MERGE drone out. Returns the car id. */
  forkCar(memberId: string): string {
    const carId = this.t(memberId).carId!;
    const f = this.effects.filter((e): e is Extract<Effect, { type: "provision" }> => e.type === "provision" && e.trainId === carId && e.command.op === "FORK").at(-1)!;
    const c = f.command as Extract<ProvisionCommand, { op: "FORK" }>;
    this.run((p) => p.provisionResult({ commandId: c.commandId, op: "FORK", trainId: carId, ok: true, artifactRepo: c.forkName, baseSha: "c".repeat(40) }));
    return carId;
  }

  /** The MERGE drone reports `memberId` conflicting in `carId`. */
  conflict(carId: string, memberId: string, paths = ["src/shared.js"]): PlanResult {
    const r: MergeResult = { trainId: carId, ok: true, headSha: "d".repeat(40), baseSha: "c".repeat(40), merged: [], conflicts: [{ trainId: memberId, kind: "content", paths, summary: `Merge conflict in ${paths.join(", ")}` }], fastForward: false, summary: "" };
    return this.run((p) => p.mergeResult(r));
  }

  /** `memberId` merges into `carId`, the car's preview goes live, and its integration gate fails. */
  integrationFail(carId: string, memberId: string): PlanResult {
    const r: MergeResult = { trainId: carId, ok: true, headSha: "d".repeat(40), baseSha: "c".repeat(40), merged: [memberId], conflicts: [], fastForward: false, summary: "" };
    this.run((p) => p.mergeResult(r));
    this.live(carId);
    return this.run((p) => p.trainResult({ trainId: carId, passed: false, summary: "integration smoke /tip failed" }));
  }

  t(id: string): TrainRecord {
    return this.trains.get(id)!;
  }

  /** The item's newest race. */
  race(itemId = "A"): RaceRecord {
    return [...this.races.values()].filter((r) => r.itemId === itemId).at(-1)!;
  }

  slot(attemptId: string): AttemptSlot | undefined {
    return this.slots.get(attemptId);
  }

  /** Complete every pending FORK and preview DEPLOY (swarm races; pick.test.ts's Hive.settle). */
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

  /** A swarm hive (no rework settings): item A races 3 drone candidates t2, t3, t4 (race t1), all built and live. */
  static swarmRace(): ReworkHive {
    const h = new ReworkHive();
    h.external = false;
    h.rework = undefined;
    h.judge = "human";
    h.run((p) => p.submit({ promptId: "A", promptText: "do A", raceWidth: 3 }));
    h.settle();
    for (const id of ["t2", "t3", "t4"]) h.run((p) => p.buildResult({ trainId: id, headSha: `h-${id}` }));
    h.settle();
    return h;
  }
}
