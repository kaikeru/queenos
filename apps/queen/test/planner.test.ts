import { describe, expect, it, vi } from "vitest";
import type { DeployCommand, Deployment, EventDraft, GateScore, ProvisionCommand, RecalledMemory } from "@queenos/queen-types";
import { spanIdFor, traceIdFromUuid, traceparent } from "@queenos/queen-types";
import type { RaceRecord } from "../src/records";
import type { QueueDecision } from "../src/train/queue";
import { INITIAL_FLOOR, type FloorState, type RouterPolicy, type RouterStats } from "../src/models/router";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_ATTEMPTS,
  MAX_FORK_ATTEMPTS,
  watchdogDeadline,
  UNDISPATCHED_RETRY_MS,
  TrainPlanner,
  nextCommandId,
  toMergeTrain,
  toMergeTrainV2,
  type Effect,
  type ModelStatDelta,
  type PlanResult,
  type PlannerItem,
  type PromptRecord,
  type QueueOptions,
  type RaceSettings,
  type TrainRecord,
  INFRA_RETRY_BASE_MS,
  MAX_INFRA_ATTEMPTS,
  infraRetryAt,
  infraRetryDelayMs,
  KEEP_FORK_MS,
  keptFork,
} from "../src/train/planner";

type Fork = Extract<ProvisionCommand, { op: "FORK" }>;
type Del = Extract<ProvisionCommand, { op: "DELETE" }>;
type Deploy = Extract<DeployCommand, { op: "DEPLOY" }>;
type Teardown = Extract<DeployCommand, { op: "TEARDOWN" }>;

/** In-memory hive that persists PlanResults the way the DO does. */
class Sim {
  prompts = new Map<string, PromptRecord>();
  trains = new Map<string, TrainRecord>();
  deployments = new Map<string, Deployment>();
  effects: Effect[] = [];
  /** Planner clock (the watchdog compares command issue times against it). */
  now = 1000;
  /** Router state, persisted like the DO's model_stats / model_router tables. */
  stats = new Map<string, RouterStats>();
  deltas: ModelStatDelta[] = [];
  routerDispatches = 0;
  floor: FloorState = { ...INITIAL_FLOOR };
  pin: string | null = null;
  policy: RouterPolicy | undefined;
  /** v2: races, items, rework race policy, merge queue options (injected hooks). */
  races = new Map<string, RaceRecord>();
  items: PlannerItem[] = [];
  race: RaceSettings | undefined;
  queue: QueueOptions | undefined;
  events: EventDraft[] = [];
  results: PlanResult[] = [];
  /** T1: the notes projection hook (a seeded REWORK's brief). */
  briefFor: ((sha: string) => string | null) | undefined;
  maxPassedSeq = 0;
  /** `settings.executors === "external"` (no swarm). */
  external = false;
  /** External hives: the entry window of races a push opens (0 = none). */
  entryWindowMs = 0;
  private ids = 0;
  private maxTrainSeq = 0;
  private maxPromptSeq = 0;

  run(fn: (p: TrainPlanner) => PlanResult): PlanResult {
    return this.runMany((p) => [fn(p)])[0]!;
  }

  /** Several transitions on ONE planner (one DO decision), each result persisted. */
  runMany(fn: (p: TrainPlanner) => PlanResult[]): PlanResult[] {
    const planner = new TrainPlanner(
      {
        prompts: [...this.prompts.values()],
        trains: [...this.trains.values()],
        deployments: [...this.deployments.values()],
        maxTrainSeq: this.maxTrainSeq,
        maxPromptSeq: this.maxPromptSeq,
        modelStats: [...this.stats.values()],
        routerDispatches: this.routerDispatches,
        routerFloor: this.floor,
        races: [...this.races.values()],
        items: this.items,
        maxPassedSeq: this.maxPassedSeq,
      },
      {
        namespace: "hive",
        now: this.now,
        newId: () => `t${++this.ids}`,
        modelPin: this.pin,
        routerPolicy: this.policy,
        ...(this.race ? { race: this.race } : {}),
        ...(this.queue ? { queue: this.queue } : {}),
        ...(this.briefFor ? { briefFor: this.briefFor } : {}),
        ...(this.external ? { external: true } : {}),
        ...(this.entryWindowMs ? { entryWindowMs: this.entryWindowMs } : {}),
      },
    );
    const rs = fn(planner);
    for (const r of rs) this.persist(r);
    return rs;
  }

  private persist(r: PlanResult): void {
    this.results.push(r);
    for (const p of r.prompts) {
      this.prompts.set(p.promptId, p);
      this.maxPromptSeq = Math.max(this.maxPromptSeq, p.seq);
    }
    for (const t of r.trains) {
      this.trains.set(t.trainId, t);
      this.maxTrainSeq = Math.max(this.maxTrainSeq, t.seq);
      this.maxPassedSeq = Math.max(this.maxPassedSeq, t.passedSeq ?? 0);
    }
    for (const race of r.races) this.races.set(race.raceId, race);
    this.events.push(...r.events);
    for (const d of r.deployments) this.deployments.set(d.deploymentId, d);
    this.effects.push(...r.effects);
    for (const d of r.modelStats) this.applyDelta(d);
    if (r.routerDispatches !== undefined) this.routerDispatches = r.routerDispatches;
    if (r.routerFloor !== undefined) this.floor = r.routerFloor;
  }

  /** Mirror of db.applyModelStatDelta. */
  private applyDelta(d: ModelStatDelta): void {
    this.deltas.push(d);
    const key = `${d.model}|${d.role}`;
    const s = this.stats.get(key) ?? { model: d.model, role: d.role, attempts: 0, passes: 0, failures: 0, avgBuildMs: null, updatedAt: 0, failStreak: 0 };
    const timed = s.avgBuildMs === null ? 0 : 1; // tests only check single-build averages
    this.stats.set(key, {
      ...s,
      attempts: s.attempts + d.attempts,
      passes: s.passes + d.passes,
      failures: s.failures + d.failures,
      avgBuildMs: d.buildMs === undefined ? s.avgBuildMs : Math.round(((s.avgBuildMs ?? 0) * timed + d.buildMs) / (timed + 1)),
      failStreak: d.streak === "pass" ? 0 : d.streak === "fail" ? (s.failStreak ?? 0) + 1 : s.failStreak,
      updatedAt: this.now,
    });
  }

  stat(model: string, role: "builder" | "rework" = "builder"): RouterStats | undefined {
    return this.stats.get(`${model}|${role}`);
  }

  submit(...ids: string[]): void {
    for (const id of ids) this.run((p) => p.submit({ promptId: id, promptText: `do ${id}` }));
  }

  take<T extends Effect["type"]>(type: T): Extract<Effect, { type: T }>[] {
    const out = this.effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);
    this.effects = this.effects.filter((e) => e.type !== type);
    return out;
  }

  /** Take pending executor commands of one op, leaving the others queued. */
  takeOp(op: "FORK"): Fork[];
  takeOp(op: "DELETE"): Del[];
  takeOp(op: "DEPLOY"): Deploy[];
  takeOp(op: "TEARDOWN"): Teardown[];
  takeOp(op: string): unknown[] {
    const match = (e: Effect) => (e.type === "provision" || e.type === "deploy") && e.command.op === op;
    const out = this.effects.filter(match).map((e) => withoutTrace((e as Extract<Effect, { type: "provision" | "deploy" }>).command));
    this.effects = this.effects.filter((e) => !match(e));
    return out;
  }

  /** The Provisioner completes every pending FORK (fake Artifacts). */
  completeForks(): void {
    for (;;) {
      const forks = this.takeOp("FORK");
      if (!forks.length) return;
      for (const c of forks) {
        this.run((p) =>
          p.provisionResult({ commandId: c.commandId, op: "FORK", trainId: c.trainId, ok: true, artifactRepo: c.forkName, baseSha: `sha:${c.sourceRepo}` }),
        );
      }
    }
  }

  /** The Herald brings every pending preview DEPLOY live. */
  completeDeploys(): void {
    for (const c of this.takeOp("DEPLOY")) {
      this.run((p) => p.deployResult({ commandId: c.commandId, op: "DEPLOY", environment: "preview", trainId: c.trainId, ok: true, url: url(c.trainId!) }));
    }
  }

  /** Active train owned by a prompt. */
  trainOf(promptId: string): TrainRecord {
    const t = [...this.trains.values()]
      .filter((x) => x.promptId === promptId && x.phase !== "EJECTED" && x.phase !== "MERGED")
      .at(-1);
    if (!t) throw new Error(`no active train for ${promptId}`);
    return t;
  }

  /** Builder pushes; successor forks chain; the preview goes live (unless `deploy` is false). */
  build(promptId: string, deploy = true): void {
    const t = this.trainOf(promptId);
    this.run((p) => p.buildResult({ trainId: t.trainId, headSha: `head:${promptId}` }));
    this.completeForks();
    if (deploy) this.completeDeploys();
  }

  result(promptId: string, passed: boolean, summary = passed ? "ok" : "tests failed"): PlanResult {
    const t = this.trainOf(promptId);
    const r = this.run((p) => p.trainResult({ trainId: t.trainId, passed, summary }));
    this.completeForks();
    return r;
  }

  land(promptId: string, landed = true): PlanResult {
    const t = this.trainOf(promptId);
    const r = this.run((p) =>
      p.landResult({ trainId: t.trainId, landed, mainSha: landed ? `main:${promptId}` : undefined, summary: "" }),
    );
    this.completeForks();
    return r;
  }

  status(promptId: string): string {
    return this.prompts.get(promptId)!.status;
  }

  phases(): Record<string, string> {
    return Object.fromEntries([...this.trains.values()].map((t) => [t.trainId, t.phase]));
  }

  /** Submit A,B,C; forks chain as each builder pushes; previews go live. */
  static abc(): Sim {
    const s = new Sim();
    s.submit("A", "B", "C");
    s.completeForks();
    s.build("A");
    s.build("B");
    s.build("C");
    s.take("dispatchDrone");
    s.take("broadcast");
    return s;
  }
}

/** Commands without their W3C trace (asserted separately in "planner: trace"). */
function withoutTrace<T extends { trace?: unknown }>(c: T): Omit<T, "trace"> {
  const { trace: _trace, ...rest } = c;
  void _trace;
  return rest;
}

/** Effects with executor commands stripped of their trace. */
function plain(effects: Effect[]): unknown[] {
  return effects.map((e) => (e.type === "provision" || e.type === "deploy" ? { ...e, command: withoutTrace(e.command) } : e));
}

const url = (trainId: string) => `https://${trainId}-preview.test.dev`;

describe("planner: provisioning", () => {
  it("BUILD trains fork from main at once: each includes only its own prompt; a push forks nobody", () => {
    const s = new Sim();
    s.submit("A", "B", "C");
    expect(s.takeOp("FORK")).toEqual(
      ["A", "B", "C"].map((id, i) => ({
        op: "FORK",
        commandId: `t${i + 1}-fork-1`,
        hive: "hive",
        trainId: `t${i + 1}`,
        sourceRepo: "hive",
        forkName: `hive-train-t${i + 1}`,
        recallQuery: `do ${id}`,
      })),
    );
    expect([...s.trains.values()].map((t) => [t.includedPrompts, t.lane, t.phase, t.forkState])).toEqual([
      [["A"], "BUILD", "BUILDING", "PENDING"],
      [["B"], "BUILD", "BUILDING", "PENDING"],
      [["C"], "BUILD", "BUILDING", "PENDING"],
    ]);
    expect(s.status("B")).toBe("QUEUED");

    s.run((p) => p.provisionResult({ commandId: "t1-fork-1", op: "FORK", trainId: "t1", ok: true, artifactRepo: "hive-train-t1", baseSha: "m0" }));
    const [d] = s.take("dispatchDrone");
    expect(d!.task).toMatchObject({ trainId: "t1", promptId: "A", role: "BUILDER", action: "BUILD", artifactRepo: "hive-train-t1", ragContext: [] });
    expect(s.status("A")).toBe("BUILDING");
    expect(s.trains.get("t1")).toMatchObject({ status: "BUILDING", baseSha: "m0", forkState: "READY" });

    s.run((p) => p.buildResult({ trainId: "t1", headSha: "h1" }));
    expect(s.trains.get("t1")).toMatchObject({ phase: "DEPLOYING", status: "TESTING", deployState: "PENDING" });
    expect(s.status("A")).toBe("IN_TRAIN");
    expect(s.takeOp("FORK")).toEqual([]); // nothing forks from a build train
    expect(s.takeOp("DEPLOY")).toEqual([
      { op: "DEPLOY", commandId: "t1-deploy-1", hive: "hive", environment: "preview", trainId: "t1", artifactRepo: "hive-train-t1", commitSha: "h1" },
    ]);
  });

  it("6 independent submits in one decision → 6 FORK effects, all with sourceRepo = namespace", () => {
    const s = new Sim();
    const ids = ["A", "B", "C", "D", "E", "F"];
    const rs = s.runMany((p) => ids.map((id) => p.submit({ promptId: id, promptText: `do ${id}` })));
    const forks = rs.flatMap((r) => r.effects).filter((e) => e.type === "provision" && e.command.op === "FORK") as Extract<Effect, { type: "provision" }>[];
    expect(forks).toHaveLength(6);
    expect(forks.map((f) => (f.command as Fork).sourceRepo)).toEqual(Array(6).fill("hive"));
    expect(new Set(forks.map((f) => (f.command as Fork).forkName)).size).toBe(6);
  });

  it("broadcasts prompt.updated and train.updated for visible changes", () => {
    const s = new Sim();
    const r = s.run((p) => p.submit({ promptId: "A", promptText: "x" }));
    const types = r.effects.filter((e) => e.type === "broadcast").map((e) => e.type === "broadcast" && e.message.type);
    expect(types).toEqual(["prompt.updated", "train.updated"]);
  });
});

