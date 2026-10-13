/**
 * MCP attempts, fix wave (final review "Root cause" + items 1-3, M1, M11): a gate that could not run on an attempt's
 * head is re-gated on the same head (no re-deploy, its own bounded budget), its exhaustion is an infra verdict (never
 * a plain rejection), the labels and notes say what really happens, `attemptRegate` re-submits the head on request,
 * refusals carry `retryAfterMs`, a terminal `attemptEnd` is idempotent, and the ledger's T2/T3/T4 test gaps.
 */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE_PENDING_POLL_MS, INFRA_SUMMARY_PREFIX, MAX_MANUAL_REGATES, REGATE_MIN_INTERVAL_MS, currentVerdict, isInfraStopped, parseNotes } from "@queenos/queen-types";
import type { QueenNode } from "../src/queen-node";
import { commandTimeoutMs } from "../src/queen-node";
import { GATE_TIMEOUT_FACTOR, MAX_GATE_INFRA_ROUNDS, gateInfraBackoffMs, nextGateRound } from "../src/train/planner";
import { attemptVerdictKind } from "../src/work/attempts";
import {
  BASE_SHA,
  OTHER,
  OWNER,
  accepted,
  agent,
  deletesOf,
  distinctDeletes,
  externalHive,
  fileItem,
  gateFail,
  gitPush,
  gateInfra,
  gatePass,
  goLive,
  landCarOf,
  later,
  look,
  readyAttempt,
  sha,
  stubFor,
  trainOf,
} from "./attempt-helpers";

const push = (ns: string, att: { attemptId: string; repo: string }, after = sha(), title = "Add a tip jar") =>
  stubFor(ns).attemptPushed({ hive: ns, attemptId: att.attemptId, repo: att.repo, after, title, message: `${title}\n\nAcceptance:\n- shows a jar` }).then((res) => ({ after, res }));
const own = (ns: string, r: { attemptId: string; agent: { agentId: string } }) => ({ hive: ns, attemptId: r.attemptId, owner: OWNER, agentId: r.agent.agentId });
const noteOf = (ns: string, head: string) => runInDurableObject(stubFor(ns), (q: QueenNode) => q.verdictNote(head));

/** A pushed attempt whose preview is live and whose first Queen-started gate (q1) is out. */
async function gating(opts: { entryWindowMs?: number } = {}) {
  const { ns, stub } = await externalHive(opts.entryWindowMs !== undefined ? { race: { entryWindowMs: opts.entryWindowMs } } : {});
  const itemId = await fileItem(ns);
  const r = await readyAttempt(ns, itemId);
  const { after } = await push(ns, r);
  await goLive(ns, r.trainId);
  expect(await trainOf(ns, r.trainId)).toMatchObject({ phase: "TESTING", gate_command_id: expect.stringMatching(/-q1$/) });
  return { ns, stub, itemId, r, head: after };
}

/** Report gate infra `rounds` times (each against the train's then-current gate). */
async function infraRounds(ns: string, trainId: string, rounds: number) {
  for (let i = 0; i < rounds; i++) await gateInfra(ns, trainId);
}

