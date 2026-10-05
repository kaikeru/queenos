import { describe, expect, it } from "vitest";
import {
  GUARDRAIL_DEFAULTS,
  type DecomposedChildInput,
  type FollowUp,
  type OracleCommand,
  type OracleResult,
  type WorkStatus,
} from "@queenos/queen-types";
import type { EscalationRecord, HiveSettingsRecord, PathClaim, WorkItemRecord } from "../src/records";
import { composePrompt, itemTextFromPrompt, releaseBugText } from "../src/work/compose";
import { creditsFor, effectiveGuardrails, normalizePath, normalizePaths, rollBudgetDay } from "../src/work/guardrails";
import {
  DEFAULT_ORACLE_TIMEOUT_MS,
  MAX_ORACLE_ATTEMPTS,
  WorkPlanner,
  workWatchdogDeadline,
  type AbsorbInput,
  type DispatchCapacity,
  type WorkContext,
  type WorkPlanResult,
} from "../src/work/ledger";

const T = DEFAULT_ORACLE_TIMEOUT_MS;
/** A DECOMPOSE child in tests: kind defaults to feature, body to "". */
type ChildSpec = Omit<DecomposedChildInput, "kind" | "body"> & Partial<Pick<DecomposedChildInput, "kind" | "body">>;
const DAY0 = Date.UTC(2026, 9, 6, 12, 0, 0);

/** In-memory hive that persists WorkPlanResults the way the DO does. */
class WSim {
  items = new Map<string, WorkItemRecord>();
  claims = new Map<string, PathClaim>();
  escalations = new Map<string, EscalationRecord>();
  settings: HiveSettingsRecord | null = null;
  maxSeq = 0;
  now = DAY0;
  ctx: Partial<WorkContext> = {};
  private ids = 0;
  last!: WorkPlanResult;

  run(fn: (p: WorkPlanner) => WorkPlanResult): WorkPlanResult {
    const p = new WorkPlanner(
      {
        items: [...this.items.values()],
        claims: [...this.claims.values()],
        escalations: [...this.escalations.values()].filter((e) => e.status === "OPEN"),
        settings: this.settings,
        maxSeq: this.maxSeq,
      },
      { hive: "hive", now: this.now, newId: () => `id${++this.ids}`, ...this.ctx },
    );
    const r = fn(p);
    for (const i of r.items) {
      this.items.set(i.itemId, i);
      this.maxSeq = Math.max(this.maxSeq, i.seq);
    }
    for (const id of r.releasedClaims) for (const [k, c] of this.claims) if (c.itemId === id) this.claims.delete(k);
    for (const c of r.claims) this.claims.set(`${c.itemId}|${c.path}`, c);
    for (const e of r.escalations) this.escalations.set(e.escalationId, e);
    if (r.settings) this.settings = r.settings;
    this.last = r;
    return r;
  }

  item(id: string): WorkItemRecord {
    const i = this.items.get(id);
    if (!i) throw new Error(`no item ${id}`);
    return i;
  }
  status(id: string): WorkStatus {
    return this.item(id).status;
  }
  claimsOf(id: string): PathClaim[] {
    return [...this.claims.values()].filter((c) => c.itemId === id);
  }
  open(reason?: string): EscalationRecord[] {
    return [...this.escalations.values()].filter((e) => e.status === "OPEN" && (!reason || e.reason === reason));
  }
  oracle(r: WorkPlanResult = this.last): OracleCommand[] {
    return r.effects.flatMap((e) => (e.type === "oracle" ? [e.command] : []));
  }

  /** A user feature (READY unless deps). */
  feature(title: string, extra: Partial<{ paths: string[]; priority: number; dependsOn: string[]; bestOf: number; difficulty: "normal" | "hard"; parentId: string }> = {}): string {
    const r = this.run((p) =>
      p.fileItem({ kind: "feature", title, body: "", acceptance: [], priority: 2, dependsOn: [], paths: [], actor: "user:a@x", ...extra }),
    );
    expect(r.outcome).toBe("applied");
    return r.itemId!;
  }
  dispatch(cap: DispatchCapacity = { activeBuilds: 0 }): WorkPlanResult {
    return this.run((p) => p.dispatchReady(cap));
  }
  absorb(input: AbsorbInput): WorkPlanResult {
    return this.run((p) => p.absorb(input));
  }
  landed(id: string): WorkPlanResult {
    return this.absorb({ prompts: [{ promptId: id, status: "MERGED" }] });
  }
  goal(text = "Goals\n- a\n- b"): { goalId: string; cmd: Extract<OracleCommand, { op: "DECOMPOSE" }> } {
    const r = this.run((p) => p.fileGoal({ promptText: text, actor: "user:a@x" }));
    const cmd = this.oracle(r)[0];
    if (cmd?.op !== "DECOMPOSE") throw new Error("no DECOMPOSE");
    return { goalId: r.itemId!, cmd };
  }
  decomposed(goalId: string, commandId: string, children: ChildSpec[] | null): WorkPlanResult {
    const r: OracleResult = {
      commandId,
      op: "DECOMPOSE",
      itemId: goalId,
      ok: children !== null,
      ...(children ? { children: children.map(child) } : {}),
      summary: "",
    };
    return this.run((p) => p.oracleResult(r));
  }
}

function child(c: ChildSpec) {
  return {
    acceptance: [],
    priority: 2,
    difficulty: "normal" as const,
    dependsOn: [],
    paths: [],
    similar: [],
    ...c,
    body: c.body ?? "",
    kind: c.kind ?? ("feature" as const),
  };
}

const fu = (title: string, extra: Partial<FollowUp> = {}): FollowUp => ({ kind: "bug", title, body: "", paths: [], priority: 2, ...extra });

// ── filing ───────────────────────────────────────────────────────────────