describe("planner: results", () => {
  it("all pass in order: head lands, then each next head", () => {
    const s = Sim.abc();
    s.result("A", true);
    let landers = s.take("dispatchDrone");
    expect(landers.map((d) => [d.task.promptId, d.task.role, d.task.action, d.task.baseRef])).toEqual([
      ["A", "LANDER", "LAND", "head:A"],
    ]);
    expect(s.trainOf("A").status).toBe("TESTING");
    s.land("A");
    expect(s.status("A")).toBe("MERGED");
    expect(s.trains.get("t1")).toMatchObject({ status: "MERGED", landedSha: "main:A", forkState: "DELETING" });
    expect(s.takeOp("DELETE").map((e) => e.repo)).toEqual(["hive-train-t1"]);
    expect(s.takeOp("TEARDOWN").map((e) => e.trainId)).toEqual(["t1"]);
    s.result("B", true);
    s.land("B");
    s.result("C", true);
    s.land("C");
    expect([s.status("A"), s.status("B"), s.status("C")]).toEqual(["MERGED", "MERGED", "MERGED"]);
    landers = s.take("dispatchDrone");
    expect(landers.map((d) => d.task.promptId)).toEqual(["B", "C"]);
  });

  it("passes out of order land in ticket order (passedSeq), one at a time (direct landing, no merge queue)", () => {
    const s = Sim.abc();
    s.result("C", true);
    s.result("B", true);
    expect(s.take("dispatchDrone").map((d) => d.task.promptId)).toEqual(["C"]);
    expect([s.trainOf("C").passedSeq, s.trainOf("B").passedSeq]).toEqual([1, 2]);
    // Passing stamps the "passed at" clock the queue reads for queue-wait.
    expect(s.trainOf("B").passedAt).toBe(s.now);
    expect(s.trainOf("B").droneIssuedAt).toBeNull();
    expect(s.trainOf("B").phase).toBe("PASSED");
    s.result("A", true);
    expect(s.trainOf("A")).toMatchObject({ phase: "PASSED", passedSeq: 3 });
    s.land("C");
    expect(s.trainOf("B").phase).toBe("LANDING");
    expect(s.trainOf("A").phase).toBe("PASSED");
    s.land("B");
    s.land("A");
    expect(s.take("dispatchDrone").map((d) => d.task.promptId)).toEqual(["B", "A"]);
    expect([...s.trains.values()].every((t) => t.status === "MERGED")).toBe(true);
  });

  it("a failed build is ejected alone (no supersede); its REWORK forks from main at once and carries the summary", () => {
    const s = Sim.abc();
    s.result("A", true); // A is landing; keep it in flight
    s.take("dispatchDrone");
    s.result("B", false, "B broke the build");
    expect(s.trains.get("t1")!.phase).toBe("LANDING");
    expect(s.trains.get("t2")).toMatchObject({ status: "EJECTED", reason: "failed: B broke the build" });
    expect(s.trains.get("t3")!.phase).toBe("TESTING"); // C is untouched
    expect(s.takeOp("DELETE").map((e) => e.trainId)).toEqual(["t2"]);
    expect(s.takeOp("TEARDOWN").map((e) => e.trainId)).toEqual(["t2"]);

    const b2 = s.trainOf("B");
    expect(b2).toMatchObject({ trainId: "t4", action: "REWORK", includedPrompts: ["B"], forkSource: "hive", lane: "BUILD" });
    // EJECTED is broadcast before the rework re-queues the prompt.
    const bStates = s
      .take("broadcast")
      .flatMap((e) => (e.message.type === "prompt.updated" && e.message.promptRun.promptId === "B" ? [e.message.promptRun.status] : []));
    expect(bStates.slice(0, 2)).toEqual(["EJECTED", "QUEUED"]);
    expect(s.prompts.get("B")).toMatchObject({ attempts: 1, summary: "B broke the build" });

    // Sim.result completed the rework's fork (from main), so its REWORK drone is already out.
    const rework = s.take("dispatchDrone").find((d) => d.task.promptId === "B")!;
    expect(rework.task).toMatchObject({ action: "REWORK", role: "BUILDER", scribeSummary: "B broke the build", artifactRepo: "hive-train-t4" });
    s.land("A");
    s.result("C", true);
    s.land("C");
    s.build("B");
    s.result("B", true);
    s.land("B");
    expect([s.status("A"), s.status("B"), s.status("C")]).toEqual(["MERGED", "MERGED", "MERGED"]);
  });

  it("a pass waiting to land is unaffected by another train's failure", () => {
    const s = Sim.abc();
    s.result("A", true); // landing
    s.result("C", true); // waiting, ticket 2
    s.result("B", false);
    expect(s.trainOf("C")).toMatchObject({ phase: "PASSED", passedSeq: 2, includedPrompts: ["C"] });
    expect(s.trainOf("B")).toMatchObject({ includedPrompts: ["B"], action: "REWORK", forkSource: "hive" });
  });

  it("a failed build never ejects anyone else", () => {
    const s = Sim.abc();
    s.result("A", false);
    expect(s.trains.get("t2")!.phase).toBe("TESTING");
    expect(s.trains.get("t3")!.phase).toBe("TESTING");
    expect(s.trains.get("t1")!.phase).toBe("EJECTED");
    expect(s.takeOp("DELETE").map((e) => e.trainId)).toEqual(["t1"]);
  });

  it("a new prompt forks from main whatever is in flight", () => {
    const s = Sim.abc();
    s.result("A", true);
    s.land("A");
    s.submit("D");
    const d = s.trainOf("D");
    expect(d.includedPrompts).toEqual(["D"]);
    expect(s.takeOp("FORK").at(-1)).toMatchObject({ trainId: d.trainId, sourceRepo: "hive" });
  });

  it("a new prompt never waits for an unpushed train", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.submit("B");
    expect(s.trainOf("B")).toMatchObject({ phase: "BUILDING", forkState: "PENDING", forkSource: "hive" });
  });

  it("caps reworks: a prompt that keeps failing is FAILED", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    for (let i = 0; i < 3; i++) {
      s.build("A");
      s.result("A", false, `fail ${i}`);
    }
    expect(s.status("A")).toBe("FAILED");
    expect(() => s.trainOf("A")).toThrow();
  });

  it("a failed landing ejects the train and its dependants", () => {
    const s = Sim.abc();
    s.result("A", true);
    s.land("A", false);
    expect(s.trains.get("t1")!.status).toBe("EJECTED");
    expect(s.trainOf("B").includedPrompts).toEqual(["B"]);
    expect(s.trainOf("A").action).toBe("REWORK");
  });
});

describe("planner: idempotency", () => {
  it("ignores a result for an already-ejected train", () => {
    const s = Sim.abc();
    s.result("B", false);
    s.take("broadcast");
    const r = s.run((p) => p.trainResult({ trainId: "t2", passed: true, summary: "late" }));
    expect(r).toEqual({ outcome: "ignored:stale", prompts: [], trains: [], deployments: [], effects: [], modelStats: [], events: [], races: [], itemConflicts: [], conflictClaims: [] });
  });

  it("ignores duplicate, unknown and premature results", () => {
    const s = Sim.abc();
    s.result("A", true); // A lands first, so B waits PASSED
    s.result("B", true);
    expect(s.run((p) => p.trainResult({ trainId: "t2", passed: false, summary: "dup" })).outcome).toBe("ignored:duplicate");
    expect(s.trainOf("B").phase).toBe("PASSED");
    expect(s.run((p) => p.trainResult({ trainId: "nope", passed: true, summary: "" })).outcome).toBe("ignored:unknown");
    expect(s.run((p) => p.landResult({ trainId: "t2", landed: true, mainSha: "x", summary: "" })).outcome).toBe("ignored:premature");
    expect(s.run((p) => p.buildResult({ trainId: "t2", headSha: "again" })).outcome).toBe("ignored:duplicate");

    const w = new Sim();
    w.submit("A", "B");
    expect(w.run((p) => p.trainResult({ trainId: "t2", passed: true, summary: "" })).outcome).toBe("ignored:premature");
  });

  it("ignores a duplicate land result after merge", () => {
    const s = Sim.abc();
    s.result("A", true);
    s.land("A");
    const r = s.run((p) => p.landResult({ trainId: "t1", landed: true, mainSha: "m", summary: "" }));
    expect(r.outcome).toBe("ignored:stale");
    expect(r.effects).toEqual([]);
  });

  it("deletes an orphan fork that completes after its train was ejected (a race loser at the deadline)", () => {
    const s = new Sim();
    s.run((p) => p.submit({ promptId: "A", promptText: "do A", raceWidth: 2 })); // race t1: t2, t3
    const [f2, f3] = s.takeOp("FORK");
    s.run((p) => p.provisionResult({ commandId: f2!.commandId, op: "FORK", trainId: "t2", ok: true, artifactRepo: "hive-train-t2", baseSha: "m" }));
    s.run((p) => p.buildResult({ trainId: "t2", headSha: "h2" }));
    s.completeDeploys();
    s.effects = [];
    expect(s.trains.get("t2")!.phase).toBe("TESTING");
    s.run((p) => p.trainResult({ trainId: "t2", passed: true, summary: "ok" }));
    s.now += 90_000;
    s.run((p) => p.reconcile()); // deadline: t3 (fork still in flight) loses
    expect(s.trains.get("t3")).toMatchObject({ phase: "EJECTED", forkState: "DELETING", deleteCommandId: "t3-delete-1", raceOutcome: "LOST" });
    s.takeOp("DELETE");
    s.run((p) => p.provisionResult({ commandId: "t3-delete-1", op: "DELETE", trainId: "t3", ok: true }));
    expect(s.trains.get("t3")!.forkState).toBe("DELETED");
    // The fork finishes after the delete: it is an orphan, deleted under a new command.
    const late = s.run((p) => p.provisionResult({ commandId: f3!.commandId, op: "FORK", trainId: "t3", ok: true, artifactRepo: "hive-train-t3", baseSha: "m" }));
    expect(late.outcome).toBe("ignored:stale");
    expect(s.takeOp("DELETE")).toEqual([{ op: "DELETE", commandId: "t3-delete-2", hive: "hive", trainId: "t3", repo: "hive-train-t3" }]);
  });

  it("a duplicate FORK result is a no-op", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.take("dispatchDrone");
    const r = s.run((p) => p.provisionResult({ commandId: "t1-fork-1", op: "FORK", trainId: "t1", ok: true, artifactRepo: "hive-train-t1", baseSha: "m" }));
    expect(r.outcome).toBe("ignored:duplicate");
    expect(r.effects).toEqual([]);
  });
});

describe("planner: reconcile", () => {
  it("re-dispatches pending forks with the same command id, deletes and undispatched drones", () => {
    const s = new Sim();
    s.submit("A");
    s.take("provision");
    const r = s.run((p) => p.reconcile());
    // Same command id: if the first dispatch did start a Workflow, this is a no-op.
    expect(plain(r.effects)).toContainEqual({
      type: "provision",
      trainId: "t1",
      command: { op: "FORK", commandId: "t1-fork-1", hive: "hive", trainId: "t1", sourceRepo: "hive", forkName: "hive-train-t1", recallQuery: "do A" },
    });
    s.completeForks();
    expect(s.take("dispatchDrone")).toHaveLength(1);
    // The DO never confirmed the dispatch, so reconcile re-dispatches.
    expect(s.run((p) => p.reconcile()).effects.filter((e) => e.type === "dispatchDrone")).toHaveLength(1);
    s.run((p) => p.dispatched("t1", "BUILDING"));
    expect(s.run((p) => p.reconcile()).effects.filter((e) => e.type === "dispatchDrone")).toHaveLength(0);
  });

  it("a pending fork is re-sent to main with the same command id; merged trains' deletes and teardowns are re-sent", () => {
    const s = new Sim();
    s.submit("A", "B");
    s.completeForks();
    s.run((p) => p.buildResult({ trainId: "t1", headSha: "h1" }));
    s.completeDeploys();
    s.result("A", true);
    s.land("A");
    s.effects = [];
    s.trains.set("t2", { ...s.trains.get("t2")!, forkState: "PENDING", phase: "BUILDING" }); // B's fork result was lost
    const r = s.run((p) => p.reconcile());
    expect(plain(r.effects)).toContainEqual({
      type: "provision",
      trainId: "t2",
      command: { op: "FORK", commandId: "t2-fork-1", hive: "hive", trainId: "t2", sourceRepo: "hive", forkName: "hive-train-t2", recallQuery: "do B" },
    });
    expect(plain(r.effects)).toContainEqual({
      type: "provision",
      trainId: "t1",
      command: { op: "DELETE", commandId: "t1-delete-1", hive: "hive", trainId: "t1", repo: "hive-train-t1" },
    });
    expect(plain(r.effects)).toContainEqual({
      type: "deploy",
      trainId: "t1",
      command: { op: "TEARDOWN", commandId: "t1-teardown-1", hive: "hive", environment: "preview", trainId: "t1" },
    });
  });

  it("re-dispatches a pending preview deploy with the same command id", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A", false);
    s.effects = [];
    const r = s.run((p) => p.reconcile());
    expect(r.effects.filter((e) => e.type === "deploy").map((e) => e.type === "deploy" && e.command.commandId)).toEqual(["t1-deploy-1"]);
  });
});

describe("planner: async forks", () => {
  it("a train waits in BUILDING until the Provisioner reports its fork", () => {
    const s = new Sim();
    s.submit("A");
    expect(s.trains.get("t1")).toMatchObject({ phase: "BUILDING", forkState: "PENDING" });
    expect(s.take("dispatchDrone")).toEqual([]);
    expect(s.run((p) => p.buildResult({ trainId: "t1", headSha: "h" })).outcome).toBe("ignored:premature");
    expect(s.run((p) => p.trainResult({ trainId: "t1", passed: true, summary: "" })).outcome).toBe("ignored:premature");
    s.completeForks();
    expect(s.take("dispatchDrone")).toHaveLength(1);
  });

  it("ignores unknown trains and results for an older command id", () => {
    const s = new Sim();
    s.submit("A");
    const unknown = s.run((p) => p.provisionResult({ commandId: "x-fork-1", op: "FORK", trainId: "nope", ok: true }));
    expect(unknown.outcome).toBe("ignored:unknown");
    const stale = s.run((p) => p.provisionResult({ commandId: "t1-fork-0", op: "FORK", trainId: "t1", ok: true }));
    expect(stale.outcome).toBe("ignored:stale");
    expect(s.trains.get("t1")!.forkState).toBe("PENDING");
  });

  it(`a failed fork is retried under a new command id, then the train fails after ${MAX_FORK_ATTEMPTS} attempts`, () => {
    const s = new Sim();
    s.submit("A");
    for (let i = 1; i < MAX_FORK_ATTEMPTS; i++) {
      const [c] = s.takeOp("FORK");
      expect(c!.commandId).toBe(`t1-fork-${i}`);
      const r = s.run((p) => p.provisionResult({ commandId: c!.commandId, op: "FORK", trainId: "t1", ok: false, summary: "Artifacts 503" }));
      expect(r.outcome).toBe("applied");
      expect(s.trains.get("t1")).toMatchObject({ phase: "BUILDING", forkState: "PENDING", forkCommandId: `t1-fork-${i + 1}` });
    }
    const [last] = s.takeOp("FORK");
    s.run((p) => p.provisionResult({ commandId: last!.commandId, op: "FORK", trainId: "t1", ok: false, summary: "Artifacts 503" }));
    // Infrastructure, not the change: no rework charged; the item gets EXECUTOR_LOST (infraFailed).
    expect(s.trains.get("t1")).toMatchObject({ phase: "EJECTED", reason: "failed on infrastructure: fork failed: Artifacts 503" });
    expect(s.trains.has("t2")).toBe(false);
    expect(s.prompts.get("A")).toMatchObject({ attempts: 0, status: "FAILED" });
  });

  it("records DELETE results: ok, duplicate, stale and failed", () => {
    const s = Sim.abc();
    s.result("A", true);
    s.land("A");
    const [del] = s.takeOp("DELETE");
    expect(s.run((p) => p.provisionResult({ commandId: "t1-delete-0", op: "DELETE", trainId: "t1", ok: true })).outcome).toBe("ignored:stale");
    expect(s.run((p) => p.provisionResult({ commandId: del!.commandId, op: "DELETE", trainId: "t1", ok: true })).outcome).toBe("applied");
    expect(s.trains.get("t1")!.forkState).toBe("DELETED");
    expect(s.run((p) => p.provisionResult({ commandId: del!.commandId, op: "DELETE", trainId: "t1", ok: true })).outcome).toBe("ignored:duplicate");

    s.result("B", true);
    s.land("B");
    const [delB] = s.takeOp("DELETE");
    const failed = s.run((p) => p.provisionResult({ commandId: delB!.commandId, op: "DELETE", trainId: "t2", ok: false, summary: "boom" }));
    expect(failed.outcome).toBe("applied");
    expect(failed.effects).toEqual([]); // recorded, never retried in a loop
    expect(s.trains.get("t2")!.forkState).toBe("DELETE_FAILED");
  });
});