describe("gate-infra re-gate on the same head (contributed trains)", () => {
  it("nextGateRound keeps the odd-first parity; the backoff doubles from ~30 s, jittered, capped at 5 min", () => {
    expect([null, "g-q1", "g-q2", "g-q3", "g-q4", "g-q7"].map((id) => nextGateRound(id))).toEqual([1, 3, 3, 5, 5, 9]);
    const t = { trainId: "t-1" };
    for (let k = 1; k <= 6; k++) {
      const ms = gateInfraBackoffMs(t, k);
      const nominal = Math.min(5 * 60_000, 30_000 * 2 ** (k - 1));
      expect(ms).toBeGreaterThanOrEqual(nominal * 0.5);
      expect(ms).toBeLessThan(nominal * 1.5);
    }
    expect(MAX_GATE_INFRA_ROUNDS).toBe(3);
  });

  it("an infra gate report keeps the candidate in TESTING and re-gates the same head under -q3 with notBefore; no re-deploy; the attempt stays PUSHED, verdict pending", async () => {
    const { ns, stub, r } = await gating();
    const deploysBefore = (await look(ns)).deploys.length;
    const before = Date.now();
    const res = await gateInfra(ns, r.trainId);
    expect(res).toMatchObject({ outcome: "applied" });
    const s = await look(ns);
    const t = s.trains.find((x) => x.train_id === r.trainId)!;
    expect(t).toMatchObject({ phase: "TESTING", gate_infra_rounds: 1, gate_command_id: expect.stringMatching(/-q3$/) });
    expect(s.deploys).toHaveLength(deploysBefore);
    const gate = s.gates.at(-1)!;
    expect(gate.commandId).toBe(t.gate_command_id);
    expect(gate.notBefore).toBe(Number(t.gate_not_before));
    expect(gate.notBefore!).toBeGreaterThanOrEqual(before + 15_000);
    expect(gate.notBefore!).toBeLessThanOrEqual(Date.now() + 45_000);
    const view = await stub.getAttempt(r.attemptId);
    expect(view).toMatchObject({ state: "PUSHED", verdict: "pending", verdictKind: null, regating: { round: 1, of: 3, notBefore: gate.notBefore }, train: { gateInfraRounds: 1 } });
    const v = s.events.filter((e) => e.type === "gate.verdict").at(-1)!;
    expect(JSON.parse(v.data)).toMatchObject({ outcome: "INFRA", cause: "infra", applied: "applied", gateInfraRound: 1, of: 3 });
    expect(v.summary).toMatch(/could not run \(infrastructure; re-gate 1\/3 in \d+ s\)/);
  });

  it("a re-gated head that passes clears regating; a reconcile re-emit keeps notBefore", async () => {
    const { ns, stub, r } = await gating();
    await gateInfra(ns, r.trainId);
    const first = (await look(ns)).gates.at(-1)!;
    await later(ns, 0); // reconcile: the outstanding gate is re-emitted under the same id, with the same notBefore
    const again = (await look(ns)).gates.filter((g) => g.commandId === first.commandId);
    expect(again.length).toBeGreaterThanOrEqual(2);
    for (const g of again) expect(g.notBefore).toBe(first.notBefore);
    await stub.reportTrainResult({ trainId: r.trainId, passed: true, summary: "green", gateId: first.commandId });
    expect(await stub.getAttempt(r.attemptId)).toMatchObject({ state: "PASSED", verdict: "passed", verdictKind: null, regating: null });
  });

  it("the gate watchdog measures from notBefore, not from the issue time", async () => {
    const { ns, r } = await gating();
    await gateInfra(ns, r.trainId);
    const t = await trainOf(ns, r.trainId);
    const timeout = GATE_TIMEOUT_FACTOR * commandTimeoutMs(env as never);
    const wait = Number(t.gate_not_before) - Date.now();
    // Past the timeout from the issue time, but not from notBefore: no re-dispatch yet.
    await later(ns, timeout + Math.max(0, wait) - 5_000);
    expect(await trainOf(ns, r.trainId)).toMatchObject({ gate_command_id: t.gate_command_id });
    await later(ns, 10_000);
    expect((await trainOf(ns, r.trainId)).gate_command_id).toMatch(/-q4$/);
  });

  it("three re-gates, then the 4th infra report exhausts: EJECTED as infra (prefixed summary), attempt REJECTED with verdictKind infra, INFRA_EXHAUSTED verdict, an honest note", async () => {
    const { ns, stub, r, head, itemId } = await gating({ entryWindowMs: 0 });
    await infraRounds(ns, r.trainId, MAX_GATE_INFRA_ROUNDS);
    expect(await trainOf(ns, r.trainId)).toMatchObject({ phase: "TESTING", gate_infra_rounds: 3, gate_command_id: expect.stringMatching(/-q7$/) });
    expect((await stub.getAttempt(r.attemptId))!.regating).toMatchObject({ round: 3, of: 3 });
    expect((await look(ns)).deploys.filter((d) => d.op === "DEPLOY" && d.trainId === r.trainId)).toHaveLength(1);
    await gateInfra(ns, r.trainId);
    const s = await look(ns);
    const t = s.trains.find((x) => x.train_id === r.trainId)!;
    expect(t).toMatchObject({ phase: "EJECTED", race_outcome: "FAILED" });
    expect(isInfraStopped({ summary: String(t.summary) })).toBe(true);
    expect(String(t.summary)).toMatch(new RegExp(`^${INFRA_SUMMARY_PREFIX}gate could not run after 4 tries: `));
    const view = (await stub.getAttempt(r.attemptId))!;
    expect(view).toMatchObject({ state: "REJECTED", verdict: "rejected", verdictKind: "infra", regating: null });
    const verdicts = s.events.filter((e) => e.type === "gate.verdict").map((e) => ({ summary: e.summary, data: JSON.parse(e.data) }));
    expect(verdicts.map((v) => v.data.outcome)).toEqual(["INFRA", "INFRA", "INFRA", "INFRA_EXHAUSTED"]);
    expect(verdicts.at(-1)!.data).toMatchObject({ tries: 4 });
    expect(verdicts.at(-1)!.summary).toMatch(/could not run after 4 tries \(infrastructure\); not a verdict on the change/);
    expect(verdicts.some((v) => /re-gating/.test(v.summary) && v.data.outcome === "INFRA_EXHAUSTED")).toBe(false);
    // The live case: the sole candidate's race is abandoned and the item awaits its contributor (no auto-reopen).
    expect(s.races[0]).toMatchObject({ state: "ABANDONED" });
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ status: "FAILED" });
    const note = (await noteOf(ns, head))!;
    const entries = parseNotes(note);
    expect(currentVerdict(entries)).toBe("INFRA");
    expect(entries.at(-1)!.summary).toMatch(/^INFRA: the gate could not run after 4 tries; this is not a verdict on your change\. Call retry_gates \(MCP\) or push again\./);
    expect(note).not.toMatch(/REJECTED/);
  });

  it("an older exhausted row (prefixed summary, no INFRA_EXHAUSTED event) still gets the infra note from its EJECTED event", async () => {
    const { ns, r, head } = await gating({ entryWindowMs: 0 });
    await infraRounds(ns, r.trainId, MAX_GATE_INFRA_ROUNDS + 1);
    await runInDurableObject(stubFor(ns), (q: QueenNode) => {
      q.sql.exec("DELETE FROM event_log WHERE type = 'gate.verdict' AND json_extract(data, '$.outcome') = 'INFRA_EXHAUSTED'");
    });
    const entries = parseNotes((await noteOf(ns, head))!);
    expect(currentVerdict(entries)).toBe("INFRA");
    expect(entries.filter((e) => e.verdict === "INFRA" && /not a verdict on your change/.test(e.summary))).toHaveLength(1);
  });

  it("a re-deploy after a re-gate never reuses a gate id", async () => {
    const { ns, r } = await gating();
    await gateInfra(ns, r.trainId); // q3, with notBefore
    const timeout = GATE_TIMEOUT_FACTOR * commandTimeoutMs(env as never);
    await later(ns, timeout + 5 * 60_000); // q3 lost → q4 (the round's one watchdog re-dispatch)
    expect((await trainOf(ns, r.trainId)).gate_command_id).toMatch(/-q4$/);
    await later(ns, timeout + 60_000); // q4 lost too → the infra path: re-deploy after a backoff
    expect(await trainOf(ns, r.trainId)).toMatchObject({ phase: "DEPLOYING" });
    await later(ns, 10 * 60_000);
    expect((await trainOf(ns, r.trainId)).deploy_command_id).toMatch(/-deploy-2$/);
    await goLive(ns, r.trainId);
    const t = await trainOf(ns, r.trainId);
    expect(t.gate_command_id).toMatch(/-q5$/);
    const ids = (await look(ns)).gates.filter((g) => g.trainId === r.trainId).map((g) => g.commandId);
    expect(ids.filter((id) => id === t.gate_command_id)).toHaveLength(1);
  });

  it("a stale infra report (an old gateId) is ignored and claims no re-gate", async () => {
    const { ns, stub, r } = await gating();
    const q1 = String((await trainOf(ns, r.trainId)).gate_command_id);
    await gateInfra(ns, r.trainId); // → q3
    const res = await stub.reportTrainResult({ trainId: r.trainId, passed: false, cause: "infra", summary: "late", gateId: q1 });
    expect(res.outcome).toBe("ignored:stale");
    expect(await trainOf(ns, r.trainId)).toMatchObject({ gate_infra_rounds: 1, gate_command_id: expect.stringMatching(/-q3$/) });
    const last = (await look(ns)).events.filter((e) => e.type === "gate.verdict").at(-1)!;
    expect(JSON.parse(last.data)).toMatchObject({ applied: "ignored:stale" });
    expect(last.summary).not.toMatch(/re-gat/);
  });

  it("a preview deploy that keeps failing on infrastructure ends the candidate as infra too (the race branch of infraExhausted)", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const r = await readyAttempt(ns, await fileItem(ns));
    await push(ns, r);
    for (let n = 1; n <= 3; n++) {
      const c = (await look(ns)).deploys.filter((d) => d.op === "DEPLOY" && d.trainId === r.trainId).at(-1)!;
      expect(c.commandId).toMatch(new RegExp(`-deploy-${n}$`));
      await stub.reportDeployResult({ commandId: c.commandId, op: "DEPLOY", environment: "preview", trainId: r.trainId, ok: false, retryable: true, summary: "503 from the API" });
      if (n < 3) await later(ns, 10 * 60_000);
    }
    const t = await trainOf(ns, r.trainId);
    expect(t).toMatchObject({ phase: "EJECTED", race_outcome: "FAILED" });
    expect(String(t.summary).startsWith(INFRA_SUMMARY_PREFIX)).toBe(true);
    expect(await stub.getAttempt(r.attemptId)).toMatchObject({ state: "REJECTED", verdictKind: "infra" });
  });

  it("a gate that found problems is a findings verdict", async () => {
    const { ns, stub, r } = await gating();
    await gateFail(ns, r.trainId);
    expect(await stub.getAttempt(r.attemptId)).toMatchObject({ state: "REJECTED", verdict: "rejected", verdictKind: "findings", regating: null });
    expect(attemptVerdictKind(null)).toBeNull();
    expect(attemptVerdictKind({ phase: "TESTING", raceOutcome: "RACING", summary: null })).toBeNull();
    expect(attemptVerdictKind({ phase: "EJECTED", raceOutcome: "FAILED", summary: `${INFRA_SUMMARY_PREFIX}x` })).toBe("infra");
    expect(attemptVerdictKind({ phase: "EJECTED", raceOutcome: "FAILED", summary: "security: nope" })).toBe("findings");
  });
});