describe("filing", () => {
  it("decompose:false files one READY feature (title = first line, body = full text), no TRIAGE", () => {
    const s = new WSim();
    const r = s.run((p) => p.filePrompt({ promptText: "Add a dark theme\nwith a toggle", actor: "user" }));
    const i = s.item(r.itemId!);
    expect(i).toMatchObject({ kind: "feature", status: "READY", title: "Add a dark theme", body: "Add a dark theme\nwith a toggle", depth: 0, rootId: i.itemId });
    expect(i.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(s.oracle()).toEqual([]);
    expect(r.events.map((e) => e.type)).toContain("item.filed");
    expect(s.settings?.autonomy).toBe("autonomous"); // first filing creates the settings row
  });

  it("decompose:true files a DECOMPOSING goal and a DECOMPOSE command (counts a dispatch)", () => {
    const s = new WSim();
    const other = s.feature("existing", { paths: ["src/a.js"] });
    const { goalId, cmd } = s.goal();
    expect(s.status(goalId)).toBe("DECOMPOSING");
    expect(cmd).toMatchObject({ commandId: `${goalId}-decompose-1`, limits: { maxChildren: 8 }, promptText: "Goals\n- a\n- b" });
    expect(cmd.model.role).toBe("planner");
    expect(cmd.openItems).toEqual([{ itemId: other, title: "existing", status: "READY", paths: ["src/a.js"] }]);
    expect(cmd.trace?.traceparent).toContain(s.item(goalId).traceId);
    expect(s.settings!.dispatches).toBe(1);
    expect(s.item(goalId).commandIssuedAt).toBe(s.now);
  });

  it("dependencies: BLOCKED until every dependency LANDED", () => {
    const s = new WSim();
    const a = s.feature("a");
    const b = s.feature("b", { dependsOn: [a] });
    expect(s.status(b)).toBe("BLOCKED");
    expect(s.item(b).blockedReason).toBe(`waiting on ${a}`);
    s.dispatch();
    s.landed(a);
    expect(s.status(a)).toBe("LANDED");
    expect(s.status(b)).toBe("READY");
    expect(s.item(b).blockedReason).toBeNull();
  });

  it("a child of a parent gets depth+1, the parent's root and trace", () => {
    const s = new WSim();
    const a = s.feature("a");
    const b = s.feature("b", { parentId: a });
    expect(s.item(b)).toMatchObject({ depth: 1, parentId: a, rootId: a, traceId: s.item(a).traceId });
  });

  const refusals: { name: string; setup: (s: WSim) => Parameters<WSim["feature"]>[1]; status: number; escalates: boolean }[] = [
    { name: "unknown parent → 404", setup: () => ({ parentId: "nope" }), status: 404, escalates: false },
    { name: "unknown dependency → 400", setup: () => ({ dependsOn: ["nope"] }), status: 400, escalates: false },
    {
      name: "depth over maxDepth → 409 + GUARDRAIL_TRIPPED",
      setup: (s) => {
        const a = s.feature("a");
        const b = s.feature("b", { parentId: a });
        const c = s.feature("c", { parentId: b }); // depth 2 = maxDepth
        return { parentId: c };
      },
      status: 409,
      escalates: true,
    },
    {
      name: "open-item cap → 409 + GUARDRAIL_TRIPPED",
      setup: (s) => {
        s.settings = { ...rollBudgetDay(s.settings ?? (s.feature("seed"), s.settings!), s.now), overrides: { guardrails: { maxOpenItems: 2 } } };
        s.feature("x");
        return {};
      },
      status: 409,
      escalates: true,
    },
  ];
  for (const t of refusals) {
    it(`user filing refused: ${t.name}`, () => {
      const s = new WSim();
      const extra = t.setup(s);
      const before = s.items.size;
      const r = s.run((p) => p.fileItem({ kind: "bug", title: "t", body: "", acceptance: [], priority: 2, dependsOn: [], paths: [], actor: "user", ...extra }));
      expect(r.outcome).toBe("rejected");
      expect(r.error?.status).toBe(t.status);
      expect(s.items.size).toBe(before);
      expect(s.open("GUARDRAIL_TRIPPED").length).toBe(t.escalates ? 1 : 0);
    });
  }

  it("a second refusal does not open a second GUARDRAIL_TRIPPED", () => {
    const s = new WSim();
    s.feature("seed");
    s.settings = { ...s.settings!, overrides: { guardrails: { maxOpenItems: 1 } } };
    s.run((p) => p.fileGoal({ promptText: "g", actor: "user" }));
    s.run((p) => p.fileGoal({ promptText: "g", actor: "user" }));
    expect(s.last.outcome).toBe("rejected");
    expect(s.open("GUARDRAIL_TRIPPED")).toHaveLength(1);
  });

  it("paths are normalised on filing", () => {
    const s = new WSim();
    const a = s.feature("a", { paths: ["./src/a.js", "src/a.js", "src/features/index.js", "lib/"] });
    expect(s.item(a).paths).toEqual(["src/a.js", "lib/"]);
  });
});

// ── decomposition ────────────────────────────────────────────────────────

describe("oracleResult DECOMPOSE", () => {
  it("files children with deterministic ids, goal → ACTIVE, deps mapped, BLOCKED until deps land", () => {
    const s = new WSim();
    const { goalId, cmd } = s.goal();
    const r = s.decomposed(goalId, cmd.commandId, [
      { key: "c1", title: "health", paths: ["./src/features/health.js"] },
      { key: "c2", title: "theme", dependsOn: ["c1"], priority: 1, difficulty: "hard", acceptance: ["dark"] },
    ]);
    expect(r.outcome).toBe("applied");
    expect(s.status(goalId)).toBe("ACTIVE");
    expect(s.item(goalId).commandId).toBeNull();
    const c1 = s.item(`${goalId}-c1`);
    const c2 = s.item(`${goalId}-c2`);
    expect(c1).toMatchObject({ status: "READY", parentId: goalId, rootId: goalId, depth: 1, traceId: s.item(goalId).traceId, paths: ["src/features/health.js"] });
    expect(c1.source).toMatchObject({ kind: "oracle", itemId: goalId, commandId: cmd.commandId });
    expect(c2).toMatchObject({ status: "BLOCKED", dependsOn: [c1.itemId], difficulty: "hard", priority: 2 }); // clamped to the goal's P2
    expect(r.events.find((e) => e.type === "item.decomposed")?.data).toMatchObject({ fallback: false, children: [c1.itemId, c2.itemId] });
  });

  it("a re-delivered result is a duplicate; an older attempt is stale; an unknown item is unknown", () => {
    const s = new WSim();
    const { goalId, cmd } = s.goal();
    s.decomposed(goalId, cmd.commandId, [{ key: "c1", title: "x" }]);
    expect(s.decomposed(goalId, cmd.commandId, [{ key: "c1", title: "x" }]).outcome).toBe("ignored:duplicate");
    const g2 = s.goal("other");
    s.now += T + 1;
    s.run((p) => p.reconcile()); // re-issued as attempt 2
    expect(s.decomposed(g2.goalId, g2.cmd.commandId, [{ key: "c1", title: "y" }]).outcome).toBe("ignored:stale");
    expect(s.run((p) => p.oracleResult({ commandId: "x", op: "DECOMPOSE", itemId: "nope", ok: true, summary: "" })).outcome).toBe("ignored:unknown");
  });

  const fallbacks: { name: string; children: ChildSpec[] | null }[] = [
    { name: "ok:false", children: null },
    { name: "an empty answer", children: [] },
  ];
  for (const f of fallbacks) {
    it(`falls back to one feature with the whole prompt on ${f.name}`, () => {
      const s = new WSim();
      const { goalId, cmd } = s.goal("Make it fast\nand pretty");
      const r = s.decomposed(goalId, cmd.commandId, f.children);
      const c1 = s.item(`${goalId}-c1`);
      expect(c1).toMatchObject({ kind: "feature", status: "READY", title: "Make it fast", body: "Make it fast\nand pretty", paths: [] });
      expect(s.status(goalId)).toBe("ACTIVE");
      expect(r.events.find((e) => e.type === "item.decomposed")?.data).toMatchObject({ fallback: true });
    });
  }

  it("children over maxChildrenPerItem are dropped and GUARDRAIL_TRIPPED opens", () => {
    const s = new WSim();
    const { goalId, cmd } = s.goal();
    const ten = Array.from({ length: 10 }, (_, n) => ({ key: `c${n + 1}`, title: `t${n + 1}` }));
    s.decomposed(goalId, cmd.commandId, ten);
    expect([...s.items.values()].filter((i) => i.parentId === goalId)).toHaveLength(GUARDRAIL_DEFAULTS.maxChildrenPerItem);
    expect(s.items.has(`${goalId}-c9`)).toBe(false);
    expect(s.open("GUARDRAIL_TRIPPED")[0]?.subject).toEqual({ type: "item", id: goalId });
  });

  it("a dependency cycle drops the closing edge and logs it", () => {
    const s = new WSim();
    const { goalId, cmd } = s.goal();
    const r = s.decomposed(goalId, cmd.commandId, [
      { key: "c1", title: "a", dependsOn: ["c3"] },
      { key: "c2", title: "b", dependsOn: ["c1"] },
      { key: "c3", title: "c", dependsOn: ["c2"] },
    ]);
    expect(s.item(`${goalId}-c1`).dependsOn).toEqual([`${goalId}-c3`]);
    expect(s.item(`${goalId}-c2`).dependsOn).toEqual([`${goalId}-c1`]);
    expect(s.item(`${goalId}-c3`).dependsOn).toEqual([]); // c3→c2 closes c1→c3→c2→c1
    expect(s.status(`${goalId}-c3`)).toBe("READY");
    expect(r.events.some((e) => e.type === "guardrail.tripped" && e.summary.includes("c3→c2"))).toBe(true);
  });

  it("unknown and self dependency keys are dropped", () => {
    const s = new WSim();
    const { goalId, cmd } = s.goal();
    s.decomposed(goalId, cmd.commandId, [{ key: "c1", title: "a", dependsOn: ["c1", "c9"] }]);
    expect(s.item(`${goalId}-c1`)).toMatchObject({ dependsOn: [], status: "READY" });
  });

  const dedupe: { name: string; score: number; targetStatus: WorkStatus | "dup-chain"; dup: boolean }[] = [
    { name: "≥ 0.92 against a live item", score: 0.92, targetStatus: "READY", dup: true },
    { name: "below 0.92", score: 0.91, targetStatus: "READY", dup: false },
    { name: "against a terminal item", score: 0.99, targetStatus: "SHIPPED", dup: false },
    { name: "through a duplicateOf chain", score: 0.95, targetStatus: "dup-chain", dup: true },
  ];
  for (const d of dedupe) {
    it(`child dedupe: ${d.name}`, () => {
      const s = new WSim();
      const live = s.feature("live");
      let target = live;
      if (d.targetStatus === "dup-chain") {
        target = "dupe";
        s.items.set("dupe", { ...s.item(live), itemId: "dupe", seq: 99, status: "DUPLICATE", duplicateOf: live });
      } else {
        s.items.set(live, { ...s.item(live), status: d.targetStatus });
      }
      const { goalId, cmd } = s.goal();
      s.decomposed(goalId, cmd.commandId, [
        { key: "c1", title: "same", similar: [{ itemId: target, score: d.score }] },
        { key: "c2", title: "after", dependsOn: ["c1"] },
      ]);
      const c1 = s.item(`${goalId}-c1`);
      expect(c1.status).toBe(d.dup ? "DUPLICATE" : "READY");
      expect(c1.duplicateOf).toBe(d.dup ? live : null);
      // A sibling depending on a duplicate depends on the original instead.
      expect(s.item(`${goalId}-c2`).dependsOn).toEqual([d.dup ? live : c1.itemId]);
    });
  }
});

// ── triage and follow-ups ────────────────────────────────────────────────

describe("follow-ups and TRIAGE", () => {
  function withParent(): { s: WSim; parent: string } {
    const s = new WSim();
    const parent = s.feature("parent");
    s.dispatch();
    return { s, parent };
  }

  it("drone follow-ups become TRIAGE children (depth+1, P2 at best) with a TRIAGE command", () => {
    const { s, parent } = withParent();
    const r = s.absorb({ followUps: [{ source: "drone", actor: "drone:BUILDER", itemId: parent, trainId: "t1", followUps: [fu("flaky test", { priority: 1, paths: ["./test/a.js"] })] }] });
    const bug = [...s.items.values()].find((i) => i.title === "flaky test")!;
    expect(bug).toMatchObject({ status: "TRIAGE", depth: 1, parentId: parent, priority: 2, paths: ["test/a.js"], traceId: s.item(parent).traceId });
    expect(bug.source).toMatchObject({ kind: "drone", itemId: parent, trainId: "t1" });
    expect(s.oracle(r)).toEqual([expect.objectContaining({ op: "TRIAGE", commandId: `${bug.itemId}-triage-1` })]);
    expect(r.events.map((e) => e.type)).toContain("followup.filed");
  });

  it("gatekeeper follow-ups are roots linked to the item, P1 allowed", () => {
    const { s, parent } = withParent();
    s.absorb({ followUps: [{ source: "gatekeeper", actor: "gatekeeper:SECURITY", itemId: parent, trainId: "t1", followUps: [fu("secret in config", { priority: 1 })] }] });
    const bug = [...s.items.values()].find((i) => i.title === "secret in config")!;
    expect(bug).toMatchObject({ parentId: null, depth: 0, rootId: bug.itemId, priority: 1, status: "TRIAGE" });
  });

  const triage: { name: string; ok: boolean; score: number; want: WorkStatus }[] = [
    { name: "≥ 0.90 → DUPLICATE", ok: true, score: 0.9, want: "DUPLICATE" },
    { name: "< 0.90 → READY", ok: true, score: 0.89, want: "READY" },
    { name: "ok:false → READY (no dedupe)", ok: false, score: 0.99, want: "READY" },
  ];
  for (const t of triage) {
    it(`TRIAGE ${t.name}`, () => {
      const { s, parent } = withParent();
      const other = s.feature("other");
      s.absorb({ followUps: [{ source: "drone", actor: "drone:BUILDER", itemId: parent, trainId: "t1", followUps: [fu("bug x")] }] });
      const bug = [...s.items.values()].find((i) => i.title === "bug x")!;
      const r = s.run((p) =>
        p.oracleResult({ commandId: bug.commandId!, op: "TRIAGE", itemId: bug.itemId, ok: t.ok, similar: [{ itemId: other, score: t.score }], summary: "" }),
      );
      expect(r.outcome).toBe("applied");
      expect(s.status(bug.itemId)).toBe(t.want);
      expect(s.item(bug.itemId).duplicateOf).toBe(t.want === "DUPLICATE" ? other : null);
    });
  }

  it("more than maxFollowUpsPerBuild are truncated", () => {
    const { s, parent } = withParent();
    const r = s.absorb({ followUps: [{ source: "drone", actor: "d", itemId: parent, trainId: null, followUps: [fu("a"), fu("b"), fu("c"), fu("d"), fu("e")] }] });
    expect([...s.items.values()].filter((i) => i.status === "TRIAGE")).toHaveLength(3);
    expect(r.events.filter((e) => e.type === "followup.dropped")).toHaveLength(2);
  });

  it("exact dedupe drops a follow-up with the same source, ref and normalized title as an open item", () => {
    const { s, parent } = withParent();
    s.absorb({ followUps: [{ source: "drone", actor: "d", itemId: parent, trainId: "t1", followUps: [fu("Flaky  Test")] }] });
    const r = s.absorb({ followUps: [{ source: "drone", actor: "d", itemId: parent, trainId: "t2", followUps: [fu("flaky test")] }] });
    expect([...s.items.values()].filter((i) => i.normalizedTitle === "flaky test")).toHaveLength(1);
    expect(r.events.find((e) => e.type === "followup.dropped")?.data).toMatchObject({ reason: "duplicate" });
  });

  it("a drone follow-up past maxDepth is dropped", () => {
    const s = new WSim();
    const a = s.feature("a");
    const b = s.feature("b", { parentId: a });
    const c = s.feature("c", { parentId: b }); // depth 2
    const r = s.absorb({ followUps: [{ source: "drone", actor: "d", itemId: c, trainId: null, followUps: [fu("deep")] }] });
    expect([...s.items.values()].some((i) => i.title === "deep")).toBe(false);
    expect(r.events.find((e) => e.type === "followup.dropped")?.data).toMatchObject({ reason: "max_depth" });
  });

  it("the hourly cap drops follow-ups and opens one GUARDRAIL_TRIPPED per hour; the next hour resets", () => {
    const { s, parent } = withParent();
    s.settings = { ...s.settings!, overrides: { guardrails: { maxAutoFiledPerHour: 2 } } };
    for (const t of ["a", "b", "c", "d"]) s.absorb({ followUps: [{ source: "drone", actor: "d", itemId: parent, trainId: null, followUps: [fu(t)] }] });
    expect([...s.items.values()].filter((i) => i.status === "TRIAGE")).toHaveLength(2);
    expect(s.open("GUARDRAIL_TRIPPED")).toHaveLength(1);
    s.now += 3_600_000;
    s.absorb({ followUps: [{ source: "drone", actor: "d", itemId: parent, trainId: null, followUps: [fu("e")] }] });
    expect([...s.items.values()].filter((i) => i.status === "TRIAGE")).toHaveLength(3);
  });

  it("the open-item cap drops auto-filed follow-ups (no 409)", () => {
    const { s, parent } = withParent();
    s.settings = { ...s.settings!, overrides: { guardrails: { maxOpenItems: 1 } } };
    const r = s.absorb({ followUps: [{ source: "drone", actor: "d", itemId: parent, trainId: null, followUps: [fu("x")] }] });
    expect(r.outcome).toBe("applied");
    expect(r.events.find((e) => e.type === "followup.dropped")?.data).toMatchObject({ reason: "max_open_items" });
  });
});

// ── absorb: prompt, train and release outcomes ───────────────────────────

describe("absorb", () => {
  function active(paths: string[] = ["src/a.js"]): { s: WSim; id: string } {
    const s = new WSim();
    const id = s.feature("x", { paths });
    s.dispatch();
    expect(s.status(id)).toBe("ACTIVE");
    return { s, id };
  }

  const promptEdges: { prompt: "QUEUED" | "BUILDING" | "IN_TRAIN" | "EJECTED" | "MERGED" | "FAILED"; want: WorkStatus; claims: number }[] = [
    { prompt: "QUEUED", want: "ACTIVE", claims: 1 },
    { prompt: "BUILDING", want: "ACTIVE", claims: 1 },
    { prompt: "IN_TRAIN", want: "ACTIVE", claims: 1 },
    { prompt: "EJECTED", want: "ACTIVE", claims: 1 },
    { prompt: "MERGED", want: "LANDED", claims: 0 },
    { prompt: "FAILED", want: "FAILED", claims: 0 },
  ];
  for (const t of promptEdges) {
    it(`prompt ${t.prompt} → item ${t.want}`, () => {
      const { s, id } = active();
      const r = s.absorb({ prompts: [{ promptId: id, status: t.prompt, attempts: 1, summary: "gate failed twice" }] });
      expect(s.status(id)).toBe(t.want);
      expect(s.item(id).attempts).toBe(1);
      expect(s.claimsOf(id)).toHaveLength(t.claims);
      if (t.want === "LANDED") expect(s.item(id).landedAt).toBe(s.now);
      if (t.want === "FAILED") {
        const e = s.open("REWORK_EXHAUSTED")[0]!;
        expect(e.subject).toEqual({ type: "item", id });
        expect(e.actions).toEqual(["retry", "cancel"]);
        expect(s.item(id).escalationId).toBe(e.escalationId);
      }
      if (t.claims === 0) expect(r.releasedClaims).toEqual([id]);
    });
  }

  it("a MERGED BUILD train lands its item too; QUEUE cars are ignored", () => {
    const { s, id } = active();
    s.absorb({ trains: [{ trainId: "car", promptId: id, lane: "QUEUE", phase: "MERGED" }] });
    expect(s.status(id)).toBe("ACTIVE");
    s.absorb({ trains: [{ trainId: "t", promptId: id, lane: "BUILD", phase: "MERGED" }] });
    expect(s.status(id)).toBe("LANDED");
  });

  it("changedPaths widen claims as actual; conflicts widen as conflict and count", () => {
    const { s, id } = active(["src/a.js"]);
    s.absorb({ trains: [{ trainId: "t", promptId: id, changedPaths: ["src/a.js", "src/b.js", "src/features/index.js"] }] });
    expect(s.claimsOf(id).map((c) => [c.path, c.source]).sort()).toEqual([["src/a.js", "actual"], ["src/b.js", "actual"]]);
    s.absorb({ memberFailures: [{ trainId: "t", itemId: id, cause: "conflict", claimPaths: ["src/c.js"] }] });
    expect(s.item(id).conflicts).toBe(1);
    expect(s.claimsOf(id).find((c) => c.path === "src/c.js")?.source).toBe("conflict");
    s.absorb({ memberFailures: [{ trainId: "t", itemId: id, cause: "integration", claimPaths: [] }] });
    expect(s.item(id).conflicts).toBe(1);
  });

  it("a mirrored prompt conflicts count wins over member failures", () => {
    const { s, id } = active();
    s.absorb({ prompts: [{ promptId: id, status: "BUILDING", conflicts: 2 }], memberFailures: [{ trainId: "t", itemId: id, cause: "conflict", claimPaths: [] }] });
    expect(s.item(id).conflicts).toBe(2);
  });

  it("member failures resolve the item through ctx.itemOfTrain", () => {
    const { s, id } = active();
    s.ctx = { itemOfTrain: (t) => (t === "tx" ? id : null) };
    s.absorb({ memberFailures: [{ trainId: "tx", cause: "conflict", claimPaths: ["src/z.js"] }] });
    expect(s.item(id).conflicts).toBe(1);
  });

  it("release SHIPPED → its LANDED items SHIPPED, the goal rolls up SHIPPED", () => {
    const s = new WSim();
    const { goalId, cmd } = s.goal();
    s.decomposed(goalId, cmd.commandId, [{ key: "c1", title: "a" }, { key: "c2", title: "b" }]);
    s.dispatch();
    const [c1, c2] = [`${goalId}-c1`, `${goalId}-c2`];
    s.landed(c1);
    s.absorb({ releases: [{ releaseId: "R1", phase: "SHIPPED", trainIds: ["t1"], itemIds: [c1] }] });
    expect(s.status(c1)).toBe("SHIPPED");
    expect(s.item(c1)).toMatchObject({ releaseId: "R1", shippedAt: s.now });
    expect(s.status(goalId)).toBe("ACTIVE");
    s.landed(c2);
    s.ctx = { itemOfTrain: (t) => (t === "t2" ? c2 : null) };
    s.absorb({ releases: [{ releaseId: "R2", phase: "SHIPPED", trainIds: ["t2"] }] });
    expect(s.status(c2)).toBe("SHIPPED");
    expect(s.status(goalId)).toBe("SHIPPED");
  });

  it("goal rollup: FAILED when the rest are done and one FAILED; back to ACTIVE on retry; CANCELLED when all cancelled", () => {
    const s = new WSim();
    const { goalId, cmd } = s.goal();
    s.decomposed(goalId, cmd.commandId, [{ key: "c1", title: "a" }, { key: "c2", title: "b", dependsOn: ["c1"] }]);
    const [c1, c2] = [`${goalId}-c1`, `${goalId}-c2`];
    s.dispatch();
    s.absorb({ prompts: [{ promptId: c1, status: "FAILED" }] });
    expect(s.status(goalId)).toBe("ACTIVE"); // c2 BLOCKED is not done
    expect(s.item(c2).blockedReason).toBe(`dependency ${c1} failed`);
    s.run((p) => p.cancel(c2, "user"));
    expect(s.status(goalId)).toBe("FAILED");
    s.run((p) => p.retry(c1, "user"));
    expect(s.status(goalId)).toBe("ACTIVE");
    s.run((p) => p.cancel(c1, "user"));
    expect(s.status(goalId)).toBe("CANCELLED");
  });

  it("a rollback files one P0 bug per release, LANDED items stay LANDED; the streak is left to the ReleasePlanner", () => {
    const { s, id } = active(["src/a.js"]);
    s.landed(id);
    const rb = { releaseId: "R1", phase: "ROLLED_BACK" as const, trainIds: ["t"], itemIds: [id], summary: "5xx on /", canaryPercent: 10 };
    s.absorb({ releases: [rb] });
    s.absorb({ releases: [rb] }); // repeated row: no second bug
    const bugs = [...s.items.values()].filter((i) => i.source.kind === "queen");
    expect(bugs).toHaveLength(1);
    expect(bugs[0]).toMatchObject({ kind: "bug", priority: 0, status: "READY", paths: ["src/a.js"] });
    expect(bugs[0]!.source.releaseId).toBe("R1");
    expect(bugs[0]!.body).toContain("- x");
    expect(s.status(id)).toBe("LANDED");
    const r = s.absorb({ releases: [{ ...rb, releaseId: "R2", phase: "FAILED", canaryPercent: 50 }] });
    expect([...s.items.values()].filter((i) => i.source.kind === "queen")).toHaveLength(2);
    expect(s.settings!.rollbackStreak).toBe(0);
    expect(s.open("ROLLBACK_STREAK")).toHaveLength(0);
    expect(r.events.map((e) => e.type)).not.toContain("autonomy.degraded");
  });

  it("a staging FAILED release files a bug too", () => {
    const s = new WSim();
    s.feature("seed");
    s.absorb({ releases: [{ releaseId: "R1", phase: "FAILED", trainIds: [], canaryPercent: null, summary: "staging deploy failed" }] });
    expect([...s.items.values()].filter((i) => i.source.kind === "queen")).toHaveLength(1);
  });

  it("other release phases change nothing", () => {
    const s = new WSim();
    s.feature("seed");
    const r = s.absorb({ releases: [{ releaseId: "R1", phase: "CANARY", trainIds: [] }] });
    expect(r.items).toEqual([]);
  });

  it("credits add to today's budget", () => {
    const s = new WSim();
    s.feature("seed");
    s.absorb({ credits: 12.5 });
    expect(s.settings!.creditsUsed).toBe(12.5);
  });
});

// ── dispatch ─────────────────────────────────────────────────────────────

describe("dispatchReady", () => {
  it("dispatches by priority then seq, composing the prompt", () => {
    const s = new WSim();
    const low = s.feature("low", { priority: 3 });
    const p1a = s.feature("p1a", { priority: 1 });
    const p1b = s.feature("p1b", { priority: 1 });
    const r = s.dispatch();
    expect(r.submissions.map((x) => x.itemId)).toEqual([p1a, p1b, low]);
    expect(r.submissions[0]).toMatchObject({ width: 1, promptText: "p1a", difficulty: "normal", traceId: s.item(p1a).traceId });
    expect(s.settings!.dispatches).toBe(3);
  });

  it("paused autonomy dispatches nothing (waitReason paused)", () => {
    const s = new WSim();
    const a = s.feature("a");
    s.ctx = { autonomy: "paused" };
    expect(s.dispatch().submissions).toEqual([]);
    expect(s.item(a).waitReason).toBe("paused");
  });

  it("an exhausted budget dispatches nothing and opens one BUDGET_EXHAUSTED", () => {
    const s = new WSim();
    const a = s.feature("a");
    s.settings = { ...s.settings!, overrides: { budget: { dailyDispatches: 1 } }, dispatches: 1 };
    expect(s.dispatch().submissions).toEqual([]);
    expect(s.item(a).waitReason).toBe("budget");
    s.dispatch();
    expect(s.open("BUDGET_EXHAUSTED")).toHaveLength(1);
    s.now += 24 * 3_600_000; // next UTC day resets the counters
    expect(s.dispatch().submissions.map((x) => x.itemId)).toEqual([a]);
  });

  it("credits over the daily limit also exhaust the budget", () => {
    const s = new WSim();
    s.feature("a");
    s.settings = { ...s.settings!, overrides: { budget: { dailyCredits: 10 } }, creditsUsed: 10 };
    expect(s.dispatch().submissions).toEqual([]);
  });

  it("slots: active builds + width ≤ min(maxActiveTrains, leasedSlots); width lowered to fit; the rest wait on capacity", () => {
    const s = new WSim();
    const race = s.feature("race", { bestOf: 3 });
    const b = s.feature("b");
    const r = s.dispatch({ activeBuilds: 2, leasedSlots: 4 });
    expect(r.submissions).toEqual([expect.objectContaining({ itemId: race, width: 2 })]);
    expect(s.item(b).waitReason).toBe("capacity 4/4");
    expect(s.settings!.dispatches).toBe(2);
  });

  it("race width: hard → race.hardWidth, capped by maxRaceWidth; ctx.widthOf overrides", () => {
    const s = new WSim();
    s.feature("hard", { difficulty: "hard" });
    expect(s.dispatch().submissions[0]!.width).toBe(3);
    const t = new WSim();
    t.feature("x", { bestOf: 5 });
    expect(t.dispatch().submissions[0]!.width).toBe(3);
    const u = new WSim();
    u.feature("x", { bestOf: 3 });
    u.ctx = { widthOf: () => 1 };
    expect(u.dispatch().submissions[0]!.width).toBe(1);
  });

  it("goals and non-READY items are never dispatched", () => {
    const s = new WSim();
    s.goal();
    const a = s.feature("a");
    s.feature("b", { dependsOn: [a] });
    expect(s.dispatch().submissions.map((x) => x.itemId)).toEqual([a]);
  });

  describe("affinity", () => {
    it("an overlap waits; a non-overlap dispatches the same tick", () => {
      const s = new WSim();
      const a = s.feature("a", { paths: ["src/lib/theme.js"] });
      const b = s.feature("b", { paths: ["src/lib/"] });
      const c = s.feature("c", { paths: ["src/other.js"] });
      const r = s.dispatch();
      expect(r.submissions.map((x) => x.itemId)).toEqual([a, c]);
      expect(s.item(b).waitReason).toBe(`affinity: src/lib/ held by ${a}`);
      expect(r.events.filter((e) => e.type === "affinity.wait")).toHaveLength(1);
      expect(s.claimsOf(a).map((x) => x.path)).toEqual(["src/lib/theme.js"]);
      // Still waiting on the same holder: no second event.
      expect(s.dispatch().events.filter((e) => e.type === "affinity.wait")).toHaveLength(0);
      s.landed(a);
      expect(s.dispatch().submissions.map((x) => x.itemId)).toEqual([b]);
    });

    it("a P0 waiter goes first when the claim frees", () => {
      const s = new WSim();
      const holder = s.feature("holder", { paths: ["src/theme.js"] });
      s.dispatch();
      const p2 = s.feature("p2", { paths: ["src/theme.js"] });
      const p0 = s.feature("p0", { paths: ["src/theme.js"], priority: 0 });
      s.dispatch();
      expect(s.item(p2).waitReason).toContain(holder);
      expect(s.item(p0).waitReason).toContain(holder);
      s.landed(holder);
      const r = s.dispatch();
      expect(r.submissions.map((x) => x.itemId)).toEqual([p0]);
      expect(s.item(p2).waitReason).toBe(`affinity: src/theme.js held by ${p0}`);
    });

    it("empty paths never wait", () => {
      const s = new WSim();
      s.feature("a", { paths: ["src/a.js"] });
      s.feature("b", { paths: [] });
      s.feature("c", { paths: [] });
      expect(s.dispatch().submissions).toHaveLength(3);
    });

    it("generated paths never wait", () => {
      const s = new WSim();
      // normalizePaths drops the generated path on filing; also check a raw row carrying it.
      const a = s.feature("a");
      s.items.set(a, { ...s.item(a), paths: ["src/features/index.js"] });
      const b = s.feature("b");
      s.items.set(b, { ...s.item(b), paths: ["src/features/index.js"] });
      expect(s.dispatch().submissions).toHaveLength(2);
      expect(s.claimsOf(a)).toEqual([]);
    });

    it("a conflict widens claims, so a later item on that path waits", () => {
      const s = new WSim();
      const a = s.feature("a", { paths: [] });
      s.dispatch();
      const b = s.feature("b", { paths: ["src/lib/format.js"] });
      s.absorb({ memberFailures: [{ trainId: "t", itemId: a, cause: "conflict", claimPaths: ["src/lib/format.js"] }] });
      expect(s.dispatch().submissions).toEqual([]);
      expect(s.item(b).waitReason).toBe(`affinity: src/lib/format.js held by ${a}`);
    });

    it("actual changed paths widen claims too", () => {
      const s = new WSim();
      const a = s.feature("a", { paths: [] });
      s.dispatch();
      s.absorb({ trains: [{ trainId: "t", promptId: a, changedPaths: ["src/x.js"] }] });
      const b = s.feature("b", { paths: ["src/"] });
      s.dispatch();
      expect(s.item(b).waitReason).toBe(`affinity: src/ held by ${a}`);
    });
  });
});

// ── human actions ────────────────────────────────────────────────────────

describe("retry / cancel / not_duplicate", () => {
  function failed(): { s: WSim; id: string } {
    const s = new WSim();
    const id = s.feature("x");
    s.dispatch();
    s.absorb({ prompts: [{ promptId: id, status: "FAILED", attempts: 2, conflicts: 1 }] });
    return { s, id };
  }

  it("retry: FAILED → READY, attempts and conflicts reset, the escalation resolves", () => {
    const { s, id } = failed();
    const r = s.run((p) => p.action(id, { action: "retry", note: "try again" }, "user:a@x"));
    expect(r.outcome).toBe("applied");
    expect(s.item(id)).toMatchObject({ status: "READY", attempts: 0, conflicts: 0 });
    const e = [...s.escalations.values()].find((x) => x.reason === "REWORK_EXHAUSTED")!;
    expect(e).toMatchObject({ status: "RESOLVED", resolvedBy: "user:a@x", resolution: "retry: try again" });
  });

  it("retry of an item whose dependency is not met → BLOCKED", () => {
    const s = new WSim();
    const dep = s.feature("dep");
    const id = s.feature("x");
    s.items.set(id, { ...s.item(id), status: "FAILED", dependsOn: [dep] });
    s.run((p) => p.retry(id, "user"));
    expect(s.status(id)).toBe("BLOCKED");
  });

  const cancels: { from: WorkStatus; ok: boolean }[] = [
    { from: "TRIAGE", ok: true },
    { from: "BLOCKED", ok: true },
    { from: "READY", ok: true },
    { from: "FAILED", ok: true },
    { from: "ACTIVE", ok: false },
    { from: "LANDED", ok: false },
    { from: "SHIPPED", ok: false },
    { from: "DUPLICATE", ok: false },
    { from: "CANCELLED", ok: false },
  ];
  for (const t of cancels) {
    it(`cancel from ${t.from}: ${t.ok ? "CANCELLED" : "409"}`, () => {
      const s = new WSim();
      const id = s.feature("x");
      s.items.set(id, { ...s.item(id), status: t.from, commandId: t.from === "TRIAGE" ? `${id}-triage-1` : null });
      const r = s.run((p) => p.cancel(id, "user"));
      expect(r.outcome).toBe(t.ok ? "applied" : "conflict");
      expect(s.status(id)).toBe(t.ok ? "CANCELLED" : t.from);
      if (!t.ok) expect(r.error?.status).toBe(409);
      if (t.from === "TRIAGE") {
        // A late TRIAGE answer is now a no-op.
        const late = s.run((p) => p.oracleResult({ commandId: `${id}-triage-1`, op: "TRIAGE", itemId: id, ok: true, summary: "" }));
        expect(late.outcome).toBe("ignored:duplicate");
        expect(s.status(id)).toBe("CANCELLED");
      }
    });
  }

  const retries: WorkStatus[] = ["TRIAGE", "BLOCKED", "READY", "ACTIVE", "LANDED", "SHIPPED", "DUPLICATE", "CANCELLED"];
  for (const from of retries) {
    it(`retry from ${from} → 409`, () => {
      const s = new WSim();
      const id = s.feature("x");
      s.items.set(id, { ...s.item(id), status: from });
      expect(s.run((p) => p.retry(id, "user")).outcome).toBe("conflict");
    });
  }

  it("goals cannot be retried or cancelled", () => {
    const s = new WSim();
    const { goalId } = s.goal();
    expect(s.run((p) => p.cancel(goalId, "user")).outcome).toBe("conflict");
    s.items.set(goalId, { ...s.item(goalId), status: "FAILED" });
    expect(s.run((p) => p.retry(goalId, "user")).outcome).toBe("conflict");
  });

  it("not_duplicate: DUPLICATE → READY with duplicateOf cleared; other statuses 409; unknown 404", () => {
    const s = new WSim();
    const a = s.feature("a");
    const b = s.feature("b");
    s.items.set(b, { ...s.item(b), status: "DUPLICATE", duplicateOf: a });
    expect(s.run((p) => p.notDuplicate(b, "user")).outcome).toBe("applied");
    expect(s.item(b)).toMatchObject({ status: "READY", duplicateOf: null });
    expect(s.run((p) => p.notDuplicate(a, "user")).outcome).toBe("conflict");
    const r = s.run((p) => p.notDuplicate("nope", "user"));
    expect(r.outcome).toBe("ignored:unknown");
    expect(r.error?.status).toBe(404);
  });
});

// ── reconcile ────────────────────────────────────────────────────────────

describe("reconcile", () => {
  it("the Oracle watchdog re-issues DECOMPOSE, then falls back and opens EXECUTOR_LOST", () => {
    const s = new WSim();
    const { goalId } = s.goal();
    expect(workWatchdogDeadline([...s.items.values()], T, s.now)).toBe(s.now + T);
    s.now += T - 1;
    expect(s.oracle(s.run((p) => p.reconcile()))).toEqual([]);
    for (let n = 2; n <= MAX_ORACLE_ATTEMPTS; n++) {
      s.now += T;
      const cmds = s.oracle(s.run((p) => p.reconcile()));
      expect(cmds.map((c) => c.commandId)).toEqual([`${goalId}-decompose-${n}`]);
    }
    s.now += T;
    s.run((p) => p.reconcile());
    expect(s.status(goalId)).toBe("ACTIVE");
    expect(s.status(`${goalId}-c1`)).toBe("READY");
    expect(s.open("EXECUTOR_LOST")[0]?.subject).toEqual({ type: "item", id: goalId });
    expect(s.settings!.dispatches).toBe(MAX_ORACLE_ATTEMPTS);
  });

  it("an exhausted TRIAGE files the item without dedupe", () => {
    const s = new WSim();
    const parent = s.feature("p");
    s.dispatch();
    s.absorb({ followUps: [{ source: "drone", actor: "d", itemId: parent, trainId: null, followUps: [fu("bug")] }] });
    const bug = [...s.items.values()].find((i) => i.title === "bug")!;
    for (let n = 0; n < MAX_ORACLE_ATTEMPTS; n++) {
      s.now += T;
      s.run((p) => p.reconcile());
    }
    expect(s.status(bug.itemId)).toBe("READY");
    expect(s.open("EXECUTOR_LOST")).toHaveLength(1);
  });

  it("releases claims of items that are no longer ACTIVE", () => {
    const s = new WSim();
    const a = s.feature("a", { paths: ["src/a.js"] });
    s.dispatch();
    s.items.set(a, { ...s.item(a), status: "LANDED" }); // landed without a release of its claims
    const r = s.run((p) => p.reconcile());
    expect(r.releasedClaims).toEqual([a]);
    expect(s.claimsOf(a)).toEqual([]);
  });

  it("unblocks BLOCKED items whose dependencies landed", () => {
    const s = new WSim();
    const a = s.feature("a");
    const b = s.feature("b", { dependsOn: [a] });
    s.items.set(a, { ...s.item(a), status: "SHIPPED" });
    s.run((p) => p.reconcile());
    expect(s.status(b)).toBe("READY");
  });

  it("flags the lease renewal when work is in flight and the lease is near expiry", () => {
    const s = new WSim();
    s.feature("a");
    expect(s.run((p) => p.reconcile()).leaseDue).toBe(true);
    s.settings = { ...s.settings!, leaseExpiresAt: s.now + 120_000 };
    expect(s.run((p) => p.reconcile()).leaseDue).toBe(false);
    const idle = new WSim();
    expect(idle.run((p) => p.reconcile()).leaseDue).toBe(false);
  });
});

// ── pure helpers ─────────────────────────────────────────────────────────

describe("guardrails and compose helpers", () => {
  it("normalizePath follows assertRepoPath rules", () => {
    const table: [string, string | null][] = [
      ["src/a.js", "src/a.js"],
      ["./src/a.js", "src/a.js"],
      ["src/lib/", "src/lib/"],
      ["/etc/passwd", null],
      ["src/../x", null],
      ["src//a", null],
      [".git/config", null],
      ["src\\a", null],
      ["src/*.js", null],
      ["src/features/index.js", null],
      ["", null],
    ];
    for (const [raw, want] of table) expect(normalizePath(raw), raw).toBe(want);
    expect(normalizePaths(Array.from({ length: 15 }, (_, n) => `f${n}.js`))).toHaveLength(10);
  });

  it("effectiveGuardrails clamps overrides to GUARDRAIL_MAX", () => {
    expect(effectiveGuardrails({ maxChildrenPerItem: 99, maxDepth: 0, maxAutoFiledPerHour: 0 })).toMatchObject({
      maxChildrenPerItem: 12,
      maxDepth: 1,
      maxAutoFiledPerHour: 0,
      maxOpenItems: 40,
    });
  });

  it("creditsFor uses the catalog cost", () => {
    expect(creditsFor("@cf/deepseek-ai/deepseek-v4-pro-0813", { inputTokens: 1500, outputTokens: 500 })).toBe(18);
    expect(creditsFor("unknown", { inputTokens: 1000, outputTokens: 0 })).toBe(1);
    expect(creditsFor("unknown", undefined)).toBe(0);
  });

  it("composePrompt and item text", () => {
    expect(composePrompt({ title: "T", body: "B", acceptance: ["a", "b"] })).toBe("T\n\nB\n\nAcceptance criteria:\n- a\n- b");
    expect(composePrompt({ title: "T", body: "T", acceptance: [] })).toBe("T");
    expect(itemTextFromPrompt("\n  first   line \nrest")).toEqual({ title: "first line", body: "first   line \nrest" });
    expect(releaseBugText({ releaseId: "R", phase: "ROLLED_BACK", summary: "boom" }, ["x"]).title).toBe("Release R rolled back: boom");
  });
});