describe("planner: preview deploys", () => {
  it("DEPLOYING -> TESTING when the preview is live; the URL is on the train and its deployment row", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A", false);
    expect(s.deployments.get("preview-t1")).toMatchObject({ status: "PENDING", environment: "preview", trainId: "t1", commitSha: "head:A", url: null, hive: "hive" });
    s.effects = [];
    const r = s.run((p) =>
      p.deployResult({ commandId: "t1-deploy-1", op: "DEPLOY", environment: "preview", trainId: "t1", ok: true, url: url("t1"), versionId: "v1" }),
    );
    expect(r.outcome).toBe("applied");
    expect(s.trains.get("t1")).toMatchObject({ phase: "TESTING", status: "TESTING", deployState: "LIVE", previewUrl: url("t1") });
    expect(s.deployments.get("preview-t1")).toMatchObject({ status: "LIVE", url: url("t1"), versionId: "v1" });
    const msgs = r.effects.flatMap((e) => (e.type === "broadcast" ? [e.message] : []));
    expect(msgs).toContainEqual(expect.objectContaining({ type: "train.updated", train: expect.objectContaining({ phase: "TESTING", previewUrl: url("t1") }) }));
    expect(msgs).toContainEqual(expect.objectContaining({ type: "deployment.updated", deployment: expect.objectContaining({ status: "LIVE" }) }));
  });

  it("finds the train by command id when the Herald omits trainId", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A", false);
    const r = s.run((p) => p.deployResult({ commandId: "t1-deploy-1", op: "DEPLOY", environment: "preview", ok: true, url: url("t1") }));
    expect(r.outcome).toBe("applied");
  });

  it("a gatekeeper pass during DEPLOYING is premature; the successor chain does not wait for the deploy", () => {
    const s = new Sim();
    s.submit("A", "B");
    s.completeForks();
    s.build("A", false);
    expect(s.trains.get("t2")).toMatchObject({ forkState: "READY" }); // B forked from A's push
    expect(s.run((p) => p.trainResult({ trainId: "t1", passed: true, summary: "early" })).outcome).toBe("ignored:premature");
    expect(s.trains.get("t1")!.phase).toBe("DEPLOYING");
  });

  it("a failed deploy fails the train like a test failure: EJECTED + REWORK with the summary; preview torn down", () => {
    const s = new Sim();
    s.submit("A", "B");
    s.completeForks();
    s.build("A", false);
    s.build("B", false);
    s.effects = [];
    const r = s.run((p) =>
      p.deployResult({ commandId: "t1-deploy-1", op: "DEPLOY", environment: "preview", trainId: "t1", ok: false, summary: "Worker failed to start: SyntaxError" }),
    );
    expect(r.outcome).toBe("applied");
    expect(s.trains.get("t1")).toMatchObject({ phase: "EJECTED", reason: "failed: preview deploy failed: Worker failed to start: SyntaxError", deployState: "TEARING_DOWN" });
    expect(s.deployments.get("preview-t1")).toMatchObject({ status: "FAILED", summary: "Worker failed to start: SyntaxError" });
    expect(s.trains.get("t2")!.phase).toBe("DEPLOYING"); // B is untouched
    expect(s.takeOp("TEARDOWN").map((c) => c.commandId)).toEqual(["t1-teardown-1"]);
    s.completeForks();
    expect(s.trainOf("A")).toMatchObject({ action: "REWORK", includedPrompts: ["A"], forkSource: "hive" });
    expect(s.prompts.get("A")).toMatchObject({ attempts: 1, summary: "Worker failed to start: SyntaxError" });
    const rework = s.take("dispatchDrone").find((d) => d.task.promptId === "A");
    expect(rework!.task).toMatchObject({ action: "REWORK", scribeSummary: "Worker failed to start: SyntaxError" }); // no waiting
  });

  it("an ok deploy without a URL counts as a failure", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A", false);
    s.run((p) => p.deployResult({ commandId: "t1-deploy-1", op: "DEPLOY", environment: "preview", trainId: "t1", ok: true }));
    expect(s.trains.get("t1")!.reason).toBe("failed: preview deploy failed: Herald reported a deploy without a preview URL.");
  });

  it("a builder failure during DEPLOYING still ejects and tears the preview down", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A", false);
    s.takeOp("DEPLOY");
    s.result("A", false, "boom");
    expect(s.trains.get("t1")).toMatchObject({ phase: "EJECTED", deployState: "TEARING_DOWN" });
    expect(s.takeOp("TEARDOWN")).toHaveLength(1);
  });

  it("ignores duplicate, stale, unknown and non-preview deploy results", () => {
    const s = Sim.abc();
    const ok = { op: "DEPLOY" as const, environment: "preview" as const, trainId: "t1", ok: true, url: url("t1") };
    expect(s.run((p) => p.deployResult({ ...ok, commandId: "t1-deploy-1" })).outcome).toBe("ignored:duplicate");
    expect(s.run((p) => p.deployResult({ ...ok, commandId: "t1-deploy-0" })).outcome).toBe("ignored:stale");
    expect(s.run((p) => p.deployResult({ ...ok, commandId: "zz", trainId: "nope" })).outcome).toBe("ignored:unknown");
    expect(s.run((p) => p.deployResult({ ...ok, commandId: "t1-deploy-1", environment: "staging" })).outcome).toBe("ignored:unknown");
    expect(s.run((p) => p.deployResult({ ...ok, commandId: "t1-deploy-1", op: "ROLLBACK" })).outcome).toBe("ignored:unknown");
    expect(s.trains.get("t1")!.phase).toBe("TESTING");
  });

  it("a deploy that finishes after its train was ejected is torn down again, once", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A", false);
    s.takeOp("DEPLOY");
    s.result("A", false, "boom");
    const [td] = s.takeOp("TEARDOWN");
    s.run((p) => p.deployResult({ commandId: td!.commandId, op: "TEARDOWN", environment: "preview", trainId: "t1", ok: true }));
    expect(s.deployments.get("preview-t1")!.status).toBe("TORN_DOWN");
    const late = s.run((p) => p.deployResult({ commandId: "t1-deploy-1", op: "DEPLOY", environment: "preview", trainId: "t1", ok: true, url: url("t1") }));
    expect(late.outcome).toBe("ignored:stale");
    expect(s.takeOp("TEARDOWN").map((c) => c.commandId)).toEqual(["t1-teardown-2"]);
    expect(s.trains.get("t1")).toMatchObject({ phase: "EJECTED", deployState: "TEARING_DOWN" });
    const dup = s.run((p) => p.deployResult({ commandId: "t1-deploy-1", op: "DEPLOY", environment: "preview", trainId: "t1", ok: true, url: url("t1") }));
    expect(dup.outcome).toBe("ignored:stale");
    expect(dup.effects).toEqual([]);
    // The first teardown's result is now stale; the second one closes it out.
    expect(s.run((p) => p.deployResult({ commandId: "t1-teardown-1", op: "TEARDOWN", environment: "preview", trainId: "t1", ok: true })).outcome).toBe(
      "ignored:stale",
    );
  });

  it("MERGED tears the preview down; teardown results are idempotent; a failed teardown is recorded", () => {
    const s = Sim.abc();
    s.result("A", true);
    s.land("A");
    const [td] = s.takeOp("TEARDOWN");
    expect(td).toEqual({ op: "TEARDOWN", commandId: "t1-teardown-1", hive: "hive", environment: "preview", trainId: "t1" });
    const done = { op: "TEARDOWN" as const, environment: "preview" as const, trainId: "t1", ok: true, commandId: td!.commandId };
    expect(s.run((p) => p.deployResult(done)).outcome).toBe("applied");
    expect(s.trains.get("t1")).toMatchObject({ phase: "MERGED", deployState: "TORN_DOWN", previewUrl: url("t1") });
    expect(s.deployments.get("preview-t1")!.status).toBe("TORN_DOWN");
    expect(s.run((p) => p.deployResult(done)).outcome).toBe("ignored:duplicate");
    // A duplicate DEPLOY report for a merged train (seen LIVE) does not re-teardown.
    expect(s.run((p) => p.deployResult({ ...done, op: "DEPLOY", commandId: "t1-deploy-1", url: url("t1") })).effects).toEqual([]);

    s.result("B", true);
    s.land("B");
    const [tdB] = s.takeOp("TEARDOWN");
    s.run((p) => p.deployResult({ ...done, trainId: "t2", commandId: tdB!.commandId, ok: false, summary: "API 500" }));
    expect(s.trains.get("t2")!.deployState).toBe("TEARDOWN_FAILED");
    expect(s.deployments.get("preview-t2")).toMatchObject({ status: "FAILED", summary: "teardown failed: API 500" });
  });

  it("nextCommandId numbers attempts", () => {
    expect(nextCommandId("t1", "fork", null)).toBe("t1-fork-1");
    expect(nextCommandId("t1", "fork", "t1-fork-9")).toBe("t1-fork-10");
  });
});

describe("planner: command watchdog", () => {
  const T = DEFAULT_COMMAND_TIMEOUT_MS;
  const forkIds = (r: PlanResult) => r.effects.flatMap((e) => (e.type === "provision" && e.command.op === "FORK" ? [e.command.commandId] : []));

  it("a stuck fork is re-issued under a new command id, a late result for the old id is stale, then the train is ejected", () => {
    const s = new Sim();
    s.submit("A");
    expect(s.takeOp("FORK").map((c) => c.commandId)).toEqual(["t1-fork-1"]);
    expect(s.trains.get("t1")!.forkIssuedAt).toBe(1000);

    // Not yet expired: the reconcile re-sends the same id and keeps the clock.
    s.now += T - 1;
    expect(forkIds(s.run((p) => p.reconcile()))).toEqual(["t1-fork-1"]);
    expect(s.trains.get("t1")!.forkIssuedAt).toBe(1000);

    // Expired: a new attempt (dispatched once, not twice), clock restarted.
    s.now += 1;
    expect(forkIds(s.run((p) => p.reconcile()))).toEqual(["t1-fork-2"]);
    expect(s.trains.get("t1")).toMatchObject({ phase: "BUILDING", forkState: "PENDING", forkCommandId: "t1-fork-2", forkIssuedAt: s.now });

    // The original Provisioner finally answers: stale, nothing changes.
    const late = s.run((p) => p.provisionResult({ commandId: "t1-fork-1", op: "FORK", trainId: "t1", ok: true, artifactRepo: "hive-train-t1" }));
    expect(late.outcome).toBe("ignored:stale");
    expect(s.trains.get("t1")!.forkState).toBe("PENDING");

    s.now += T;
    expect(forkIds(s.run((p) => p.reconcile()))).toEqual([`t1-fork-${MAX_FORK_ATTEMPTS}`]);
    s.effects = [];
    s.now += T;
    s.run((p) => p.reconcile());
    expect(s.trains.get("t1")).toMatchObject({
      phase: "EJECTED",
      reason: `failed on infrastructure: fork failed: Provisioner FORK t1-fork-${MAX_FORK_ATTEMPTS} did not report within 10 min (executor lost?)`,
    });
    // Same path as ok:false: the executor is lost, so no rework is charged (EXECUTOR_LOST on the item).
    expect(s.trains.has("t2")).toBe(false);
    expect(s.prompts.get("A")).toMatchObject({ attempts: 0, status: "FAILED" });
    expect(s.takeOp("DELETE").map((c) => c.commandId)).toEqual(["t1-delete-1"]);
  });

  it("a stuck preview DEPLOY is re-issued, then fails the train like ok:false", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A", false);
    expect(s.takeOp("DEPLOY").map((c) => c.commandId)).toEqual(["t1-deploy-1"]);
    for (let n = 2; n <= MAX_COMMAND_ATTEMPTS; n++) {
      s.now += T;
      s.run((p) => p.reconcile());
      expect(s.takeOp("DEPLOY").map((c) => c.commandId)).toEqual([`t1-deploy-${n}`]);
    }
    const stale = s.run((p) => p.deployResult({ commandId: "t1-deploy-1", op: "DEPLOY", environment: "preview", trainId: "t1", ok: true, url: url("t1") }));
    expect(stale.outcome).toBe("ignored:stale");
    s.now += T;
    s.run((p) => p.reconcile());
    expect(s.trains.get("t1")).toMatchObject({ phase: "EJECTED", deployState: "TEARING_DOWN" });
    expect(s.trains.get("t1")!.reason).toMatch(/^failed on infrastructure: preview deploy failed: Herald DEPLOY t1-deploy-3 did not report/);
    expect(s.prompts.get("A")).toMatchObject({ attempts: 0, status: "FAILED" });
    expect(s.deployments.get("preview-t1")).toMatchObject({ status: "FAILED" });
    expect(s.takeOp("TEARDOWN").map((c) => c.commandId)).toEqual(["t1-teardown-1"]);
  });

  it("a builder drone that never reports is re-dispatched as a new attempt, then the train fails", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    const first = s.take("dispatchDrone");
    expect(first.map((e) => e.attempt)).toEqual([1]);
    s.run((p) => p.dispatched("t1", "BUILDING"));
    expect(s.trains.get("t1")).toMatchObject({ dispatched: true, droneIssuedAt: s.now, droneAttempt: 1 });

    s.now += T;
    const retry = s.run((p) => p.reconcile()).effects.filter((e) => e.type === "dispatchDrone");
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({ attempt: 2, task: { role: "BUILDER", action: "BUILD" } });
    expect(s.trains.get("t1")).toMatchObject({ dispatched: false, droneAttempt: 2 });
    s.run((p) => p.dispatched("t1", "BUILDING"));
    s.now += T;
    s.run((p) => p.reconcile());
    s.run((p) => p.dispatched("t1", "BUILDING"));
    expect(s.trains.get("t1")!.droneAttempt).toBe(MAX_COMMAND_ATTEMPTS);
    s.effects = [];
    s.now += T;
    s.run((p) => p.reconcile());
    expect(s.trains.get("t1")).toMatchObject({ phase: "EJECTED" });
    expect(s.trains.get("t1")!.reason).toMatch(/BUILDER drone did not report within 10 min/);
    expect(s.trainOf("A").action).toBe("REWORK");
  });

  it("a lander that never reports is retried, then fails like a failed landing", () => {
    const s = Sim.abc();
    s.result("A", true);
    expect(s.trains.get("t1")!.phase).toBe("LANDING");
    s.run((p) => p.dispatched("t1", "LANDING"));
    s.now += T;
    const retry = s.run((p) => p.reconcile()).effects.filter((e) => e.type === "dispatchDrone");
    expect(retry).toEqual([expect.objectContaining({ attempt: 2, task: expect.objectContaining({ role: "LANDER", action: "LAND" }) })]);
    for (let i = 0; i < MAX_COMMAND_ATTEMPTS - 1; i++) {
      s.run((p) => p.dispatched("t1", "LANDING"));
      s.now += T;
      s.run((p) => p.reconcile());
    }
    expect(s.trains.get("t1")).toMatchObject({ phase: "EJECTED" });
    expect(s.trains.get("t1")!.reason).toMatch(/LANDER drone did not report/);
  });

  it("stuck TEARDOWN and DELETE commands are re-issued, then recorded as failed (never looped)", () => {
    const s = Sim.abc();
    s.result("A", true);
    s.land("A");
    expect(s.takeOp("DELETE").map((c) => c.commandId)).toEqual(["t1-delete-1"]);
    expect(s.takeOp("TEARDOWN").map((c) => c.commandId)).toEqual(["t1-teardown-1"]);
    for (let n = 2; n <= MAX_COMMAND_ATTEMPTS; n++) {
      s.now += T;
      s.run((p) => p.reconcile());
      expect(s.takeOp("DELETE").map((c) => c.commandId)).toEqual([`t1-delete-${n}`]);
      expect(s.takeOp("TEARDOWN").map((c) => c.commandId)).toEqual([`t1-teardown-${n}`]);
    }
    s.now += T;
    s.run((p) => p.reconcile());
    expect(s.trains.get("t1")).toMatchObject({ forkState: "DELETE_FAILED", deployState: "TEARDOWN_FAILED" });
    expect(s.deployments.get("preview-t1")).toMatchObject({ status: "FAILED" });
    s.now += T;
    s.run((p) => p.reconcile());
    expect(s.takeOp("DELETE")).toEqual([]);
    expect(s.takeOp("TEARDOWN")).toEqual([]);
  });

  it("watchdogDeadline: earliest issue time + timeout over outstanding commands; null when idle", () => {
    const s = new Sim();
    expect(watchdogDeadline([], T, 0)).toBeNull();
    s.submit("A");
    s.now = 5000;
    s.submit("B"); // waits for A's push: nothing outstanding for t2 yet
    expect(watchdogDeadline([...s.trains.values()], T, 9999)).toBe(1000 + T);
    s.completeForks();
    // The drone is due but not confirmed dispatched (a failed create, a crash): retried soon, not after T.
    expect(watchdogDeadline([...s.trains.values()], T, 9999)).toBe(9999 + UNDISPATCHED_RETRY_MS);
    s.run((p) => p.dispatched("t1", "BUILDING"));
    s.run((p) => p.dispatched("t2", "BUILDING"));
    expect(watchdogDeadline([...s.trains.values()], T, 9999)).toBe(5000 + T);
    // A row from before the watchdog (no clock) counts from now.
    const legacy = { ...s.trains.get("t1")!, droneIssuedAt: null };
    expect(watchdogDeadline([legacy], T, 7777)).toBe(7777 + T);
    const merged = { ...legacy, phase: "MERGED" as const, forkState: "DELETED" as const };
    expect(watchdogDeadline([merged], T, 7777)).toBeNull();
  });
});