describe("attemptRegate (MCP retry_gates)", () => {
  async function exhausted() {
    const g = await gating({ entryWindowMs: 0 });
    await infraRounds(g.ns, g.r.trainId, MAX_GATE_INFRA_ROUNDS + 1);
    expect(await g.stub.getAttempt(g.r.attemptId)).toMatchObject({ state: "REJECTED", verdictKind: "infra" });
    return g;
  }

  it("re-submits the same head as a new train: the FAILED item reopens into a new race, the submission row is re-pointed, the attempt is PUSHED; a second call is a no-op", async () => {
    const { ns, stub, r, head, itemId } = await exhausted();
    const res = await stub.attemptRegate(own(ns, r));
    expect(res).toMatchObject({ ok: true, changed: true, attempt: { state: "PUSHED", headSha: head, verdict: "pending" } });
    if (!res.ok) throw new Error(res.message);
    const trainId = res.attempt.trainId;
    expect(trainId).not.toBe(r.trainId);
    const s = await look(ns);
    expect(s.trains.find((t) => t.train_id === trainId)).toMatchObject({ phase: "DEPLOYING", artifact_repo: r.repo, attempt_id: r.attemptId, prompt_id: itemId });
    expect(s.submissions).toHaveLength(1);
    expect(s.submissions[0]).toMatchObject({ head_sha: head, train_id: trainId, outcome: "applied" });
    expect(s.attempts[0]).toMatchObject({ state: "PUSHED", train_id: trainId, regates: 1 });
    expect(s.items.find((i) => i.item_id === itemId)!.status).not.toBe("FAILED");
    expect(s.races.filter((x) => x.state === "RACING")).toHaveLength(1);
    expect(s.events.some((e) => e.type === "attempt.state" && /re-gate requested \(1\/3\)/.test(e.summary))).toBe(true);
    expect(deletesOf(s.provisions, r.repo)).toEqual([]);
    // Pending again: idempotent, no counter bump.
    expect(await stub.attemptRegate(own(ns, r))).toMatchObject({ ok: true, changed: false, attempt: { trainId } });
    expect((await look(ns)).attempts[0]).toMatchObject({ regates: 1 });
    // The new train gates and passes like any push.
    await gatePass(ns, trainId);
    expect(await stub.getAttempt(r.attemptId)).toMatchObject({ verdict: "passed" });
  });

  it("refuses: no push yet, a head that passed, a findings verdict (CONFLICT); another agent (FORBIDDEN_OWNER); a terminal attempt (ATTEMPT_EXPIRED)", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const ready = await readyAttempt(ns, await fileItem(ns, "Ready"));
    expect(await stub.attemptRegate(own(ns, ready))).toMatchObject({ ok: false, code: "CONFLICT", message: expect.stringMatching(/push first/) });
    expect(await stub.attemptRegate({ ...own(ns, ready), owner: OTHER })).toMatchObject({ ok: false, code: "FORBIDDEN_OWNER" });

    const passed = await gating();
    await passed.stub.reportTrainResult({ trainId: passed.r.trainId, passed: true, summary: "green" });
    expect(await passed.stub.attemptRegate(own(passed.ns, passed.r))).toMatchObject({ ok: false, code: "CONFLICT", message: expect.stringMatching(/passed/) });

    const findings = await gating();
    await gateFail(findings.ns, findings.r.trainId);
    expect(await findings.stub.attemptRegate(own(findings.ns, findings.r))).toMatchObject({ ok: false, code: "CONFLICT", message: expect.stringMatching(/found problems/) });

    await stub.attemptEnd(own(ns, ready));
    expect(await stub.attemptRegate(own(ns, ready))).toMatchObject({ ok: false, code: "ATTEMPT_EXPIRED" });
  });

  it("rate limit: within a minute of the last re-gate CAP_EXCEEDED with retryAfterMs; past MAX_MANUAL_REGATES CAP_EXCEEDED without it", async () => {
    const { ns, stub, r } = await exhausted();
    await runInDurableObject(stubFor(ns), (q: QueenNode) => {
      q.sql.exec("UPDATE attempts SET regates = 1, last_regate_at = ? WHERE attempt_id = ?", Date.now(), r.attemptId);
    });
    const soon = await stub.attemptRegate(own(ns, r));
    expect(soon).toMatchObject({ ok: false, code: "CAP_EXCEEDED" });
    if (soon.ok) throw new Error("expected a refusal");
    expect(soon.retryAfterMs).toBeGreaterThan(REGATE_MIN_INTERVAL_MS - 5_000);
    expect(soon.retryAfterMs).toBeLessThanOrEqual(REGATE_MIN_INTERVAL_MS);
    await runInDurableObject(stubFor(ns), (q: QueenNode) => {
      q.sql.exec("UPDATE attempts SET regates = ?, last_regate_at = 1 WHERE attempt_id = ?", MAX_MANUAL_REGATES, r.attemptId);
    });
    const spent = await stub.attemptRegate(own(ns, r));
    expect(spent).toMatchObject({ ok: false, code: "CAP_EXCEEDED", message: expect.stringContaining(String(MAX_MANUAL_REGATES)) });
    expect(spent).not.toHaveProperty("retryAfterMs");
  });
});

