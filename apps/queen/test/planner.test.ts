import { describe, expect, it } from "vitest";
import type { DeployCommand, Deployment, ProvisionCommand } from "@queenos/queen-types";
import { INITIAL_FLOOR, type FloorState, type RouterPolicy, type RouterStats } from "../src/models/router";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_ATTEMPTS,
  MAX_FORK_ATTEMPTS,
  watchdogDeadline,
  TrainPlanner,
  nextCommandId,
  type Effect,
  type ModelStatDelta,
  type PlanResult,
  type PromptRecord,
  type TrainRecord,
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
  private ids = 0;
  private maxTrainSeq = 0;
  private maxPromptSeq = 0;

  run(fn: (p: TrainPlanner) => PlanResult): PlanResult {
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
      },
      { namespace: "hive", now: this.now, newId: () => `t${++this.ids}`, modelPin: this.pin, routerPolicy: this.policy },
    );
    const r = fn(planner);
    for (const p of r.prompts) {
      this.prompts.set(p.promptId, p);
      this.maxPromptSeq = Math.max(this.maxPromptSeq, p.seq);
    }
    for (const t of r.trains) {
      this.trains.set(t.trainId, t);
      this.maxTrainSeq = Math.max(this.maxTrainSeq, t.seq);
    }
    for (const d of r.deployments) this.deployments.set(d.deploymentId, d);
    this.effects.push(...r.effects);
    for (const d of r.modelStats) this.applyDelta(d);
    if (r.routerDispatches !== undefined) this.routerDispatches = r.routerDispatches;
    if (r.routerFloor !== undefined) this.floor = r.routerFloor;
    return r;
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
    const out = this.effects.filter(match).map((e) => (e as Extract<Effect, { type: "provision" | "deploy" }>).command);
    this.effects = this.effects.filter((e) => !match(e));
    return out;
  }

  /** The Provisioner completes every pending FORK (fake Artifacts). */
  completeForks(): void {
    for (;;) {
      const c = this.takeOp("FORK")[0];
      if (!c) return;
      this.run((p) =>
        p.provisionResult({ commandId: c.commandId, op: "FORK", trainId: c.trainId, ok: true, artifactRepo: c.forkName, baseSha: `sha:${c.sourceRepo}` }),
      );
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

const url = (trainId: string) => `https://${trainId}-preview.test.dev`;

describe("planner: provisioning", () => {
  it("chains cumulative trains: train-1 from main, train-k from train-(k-1) after it pushes", () => {
    const s = new Sim();
    s.submit("A", "B", "C");
    const forks = s.take("provision");
    expect(forks).toEqual([
      {
        type: "provision",
        trainId: "t1",
        command: { op: "FORK", commandId: "t1-fork-1", hive: "hive", trainId: "t1", sourceRepo: "hive", forkName: "hive-train-t1" },
      },
    ]);
    expect(s.trains.get("t1")!.forkCommandId).toBe("t1-fork-1");
    expect(s.trains.get("t2")!.phase).toBe("WAITING_PARENT");
    expect(s.trains.get("t3")!.includedPrompts).toEqual(["A", "B", "C"]);
    expect(s.trains.get("t2")!.includedPrompts).toEqual(["A", "B"]);
    expect(s.status("B")).toBe("QUEUED");

    s.run((p) => p.provisionResult({ commandId: "t1-fork-1", op: "FORK", trainId: "t1", ok: true, artifactRepo: "hive-train-t1", baseSha: "m0" }));
    const [d] = s.take("dispatchDrone");
    expect(d!.task).toMatchObject({ trainId: "t1", promptId: "A", role: "BUILDER", action: "BUILD", artifactRepo: "hive-train-t1", ragContext: [] });
    expect(s.status("A")).toBe("BUILDING");
    expect(s.trains.get("t1")).toMatchObject({ status: "BUILDING", baseSha: "m0", forkState: "READY" });

    s.run((p) => p.buildResult({ trainId: "t1", headSha: "h1" }));
    expect(s.trains.get("t1")).toMatchObject({ phase: "DEPLOYING", status: "TESTING", deployState: "PENDING" });
    expect(s.status("A")).toBe("IN_TRAIN");
    // The successor forks on the push; it does not wait for the preview deploy.
    expect(s.takeOp("FORK")).toEqual([
      { op: "FORK", commandId: "t2-fork-1", hive: "hive", trainId: "t2", sourceRepo: "hive-train-t1", forkName: "hive-train-t2" },
    ]);
    expect(s.takeOp("DEPLOY")).toEqual([
      { op: "DEPLOY", commandId: "t1-deploy-1", hive: "hive", environment: "preview", trainId: "t1", artifactRepo: "hive-train-t1", commitSha: "h1" },
    ]);
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

  it("all pass out of order: later passes wait, then cascade behind the head", () => {
    const s = Sim.abc();
    s.result("C", true);
    s.result("B", true);
    expect(s.take("dispatchDrone")).toEqual([]);
    expect(s.trainOf("C").phase).toBe("PASSED");
    s.result("A", true);
    expect(s.take("dispatchDrone").map((d) => d.task.promptId)).toEqual(["A"]);
    s.land("A");
    expect(s.trainOf("B").phase).toBe("LANDING");
    expect(s.trainOf("C").phase).toBe("PASSED"); // only the head lands
    s.land("B");
    s.land("C");
    expect(s.take("dispatchDrone").map((d) => d.task.promptId)).toEqual(["B", "C"]);
    expect([...s.trains.values()].every((t) => t.status === "MERGED")).toBe(true);
  });

  it("middle train fails: B ejected for rework; C re-forked as main+[A,C]; A unaffected", () => {
    const s = Sim.abc();
    s.result("A", true); // A is landing; keep it in flight
    s.take("dispatchDrone");
    s.result("B", false, "B broke the build");
    expect(s.trains.get("t1")!.phase).toBe("LANDING");
    expect(s.trains.get("t2")).toMatchObject({ status: "EJECTED", reason: "failed: B broke the build" });
    expect(s.trains.get("t3")!.status).toBe("EJECTED");
    expect(s.trains.get("t3")!.reason).toMatch(/^superseded/);
    expect(s.takeOp("DELETE").map((e) => e.trainId)).toEqual(["t2", "t3"]);
    expect(s.takeOp("TEARDOWN").map((e) => e.trainId)).toEqual(["t2", "t3"]);

    const c2 = s.trainOf("C");
    expect(c2.trainId).toBe("t4");
    expect(c2.includedPrompts).toEqual(["A", "C"]);
    expect(c2.forkSource).toBe("hive-train-t1");
    const b2 = s.trainOf("B");
    expect(b2).toMatchObject({ trainId: "t5", action: "REWORK", includedPrompts: ["A", "C", "B"], phase: "WAITING_PARENT" });
    // EJECTED is broadcast before the rework re-queues the prompt.
    const bStates = s
      .take("broadcast")
      .flatMap((e) => (e.message.type === "prompt.updated" && e.message.promptRun.promptId === "B" ? [e.message.promptRun.status] : []));
    expect(bStates.slice(0, 2)).toEqual(["EJECTED", "QUEUED"]);
    expect(s.prompts.get("B")).toMatchObject({ attempts: 1, summary: "B broke the build" });

    // C' builds -> the rework train forks from it and dispatches a REWORK carrying the summary.
    s.completeForks();
    s.take("dispatchDrone");
    s.build("C");
    const rework = s.take("dispatchDrone").find((d) => d.task.promptId === "B")!;
    expect(rework.task).toMatchObject({ action: "REWORK", role: "BUILDER", scribeSummary: "B broke the build", artifactRepo: "hive-train-t5" });
    s.land("A");
    s.result("C", true);
    s.land("C");
    s.build("B");
    s.result("B", true);
    s.land("B");
    expect([s.status("A"), s.status("B"), s.status("C")]).toEqual(["MERGED", "MERGED", "MERGED"]);
  });

  it("head train fails: B and C slide forward and B re-forks from main", () => {
    const s = Sim.abc();
    s.result("C", true); // speculative pass is discarded with its train
    s.result("A", false);
    expect(s.trainOf("B")).toMatchObject({ includedPrompts: ["B"], forkSource: "hive", phase: "BUILDING" });
    expect(s.trainOf("C")).toMatchObject({ includedPrompts: ["B", "C"], phase: "WAITING_PARENT" });
    expect(s.trainOf("A")).toMatchObject({ includedPrompts: ["B", "C", "A"], action: "REWORK" });
    expect(s.status("A")).toBe("QUEUED");
    expect(["t1", "t2", "t3"].map((id) => s.trains.get(id)!.status)).toEqual(["EJECTED", "EJECTED", "EJECTED"]);
  });

  it("tail train fails: only the tail is ejected and re-queued", () => {
    const s = Sim.abc();
    s.result("C", false);
    expect(s.trains.get("t1")!.phase).toBe("TESTING");
    expect(s.trains.get("t2")!.phase).toBe("TESTING");
    expect(s.trains.get("t3")!.phase).toBe("EJECTED");
    expect(s.takeOp("DELETE").map((e) => e.trainId)).toEqual(["t3"]);
    // B already pushed, so the rework forks immediately from B's fork.
    expect(s.trainOf("C")).toMatchObject({ trainId: "t4", includedPrompts: ["A", "B", "C"], forkSource: "hive-train-t2" });
  });

  it("a new prompt arriving mid-train joins the tail, excluding merged prompts", () => {
    const s = Sim.abc();
    s.result("A", true);
    s.land("A");
    s.submit("D");
    const d = s.trainOf("D");
    expect(d.includedPrompts).toEqual(["B", "C", "D"]);
    expect(s.takeOp("FORK").at(-1)).toMatchObject({ trainId: d.trainId, sourceRepo: "hive-train-t3" });
  });

  it("a new prompt waits for an unpushed predecessor", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.submit("B");
    expect(s.trainOf("B").phase).toBe("WAITING_PARENT");
    s.build("A");
    expect(s.trainOf("B").forkSource).toBe("hive-train-t1");
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
  it("ignores a result for an already-superseded train", () => {
    const s = Sim.abc();
    s.result("B", false);
    s.take("broadcast");
    const r = s.run((p) => p.trainResult({ trainId: "t3", passed: true, summary: "late" }));
    expect(r).toEqual({ outcome: "ignored:stale", prompts: [], trains: [], deployments: [], effects: [], modelStats: [] });
  });

  it("ignores duplicate, unknown and premature results", () => {
    const s = Sim.abc();
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

  it("deletes an orphan fork that completes after its train was superseded", () => {
    const s = new Sim();
    s.submit("A", "B");
    s.completeForks();
    s.run((p) => p.buildResult({ trainId: "t1", headSha: "h1" })); // B's fork is now in flight
    const [bFork] = s.takeOp("FORK");
    expect(bFork).toMatchObject({ trainId: "t2", sourceRepo: "hive-train-t1" });
    s.result("A", false, "x"); // B (contains A) is superseded mid-fork
    expect(s.trains.get("t2")).toMatchObject({ phase: "EJECTED", forkState: "DELETING", deleteCommandId: "t2-delete-1" });
    const dels = s.takeOp("DELETE");
    expect(dels.map((d) => d.commandId)).toEqual(["t1-delete-1", "t2-delete-1"]);
    s.run((p) => p.provisionResult({ commandId: "t2-delete-1", op: "DELETE", trainId: "t2", ok: true }));
    expect(s.trains.get("t2")!.forkState).toBe("DELETED");
    // The fork finishes after the delete: it is an orphan, deleted under a new command.
    const late = s.run((p) => p.provisionResult({ commandId: bFork!.commandId, op: "FORK", trainId: "t2", ok: true, artifactRepo: "hive-train-t2", baseSha: "m" }));
    expect(late.outcome).toBe("ignored:stale");
    expect(s.takeOp("DELETE")).toEqual([{ op: "DELETE", commandId: "t2-delete-2", hive: "hive", trainId: "t2", repo: "hive-train-t2" }]);
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
    expect(r.effects).toContainEqual({
      type: "provision",
      trainId: "t1",
      command: { op: "FORK", commandId: "t1-fork-1", hive: "hive", trainId: "t1", sourceRepo: "hive", forkName: "hive-train-t1" },
    });
    s.completeForks();
    expect(s.take("dispatchDrone")).toHaveLength(1);
    // The DO never confirmed the dispatch, so reconcile re-dispatches.
    expect(s.run((p) => p.reconcile()).effects.filter((e) => e.type === "dispatchDrone")).toHaveLength(1);
    s.run((p) => p.dispatched("t1", "BUILDING"));
    expect(s.run((p) => p.reconcile()).effects.filter((e) => e.type === "dispatchDrone")).toHaveLength(0);
  });

  it("re-derives a pending fork's source (under a new command id) when its predecessor merged meanwhile", () => {
    const s = new Sim();
    s.submit("A", "B");
    s.completeForks();
    s.run((p) => p.buildResult({ trainId: "t1", headSha: "h1" }));
    s.completeDeploys();
    expect(s.takeOp("FORK").map((c) => c.commandId)).toEqual(["t2-fork-1"]); // B's fork from A's repo is lost
    s.effects = [];
    s.result("A", true);
    s.land("A");
    s.effects = [];
    const r = s.run((p) => p.reconcile());
    expect(r.effects).toContainEqual({
      type: "provision",
      trainId: "t2",
      command: { op: "FORK", commandId: "t2-fork-2", hive: "hive", trainId: "t2", sourceRepo: "hive", forkName: "hive-train-t2" },
    });
    expect(r.effects).toContainEqual({
      type: "provision",
      trainId: "t1",
      command: { op: "DELETE", commandId: "t1-delete-1", hive: "hive", trainId: "t1", repo: "hive-train-t1" },
    });
    expect(r.effects).toContainEqual({
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
    expect(s.trains.get("t1")).toMatchObject({ phase: "EJECTED", reason: "failed: fork failed: Artifacts 503" });
    expect(s.trainOf("A")).toMatchObject({ trainId: "t2", action: "REWORK" });
    expect(s.prompts.get("A")).toMatchObject({ attempts: 1, summary: "Artifacts 503" });
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
    expect(s.trains.get("t2")!.reason).toMatch(/^superseded/);
    expect(s.takeOp("TEARDOWN").map((c) => c.commandId)).toEqual(["t1-teardown-1", "t2-teardown-1"]);
    s.completeForks();
    expect(s.trainOf("A")).toMatchObject({ action: "REWORK", includedPrompts: ["B", "A"] });
    expect(s.prompts.get("A")).toMatchObject({ attempts: 1, summary: "Worker failed to start: SyntaxError" });
    const rework = s.take("dispatchDrone").find((d) => d.task.promptId === "A");
    expect(rework).toBeUndefined(); // waits for B' to push
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
      reason: `failed: fork failed: Provisioner FORK t1-fork-${MAX_FORK_ATTEMPTS} did not report within 10 min (executor lost?)`,
    });
    // Same path as ok:false: the prompt is re-queued as a rework with a fresh fork.
    expect(s.trainOf("A")).toMatchObject({ trainId: "t2", action: "REWORK", forkCommandId: "t2-fork-1" });
    expect(s.prompts.get("A")).toMatchObject({ attempts: 1, status: "QUEUED" });
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
    expect(s.trains.get("t1")!.reason).toMatch(/^failed: preview deploy failed: Herald DEPLOY t1-deploy-3 did not report/);
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
    s.run((p) => p.dispatched("t1", "BUILDING"));
    expect(watchdogDeadline([...s.trains.values()], T, 9999)).toBe(5000 + T);
    // A row from before the watchdog (no clock) counts from now.
    const legacy = { ...s.trains.get("t1")!, droneIssuedAt: null };
    expect(watchdogDeadline([legacy], T, 7777)).toBe(7777 + T);
    const merged = { ...legacy, phase: "MERGED" as const, forkState: "DELETED" as const };
    expect(watchdogDeadline([merged], T, 7777)).toBeNull();
  });
});

describe("planner: model router", () => {
  const QWEN = "@cf/qwen/qwen3.8-27b";
  const GLM_FLASH = "@cf/zai-org/glm-5.3-flash";
  const KIMI = "@cf/moonshotai/kimi-k2.7-code";
  const dispatchOf = (s: Sim) => s.take("dispatchDrone").filter((e) => e.task.role === "BUILDER");

  it("a dispatched BUILD carries the Queen's modelChoice; the train records model + reason and broadcasts them", () => {
    const s = new Sim();
    s.submit("A");
    s.take("broadcast");
    s.completeForks();
    const [d] = dispatchOf(s);
    expect(d!.task.modelChoice).toMatchObject({ model: QWEN, tier: "fast", role: "builder", fallbacks: ["@cf/deepseek-ai/deepseek-v4-flash-0731", GLM_FLASH] });
    expect(s.trains.get("t1")).toMatchObject({ model: QWEN, modelReason: d!.task.modelChoice!.reason, modelChoiceAttempt: 1, modelProbe: false });
    const upd = s.take("broadcast").find((e) => e.message.type === "train.updated");
    expect(upd?.message).toMatchObject({ train: { trainId: "t1", model: QWEN, modelReason: expect.stringContaining("fast tier") } });
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
    s.run((p) => p.buildResult({ trainId: "t1", headSha: "h", model: GLM_FLASH, failedModels: [QWEN], buildMs: 4200 }));
    expect(s.stat(QWEN)).toMatchObject({ attempts: 1, passes: 0, failures: 1, failStreak: 1 });
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
    expect(s.stat(QWEN)).toMatchObject({ attempts: 1, passes: 1, failures: 0, failStreak: 0 });
    expect(s.floor).toMatchObject({ tier: "fast", passStreak: 1 });
    const n = s.deltas.length;
    expect(s.run((p) => p.trainResult({ trainId: "t1", passed: true, summary: "again" })).outcome).toBe("ignored:duplicate");
    expect(s.run((p) => p.buildResult({ trainId: "t1", headSha: "h", model: KIMI })).outcome).not.toBe("applied");
    s.land("A");
    expect(s.run((p) => p.trainResult({ trainId: "t1", passed: false, summary: "late" })).outcome).toBe("ignored:stale");
    expect(s.deltas).toHaveLength(n);
    expect(s.stat(QWEN)).toMatchObject({ attempts: 1, passes: 1, failures: 0 });
  });

  it("a gate failure counts against the builder and raises the floor; the REWORK escalates to frontier under role rework and leaves the floor alone", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.build("A");
    s.result("A", false, "security scan rejected");
    expect(s.stat(QWEN)).toMatchObject({ attempts: 1, passes: 0, failures: 1, failStreak: 1 });
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
    expect(s.stat(QWEN)).toMatchObject({ attempts: 1, failures: 1 });
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
    expect(d!.task.modelChoice).toMatchObject({ model: QWEN, tier: "fast" });
    expect(d!.task.modelChoice!.reason).toMatch(/^probe: trying fast tier again/);
    expect(s.trains.get("t1")!.modelProbe).toBe(true);
    s.build("A");
    s.result("A", true);
    expect(s.floor).toEqual({ tier: "fast", passStreak: 0, aboveStreak: 0, note: "dropped to fast after a probe passed" });
  });

  it("honours the pin and the policy from the context; every 5th decision explores", () => {
    const s = new Sim();
    s.pin = "@cf/zai-org/glm-5.3";
    s.submit("A");
    s.completeForks();
    expect(dispatchOf(s)[0]!.task.modelChoice).toMatchObject({ model: "@cf/zai-org/glm-5.3", reason: "pinned by MODEL_ROUTER_PIN_BUILDER" });

    const e = new Sim();
    e.routerDispatches = 4;
    e.stats.set(`${QWEN}|builder`, { model: QWEN, role: "builder", attempts: 3, passes: 3, failures: 0, avgBuildMs: null, updatedAt: 0 });
    e.submit("A");
    e.completeForks();
    expect(dispatchOf(e)[0]!.task.modelChoice).toMatchObject({ model: "@cf/deepseek-ai/deepseek-v4-flash-0731", reason: expect.stringContaining("exploring least-tried") });

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