describe("planner: model router", () => {
  const DS_FLASH = "@cf/deepseek-ai/deepseek-v4-flash-0731";
  const GLM_FLASH = "@cf/zai-org/glm-5.3-flash";
  const KIMI = "@cf/moonshotai/kimi-k2.7-code";
  const dispatchOf = (s: Sim) => s.take("dispatchDrone").filter((e) => e.task.role === "BUILDER");

  it("a dispatched BUILD carries the Queen's modelChoice; the train records model + reason and broadcasts them", () => {
    const s = new Sim();
    s.submit("A");
    s.take("broadcast");
    s.completeForks();
    const [d] = dispatchOf(s);
    expect(d!.task.modelChoice).toMatchObject({ model: DS_FLASH, tier: "fast", role: "builder", fallbacks: [GLM_FLASH, KIMI] });
    expect(s.trains.get("t1")).toMatchObject({ model: DS_FLASH, modelReason: d!.task.modelChoice!.reason, modelChoiceAttempt: 1, modelProbe: false });
    const upd = s.take("broadcast").find((e) => e.message.type === "train.updated");
    expect(upd?.message).toMatchObject({ train: { trainId: "t1", model: DS_FLASH, modelReason: expect.stringContaining("fast tier") } });
    expect(s.routerDispatches).toBe(1);
  });

  it("a reconcile re-dispatch of the same drone attempt reuses the persisted choice", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    const [first] = dispatchOf(s);
    const [again] = s.run((p) => p.reconcile()).effects.filter((e) => e.type === "dispatchDrone");
    expect(again).toMatchObject({ task: { modelChoice: first!.task.modelChoice } });
    expect(s.routerDispatches).toBe(1);
  });

  it("build-result: attempts for the model used (with build time), failures for unusable models; the train shows the actual model", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.run((p) => p.buildResult({ trainId: "t1", headSha: "h", model: GLM_FLASH, failedModels: [DS_FLASH], buildMs: 4200 }));
    expect(s.stat(DS_FLASH)).toMatchObject({ attempts: 1, passes: 0, failures: 1, failStreak: 1 });
    expect(s.stat(GLM_FLASH)).toMatchObject({ attempts: 1, passes: 0, failures: 0, avgBuildMs: 4200 });
    expect(s.trains.get("t1")).toMatchObject({ model: GLM_FLASH, modelOutcome: "BUILT" });
    expect(s.trains.get("t1")!.modelReason).toMatch(/^fell back to @cf\/zai-org\/glm-5.3-flash after 1 unusable · fast tier/);
    // An unusable change set on a floor-routed build raises the hive's floor.
    expect(s.floor).toMatchObject({ tier: "frontier", note: "raised to frontier after an unusable change set" });
  });

  it("a gate pass counts once: duplicate and stale results never double count", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A"); // no model in the result: attributed to the router's choice
    s.result("A", true);
    expect(s.stat(DS_FLASH)).toMatchObject({ attempts: 1, passes: 1, failures: 0, failStreak: 0 });
    expect(s.floor).toMatchObject({ tier: "fast", passStreak: 1 });
    const n = s.deltas.length;
    expect(s.run((p) => p.trainResult({ trainId: "t1", passed: true, summary: "again" })).outcome).toBe("ignored:duplicate");
    expect(s.run((p) => p.buildResult({ trainId: "t1", headSha: "h", model: KIMI })).outcome).not.toBe("applied");
    s.land("A");
    expect(s.run((p) => p.trainResult({ trainId: "t1", passed: false, summary: "late" })).outcome).toBe("ignored:stale");
    expect(s.deltas).toHaveLength(n);
    expect(s.stat(DS_FLASH)).toMatchObject({ attempts: 1, passes: 1, failures: 0 });
  });

  it("a gate failure counts against the builder and raises the floor; the REWORK escalates to frontier under role rework and leaves the floor alone", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A");
    s.result("A", false, "security scan rejected");
    expect(s.stat(DS_FLASH)).toMatchObject({ attempts: 1, passes: 0, failures: 1, failStreak: 1 });
    expect(s.floor).toEqual({ tier: "frontier", passStreak: 0, aboveStreak: 0, note: "raised to frontier after a gate failure" });
    const rework = dispatchOf(s).at(-1);
    expect(rework!.task).toMatchObject({ action: "REWORK", scribeSummary: "security scan rejected" });
    expect(rework!.task.modelChoice).toMatchObject({ model: KIMI, tier: "frontier", role: "rework" });
    expect(rework!.task.modelChoice!.reason).toMatch(/^rework → escalated to frontier · frontier tier/);
    s.build("A");
    s.result("A", true);
    expect(s.stat(KIMI, "rework")).toMatchObject({ attempts: 1, passes: 1 });
    expect(s.stat(KIMI)).toBeUndefined();
    // The floor neither consumed its note nor counted the rework pass.
    expect(s.floor).toEqual({ tier: "frontier", passStreak: 0, aboveStreak: 0, note: "raised to frontier after a gate failure" });
  });

  it("non-catalog models (scripted drones) are excluded from stats and the floor", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.run((p) => p.buildResult({ trainId: "t1", headSha: "h", model: "queenos/scripted-drone-v1", failedModels: ["queenos/other"], buildMs: 10 }));
    expect(s.trains.get("t1")!.model).toBe("queenos/scripted-drone-v1");
    s.completeDeploys();
    s.result("A", false);
    expect(s.deltas).toEqual([]);
    expect(s.floor).toEqual(INITIAL_FLOOR);
  });

  it("a builder that gives up before pushing counts an attempt and a failure for the chosen model", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.result("A", false, "no valid change set from any model");
    expect(s.stat(DS_FLASH)).toMatchObject({ attempts: 1, failures: 1 });
    expect(s.floor.tier).toBe("frontier");
  });

  it("a watchdog re-dispatch is a new attempt: escalated to frontier, floor untouched", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.take("dispatchDrone");
    s.run((p) => p.dispatched("t1", "BUILDING"));
    s.now += DEFAULT_COMMAND_TIMEOUT_MS;
    const [retry] = s.run((p) => p.reconcile()).effects.filter((e) => e.type === "dispatchDrone");
    expect(retry).toMatchObject({ attempt: 2, task: { modelChoice: { tier: "frontier", role: "builder" } } });
    if (retry?.type === "dispatchDrone") expect(retry.task.modelChoice!.reason).toMatch(/^attempt 2 → escalated to frontier/);
    expect(s.routerDispatches).toBe(2);
    // Its outcome does not move the floor either.
    s.build("A");
    s.result("A", true);
    expect(s.floor).toEqual(INITIAL_FLOOR);
  });

  it("at a frontier floor, 3 clean builds back off to fast; the next choice says why", () => {
    const s = new Sim();
    s.floor = { tier: "frontier", passStreak: 0, aboveStreak: 0, note: null };
    s.submit("A", "B", "C");
    s.completeForks();
    s.build("A");
    s.build("B");
    s.build("C");
    const tasks = dispatchOf(s);
    expect(tasks.map((d) => d.task.modelChoice?.tier)).toEqual(["frontier", "frontier", "frontier"]);
    expect(tasks[0]!.task.modelChoice!.reason).toContain("floor: frontier · 0/3 to back off · probe in 3");
    s.result("A", true);
    s.result("B", true);
    expect(s.floor).toMatchObject({ tier: "frontier", passStreak: 2 });
    s.result("C", true);
    expect(s.floor).toEqual({ tier: "fast", passStreak: 0, aboveStreak: 0, note: "backed off to fast after 3 clean builds" });
    s.submit("D");
    s.completeForks();
    const [d] = dispatchOf(s);
    expect(d!.task.modelChoice).toMatchObject({ tier: "fast" });
    expect(d!.task.modelChoice!.reason).toMatch(/^backed off to fast after 3 clean builds · fast tier/);
    expect(s.floor.note).toBeNull();
  });

  it("probe-down: after 4 floor dispatches the next tries fast; its pass drops the floor at once", () => {
    const s = new Sim();
    s.floor = { tier: "frontier", passStreak: 1, aboveStreak: 4, note: null };
    s.submit("A");
    s.completeForks();
    const [d] = dispatchOf(s);
    expect(d!.task.modelChoice).toMatchObject({ model: DS_FLASH, tier: "fast" });
    expect(d!.task.modelChoice!.reason).toMatch(/^probe: trying fast tier again/);
    expect(s.trains.get("t1")!.modelProbe).toBe(true);
    s.build("A");
    s.result("A", true);
    expect(s.floor).toEqual({ tier: "fast", passStreak: 0, aboveStreak: 0, note: "dropped to fast after a probe passed" });
  });

  it("an INFRA builder failure (AI rate limits) re-dispatches the drone: no rework, no model failure, floor and prompt attempts untouched", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.take("dispatchDrone");
    s.run((p) => p.dispatched("t1", "BUILDING"));
    const before = { floor: { ...s.floor }, deltas: s.deltas.length };
    const r = s.run((p) => p.trainResult({ trainId: "t1", passed: false, summary: "rate limited: 3021", cause: "infra", commandId: "t1-build" }));
    expect(r.outcome).toBe("applied");
    expect(s.trains.get("t1")).toMatchObject({ phase: "BUILDING", action: "BUILD", droneAttempt: 2, dispatched: false, modelOutcome: null });
    expect(s.prompts.get("A")).toMatchObject({ attempts: 0 });
    expect(s.deltas).toHaveLength(before.deltas);
    expect(s.floor).toEqual(before.floor);
    const [again] = s.take("dispatchDrone");
    expect(again).toMatchObject({ trainId: "t1", attempt: 2, task: { action: "BUILD" } });
    // A late or duplicate infra report from the superseded attempt is stale.
    expect(s.run((p) => p.trainResult({ trainId: "t1", passed: false, summary: "late", cause: "infra", commandId: "t1-build" })).outcome).toBe("ignored:stale");
    expect(s.trains.get("t1")!.droneAttempt).toBe(2);
    // The re-dispatched drone then builds and passes normally.
    s.run((p) => p.dispatched("t1", "BUILDING"));
    s.build("A");
    s.result("A", true);
    expect(s.status("A")).not.toBe("EJECTED");
    expect(s.floor.tier).toBe("fast");
  });

  it("past the drone attempt cap an INFRA failure fails the item on infrastructure (EXECUTOR_LOST), not as a rework", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    for (let n = 1; n < MAX_COMMAND_ATTEMPTS; n++) {
      s.run((p) => p.dispatched("t1", "BUILDING"));
      const id = n === 1 ? "t1-build" : `t1-build-${n}`;
      expect(s.run((p) => p.trainResult({ trainId: "t1", passed: false, summary: "rate limited", cause: "infra", commandId: id })).outcome).toBe("applied");
    }
    s.run((p) => p.dispatched("t1", "BUILDING"));
    s.run((p) => p.trainResult({ trainId: "t1", passed: false, summary: "rate limited", cause: "infra", commandId: `t1-build-${MAX_COMMAND_ATTEMPTS}` }));
    expect(s.trains.get("t1")).toMatchObject({ phase: "EJECTED", reason: "failed on infrastructure: rate limited" });
    expect(s.prompts.get("A")).toMatchObject({ attempts: 0, status: "FAILED" });
    expect(() => s.trainOf("A")).toThrow(); // no rework train
    expect(s.results.at(-1)!.infraFailed).toEqual([{ promptId: "A", summary: "rate limited" }]);
  });

  it("concurrent BUILD dispatches spread across the tier's builder models (Workers AI limits are per model); the floor is unchanged", () => {
    const s = new Sim();
    s.submit("A", "B", "C", "D");
    s.completeForks();
    const models = dispatchOf(s).map((d) => d.task.modelChoice!);
    expect(models.map((m) => m.model)).toEqual([DS_FLASH, GLM_FLASH, DS_FLASH, GLM_FLASH]);
    expect(models.every((m) => m.tier === "fast")).toBe(true);
    expect(models[1]!.reason).toContain("spread: 1 in flight on DeepSeek V4 Flash, 0 here");
    expect(models[1]!.fallbacks[0]).toBe(DS_FLASH);
    expect(s.floor).toMatchObject({ tier: "fast" });
  });

  it("honours the pin and the policy from the context; every 5th decision explores", () => {
    const s = new Sim();
    s.pin = "@cf/zai-org/glm-5.3";
    s.submit("A");
    s.completeForks();
    expect(dispatchOf(s)[0]!.task.modelChoice).toMatchObject({ model: "@cf/zai-org/glm-5.3", reason: "pinned by MODEL_ROUTER_PIN_BUILDER" });

    const e = new Sim();
    e.routerDispatches = 4;
    e.stats.set(`${DS_FLASH}|builder`, { model: DS_FLASH, role: "builder", attempts: 3, passes: 3, failures: 0, avgBuildMs: null, updatedAt: 0 });
    e.submit("A");
    e.completeForks();
    expect(dispatchOf(e)[0]!.task.modelChoice).toMatchObject({ model: GLM_FLASH, reason: expect.stringContaining("exploring least-tried") });

    const k = new Sim();
    k.policy = { backoffStreak: 1, probeAfter: 4 };
    k.floor = { tier: "frontier", passStreak: 0, aboveStreak: 0, note: null };
    k.submit("A");
    k.completeForks();
    k.build("A");
    k.result("A", true);
    expect(k.floor.tier).toBe("fast");
  });
});

const memory = (over: Partial<RecalledMemory> = {}): RecalledMemory => ({
  memoryId: "t0:aaaaaaaaaaaa",
  trainId: "t0",
  promptId: "Z",
  outcome: "FAILED",
  promptText: "do Z",
  text: "Prompt: do Z. Gate: security rejected an unbounded retry loop.",
  createdAt: 1,
  score: 0.82,
  ...over,
});