describe("refusals carry retryAfterMs; attemptReady BASE_PENDING (M11)", () => {
  it("the hourly cap says when its oldest counted start ages out; BASE_PENDING says the poll interval", async () => {
    const hourly = await externalHive({ guardrails: { maxInboxPushesPerHour: 1 } });
    accepted(await hourly.stub.attemptIntent({ hive: hourly.ns, owner: OWNER, agent: agent(), target: { itemId: await fileItem(hourly.ns, "One") } }));
    const again = await hourly.stub.attemptIntent({ hive: hourly.ns, owner: OWNER, agent: agent(), target: { itemId: await fileItem(hourly.ns, "Two") } });
    expect(again).toMatchObject({ verdict: "refuse", code: "CAP_EXCEEDED" });
    if (again.verdict !== "refuse") throw new Error("expected a refusal");
    expect(again.retryAfterMs).toBeGreaterThan(3_600_000 - 60_000);
    expect(again.retryAfterMs).toBeLessThanOrEqual(3_600_000);

    const perAgent = await externalHive({ guardrails: { maxInboxOpenPerContributor: 10 } });
    const a = agent();
    for (const t of ["A", "B", "C"]) accepted(await perAgent.stub.attemptIntent({ hive: perAgent.ns, owner: OWNER, agent: a, target: { itemId: await fileItem(perAgent.ns, t) } }));
    const fourth = await perAgent.stub.attemptIntent({ hive: perAgent.ns, owner: OWNER, agent: a, target: { itemId: await fileItem(perAgent.ns, "D") } });
    expect(fourth).toMatchObject({ verdict: "refuse", code: "CAP_EXCEEDED" });
    expect(fourth).not.toHaveProperty("retryAfterMs");

    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    accepted(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent(), target: { itemId } }));
    expect(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent(), target: { itemId } })).toMatchObject({ verdict: "refuse", code: "BASE_PENDING", retryAfterMs: BASE_PENDING_POLL_MS });
  });

  it("attemptReady while the item's base is (again) being created is BASE_PENDING, not BASE_MOVED", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const d = accepted(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent(), target: { itemId } }));
    expect(d.base.kind).toBe("create");
    const res = await stub.attemptReady({ hive: ns, attemptId: d.attemptId, repo: d.repo, baseSha: BASE_SHA, expiresAt: Date.now() + 7_200_000 });
    expect(res).toMatchObject({ ok: false, code: "BASE_PENDING", retryAfterMs: BASE_PENDING_POLL_MS });
  });
});

