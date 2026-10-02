import { describe, expect, it } from "vitest";
import {
  TrainPlanner,
  type Effect,
  type PlanResult,
  type PromptRecord,
  type TrainRecord,
} from "../src/train/planner";

/** In-memory hive that persists PlanResults the way the DO does. */
class Sim {
  prompts = new Map<string, PromptRecord>();
  trains = new Map<string, TrainRecord>();
  effects: Effect[] = [];
  private ids = 0;
  private maxTrainSeq = 0;
  private maxPromptSeq = 0;

  run(fn: (p: TrainPlanner) => PlanResult): PlanResult {
    const planner = new TrainPlanner(
      {
        prompts: [...this.prompts.values()],
        trains: [...this.trains.values()],
        maxTrainSeq: this.maxTrainSeq,
        maxPromptSeq: this.maxPromptSeq,
      },
      { namespace: "hive", now: 1000, newId: () => `t${++this.ids}` },
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
    this.effects.push(...r.effects);
    return r;
  }

  submit(...ids: string[]): void {
    for (const id of ids) this.run((p) => p.submit({ promptId: id, promptText: `do ${id}` }));
  }

  /** Execute every pending provisionFork effect (fake Artifacts). */
  completeForks(): void {
    for (;;) {
      const e = this.take("provisionFork")[0];
      if (!e) return;
      this.run((p) => p.forkReady({ trainId: e.trainId, artifactRepo: e.artifactRepo, baseSha: `sha:${e.source}` }));
    }
  }

  take<T extends Effect["type"]>(type: T): Extract<Effect, { type: T }>[] {
    const out = this.effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);
    this.effects = this.effects.filter((e) => e.type !== type);
    return out;
  }

  /** Active train owned by a prompt. */
  trainOf(promptId: string): TrainRecord {
    const t = [...this.trains.values()]
      .filter((x) => x.promptId === promptId && x.phase !== "EJECTED" && x.phase !== "MERGED")
      .at(-1);
    if (!t) throw new Error(`no active train for ${promptId}`);
    return t;
  }

  build(promptId: string): void {
    const t = this.trainOf(promptId);
    this.run((p) => p.buildResult({ trainId: t.trainId, headSha: `head:${promptId}` }));
    this.completeForks();
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

  /** Submit A,B,C; forks chain as each builder pushes. */
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

describe("planner: provisioning", () => {
  it("chains cumulative trains: train-1 from main, train-k from train-(k-1) after it pushes", () => {
    const s = new Sim();
    s.submit("A", "B", "C");
    const forks = s.take("provisionFork");
    expect(forks).toEqual([{ type: "provisionFork", trainId: "t1", source: "hive", artifactRepo: "hive-train-t1" }]);
    expect(s.trains.get("t2")!.phase).toBe("WAITING_PARENT");
    expect(s.trains.get("t3")!.includedPrompts).toEqual(["A", "B", "C"]);
    expect(s.trains.get("t2")!.includedPrompts).toEqual(["A", "B"]);
    expect(s.status("B")).toBe("QUEUED");

    s.run((p) => p.forkReady({ trainId: "t1", artifactRepo: "hive-train-t1", baseSha: "m0" }));
    const [d] = s.take("dispatchDrone");
    expect(d!.task).toMatchObject({ trainId: "t1", promptId: "A", role: "BUILDER", action: "BUILD", artifactRepo: "hive-train-t1", ragContext: [] });
    expect(s.status("A")).toBe("BUILDING");
    expect(s.trains.get("t1")).toMatchObject({ status: "BUILDING", baseSha: "m0", forkState: "READY" });

    s.run((p) => p.buildResult({ trainId: "t1", headSha: "h1" }));
    expect(s.trains.get("t1")!.status).toBe("TESTING");
    expect(s.status("A")).toBe("IN_TRAIN");
    expect(s.take("provisionFork")).toEqual([
      { type: "provisionFork", trainId: "t2", source: "hive-train-t1", artifactRepo: "hive-train-t2" },
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
    expect(s.take("deleteFork").map((e) => e.artifactRepo)).toEqual(["hive-train-t1"]);
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
    expect(s.take("deleteFork").map((e) => e.trainId)).toEqual(["t2", "t3"]);

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
    expect(s.take("deleteFork").map((e) => e.trainId)).toEqual(["t3"]);
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
    expect(s.take("provisionFork").at(-1)).toMatchObject({ trainId: d.trainId, source: "hive-train-t3" });
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
    expect(r).toEqual({ outcome: "ignored:stale", prompts: [], trains: [], effects: [] });
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
    s.submit("A");
    s.take("provisionFork"); // fork still in flight
    s.run((p) => p.trainResult({ trainId: "t1", passed: false, summary: "x" })); // premature: ignored
    expect(s.trains.get("t1")!.phase).toBe("BUILDING");
    // Force-eject via a fresh failing path: B's train after A builds.
    s.run((p) => p.forkReady({ trainId: "t1", artifactRepo: "hive-train-t1", baseSha: "m" }));
    s.run((p) => p.trainResult({ trainId: "t1", passed: false, summary: "x" }));
    s.take("deleteFork");
    s.run((p) => p.forkDeleted("t1"));
    const late = s.run((p) => p.forkReady({ trainId: "t1", artifactRepo: "hive-train-t1", baseSha: "m" }));
    expect(late.outcome).toBe("ignored:stale");
    expect(late.effects).toContainEqual({ type: "deleteFork", trainId: "t1", artifactRepo: "hive-train-t1" });
  });

  it("forkReady twice is a no-op", () => {
    const s = new Sim();
    s.submit("A");
    s.completeForks();
    s.take("dispatchDrone");
    const r = s.run((p) => p.forkReady({ trainId: "t1", artifactRepo: "hive-train-t1", baseSha: "m" }));
    expect(r.outcome).toBe("ignored:duplicate");
    expect(r.effects).toEqual([]);
  });
});

describe("planner: reconcile", () => {
  it("re-issues pending forks, deletes and undispatched drones", () => {
    const s = new Sim();
    s.submit("A");
    s.take("provisionFork");
    const r = s.run((p) => p.reconcile());
    expect(r.effects).toContainEqual({ type: "provisionFork", trainId: "t1", source: "hive", artifactRepo: "hive-train-t1" });
    s.completeForks();
    expect(s.take("dispatchDrone")).toHaveLength(1);
    // The DO never confirmed the dispatch, so reconcile re-dispatches.
    expect(s.run((p) => p.reconcile()).effects.filter((e) => e.type === "dispatchDrone")).toHaveLength(1);
    s.run((p) => p.dispatched("t1", "BUILDING"));
    expect(s.run((p) => p.reconcile()).effects.filter((e) => e.type === "dispatchDrone")).toHaveLength(0);
  });

  it("re-derives a pending fork's source when its predecessor merged meanwhile", () => {
    const s = new Sim();
    s.submit("A", "B");
    s.completeForks();
    s.run((p) => p.buildResult({ trainId: "t1", headSha: "h1" }));
    expect(s.take("provisionFork")).toHaveLength(1); // B's fork from A's repo is lost
    s.result("A", true);
    s.land("A");
    const r = s.run((p) => p.reconcile());
    expect(r.effects).toContainEqual({ type: "provisionFork", trainId: "t2", source: "hive", artifactRepo: "hive-train-t2" });
    expect(r.effects).toContainEqual({ type: "deleteFork", trainId: "t1", artifactRepo: "hive-train-t1" });
  });
});