describe("planner: hive memory", () => {
  it("FORK carries the train's prompt as recallQuery (truncated to 4000 chars), identical on re-dispatch", () => {
    const s = new Sim();
    const long = "x".repeat(4_500);
    s.run((p) => p.submit({ promptId: "A", promptText: long }));
    const [first] = s.takeOp("FORK");
    expect(first!.recallQuery).toBe(long.slice(0, 4_000));
    const again = s.run((p) => p.reconcile()).effects.find((e) => e.type === "provision")!;
    expect(plain([again])[0]).toEqual({ type: "provision", trainId: "t1", command: first });
  });

  it("a fork retry under a new command id recalls for the same prompt", () => {
    const s = new Sim();
    s.submit("A");
    const [c] = s.takeOp("FORK");
    s.run((p) => p.provisionResult({ commandId: c!.commandId, op: "FORK", trainId: "t1", ok: false, summary: "503" }));
    expect(s.takeOp("FORK")).toEqual([expect.objectContaining({ commandId: "t1-fork-2", recallQuery: "do A" })]);
  });

  it("persists recalled memories on the train, exposes them, and feeds them to the BUILD drone as ragContext", () => {
    const s = new Sim();
    s.submit("A");
    expect(s.trains.get("t1")!.memories).toEqual([]);
    const [c] = s.takeOp("FORK");
    s.effects = [];
    const mems = [memory(), memory({ memoryId: "t9:bbbbbbbbbbbb", outcome: "PASSED", text: "Prompt: do Y. Gate: passed." })];
    const r = s.run((p) => p.provisionResult({ commandId: c!.commandId, op: "FORK", trainId: "t1", ok: true, artifactRepo: c!.forkName, baseSha: "m", memories: mems }));
    expect(s.trains.get("t1")!.memories).toEqual(mems);
    expect(toMergeTrain(s.trains.get("t1")!).memories).toEqual(mems);
    const updated = r.effects.find((e) => e.type === "broadcast" && e.message.type === "train.updated");
    expect(updated).toMatchObject({ message: { train: { trainId: "t1", memories: mems } } });
    const [d] = s.take("dispatchDrone");
    expect(d!.task.ragContext).toEqual([
      "[FAILED] Prompt: do Z. Gate: security rejected an unbounded retry loop.",
      "[PASSED] Prompt: do Y. Gate: passed.",
    ]);
  });

  it("a fork without memories (recall trouble) still builds, with an empty ragContext", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    expect(s.trains.get("t1")!.memories).toEqual([]);
    expect(s.take("dispatchDrone")[0]!.task.ragContext).toEqual([]);
  });

  it("a REWORK train builds with the memories recalled for its own fork; the lander gets none", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A");
    s.take("dispatchDrone");
    s.run((p) => p.trainResult({ trainId: "t1", passed: false, summary: "security rejected it" }));
    const [c] = s.takeOp("FORK");
    expect(c).toMatchObject({ trainId: "t2", recallQuery: "do A" });
    const mems = [memory({ trainId: "t1", promptId: "A", text: "Prompt: do A. Gate: failed. security rejected it" })];
    s.run((p) => p.provisionResult({ commandId: c!.commandId, op: "FORK", trainId: "t2", ok: true, artifactRepo: c!.forkName, memories: mems }));
    const [d] = s.take("dispatchDrone");
    expect(d!.task).toMatchObject({ action: "REWORK", scribeSummary: "security rejected it", ragContext: ["[FAILED] Prompt: do A. Gate: failed. security rejected it"] });
    // A reconcile re-dispatch of the same builder carries the same context.
    expect(s.run((p) => p.reconcile()).effects.find((e) => e.type === "dispatchDrone")).toMatchObject({ task: { ragContext: d!.task.ragContext } });
    s.take("dispatchDrone");
    s.build("A");
    s.result("A", true);
    const lander = s.take("dispatchDrone").find((e) => e.task.role === "LANDER");
    expect(lander!.task.ragContext).toEqual([]);
    expect(s.trains.get("t2")!.memories).toEqual(mems);
  });
});

// ── v2: races, merge-queue hooks, traces ─────────────────────────────────

const DS_FLASH = "@cf/deepseek-ai/deepseek-v4-flash-0731";
const GLM_FLASH = "@cf/zai-org/glm-5.3-flash";
const KIMI = "@cf/moonshotai/kimi-k2.7-code";
const score = (over: Partial<GateScore> = {}): GateScore => ({ review: "approved", satisfied: 4, missing: 0, changedFiles: 2, changedBytes: 3000, checks: 5, ...over });

/** A race of `width` for prompt A: race t1, candidates t2.., all forked, built and live. */
function raceSim(width = 3): Sim {
  const s = new Sim();
  s.run((p) => p.submit({ promptId: "A", promptText: "do A", raceWidth: width }));
  s.completeForks();
  for (let i = 0; i < width; i++) s.run((p) => p.buildResult({ trainId: `t${i + 2}`, headSha: `h${i + 2}`, model: undefined }));
  s.completeDeploys();
  s.take("dispatchDrone");
  return s;
}

describe("planner: races (best-of-N)", () => {
  it("a race's candidates all fork from main at once, on distinct models whose fallbacks exclude their siblings", () => {
    const s = new Sim();
    const r = s.run((p) => p.submit({ promptId: "A", promptText: "do A", raceWidth: 3 }));
    expect(s.takeOp("FORK").map((f) => [f.trainId, f.sourceRepo])).toEqual([
      ["t2", "hive"],
      ["t3", "hive"],
      ["t4", "hive"],
    ]);
    expect(r.races).toEqual([expect.objectContaining({ raceId: "t1", itemId: "A", width: 3, state: "RACING", trainIds: ["t2", "t3", "t4"], deadlineAt: null })]);
    const cands = ["t2", "t3", "t4"].map((id) => s.trains.get(id)!);
    expect(cands.map((t) => [t.raceId, t.candidate, t.raceOutcome, t.includedPrompts])).toEqual([
      ["t1", 0, "RACING", ["A"]],
      ["t1", 1, "RACING", ["A"]],
      ["t1", 2, "RACING", ["A"]],
    ]);
    expect(cands.map((t) => t.model)).toEqual([DS_FLASH, GLM_FLASH, KIMI]);
    for (const t of cands) for (const fb of t.modelChoice!.fallbacks) expect([DS_FLASH, GLM_FLASH, KIMI]).not.toContain(fb);
    expect(r.events.filter((e) => e.type === "race.started")).toHaveLength(1);
    for (const id of ["t2", "t3", "t4"]) {
      s.run((p) => p.provisionResult({ commandId: `${id}-fork-1`, op: "FORK", trainId: id, ok: true, artifactRepo: `hive-train-${id}` }));
    }
    expect(s.take("dispatchDrone").map((d) => d.task.modelChoice?.model)).toEqual([DS_FLASH, GLM_FLASH, KIMI]);
  });

  it("the winner (by rankCandidates) gets passedSeq; losers are EJECTED as LOST; the floor does not move; stats count every candidate", () => {
    const s = raceSim();
    const floor = { ...s.floor };
    s.run((p) => p.trainResult({ trainId: "t2", passed: true, summary: "ok", score: score({ review: "skipped" }) }));
    expect(s.trains.get("t2")).toMatchObject({ phase: "TESTING", raceOutcome: "PASSED" });
    expect(s.races.get("t1")!.deadlineAt).toBe(s.now + 90_000);
    s.run((p) => p.trainResult({ trainId: "t3", passed: true, summary: "ok", score: score({ changedBytes: 3000 }) }));
    s.run((p) => p.trainResult({ trainId: "t4", passed: true, summary: "ok", score: score({ changedBytes: 9000 }) }));
    expect(s.trains.get("t3")).toMatchObject({ raceOutcome: "WON", passedSeq: 1 });
    expect(s.trains.get("t3")!.reason).toMatch(/^won: reviewer approved \(4\/0\).*2\.9 KB vs 8\.8 KB; GLM-5\.3 Flash$/);
    expect(s.trains.get("t3")!.phase).toBe("LANDING"); // direct landing: nothing ahead
    expect(s.trains.get("t2")).toMatchObject({ phase: "EJECTED", raceOutcome: "LOST" });
    expect(s.trains.get("t2")!.reason).toMatch(/^lost race to t3: reviewer approved/);
    expect(s.trains.get("t4")!.reason).toBe("lost race to t3: 2.9 KB vs 8.8 KB");
    expect(s.races.get("t1")).toMatchObject({ state: "DECIDED", winnerTrainId: "t3" });
    expect(s.status("A")).toBe("IN_TRAIN");
    expect(s.floor).toEqual(floor);
    for (const m of [DS_FLASH, GLM_FLASH, KIMI]) expect(s.stat(m)).toMatchObject({ attempts: 1, passes: 1 });
    expect(s.events.filter((e) => e.type === "race.decided")).toHaveLength(1);
  });

  it("a late loser result is ignored:stale", () => {
    const s = raceSim(2);
    s.run((p) => p.trainResult({ trainId: "t2", passed: true, summary: "ok" }));
    s.run((p) => p.trainResult({ trainId: "t3", passed: true, summary: "ok" }));
    expect(s.trains.get("t3")!.raceOutcome).toBe("LOST"); // tie → lower candidate index wins
    expect(s.run((p) => p.trainResult({ trainId: "t3", passed: true, summary: "late" })).outcome).toBe("ignored:stale");
    expect(s.run((p) => p.buildResult({ trainId: "t3", headSha: "late" })).outcome).toBe("ignored:stale");
  });

  it("at the deadline the race is decided with the passes so far; still-running candidates lose; the alarm covers it", () => {
    const s = raceSim();
    s.run((p) => p.trainResult({ trainId: "t2", passed: true, summary: "ok" }));
    const deadline = s.now + 90_000;
    expect(watchdogDeadline([...s.trains.values()], DEFAULT_COMMAND_TIMEOUT_MS, s.now, [...s.races.values()])).toBe(deadline);
    s.now = deadline - 1;
    s.run((p) => p.reconcile());
    expect(s.races.get("t1")!.state).toBe("RACING");
    s.now = deadline;
    s.run((p) => p.reconcile());
    expect(s.trains.get("t2")).toMatchObject({ raceOutcome: "WON", passedSeq: 1 });
    expect(["t3", "t4"].map((id) => s.trains.get(id)!.reason)).toEqual(["lost race to t2: still running at the race deadline", "lost race to t2: still running at the race deadline"]);
  });

  it("a failing candidate is ejected alone; when all fail the race is ABANDONED and the item reworks once with the best failure's summary", () => {
    const s = raceSim();
    s.run((p) => p.trainResult({ trainId: "t2", passed: false, summary: "bad 1", score: score({ review: "off", missing: 3 }) }));
    expect(s.trains.get("t2")).toMatchObject({ phase: "EJECTED", raceOutcome: "FAILED", reason: "failed in race: bad 1" });
    expect(s.prompts.get("A")!.attempts).toBe(0);
    expect([...s.trains.values()].filter(isActiveRow)).toHaveLength(2); // no rework yet
    s.run((p) => p.trainResult({ trainId: "t3", passed: false, summary: "bad 2", score: score({ missing: 1 }) }));
    s.run((p) => p.trainResult({ trainId: "t4", passed: false, summary: "bad 3" }));
    expect(s.races.get("t1")).toMatchObject({ state: "ABANDONED", winnerTrainId: null });
    expect(s.prompts.get("A")).toMatchObject({ attempts: 1, summary: "bad 2" });
    const active = [...s.trains.values()].filter(isActiveRow);
    expect(active).toEqual([expect.objectContaining({ promptId: "A", action: "REWORK", raceId: null, forkSource: "hive" })]);
  });

  it("the rework width comes from the race policy (reworkWidth), and a pin forces width 1", () => {
    const s = new Sim();
    s.race = { reworkWidth: 2, hardWidth: 3, maxRaceWidth: 3, slotsFree: 10 };
    s.submit("A");
    s.completeForks();
    s.build("A");
    s.result("A", false, "nope");
    const reworks = [...s.trains.values()].filter((t) => isActiveRow(t) && t.action === "REWORK");
    expect(reworks).toHaveLength(2);
    expect(new Set(reworks.map((t) => t.raceId)).size).toBe(1);
    expect(reworks.every((t) => t.modelChoice?.role === "rework" && t.modelChoice.tier === "frontier")).toBe(true);
    expect(new Set(reworks.map((t) => t.model)).size).toBe(2);

    const pinned = new Sim();
    pinned.race = s.race;
    pinned.pin = KIMI;
    pinned.submit("A");
    pinned.completeForks();
    pinned.build("A");
    pinned.result("A", false, "nope");
    expect([...pinned.trains.values()].filter((t) => isActiveRow(t) && t.action === "REWORK")).toHaveLength(1);
  });
});

function isActiveRow(t: TrainRecord): boolean {
  return t.phase !== "MERGED" && t.phase !== "EJECTED";
}

const none = (): QueueDecision => ({ patches: [], cars: [], failures: [], effects: [], events: [] });

/** Fake queue.ts: boards every waiting passed build (at least `min`) onto one car; mergeResult moves the car on. */
function fakeQueue(min = 1) {
  const formCars = vi.fn((trains: readonly TrainRecord[], ctx: { newId: () => string }): QueueDecision => {
    const waiting = trains.filter((t) => t.lane !== "QUEUE" && t.phase === "PASSED" && !t.carId);
    if (waiting.length < min) return none();
    const carId = ctx.newId();
    return {
      ...none(),
      cars: [{ carId, members: waiting.map((t) => t.trainId), includedPrompts: waiting.map((t) => t.promptId), predecessorCarId: null, bisectOf: null }],
      patches: waiting.map((t) => ({ trainId: t.trainId, patch: { carId } })),
    };
  });
  const mergeResult = vi.fn((car: TrainRecord, r: { headSha?: string; merged: string[]; fastForward: boolean; conflicts: { trainId: string; paths: string[]; kind: "content"; summary: string }[] }): QueueDecision => ({
    ...none(),
    patches: [
      { trainId: car.trainId, patch: { phase: r.fastForward ? "PASSED" : "DEPLOYING", headSha: r.headSha ?? null, members: r.merged, dispatched: false } },
      ...r.conflicts.map((c) => ({ trainId: c.trainId, patch: { carId: null, conflict: c } })),
    ],
    failures: r.conflicts.map((c) => ({ trainId: c.trainId, summary: `Merge conflict: ${c.paths.join(", ")}`, cause: "conflict" as const, waitForCarSeq: car.seq, conflict: c, claimPaths: c.paths })),
  }));
  const carFailed = vi.fn((): QueueDecision => none());
  const carLanded = vi.fn((car: TrainRecord, sha: string): QueueDecision => ({
    ...none(),
    patches: [car.trainId, ...(car.members ?? [])].map((id) => ({ trainId: id, patch: { phase: "MERGED" as const, landedSha: sha } })),
  }));
  return { formCars, mergeResult, carFailed, carLanded };
}

function queueSim(min = 1) {
  const s = new Sim();
  const hooks = fakeQueue(min);
  s.queue = { settings: { maxQueueBatch: 4, maxQueueDepth: 3 }, hooks: hooks as unknown as QueueOptions["hooks"] };
  return { s, hooks };
}