describe("attemptEnd on a terminal attempt is idempotent (M1)", () => {
  it("the owner's agent gets ok, changed:false and the terminal view; refresh still says ATTEMPT_EXPIRED; another agent is still FORBIDDEN_OWNER", async () => {
    const { ns, stub } = await externalHive();
    const r = await readyAttempt(ns, await fileItem(ns));
    expect(await stub.attemptEnd(own(ns, r))).toMatchObject({ ok: true, changed: true, attempt: { state: "ABANDONED" } });
    expect(await stub.attemptEnd(own(ns, r))).toMatchObject({ ok: true, changed: false, attempt: { state: "ABANDONED" } });
    expect(await stub.attemptRefresh(own(ns, r))).toMatchObject({ ok: false, code: "ATTEMPT_EXPIRED" });
    expect(await stub.attemptEnd({ ...own(ns, r), agentId: agent().agentId })).toMatchObject({ ok: false, code: "FORBIDDEN_OWNER" });
    expect(distinctDeletes(await look(ns), r.repo)).toBe(1);
  });

  it("a LANDED attempt: end returns its terminal state without a second delete", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 0 } });
    const r = await readyAttempt(ns, await fileItem(ns));
    await push(ns, r);
    await gatePass(ns, r.trainId);
    await landCarOf(ns, r.trainId);
    expect(await stub.getAttempt(r.attemptId)).toMatchObject({ state: "LANDED" });
    const deletes = distinctDeletes(await look(ns), r.repo);
    expect(await stub.attemptEnd(own(ns, r))).toMatchObject({ ok: true, changed: false, attempt: { state: "LANDED" } });
    expect(distinctDeletes(await look(ns), r.repo)).toBe(deletes);
  });
});