describe("planner: merge-queue hooks (queue.ts injected)", () => {
  it("a pass calls formCars; the CarDraft becomes a QUEUE car forked from main; its fork dispatches the MERGE drone with the members", () => {
    const { s, hooks } = queueSim();
    s.submit("A");
    s.completeForks();
    s.build("A");
    s.take("dispatchDrone");
    s.run((p) => p.trainResult({ trainId: "t1", passed: true, summary: "ok" }));
    expect(hooks.formCars).toHaveBeenCalled();
    expect(s.trains.get("t1")).toMatchObject({ phase: "PASSED", passedSeq: 1, carId: "t2" });
    expect(s.trains.get("t2")).toMatchObject({ lane: "QUEUE", members: ["t1"], includedPrompts: ["A"], phase: "BUILDING", forkState: "PENDING", forkSource: "hive" });
    const [fork] = s.takeOp("FORK");
    expect(fork).toEqual({ op: "FORK", commandId: "t2-fork-1", hive: "hive", trainId: "t2", sourceRepo: "hive", forkName: "hive-train-t2" }); // no recallQuery
    s.run((p) => p.provisionResult({ commandId: "t2-fork-1", op: "FORK", trainId: "t2", ok: true, artifactRepo: "hive-train-t2", baseSha: "m0" }));
    const [merge] = s.take("dispatchDrone");
    expect(merge!.task).toMatchObject({
      trainId: "t2",
      action: "MERGE",
      role: "LANDER",
      promptText: "queue car t2: 1 members",
      members: [{ trainId: "t1", promptId: "A", artifactRepo: "hive-train-t1", headSha: "head:A", title: "do A" }],
    });
    expect(s.run((p) => p.buildResult({ trainId: "t2", headSha: "x" })).outcome).toBe("ignored:unknown");
  });

  it("mergeResult: DEPLOYING car gets a preview, the next car forks from it; the PASSED head lands with the LANDER; carLanded fans out to members", () => {
    const { s, hooks } = queueSim();
    s.submit("A", "B");
    s.completeForks();
    s.build("A");
    s.build("B");
    s.take("dispatchDrone");
    s.run((p) => p.trainResult({ trainId: "t1", passed: true, summary: "ok" })); // car t3 [t1]
    s.run((p) => p.trainResult({ trainId: "t2", passed: true, summary: "ok" })); // car t4 [t2], waits for t3's push
    expect(s.trains.get("t4")).toMatchObject({ lane: "QUEUE", phase: "WAITING_PARENT" });
    s.completeForks();
    const m = { trainId: "t3", ok: true, headSha: "k1", baseSha: "m0", merged: ["t1"], conflicts: [], fastForward: false, summary: "" };
    expect(s.run((p) => p.mergeResult(m)).outcome).toBe("applied");
    expect(hooks.mergeResult).toHaveBeenCalledTimes(1);
    expect(s.trains.get("t3")).toMatchObject({ phase: "DEPLOYING", headSha: "k1", deployState: "PENDING" });
    expect(s.takeOp("FORK")).toEqual([expect.objectContaining({ trainId: "t4", sourceRepo: "hive-train-t3" })]);
    expect(s.run((p) => p.mergeResult(m)).outcome).toBe("ignored:duplicate");
    s.completeDeploys();
    s.take("dispatchDrone");
    s.run((p) => p.trainResult({ trainId: "t3", passed: true, summary: "integration ok" }));
    const [lander] = s.take("dispatchDrone").filter((d) => d.task.action === "LAND");
    expect(lander!.task).toMatchObject({ trainId: "t3", role: "LANDER", baseRef: "k1", members: [expect.objectContaining({ trainId: "t1" })] });
    s.effects = [];
    const landed = s.run((p) => p.landResult({ trainId: "t3", landed: true, mainSha: "main-1", summary: "" }));
    expect(hooks.carLanded).toHaveBeenCalledWith(expect.objectContaining({ trainId: "t3" }), "main-1", expect.anything(), expect.anything());
    expect(landed.landed).toEqual({ sha: "main-1", trainIds: ["t1"] });
    expect([s.trains.get("t3")!.phase, s.trains.get("t1")!.phase, s.status("A")]).toEqual(["MERGED", "MERGED", "MERGED"]);
    expect(s.takeOp("DELETE").map((d) => d.trainId).sort()).toEqual(["t1", "t3"]);
  });

  it("a conflict reworks the member (conflicts + 1, not attempts) and holds it WAITING_PARENT until the car is terminal", () => {
    const { s } = queueSim(2);
    s.submit("A", "B");
    s.completeForks();
    s.build("A");
    s.build("B");
    s.run((p) => p.trainResult({ trainId: "t1", passed: true, summary: "ok" }));
    s.run((p) => p.trainResult({ trainId: "t2", passed: true, summary: "ok" })); // car t3 [t1, t2]
    expect(s.trains.get("t3")!.members).toEqual(["t1", "t2"]);
    s.completeForks();
    s.effects = [];
    const conflict = { trainId: "t2", kind: "content" as const, paths: ["src/theme.js"], summary: "" };
    const r = s.run((p) => p.mergeResult({ trainId: "t3", ok: true, headSha: "k1", merged: ["t1"], conflicts: [conflict], fastForward: false, summary: "" }));
    expect(s.trains.get("t2")).toMatchObject({ phase: "EJECTED", reason: "failed: Merge conflict: src/theme.js", conflict });
    expect(s.prompts.get("B")).toMatchObject({ attempts: 0, summary: "Merge conflict: src/theme.js" });
    expect(r.itemConflicts).toEqual([{ itemId: "B", conflicts: 1 }]);
    expect(r.conflictClaims).toEqual([{ itemId: "B", paths: ["src/theme.js"] }]);
    const rework = s.trainOf("B");
    expect(rework).toMatchObject({ action: "REWORK", waitForCarSeq: 3, phase: "WAITING_PARENT" });
    expect(s.takeOp("FORK").filter((f) => f.trainId === rework.trainId)).toEqual([]);
    s.run((p) => p.reconcile());
    expect(s.trainOf("B").phase).toBe("WAITING_PARENT");
    s.completeDeploys();
    s.run((p) => p.trainResult({ trainId: "t3", passed: true, summary: "ok" }));
    s.run((p) => p.landResult({ trainId: "t3", landed: true, mainSha: "main-2", summary: "" }));
    expect(s.trainOf("B")).toMatchObject({ phase: "BUILDING", forkState: "PENDING", forkSource: "hive" });
  });

  it("past maxConflictReworks a conflicting item is FAILED", () => {
    const { s } = queueSim(2);
    s.items = [{ itemId: "B", conflicts: 2 }];
    s.submit("A", "B");
    s.completeForks();
    s.build("A");
    s.build("B");
    s.run((p) => p.trainResult({ trainId: "t1", passed: true, summary: "ok" }));
    s.run((p) => p.trainResult({ trainId: "t2", passed: true, summary: "ok" }));
    s.completeForks();
    const r = s.run((p) =>
      p.mergeResult({ trainId: "t3", ok: true, headSha: "k1", merged: ["t1"], conflicts: [{ trainId: "t2", kind: "content", paths: ["a"], summary: "" }], fastForward: false, summary: "" }),
    );
    expect(r.itemConflicts).toEqual([{ itemId: "B", conflicts: 3 }]);
    expect(s.status("B")).toBe("FAILED");
  });

  it("car failures route to carFailed: a gate verdict as 'gate', a preview failure as 'infra'; the car is ejected", () => {
    for (const how of ["gate", "infra"] as const) {
      const { s, hooks } = queueSim();
      s.submit("A");
      s.completeForks();
      s.build("A");
      s.run((p) => p.trainResult({ trainId: "t1", passed: true, summary: "ok" }));
      s.completeForks();
      s.run((p) => p.mergeResult({ trainId: "t2", ok: true, headSha: "k1", merged: ["t1"], conflicts: [], fastForward: false, summary: "" }));
      if (how === "gate") {
        s.completeDeploys();
        s.run((p) => p.trainResult({ trainId: "t2", passed: false, summary: "smoke /x 500" }));
      } else {
        s.run((p) => p.deployResult({ commandId: "t2-deploy-1", op: "DEPLOY", environment: "preview", trainId: "t2", ok: false, summary: "boom" }));
      }
      expect(hooks.carFailed).toHaveBeenCalledWith(expect.objectContaining({ trainId: "t2" }), expect.any(String), how, expect.anything(), expect.anything());
      expect(s.trains.get("t2")!.phase).toBe("EJECTED");
      expect(s.prompts.get("A")!.attempts).toBe(0); // the car's failure is not the member's
    }
  });
});

describe("planner: trace stamping and events", () => {
  it("every command and drone task carries the item's trace, with span = spanIdFor(command / drone instance id)", () => {
    const s = new Sim();
    const trace = "a".repeat(32);
    s.items = [{ itemId: "A", traceId: trace }];
    s.submit("A", "B");
    const forks = s.take("provision").map((e) => e.command);
    expect(forks[0]!.trace).toEqual({ traceparent: traceparent(trace, spanIdFor("t1-fork-1")) });
    expect(forks[1]!.trace).toEqual({ traceparent: traceparent(traceIdFromUuid("B"), spanIdFor("t2-fork-1")) });
    expect([s.trains.get("t1")!.traceId, s.trains.get("t2")!.traceId]).toEqual([trace, traceIdFromUuid("B")]);
    s.run((p) => p.provisionResult({ commandId: "t1-fork-1", op: "FORK", trainId: "t1", ok: true, artifactRepo: "hive-train-t1" }));
    const [d] = s.take("dispatchDrone");
    expect(d!.task.trace).toEqual({ traceparent: traceparent(trace, spanIdFor("t1-build")) });
  });

  it("enqueue emits train.enqueued; each phase change emits train.phase as a child of the item span (EJECTED is a warning)", () => {
    const s = new Sim();
    const r = s.run((p) => p.submit({ promptId: "A", promptText: "do A" }));
    expect(r.events.map((e) => [e.type, e.summary])).toEqual([
      ["train.enqueued", "BUILD train t1 for A"],
      ["train.phase", "train t1 WAITING_PARENT → BUILDING"],
    ]);
    expect(r.events[1]).toMatchObject({ actor: "queen", traceId: traceIdFromUuid("A"), spanId: spanIdFor("t1"), parentSpanId: spanIdFor("A"), itemId: "A", trainId: "t1", data: { from: "WAITING_PARENT", to: "BUILDING", lane: "BUILD" } });
    s.completeForks();
    s.build("A");
    const f = s.result("A", false, "nope");
    expect(f.events.find((e) => e.type === "train.phase" && e.trainId === "t1")).toMatchObject({ severity: "warn", summary: "train t1 TESTING → EJECTED: failed: nope" });
  });

  it("a car's events are recorded in each member's trace, as a child of that member's build span", () => {
    const { s } = queueSim(2);
    s.items = [{ itemId: "A", traceId: "a".repeat(32) }, { itemId: "B", traceId: "b".repeat(32) }];
    s.submit("A", "B");
    s.completeForks();
    s.build("A");
    s.build("B");
    s.run((p) => p.trainResult({ trainId: "t1", passed: true, summary: "ok" }));
    const r = s.run((p) => p.trainResult({ trainId: "t2", passed: true, summary: "ok" }));
    const carEvents = r.events.filter((e) => e.trainId === "t3" && e.type === "train.phase");
    expect(carEvents.map((e) => [e.traceId, e.spanId, e.parentSpanId, e.itemId])).toEqual([
      ["a".repeat(32), spanIdFor("t3"), spanIdFor("t1"), "A"],
      ["b".repeat(32), spanIdFor("t3"), spanIdFor("t2"), "B"],
    ]);
  });
});

describe("planner: War Room views", () => {
  it("toMergeTrain stays v1-shaped; toMergeTrainV2 adds the v2 fields that are set (lane only for cars)", () => {
    const s = raceSim(2);
    s.run((p) => p.trainResult({ trainId: "t2", passed: true, summary: "ok", score: score() }));
    const t = s.trains.get("t2")!;
    expect(toMergeTrain(t)).not.toHaveProperty("raceId");
    expect(toMergeTrainV2(t)).toMatchObject({ trainId: "t2", raceId: "t1", candidate: 0, raceOutcome: "PASSED", traceId: traceIdFromUuid("A"), score: score() });
    expect(toMergeTrainV2(t)).not.toHaveProperty("lane");
    expect(toMergeTrainV2({ ...t, lane: "QUEUE", members: ["x"] })).toMatchObject({ lane: "QUEUE", members: ["x"] });
  });
});

describe("planner: infrastructure failures (one path: no attempt charged, bounded, then EXECUTOR_LOST)", () => {
  const deployFail = (s: Sim, commandId: string, retryable: boolean, summary = "Preview deploy failed: HttpError: HTTP Error: 503 Service Unavailable") =>
    s.run((p) => p.deployResult({ commandId, op: "DEPLOY", environment: "preview", trainId: "t1", ok: false, retryable, summary }));
  const waitOut = (s: Sim) => {
    const t = s.trains.get("t1")!;
    const at = infraRetryAt(t, s.now);
    expect(at).not.toBeNull();
    s.now = at!;
    return s.run((p) => p.reconcile());
  };

  it("a retryable (503) preview deploy is re-deployed after a jittered backoff via the alarm: no rework, attempts untouched", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A", false);
    expect(s.takeOp("DEPLOY").map((c) => c.commandId)).toEqual(["t1-deploy-1"]);
    expect(deployFail(s, "t1-deploy-1", true).outcome).toBe("applied");
    const t = s.trains.get("t1")!;
    expect(t).toMatchObject({ phase: "DEPLOYING", deployState: "FAILED", deployIssuedAt: s.now });
    expect(s.prompts.get("A")).toMatchObject({ attempts: 0, status: "IN_TRAIN" });
    expect(s.takeOp("DEPLOY")).toEqual([]); // not at once: backoff
    const delay = infraRetryDelayMs(t);
    expect(delay).toBeGreaterThanOrEqual(INFRA_RETRY_BASE_MS / 2);
    expect(delay).toBeLessThan(INFRA_RETRY_BASE_MS * 1.5);
    // The alarm is armed for the retry (well before the 10 min watchdog).
    expect(watchdogDeadline([...s.trains.values()], DEFAULT_COMMAND_TIMEOUT_MS, s.now)).toBe(s.now + delay);
    // Early reconcile: still waiting.
    s.now += 1;
    s.run((p) => p.reconcile());
    expect(s.takeOp("DEPLOY")).toEqual([]);
    waitOut(s);
    expect(s.takeOp("DEPLOY").map((c) => c.commandId)).toEqual(["t1-deploy-2"]);
    s.run((p) => p.deployResult({ commandId: "t1-deploy-2", op: "DEPLOY", environment: "preview", trainId: "t1", ok: true, url: url("t1") }));
    expect(s.trains.get("t1")).toMatchObject({ phase: "TESTING", deployState: "LIVE" });
    s.result("A", true);
    expect(s.trains.get("t1")!.phase).toMatch(/^(PASSED|LANDING)$/); // passed its gate (direct landing without a queue)
    expect(s.prompts.get("A")!.attempts).toBe(0);
  });

  it("a non-retryable preview failure (the change: bad module) still reworks", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A", false);
    s.takeOp("DEPLOY");
    deployFail(s, "t1-deploy-1", false, "Uncaught SyntaxError");
    expect(s.trains.get("t1")!.phase).toBe("EJECTED");
    expect(s.trainOf("A")).toMatchObject({ action: "REWORK" });
    expect(s.prompts.get("A")!.attempts).toBe(1);
  });

  it("a gate that could not run (cause infra in TESTING, no commandId) re-deploys and re-gates; it never reworks", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A");
    expect(s.trains.get("t1")!.phase).toBe("TESTING");
    const r = s.run((p) => p.trainResult({ trainId: "t1", passed: false, summary: "Gatekeeper could not inspect the push: HttpError: HTTP Error: 503 Service Unavailable", cause: "infra" }));
    expect(r.outcome).toBe("applied");
    expect(s.trains.get("t1")).toMatchObject({ phase: "DEPLOYING", deployState: "FAILED" });
    expect(s.prompts.get("A")).toMatchObject({ attempts: 0 });
    expect(s.deltas.filter((d) => d.failures > 0)).toEqual([]); // not a model failure
    expect(s.events.some((e) => /infra retry 1\/2/.test(e.summary))).toBe(true);
    waitOut(s);
    s.completeDeploys();
    expect(s.trains.get("t1")!.phase).toBe("TESTING");
    s.result("A", true);
    expect(s.trains.get("t1")!.phase).toMatch(/^(PASSED|LANDING)$/); // passed its gate (direct landing without a queue)
  });

  it(`repeated infra failures stop after ${MAX_INFRA_ATTEMPTS} attempts with EXECUTOR_LOST (infraFailed), never REWORK_EXHAUSTED`, () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A", false);
    for (let n = 1; n < MAX_INFRA_ATTEMPTS; n++) {
      const [c] = s.takeOp("DEPLOY");
      expect(c!.commandId).toBe(`t1-deploy-${n}`);
      deployFail(s, c!.commandId, true);
      expect(s.trains.get("t1")!.phase).toBe("DEPLOYING");
      waitOut(s);
    }
    // The last deploy goes live, but then the gate cannot run: same cap (counted by deploy attempts).
    const [last] = s.takeOp("DEPLOY");
    expect(last!.commandId).toBe(`t1-deploy-${MAX_INFRA_ATTEMPTS}`);
    s.run((p) => p.deployResult({ commandId: last!.commandId, op: "DEPLOY", environment: "preview", trainId: "t1", ok: true, url: url("t1") }));
    const r = s.run((p) => p.trainResult({ trainId: "t1", passed: false, summary: "Gatekeeper could not inspect the push: HTTP Error: 503", cause: "infra" }));
    expect(s.trains.get("t1")).toMatchObject({ phase: "EJECTED" });
    expect(s.trains.get("t1")!.reason).toMatch(/^failed on infrastructure: gate could not run: .*503.*\(after 3 attempts\)$/);
    expect(s.prompts.get("A")).toMatchObject({ status: "FAILED", attempts: 0 });
    expect(r.infraFailed).toEqual([{ promptId: "A", summary: expect.stringContaining("gate could not run") }]);
    expect([...s.trains.values()].filter((t) => t.action === "REWORK")).toEqual([]);
  });

});

// ── T1: pushed submissions (pre-forked trains; human-push design rev 2 §6) ──────────────────────────

describe("planner: pushed submissions (pre-forked trains)", () => {
  const HUMAN = { kind: "human" as const, id: "ada@example.com" };
  const HEAD = "a".repeat(40);
  const BASE = "b".repeat(40);
  const item = (id: string, extra: Partial<PlannerItem> = {}): PlannerItem => ({ itemId: id, traceId: traceIdFromUuid(id), priority: 2, paths: [], bestOf: null, ...extra });

  function intent(s: Sim, trainId: string, promptId: string): TrainRecord {
    s.run((p) => p.intent({ trainId, promptId, origin: HUMAN }));
    return s.trains.get(trainId)!;
  }

  function push(s: Sim, trainId: string, promptId: string, opts: { resume?: boolean; race?: { join: string } | { create: true } | null; head?: string; handoff?: boolean } = {}): PlanResult {
    return s.run((p) =>
      p.pushed({
        trainId,
        headSha: opts.head ?? HEAD,
        baseSha: BASE,
        origin: HUMAN,
        promptId,
        promptText: `pushed ${promptId}`,
        attempts: 0,
        item: item(promptId, opts.handoff ? { handoff: true } : {}),
        race: opts.race ?? null,
        resume: opts.resume ?? true,
      }),
    );
  }

  it("an intent is a pre-forked BUILD train: BUILDING, fork PENDING, origin set, nothing dispatched; its clock arms the watchdog", () => {
    const s = new Sim();
    const t = intent(s, "p1", "I1");
    expect(t).toMatchObject({ phase: "BUILDING", forkState: "PENDING", lane: "BUILD", action: "BUILD", origin: HUMAN, artifactRepo: "hive-train-p1", forkIssuedAt: 1000 });
    expect(s.effects.filter((e) => e.type !== "broadcast")).toEqual([]);
    expect(watchdogDeadline([t], DEFAULT_COMMAND_TIMEOUT_MS, s.now)).toBe(1000 + DEFAULT_COMMAND_TIMEOUT_MS);
    // reconcile re-sends nothing for it (the proxy forks, not the Provisioner).
    s.run((p) => p.reconcile());
    expect(s.effects.filter((e) => e.type !== "broadcast")).toEqual([]);
    expect(toMergeTrainV2(s.trains.get("p1")!).origin).toEqual(HUMAN);
  });

  it("gitPushed adopts the fork and enters the pipeline like a build-result: DEPLOYING, preview, gate, PASSED, landed; no fork, no builder", () => {
    const s = new Sim();
    intent(s, "p1", "I1");
    push(s, "p1", "I1");
    const t = s.trains.get("p1")!;
    expect(t).toMatchObject({ phase: "DEPLOYING", forkState: "READY", headSha: HEAD, baseSha: BASE, raceId: null });
    expect(s.prompts.get("I1")).toMatchObject({ status: "IN_TRAIN", promptText: "pushed I1" });
    expect(s.takeOp("FORK")).toEqual([]);
    expect(s.take("dispatchDrone")).toEqual([]);
    s.completeDeploys();
    expect(s.trains.get("p1")!.phase).toBe("TESTING");
    s.run((p) => p.trainResult({ trainId: "p1", passed: true, summary: "ok" }));
    expect(s.trains.get("p1")!.phase).toBe("LANDING"); // no queue: lands directly (uncorrelated: no race record)
    s.run((p) => p.landResult({ trainId: "p1", landed: true, mainSha: "m".repeat(40), summary: "" }));
    expect(s.trains.get("p1")).toMatchObject({ phase: "MERGED", forkState: "DELETING" });
    expect(s.races.size).toBe(0);
  });

  it("a duplicate or late gitPushed is ignored; human code never counts toward model stats", () => {
    const s = new Sim();
    intent(s, "p1", "I1");
    push(s, "p1", "I1");
    expect(push(s, "p1", "I1").outcome).toBe("ignored:duplicate");
    s.completeDeploys();
    s.run((p) => p.trainResult({ trainId: "p1", passed: false, summary: "nope" }));
    expect(s.deltas).toEqual([]);
  });

  it("a push whose item is not dispatched yet is PARKED (fork ready, no drone, no alarm) and submit() resumes it instead of forking a builder", () => {
    const s = new Sim();
    intent(s, "p1", "I1");
    push(s, "p1", "I1", { resume: false });
    expect(s.trains.get("p1")).toMatchObject({ phase: "BUILDING", forkState: "READY", dispatched: false });
    expect(s.prompts.get("I1")!.status).toBe("QUEUED");
    s.run((p) => p.reconcile());
    expect(s.take("dispatchDrone")).toEqual([]);
    expect(watchdogDeadline([...s.trains.values()], DEFAULT_COMMAND_TIMEOUT_MS, s.now)).toBeNull();
    s.run((p) => p.submit({ promptId: "I1", promptText: "pushed I1", raceWidth: 3 }));
    expect([...s.trains.values()].filter((t) => t.promptId === "I1")).toHaveLength(1);
    expect(s.trains.get("p1")!.phase).toBe("DEPLOYING");
    expect(s.takeOp("FORK")).toEqual([]);
    expect(s.takeOp("DEPLOY")).toHaveLength(1);
  });

  it("a correlated push opens a width-1 race lazily, or joins the item's RACING race as one more candidate", () => {
    const s = new Sim();
    intent(s, "p1", "I1");
    push(s, "p1", "I1", { race: { create: true } });
    const race = [...s.races.values()][0]!;
    expect(race).toMatchObject({ itemId: "I1", width: 1, state: "RACING", trainIds: ["p1"], entryClosesAt: null });
    expect(s.trains.get("p1")).toMatchObject({ raceId: race.raceId, candidate: 0, raceOutcome: "RACING" });
    intent(s, "p2", "I1");
    push(s, "p2", "I1", { race: { join: race.raceId }, head: "c".repeat(40) });
    expect(s.races.get(race.raceId)).toMatchObject({ width: 1, trainIds: ["p1", "p2"] });
    expect(s.trains.get("p2")).toMatchObject({ raceId: race.raceId, candidate: 1, raceOutcome: "RACING" });
    s.completeDeploys();
    s.run((p) => p.trainResult({ trainId: "p1", passed: true, summary: "ok", score: { review: "approved", satisfied: 1, missing: 0, changedFiles: 1, changedBytes: 10, checks: 3 } }));
    expect(s.races.get(race.raceId)!.state).toBe("RACING"); // p2 still pending
    s.run((p) => p.trainResult({ trainId: "p2", passed: false, summary: "bad" }));
    expect(s.races.get(race.raceId)).toMatchObject({ state: "DECIDED", winnerTrainId: "p1" });
  });

  it("gitAborted before the push ejects the intent (no attempt) and deletes the fork; after the push it is ignored", () => {
    const s = new Sim();
    intent(s, "p1", "I1");
    const r = s.run((p) => p.abort("p1", "upstream receive-pack failed"));
    expect(r.outcome).toBe("applied");
    expect(r.abortedIntents).toEqual(["p1"]);
    expect(s.trains.get("p1")).toMatchObject({ phase: "EJECTED", forkState: "DELETING" });
    expect(s.takeOp("DELETE").map((c) => c.repo)).toEqual(["hive-train-p1"]);
    intent(s, "p2", "I2");
    push(s, "p2", "I2");
    expect(s.run((p) => p.abort("p2", "late")).outcome).toBe("ignored:stale");
    expect(s.run((p) => p.abort("nope", "x")).outcome).toBe("ignored:unknown");
  });

  it("the intent watchdog: no gitPushed within the command timeout → EJECTED, fork deleted, no attempt charged", () => {
    const s = new Sim();
    intent(s, "p1", "I1");
    s.now += DEFAULT_COMMAND_TIMEOUT_MS - 1;
    s.run((p) => p.reconcile());
    expect(s.trains.get("p1")!.phase).toBe("BUILDING");
    s.now += 1;
    const r = s.run((p) => p.reconcile());
    expect(r.abortedIntents).toEqual(["p1"]);
    expect(s.trains.get("p1")).toMatchObject({ phase: "EJECTED", forkState: "DELETING" });
    expect(s.trains.get("p1")!.reason).toMatch(/push intent expired/);
    expect(s.takeOp("DELETE")).toHaveLength(1);
    expect(s.takeOp("FORK")).toEqual([]);
  });

  it("a gate reject of human code: EJECTED, fork KEPT (delete-after 24 h), prompt FAILED awaiting the contributor, no REWORK", () => {
    const s = new Sim();
    intent(s, "p1", "I1");
    push(s, "p1", "I1");
    s.completeDeploys();
    const r = s.run((p) => p.trainResult({ trainId: "p1", passed: false, summary: "security: fetch to a non-allowlisted host" }));
    expect(r.awaitingContributor).toEqual([{ promptId: "I1", summary: "security: fetch to a non-allowlisted host" }]);
    const t = s.trains.get("p1")!;
    expect(t).toMatchObject({ phase: "EJECTED", forkState: "READY", deleteIssuedAt: s.now + KEEP_FORK_MS });
    expect(keptFork(t)).toBe(true);
    expect(s.takeOp("DELETE")).toEqual([]);
    expect(s.takeOp("TEARDOWN")).toHaveLength(1);
    expect(s.prompts.get("I1")).toMatchObject({ status: "FAILED", attempts: 0 });
    expect([...s.trains.values()].filter((x) => x.promptId === "I1")).toHaveLength(1); // no rework
    // Once the preview is torn down, the delete-after deadline is what keeps the alarm armed.
    expect(watchdogDeadline([{ ...t, deployState: "TORN_DOWN" }], DEFAULT_COMMAND_TIMEOUT_MS, s.now)).toBe(s.now + KEEP_FORK_MS);
  });

  it("a kept fork is deleted at its deadline, or once its item left FAILED with no REWORK running", () => {
    const s = new Sim();
    intent(s, "p1", "I1");
    push(s, "p1", "I1");
    s.completeDeploys();
    s.run((p) => p.trainResult({ trainId: "p1", passed: false, summary: "no" }));
    s.items = [item("I1", { status: "FAILED" })];
    s.run((p) => p.reconcile());
    expect(s.trains.get("p1")!.forkState).toBe("READY");
    s.now += KEEP_FORK_MS;
    s.run((p) => p.reconcile());
    expect(s.trains.get("p1")!.forkState).toBe("DELETING");

    const s2 = new Sim();
    intent(s2, "p1", "I1");
    push(s2, "p1", "I1");
    s2.completeDeploys();
    s2.run((p) => p.trainResult({ trainId: "p1", passed: false, summary: "no" }));
    s2.items = [item("I1", { status: "READY" })]; // the contributor re-pushed (reopened)
    s2.run((p) => p.reconcile());
    expect(s2.trains.get("p1")!.forkState).toBe("DELETING");
  });

  it("`Queen: rework` (handoff): a reject reworks as for drones, the REWORK forks FROM the kept fork and carries the rendered note as its brief", () => {
    const s = new Sim();
    s.briefFor = (sha) => (sha === HEAD ? "REJECTED by SECURITY: nope\n\nQueen-Note: v1\nQueen-Kind: verdict\nQueen-Verdict: REJECTED" : null);
    intent(s, "p1", "I1");
    push(s, "p1", "I1", { handoff: true });
    s.items = [item("I1", { status: "ACTIVE", handoff: true })]; // persisted on the item (inbox.handoff)
    s.completeDeploys();
    const r = s.run((p) => p.trainResult({ trainId: "p1", passed: false, summary: "security: nope" }));
    expect(r.awaitingContributor).toBeUndefined();
    expect(s.trains.get("p1")!.forkState).toBe("READY"); // kept: the seed
    const rework = [...s.trains.values()].find((t) => t.promptId === "I1" && t.action === "REWORK")!;
    expect(rework.origin).toBeUndefined(); // a drone train
    const [fork] = s.takeOp("FORK");
    expect(fork).toMatchObject({ trainId: rework.trainId, sourceRepo: "hive", from: "hive-train-p1" });
    expect(s.prompts.get("I1")!.attempts).toBe(1);
    s.run((p) => p.provisionResult({ commandId: fork!.commandId, op: "FORK", trainId: rework.trainId, ok: true, artifactRepo: fork!.forkName, baseSha: HEAD }));
    const task = s.take("dispatchDrone").at(-1)!.task;
    expect(task).toMatchObject({ action: "REWORK", seed: { repo: "hive-train-p1", ref: "refs/heads/main", headSha: HEAD }, scribeSummary: "security: nope" });
    expect(task.brief).toBe(s.briefFor(HEAD));
    // The kept fork outlives the rework's fork creation; once no REWORK is active and the item is not FAILED, it goes.
    s.items = [item("I1", { status: "ACTIVE", handoff: true })];
    s.run((p) => p.reconcile());
    expect(s.trains.get("p1")!.forkState).toBe("READY");
  });

  it("handoff() later: the FAILED item's prompt reworks (attempts + 1), seeded from the newest kept fork", () => {
    const s = new Sim();
    intent(s, "p1", "I1");
    push(s, "p1", "I1");
    s.completeDeploys();
    s.run((p) => p.trainResult({ trainId: "p1", passed: false, summary: "no" }));
    s.takeOp("FORK");
    s.items = [item("I1", { status: "ACTIVE", handoff: true })];
    s.run((p) => p.handoff({ promptId: "I1", promptText: "pushed I1", summary: "no", attempts: 0, item: item("I1", { status: "ACTIVE" }) }));
    const [fork] = s.takeOp("FORK");
    expect(fork).toMatchObject({ from: "hive-train-p1" });
    expect(s.prompts.get("I1")).toMatchObject({ status: "QUEUED", attempts: 1 });
    // Past maxReworks the handoff fails the prompt (→ REWORK_EXHAUSTED on the item).
    const s2 = new Sim();
    s2.run((p) => p.handoff({ promptId: "I9", promptText: "x", summary: null, attempts: 2, item: item("I9") }));
    expect(s2.prompts.get("I9")!.status).toBe("FAILED");
  });

  it("supersede: a re-push replaces the train not yet in a car (EJECTED, LOST, fork deleted); the race waits for the new candidate", () => {
    const s = new Sim();
    intent(s, "p1", "I1");
    push(s, "p1", "I1", { race: { create: true } });
    const raceId = s.trains.get("p1")!.raceId!;
    s.takeOp("DEPLOY");
    intent(s, "p2", "I1");
    push(s, "p2", "I1", { race: { join: raceId }, head: "c".repeat(40) });
    const r = s.run((p) => p.supersede("p1", "c".repeat(40)));
    expect(r.outcome).toBe("applied");
    expect(s.trains.get("p1")).toMatchObject({ phase: "EJECTED", raceOutcome: "LOST", forkState: "DELETING" });
    expect(s.trains.get("p1")!.reason).toBe("superseded by push ccccccc");
    expect(s.races.get(raceId)!.state).toBe("RACING");
    expect(s.prompts.get("I1")!.attempts).toBe(0);
    // A train in a car (or landing) is never superseded.
    const s2 = new Sim();
    intent(s2, "q1", "I2");
    push(s2, "q1", "I2");
    s2.completeDeploys();
    s2.run((p) => p.trainResult({ trainId: "q1", passed: true, summary: "ok" }));
    expect(s2.trains.get("q1")!.phase).toBe("LANDING");
    expect(s2.run((p) => p.supersede("q1", HEAD)).outcome).toBe("ignored:stale");
  });

  it("a race of contributed candidates only that nobody passes: the item waits for its contributor (no drone rework)", () => {
    const s = new Sim();
    intent(s, "p1", "I1");
    push(s, "p1", "I1", { race: { create: true } });
    s.completeDeploys();
    const r = s.run((p) => p.trainResult({ trainId: "p1", passed: false, summary: "bad" }));
    expect(r.awaitingContributor?.[0]?.promptId).toBe("I1");
    expect(s.races.get(s.trains.get("p1")!.raceId!)!.state).toBe("ABANDONED");
    expect([...s.trains.values()].filter((t) => t.promptId === "I1")).toHaveLength(1);
    expect(s.trains.get("p1")!.forkState).toBe("READY");
  });

  // ── external hives: the entry window (human-push design §2.5) ──────────────────────────────────────
  describe("entry window", () => {
    const WINDOW = 15 * 60_000;
    const GRACE = 90_000;
    const GREEN = { review: "approved" as const, satisfied: 1, missing: 0, changedFiles: 1, changedBytes: 10, checks: 3 };
    const open = (s: Sim, ...ids: string[]) => {
      ids.forEach((id, i) => {
        intent(s, id, "I1");
        push(s, id, "I1", { race: i === 0 ? { create: true } : { join: [...s.races.keys()][0]! }, head: id.padEnd(40, "0") });
      });
      s.completeDeploys();
    };
    const pass = (s: Sim, id: string) => s.run((p) => p.trainResult({ trainId: id, passed: true, summary: "ok", score: GREEN }));
    const fail = (s: Sim, id: string) => s.run((p) => p.trainResult({ trainId: id, passed: false, summary: "bad" }));
    const race = (s: Sim) => [...s.races.values()][0]!;
    const tick = (s: Sim, ms: number) => {
      s.now += ms;
      s.run((p) => p.reconcile());
    };

    it("an external push opens the race with entryClosesAt = creation + window; a swarm hive (no window) keeps it null; the joiner does not move it", () => {
      const s = new Sim();
      s.entryWindowMs = WINDOW;
      open(s, "p1");
      expect(race(s)).toMatchObject({ state: "RACING", entryClosesAt: 1000 + WINDOW });
      s.now += 60_000;
      intent(s, "p2", "I1");
      push(s, "p2", "I1", { race: { join: race(s).raceId }, head: "c".repeat(40) });
      expect(race(s)).toMatchObject({ trainIds: ["p1", "p2"], entryClosesAt: 1000 + WINDOW });

      const swarm = new Sim();
      intent(swarm, "p1", "I1");
      push(swarm, "p1", "I1", { race: { create: true } });
      expect(race(swarm).entryClosesAt).toBeNull();
    });

    it("a lone candidate that passes before the close leaves the race RACING; at the close (deadline + tick) it decides", () => {
      const s = new Sim();
      s.entryWindowMs = WINDOW;
      open(s, "p1");
      s.now += 120_000;
      pass(s, "p1");
      expect(race(s)).toMatchObject({ state: "RACING", deadlineAt: 1000 + WINDOW + GRACE });
      expect(s.trains.get("p1")).toMatchObject({ phase: "TESTING", raceOutcome: "PASSED" });
      tick(s, 10 * 60_000); // still inside the window
      expect(race(s).state).toBe("RACING");
      tick(s, 5 * 60_000 - 120_000 + 1); // window closed; nobody pending
      expect(race(s)).toMatchObject({ state: "DECIDED", winnerTrainId: "p1" });
    });

    it("an all-failed race is held until the close, then ABANDONED (the item awaits its contributor)", () => {
      const s = new Sim();
      s.entryWindowMs = WINDOW;
      open(s, "p1");
      const r = fail(s, "p1");
      expect(race(s).state).toBe("RACING");
      expect(r.awaitingContributor).toBeUndefined();
      tick(s, WINDOW - 1);
      expect(race(s).state).toBe("RACING");
      s.now += 1;
      const done = s.run((p) => p.reconcile());
      expect(race(s).state).toBe("ABANDONED");
      expect(done.awaitingContributor?.[0]?.promptId).toBe("I1");
    });

    it("a late entrant that joins just before the close still gets the grace: the first pass sets deadlineAt from the close", () => {
      const s = new Sim();
      s.entryWindowMs = WINDOW;
      open(s, "p1");
      s.now = 1000 + WINDOW - 1_000;
      intent(s, "p2", "I1");
      push(s, "p2", "I1", { race: { join: race(s).raceId }, head: "c".repeat(40) });
      s.completeDeploys();
      pass(s, "p1");
      expect(race(s).deadlineAt).toBe(1000 + WINDOW + GRACE);
      tick(s, 2_000); // closed; p2 pending and inside the grace
      expect(race(s).state).toBe("RACING");
      tick(s, GRACE);
      expect(race(s)).toMatchObject({ state: "DECIDED", winnerTrainId: "p1" });
      expect(s.trains.get("p2")).toMatchObject({ raceOutcome: "LOST" });
    });

    it("watchdogDeadline includes a future entryClosesAt of a RACING race only", () => {
      const s = new Sim();
      s.entryWindowMs = WINDOW;
      open(s, "p1");
      const trains = [...s.trains.values()];
      const races = [...s.races.values()];
      const at = (now: number) => watchdogDeadline([], DEFAULT_COMMAND_TIMEOUT_MS, now, races);
      expect(at(s.now)).toBe(1000 + WINDOW);
      expect(at(1000 + WINDOW)).toBeNull(); // past (or at) the close: no hot alarm loop
      expect(at(1000 + WINDOW + 1)).toBeNull();
      expect(watchdogDeadline([], DEFAULT_COMMAND_TIMEOUT_MS, s.now, races.map((r) => ({ ...r, state: "DECIDED" as const })))).toBeNull();
      expect(trains.length).toBeGreaterThan(0);
    });

    it("pushed() never joins a race whose entry window has closed: no race for the train (and no new race)", () => {
      const s = new Sim();
      s.entryWindowMs = WINDOW;
      open(s, "p1");
      const raceId = race(s).raceId;
      s.now = 1000 + WINDOW; // closed, the race still RACING
      intent(s, "p2", "I1");
      push(s, "p2", "I1", { race: { join: raceId }, head: "c".repeat(40) });
      expect(s.races.size).toBe(1);
      expect(race(s).trainIds).toEqual(["p1"]);
      expect(s.trains.get("p2")).toMatchObject({ raceId: null });
    });

    it("the grace clock belongs to a live pass: superseding the only pass resets deadlineAt (next pass restarts grace); watchdogDeadline ignores a past deadline", () => {
      const s = new Sim();
      s.entryWindowMs = WINDOW;
      open(s, "p1", "p2");
      pass(s, "p1");
      expect(race(s).deadlineAt).toBe(1000 + WINDOW + GRACE);
      s.run((p) => p.supersede("p1", "d".repeat(40)));
      expect(s.trains.get("p1")).toMatchObject({ phase: "EJECTED" });
      expect(race(s)).toMatchObject({ state: "RACING", deadlineAt: null });
      // A stale deadline left on a RACING race with only pending candidates must not arm the alarm in the past.
      const stale = { ...race(s), deadlineAt: 5_000, entryClosesAt: null };
      s.now = 100_000;
      expect(watchdogDeadline([], DEFAULT_COMMAND_TIMEOUT_MS, s.now, [stale])).toBeNull();
      expect(watchdogDeadline([], DEFAULT_COMMAND_TIMEOUT_MS, 4_000, [stale])).toBe(5_000);
      // The next pass restarts the grace from the close (or now, when later).
      s.now = 1000 + WINDOW + 10_000;
      pass(s, "p2");
      expect(race(s).deadlineAt).toBe(s.now + GRACE);
    });

    it("a failed pass (the last live one) also resets deadlineAt via the reconcile tick", () => {
      const s = new Sim();
      s.entryWindowMs = WINDOW;
      open(s, "p1", "p2");
      pass(s, "p1");
      // The passed candidate is lost some other way (here: ejected directly), without a maybeDecide hook.
      s.trains.set("p1", { ...s.trains.get("p1")!, phase: "EJECTED" });
      s.run((p) => p.reconcile());
      expect(race(s).deadlineAt).toBeNull();
    });

    describe("closeEntries", () => {
      it("refuses a race with no entry window (swarm or entryWindowMs 0): 409, nothing changes", () => {
        const s = new Sim();
        open(s, "p1");
        expect(race(s).entryClosesAt).toBeNull();
        const r = s.run((p) => p.closeEntries({ raceId: race(s).raceId, by: "human:kyle@example.com" }));
        expect(r.refused).toMatchObject({ status: 409, message: expect.stringContaining("no entry window") });
        expect(r.races).toEqual([]);
        expect(r.events).toEqual([]);
      });

      it("closes now and decides a passed lone candidate at once (auto judge); emits race.entries-closed by user:<email>", () => {
        const s = new Sim();
        s.entryWindowMs = WINDOW;
        open(s, "p1");
        pass(s, "p1");
        s.now += 5_000;
        const r = s.run((p) => p.closeEntries({ raceId: race(s).raceId, by: "human:kyle@example.com" }));
        expect(r.outcome).toBe("applied");
        expect(race(s)).toMatchObject({ state: "DECIDED", winnerTrainId: "p1", entryClosesAt: s.now });
        const ev = r.events.find((e) => e.type === "race.entries-closed")!;
        expect(ev).toMatchObject({ actor: "user:kyle@example.com", itemId: "I1", data: { raceId: race(s).raceId, by: "human:kyle@example.com", candidates: 1 } });
      });

      it("pending candidates get at most the grace from the close: deadlineAt = min(existing, now + grace)", () => {
        const s = new Sim();
        s.entryWindowMs = WINDOW;
        open(s, "p1", "p2");
        pass(s, "p1");
        expect(race(s).deadlineAt).toBe(1000 + WINDOW + GRACE);
        s.now += 30_000;
        s.run((p) => p.closeEntries({ raceId: race(s).raceId, by: "human:kyle@example.com" }));
        expect(race(s)).toMatchObject({ state: "RACING", entryClosesAt: s.now, deadlineAt: s.now + GRACE });
        tick(s, GRACE);
        expect(race(s)).toMatchObject({ state: "DECIDED", winnerTrainId: "p1" });
      });

      it("with no pass yet the deadline stays unset; the first pass after the close sets it from now", () => {
        const s = new Sim();
        s.entryWindowMs = WINDOW;
        open(s, "p1", "p2");
        s.run((p) => p.closeEntries({ raceId: race(s).raceId, by: "human:kyle@example.com" }));
        expect(race(s)).toMatchObject({ state: "RACING", deadlineAt: null, entryClosesAt: s.now });
        s.now += 10_000;
        pass(s, "p1");
        expect(race(s).deadlineAt).toBe(s.now + GRACE);
        fail(s, "p2");
        expect(race(s)).toMatchObject({ state: "DECIDED", winnerTrainId: "p1" });
      });

      it("an all-failed race abandons on close", () => {
        const s = new Sim();
        s.entryWindowMs = WINDOW;
        open(s, "p1");
        fail(s, "p1");
        expect(race(s).state).toBe("RACING");
        const r = s.run((p) => p.closeEntries({ raceId: race(s).raceId, by: "human:kyle@example.com" }));
        expect(race(s).state).toBe("ABANDONED");
        expect(r.awaitingContributor?.[0]?.promptId).toBe("I1");
      });

      it("refuses an unknown race (404), a decided race (409) and one already closed (409); nothing changes", () => {
        const s = new Sim();
        s.entryWindowMs = WINDOW;
        open(s, "p1", "p2");
        const by = "human:kyle@example.com";
        expect(s.run((p) => p.closeEntries({ raceId: "nope", by })).refused).toMatchObject({ status: 404 });
        s.run((p) => p.closeEntries({ raceId: race(s).raceId, by }));
        const again = s.run((p) => p.closeEntries({ raceId: race(s).raceId, by }));
        expect(again.refused).toMatchObject({ status: 409, message: expect.stringContaining("already closed") });
        expect(again.races).toEqual([]);
        pass(s, "p1");
        tick(s, GRACE);
        expect(race(s).state).toBe("DECIDED");
        expect(s.run((p) => p.closeEntries({ raceId: race(s).raceId, by })).refused).toMatchObject({ status: 409, message: expect.stringContaining("DECIDED") });
      });
    });
  });
});