describe("ledger test gaps (T2, T3, T4)", () => {
  it("T2: a RACING race with its entry window closed refuses new attempts (ITEM_NOT_ACCEPTING); an open window accepts them", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 15 * 60_000 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId, agent());
    await push(ns, a);
    expect((await look(ns)).races[0]).toMatchObject({ state: "RACING" });
    expect(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent({ name: "haiku" }), target: { itemId } })).toMatchObject({ verdict: "accept", itemId });
    await stub.closeRaceEntries({ hive: ns, raceId: String((await look(ns)).races[0]!.race_id), user: OWNER });
    expect((await look(ns)).races[0]).toMatchObject({ state: "RACING" }); // a candidate is still pending
    expect(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent({ name: "sonnet" }), target: { itemId } })).toMatchObject({ verdict: "refuse", code: "ITEM_NOT_ACCEPTING" });
  });

  it("T2: baseFailed without an attemptId frees the pending base and aborts no INTENT", async () => {
    const { ns, stub } = await externalHive();
    const itemId = await fileItem(ns);
    const d = accepted(await stub.attemptIntent({ hive: ns, owner: OWNER, agent: agent(), target: { itemId } }));
    expect(await stub.attemptBaseFailed({ hive: ns, itemId, baseRepo: d.base.baseRepo, reason: "503" })).toEqual({ outcome: "applied" });
    const s = await look(ns);
    expect(s.items.find((i) => i.item_id === itemId)).toMatchObject({ base_repo: null, base_sha: null });
    expect(s.attempts.find((x) => x.attempt_id === d.attemptId)).toMatchObject({ state: "INTENT" });
    expect(await stub.attemptBaseFailed({ hive: ns, itemId, baseRepo: d.base.baseRepo, reason: "503" })).toEqual({ outcome: "ignored:stale" });
  });

  it("T2: submitWork without decompose keeps entryWindowMs on its one item", async () => {
    const { ns, stub } = await externalHive();
    const { item } = await stub.submitWork({ namespace: ns, promptText: "Tip jar\n\nadd one", decompose: false, entryWindowMs: 90_000, user: OWNER });
    expect(item.entryWindowMs).toBe(90_000);
    expect((await look(ns)).items.find((i) => i.item_id === item.itemId)).toMatchObject({ entry_window_ms: 90_000 });
  });

  it("T3: ending a REJECTED attempt abandons it and deletes its fork exactly once", async () => {
    const { ns, stub } = await externalHive();
    const r = await readyAttempt(ns, await fileItem(ns));
    await push(ns, r);
    await goLive(ns, r.trainId);
    await gateFail(ns, r.trainId);
    expect(await stub.getAttempt(r.attemptId)).toMatchObject({ state: "REJECTED" });
    expect(await stub.attemptEnd(own(ns, r))).toMatchObject({ ok: true, changed: true, attempt: { state: "ABANDONED" } });
    await later(ns, 0);
    expect(distinctDeletes(await look(ns), r.repo)).toBe(1);
  });

  it("T4: a PICKING race decided by a human pick releases the item's base once every attempt is terminal", async () => {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 15 * 60_000, judge: "human" } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId, agent());
    const b = await readyAttempt(ns, itemId, agent({ name: "haiku" }));
    const baseRepo = String((await look(ns)).items.find((i) => i.item_id === itemId)!.base_repo);
    await push(ns, a);
    await push(ns, b);
    await gatePass(ns, a.trainId);
    await gatePass(ns, b.trainId);
    const raceId = String((await look(ns)).races[0]!.race_id);
    await stub.closeRaceEntries({ hive: ns, raceId, user: OWNER });
    expect((await look(ns)).races[0]).toMatchObject({ state: "PICKING" });
    expect(deletesOf((await look(ns)).provisions, baseRepo)).toEqual([]);
    await stub.pick({ hive: ns, raceId, user: OWNER, pick: { trainId: a.trainId } });
    let s = await look(ns);
    expect(s.races[0]).toMatchObject({ state: "DECIDED", winner_train_id: a.trainId });
    expect(s.attempts.find((x) => x.attempt_id === b.attemptId)).toMatchObject({ state: "LOST" });
    expect(deletesOf(s.provisions, baseRepo)).toEqual([]); // the winner's attempt is still open
    await stub.attemptEnd(own(ns, a)); // the winner is in a car: a no-op
    await landCarOf(ns, a.trainId);
    s = await look(ns);
    expect(s.attempts.find((x) => x.attempt_id === a.attemptId)).toMatchObject({ state: "LANDED" });
    expect(deletesOf(s.provisions, baseRepo)).toHaveLength(1);
    await later(ns, 0);
    expect(distinctDeletes(await look(ns), baseRepo)).toBe(1);
  });
});