// ── external executors mode ─────────────────────────────────────────────────────────────────────────

describe("planner: external executors", () => {
  const HUMAN = { kind: "human" as const, id: "ada@example.com" };
  const HEAD = "a".repeat(40);
  const BASE = "b".repeat(40);

  it("a failed drone train (hive switched while it was in flight): the item awaits a contributor; no REWORK, attempts untouched", () => {
    const s = Sim.abc();
    s.external = true;
    const r = s.result("B", false, "B broke the build");
    expect(r.awaitingContributor).toEqual([{ promptId: "B", summary: "B broke the build" }]);
    expect(s.prompts.get("B")).toMatchObject({ status: "FAILED", attempts: 0 });
    expect([...s.trains.values()].filter((t) => t.action === "REWORK")).toEqual([]);
    expect(s.take("dispatchDrone")).toEqual([]);
    expect(s.takeOp("FORK")).toEqual([]);
    expect(s.trains.get("t2")).toMatchObject({ status: "EJECTED", reason: "failed: B broke the build" });
  });

  it("the same failure in a swarm hive still reworks (control)", () => {
    const s = Sim.abc();
    const r = s.result("B", false, "B broke the build");
    expect(r.awaitingContributor).toBeUndefined();
    expect(s.trainOf("B").action).toBe("REWORK");
  });

  it("submit() forks no builder: no train, no fork, a warn event", () => {
    const s = new Sim();
    s.external = true;
    const r = s.run((p) => p.submit({ promptId: "A", promptText: "do A" }));
    expect(s.trains.size).toBe(0);
    expect(s.takeOp("FORK")).toEqual([]);
    expect(r.events.some((e) => e.severity === "warn" && e.itemId === "A")).toBe(true);
  });

  it("submit() still resumes parked pushed code", () => {
    const s = new Sim();
    s.external = true;
    s.run((p) => p.intent({ trainId: "p1", promptId: "I1", origin: HUMAN }));
    s.run((p) =>
      p.pushed({
        trainId: "p1",
        headSha: HEAD,
        baseSha: BASE,
        origin: HUMAN,
        promptId: "I1",
        promptText: "pushed I1",
        attempts: 0,
        item: { itemId: "I1", traceId: traceIdFromUuid("I1"), priority: 2, paths: [], bestOf: null },
        race: { create: true },
        resume: false,
      }),
    );
    expect(s.trains.get("p1")!.phase).toBe("BUILDING");
    s.run((p) => p.submit({ promptId: "I1", promptText: "pushed I1" }));
    expect(s.trains.get("p1")!.phase).toBe("DEPLOYING");
    expect(s.takeOp("FORK")).toEqual([]);
  });

  it("a handed-off contributed item (`Queen: rework`, or handed off before a switch) never gets a drone REWORK: it awaits its contributor", () => {
    const s = new Sim();
    s.external = true;
    s.run((p) => p.intent({ trainId: "p1", promptId: "I1", origin: HUMAN }));
    s.run((p) =>
      p.pushed({
        trainId: "p1",
        headSha: HEAD,
        baseSha: BASE,
        origin: HUMAN,
        promptId: "I1",
        promptText: "pushed I1",
        attempts: 0,
        item: { itemId: "I1", traceId: traceIdFromUuid("I1"), priority: 2, paths: [], bestOf: null, handoff: true },
        race: null,
        resume: true,
      }),
    );
    s.completeDeploys();
    // The Queen rebuilds PlannerItems from the ledger each decision: the item carries its inbox handoff.
    s.items = [{ itemId: "I1", traceId: traceIdFromUuid("I1"), priority: 2, paths: [], bestOf: null, handoff: true }];
    const r = s.run((p) => p.trainResult({ trainId: "p1", passed: false, summary: "security: nope" }));
    expect(r.awaitingContributor).toEqual([{ promptId: "I1", summary: "security: nope" }]);
    expect(s.prompts.get("I1")).toMatchObject({ status: "FAILED", attempts: 0 });
    expect([...s.trains.values()].filter((t) => t.promptId === "I1")).toHaveLength(1);
    expect(s.take("dispatchDrone")).toEqual([]);
    expect(s.takeOp("FORK")).toEqual([]);
  });

  it("a direct handoff() in an external hive does not enqueue a REWORK either", () => {
    const s = new Sim();
    s.external = true;
    const r = s.run((p) =>
      p.handoff({ promptId: "I1", promptText: "pushed I1", summary: "rejected", attempts: 0, item: { itemId: "I1", traceId: traceIdFromUuid("I1"), priority: 2, paths: [], bestOf: null } }),
    );
    expect(r.awaitingContributor).toEqual([{ promptId: "I1", summary: "rejected" }]);
    expect(s.trains.size).toBe(0);
  });
});