describe("fix round 1", () => {
  /** Two attempts race (window open), entries close while B is pending, then A's gate infra-exhausts. */
  async function closedRace() {
    const { ns, stub } = await externalHive({ race: { entryWindowMs: 15 * 60_000 } });
    const itemId = await fileItem(ns);
    const a = await readyAttempt(ns, itemId, agent());
    const b = await readyAttempt(ns, itemId, agent({ name: "haiku" }));
    await push(ns, a);
    await push(ns, b);
    await goLive(ns, a.trainId);
    const raceId = String((await look(ns)).races[0]!.race_id);
    await stub.closeRaceEntries({ hive: ns, raceId, user: OWNER });
    await infraRounds(ns, a.trainId, MAX_GATE_INFRA_ROUNDS + 1);
    expect(await stub.getAttempt(a.attemptId)).toMatchObject({ state: "REJECTED", verdictKind: "infra" });
    expect((await look(ns)).races[0]).toMatchObject({ state: "RACING" }); // B is still pending
    return { ns, stub, itemId, a, b, raceId };
  }

  it("I1: a regate into a still-RACING race with entries closed rejoins that same race; no follow-up item is filed", async () => {
    const { ns, stub, itemId, a, raceId } = await closedRace();
    const items = (await look(ns)).items.length;
    const res = await stub.attemptRegate(own(ns, a));
    expect(res).toMatchObject({ ok: true, changed: true, attempt: { state: "PUSHED", itemId, raceId } });
    if (!res.ok) throw new Error(res.message);
    const s = await look(ns);
    expect(s.items).toHaveLength(items);
    expect(s.races).toHaveLength(1);
    expect(JSON.parse(String(s.races[0]!.train_ids))).toContain(res.attempt.trainId);
    expect(s.trains.find((t) => t.train_id === res.attempt.trainId)).toMatchObject({ race_id: raceId, race_outcome: "RACING", prompt_id: itemId });
    expect(s.submissions.find((x) => x.attempt_id === a.attemptId)).toMatchObject({ train_id: res.attempt.trainId, disposition: "joined-race", item_id: itemId });
  });

  it("I1: once the other candidate won, a regate is refused (ITEM_NOT_ACCEPTING) and nothing is committed", async () => {
    const { ns, stub, a, b } = await closedRace();
    await gatePass(ns, b.trainId);
    expect((await look(ns)).races[0]).toMatchObject({ state: "DECIDED", winner_train_id: b.trainId });
    const before = await look(ns);
    const res = await stub.attemptRegate(own(ns, a));
    expect(res).toMatchObject({ ok: false, code: "ITEM_NOT_ACCEPTING", message: expect.stringMatching(/was decided without this head; nothing to re-gate/) });
    const after = await look(ns);
    expect(after.items).toHaveLength(before.items.length);
    expect(after.trains).toHaveLength(before.trains.length);
    expect(after.attempts.find((x) => x.attempt_id === a.attemptId)).toMatchObject({ state: "REJECTED", regates: 0, train_id: a.trainId });
  });

  it("I2: an uncorrelated human push (no race) whose gate keeps failing on infrastructure ends EJECTED with EXECUTOR_LOST, never a REWORK", async () => {
    const ns = `inf-${crypto.randomUUID().slice(0, 8)}`;
    const p = await gitPush(ns, "refs/heads/tip-jar", "Add a tip jar");
    const trainId = p.decision.trainId;
    expect(await trainOf(ns, trainId)).toMatchObject({ phase: "DEPLOYING", race_id: null });
    await goLive(ns, trainId);
    await infraRounds(ns, trainId, MAX_GATE_INFRA_ROUNDS + 1);
    const t = await trainOf(ns, trainId);
    expect(t).toMatchObject({ phase: "EJECTED" });
    expect(isInfraStopped({ summary: String(t.summary) })).toBe(true);
    const esc = await runInDurableObject(stubFor(ns), (q: QueenNode) => q.sql.exec("SELECT reason, subject_id FROM escalations").toArray());
    expect(esc).toEqual([expect.objectContaining({ reason: "EXECUTOR_LOST", subject_id: t.prompt_id })]);
    const rework = await runInDurableObject(stubFor(ns), (q: QueenNode) => q.sql.exec("SELECT COUNT(*) AS n FROM merge_trains WHERE action = 'REWORK'").one().n);
    expect(Number(rework)).toBe(0);
  });

  it("M-b: a real second regate: exhaust, regate, exhaust again, wait past the interval, regate → regates 2 and the (2/3) event", async () => {
    const { ns, stub, r } = await (async () => {
      const g = await gating({ entryWindowMs: 0 });
      await infraRounds(g.ns, g.r.trainId, MAX_GATE_INFRA_ROUNDS + 1);
      return g;
    })();
    const first = await stub.attemptRegate(own(ns, r));
    if (!first.ok) throw new Error(first.message);
    await goLive(ns, first.attempt.trainId);
    await infraRounds(ns, first.attempt.trainId, MAX_GATE_INFRA_ROUNDS + 1);
    expect(await stub.getAttempt(r.attemptId)).toMatchObject({ state: "REJECTED", verdictKind: "infra" });
    expect(await stub.attemptRegate(own(ns, r))).toMatchObject({ ok: false, code: "CAP_EXCEEDED", retryAfterMs: expect.any(Number) });
    await later(ns, REGATE_MIN_INTERVAL_MS + 1_000);
    const second = await stub.attemptRegate(own(ns, r));
    expect(second).toMatchObject({ ok: true, changed: true, attempt: { state: "PUSHED", regates: 2 } });
    const s = await look(ns);
    expect(s.attempts[0]).toMatchObject({ regates: 2 });
    expect(s.events.some((e) => e.type === "attempt.state" && /re-gate requested \(2\/3\)/.test(e.summary))).toBe(true);
  });
});
