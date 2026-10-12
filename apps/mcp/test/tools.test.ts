import { describe, expect, it } from "vitest";
import type { McpAgentIdentity } from "@queenos/queen-types";
import { TOOLS, callTool, type ToolOutcome } from "../src/tools";
import { ATT, ATT_REPO, BASE_REPO, FakeSession, FakeWorld, HIVE, MAIN_SHA, OTHER, OWNER, REMOTE, acceptCreate, viewOf } from "./fakes";

const run = (w: FakeWorld, s: FakeSession, name: string, args: unknown = {}): Promise<ToolOutcome> => callTool(TOOLS.find((t) => t.name === name)!, { ports: w.ports(), session: s }, args);
const value = <T = Record<string, unknown>>(o: ToolOutcome): T => {
  if (!o.ok) throw new Error(`tool error ${o.error.code}: ${o.error.message}`);
  return o.value as T;
};
const errOf = (o: ToolOutcome) => (o.ok ? null : o.error);

async function worker(w: FakeWorld, role: "worker" | "orchestrator" = "worker"): Promise<{ s: FakeSession; agent: McpAgentIdentity }> {
  const s = new FakeSession();
  const agent = value<McpAgentIdentity>(await run(w, s, "init_agent", { name: "opus", model: "claude-opus-5-5", role }));
  return { s, agent };
}

describe("tool table", () => {
  it("has the 16 tools of spec §6", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      ["close_entries", "create_goal", "end_attempt", "get_attempt", "get_item", "get_verdict", "init_agent", "list_attempts", "list_hives", "list_items", "pick", "refresh_attempt", "resume_agent", "start_attempt", "wait", "whoami"].sort(),
    );
  });
});

describe("identity", () => {
  it("whoami needs no init; other tools are NOT_INITIALIZED until init_agent; a second init is ALREADY_INITIALIZED", async () => {
    const w = new FakeWorld();
    const s = new FakeSession();
    expect(value(await run(w, s, "whoami"))).toEqual({ owner: OWNER, agent: null });
    expect(errOf(await run(w, s, "list_hives"))).toMatchObject({ code: "NOT_INITIALIZED" });
    const id = value<McpAgentIdentity>(await run(w, s, "init_agent", { name: "opus", model: "claude-opus-5-5", role: "worker" }));
    expect(id).toEqual({ agentId: expect.stringMatching(/^ag_[0-9a-f]{32}$/), name: "opus", model: "claude-opus-5-5", role: "worker", owner: OWNER });
    expect(w.identity(id.agentId).identity).toEqual(id);
    expect(value(await run(w, s, "whoami"))).toEqual({ owner: OWNER, agent: { agentId: id.agentId, name: "opus", model: "claude-opus-5-5", role: "worker" } });
    expect(errOf(await run(w, s, "init_agent", { name: "haiku", model: "m", role: "worker" }))).toMatchObject({ code: "ALREADY_INITIALIZED" });
    expect(value(await run(w, s, "list_hives"))).toEqual([{ hive: HIVE, name: "Demo", status: "ACTIVE" }]);
  });

  it("resume_agent re-binds a new session of the same owner with its open attempts; another owner is FORBIDDEN_OWNER; unknown is NOT_FOUND", async () => {
    const w = new FakeWorld();
    const { agent } = await worker(w);
    await w.identity(agent.agentId).addAttempt({ hive: HIVE, attemptId: ATT });
    const again = new FakeSession();
    expect(value(await run(w, again, "resume_agent", { agentId: agent.agentId }))).toEqual({ ...agent, openAttempts: [{ hive: HIVE, attemptId: ATT }] });
    expect(again.identity()).toEqual(agent);
    expect(errOf(await run(w, new FakeSession(OTHER), "resume_agent", { agentId: agent.agentId }))).toMatchObject({ code: "FORBIDDEN_OWNER" });
    expect(errOf(await run(w, new FakeSession(), "resume_agent", { agentId: `ag_${"f".repeat(32)}` }))).toMatchObject({ code: "NOT_FOUND" });
  });

  it("a session whose agent belongs to another owner is FORBIDDEN_OWNER on every agent tool", async () => {
    const w = new FakeWorld();
    const { agent } = await worker(w);
    expect(errOf(await run(w, new FakeSession(OTHER, agent), "list_hives"))).toMatchObject({ code: "FORBIDDEN_OWNER" });
  });

  it("INVALID_INPUT names the fields, never the values", async () => {
    const w = new FakeWorld();
    const e = errOf(await run(w, new FakeSession(), "init_agent", { name: "../evil", model: "m", role: "boss" }));
    expect(e).toMatchObject({ code: "INVALID_INPUT" });
    expect(e!.message).toContain("name");
    expect(e!.message).toContain("role");
    expect(e!.message).not.toContain("evil");
    expect(e!.message).not.toContain("boss");
  });
});

describe("create_goal", () => {
  it("orchestrators only, external hives only; files a decomposed prompt and returns the goal and its item", async () => {
    const w = new FakeWorld();
    const { s: workerS } = await worker(w, "worker");
    expect(errOf(await run(w, workerS, "create_goal", { hive: HIVE, title: "Tip jar", description: "x" }))).toMatchObject({ code: "FORBIDDEN_ROLE" });
    const { s } = await worker(w, "orchestrator");
    expect(errOf(await run(w, s, "create_goal", { hive: "nope-hive", title: "Tip jar", description: "x" }))).toMatchObject({ code: "NOT_FOUND" });
    w.queen.executors = "swarm";
    expect(errOf(await run(w, s, "create_goal", { hive: HIVE, title: "Tip jar", description: "x" }))).toMatchObject({ code: "HIVE_NOT_EXTERNAL" });
    w.queen.executors = "external";
    expect(value(await run(w, s, "create_goal", { hive: HIVE, title: "Tip jar", description: "Add one", judge: "pick", entryWindowMs: 120_000 }))).toEqual({ goalId: "goal-1", itemId: "goal-1-c1" });
    expect(w.queen.inputs("submitWork")).toEqual([{ namespace: HIVE, promptText: "Tip jar\n\nAdd one", decompose: true, judge: "human", entryWindowMs: 120_000, user: OWNER }]);
  });
});

describe("start_attempt", () => {
  it("the first attempt of an item forks hive main read-only into the base, then the attempt from the base; the token never sits in a URL", async () => {
    const w = new FakeWorld();
    const { s, agent } = await worker(w);
    const r = value<Record<string, string | number>>(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }));
    expect(w.artifacts.forks).toEqual([
      { name: BASE_REPO, source: HIVE, readOnly: true },
      { name: ATT_REPO, source: BASE_REPO, readOnly: false },
    ]);
    expect(w.queen.inputs("attemptBaseReady")).toEqual([{ hive: HIVE, itemId: "item-1", baseRepo: BASE_REPO, baseSha: MAIN_SHA }]);
    expect(w.queen.inputs("attemptReady")).toEqual([{ hive: HIVE, attemptId: ATT, repo: ATT_REPO, baseSha: MAIN_SHA, expiresAt: expect.any(Number) }]);
    expect(w.queen.inputs("attemptIntent")[0]).toEqual({ hive: HIVE, owner: OWNER, agent, target: { itemId: "item-1" } });
    expect(r).toMatchObject({ attemptId: ATT, itemId: "item-1", remote: REMOTE(ATT_REPO), baseSha: MAIN_SHA, dir: `.queenos/attempts/${ATT}` });
    const token = String(r.token);
    expect(token).toMatch(/^art_v1_/);
    expect(String(r.remote)).not.toContain("art_v1");
    expect(r.cloneCommand).toBe(`git -c http.extraHeader="Authorization: Bearer ${token}" clone ${REMOTE(ATT_REPO)} .queenos/attempts/${ATT}`);
    expect(r.configCommand).toBe(`git -C .queenos/attempts/${ATT} config --local --replace-all http.${REMOTE(ATT_REPO)}.extraHeader "Authorization: Bearer ${token}"`);
    expect(String(r.cloneCommand)).not.toMatch(/https:\/\/[^ ]*art_v1/);
    // The probe's own token was revoked; only the agent's token is active.
    expect(w.artifacts.activeTokens(ATT_REPO)).toHaveLength(1);
    expect(await w.identity(agent.agentId).attempts()).toEqual([{ hive: HIVE, attemptId: ATT, open: true }]);
  });

  it("a later attempt forks the existing base, never hive main", async () => {
    const w = new FakeWorld();
    w.artifacts.repos.set(BASE_REPO, { main: MAIN_SHA, readOnly: true, source: HIVE, tokens: [] });
    w.queen.intents = [acceptCreate({ base: { kind: "existing", baseRepo: BASE_REPO, baseSha: MAIN_SHA } })];
    const { s } = await worker(w);
    value(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }));
    expect(w.artifacts.forks).toEqual([{ name: ATT_REPO, source: BASE_REPO, readOnly: false }]);
    expect(w.queen.methods()).not.toContain("attemptBaseReady");
  });

  it("BASE_PENDING is polled every 2 s, then succeeds; still pending after 30 s it is returned (retryable)", async () => {
    const w = new FakeWorld();
    w.artifacts.repos.set(BASE_REPO, { main: MAIN_SHA, readOnly: true, source: HIVE, tokens: [] });
    const pending = { verdict: "refuse" as const, code: "BASE_PENDING" as const, message: "being created" };
    w.queen.intents = [pending, pending, acceptCreate({ base: { kind: "existing", baseRepo: BASE_REPO, baseSha: MAIN_SHA } })];
    const { s } = await worker(w);
    expect((await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" })).ok).toBe(true);
    expect(w.sleeps.slice(0, 2)).toEqual([2000, 2000]);

    const w2 = new FakeWorld();
    w2.queen.intents = [pending];
    const second = await worker(w2);
    expect(errOf(await run(w2, second.s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toMatchObject({ code: "BASE_PENDING" });
    expect(w2.sleeps).toEqual(Array(15).fill(2000));
  });

  it("a base fork that keeps failing reports attemptBaseFailed and is ARTIFACTS_UNAVAILABLE", async () => {
    const w = new FakeWorld();
    for (const n of [BASE_REPO, `${BASE_REPO}-r2`, `${BASE_REPO}-r3`]) w.artifacts.forkErrors.set(n, "INTERNAL_ERROR");
    const { s, agent } = await worker(w);
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toMatchObject({ code: "ARTIFACTS_UNAVAILABLE" });
    expect(w.queen.inputs("attemptBaseFailed")).toEqual([{ hive: HIVE, itemId: "item-1", baseRepo: BASE_REPO, attemptId: ATT, reason: expect.any(String) }]);
    expect(w.queen.methods()).not.toContain("attemptReady");
    expect((await w.identity(agent.agentId).attempts())[0]).toMatchObject({ open: false });
  });

  it("an attempt fork that stays sick is deleted, the attempt aborted, and the error carries the cf-ray", async () => {
    const w = new FakeWorld();
    for (const n of [ATT_REPO, `${ATT_REPO}-r2`, `${ATT_REPO}-r3`]) w.artifacts.sick.add(n);
    const { s } = await worker(w);
    const e = errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }));
    expect(e).toMatchObject({ code: "ARTIFACTS_UNAVAILABLE" });
    expect(e!.message).toContain("cf-ray 8f00ray");
    expect(w.artifacts.deleted).toEqual(expect.arrayContaining([ATT_REPO, `${ATT_REPO}-r2`, `${ATT_REPO}-r3`]));
    expect(w.queen.inputs("attemptAborted")).toEqual([{ hive: HIVE, attemptId: ATT, reason: expect.any(String) }]);
  });

  it("a Queen refusal at ready (BASE_MOVED) deletes the fork and aborts", async () => {
    const w = new FakeWorld();
    w.queen.readyRefusal = { ok: false, code: "BASE_MOVED", message: "moved" };
    const { s } = await worker(w);
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toMatchObject({ code: "BASE_MOVED" });
    expect(w.artifacts.deleted).toContain(ATT_REPO);
    expect(w.queen.methods()).toContain("attemptAborted");
  });

  it("refusals pass through (GOAL_AMBIGUOUS lists the items); exactly one of itemId / goalId", async () => {
    const w = new FakeWorld();
    w.queen.intents = [{ verdict: "refuse", code: "GOAL_AMBIGUOUS", message: "2 open items", items: [{ itemId: "a", title: "A", status: "READY" }, { itemId: "b", title: "B", status: "READY" }] }];
    const { s } = await worker(w);
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, goalId: "goal-1" }))).toEqual({ code: "GOAL_AMBIGUOUS", message: "2 open items", items: [{ itemId: "a", title: "A", status: "READY" }, { itemId: "b", title: "B", status: "READY" }] });
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "i", goalId: "g" }))).toMatchObject({ code: "INVALID_INPUT" });
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE }))).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("3 open attempts per agent (checked in AgentIdentity, terminal ones pruned)", async () => {
    const w = new FakeWorld();
    const { s, agent } = await worker(w);
    for (const id of ["att_000000000001", "att_000000000002", "att_000000000003"]) {
      await w.identity(agent.agentId).addAttempt({ hive: HIVE, attemptId: id });
      w.queen.views.set(id, viewOf({ attemptId: id, state: "PUSHED" }));
    }
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toMatchObject({ code: "CAP_EXCEEDED" });
    w.queen.views.set("att_000000000003", viewOf({ attemptId: "att_000000000003", state: "LOST" }));
    expect((await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" })).ok).toBe(true);
  });
});

describe("own-attempt tools", () => {
  async function started() {
    const w = new FakeWorld();
    const { s, agent } = await worker(w);
    value(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }));
    return { w, s, agent };
  }

  it("refresh_attempt mints a new token and revokes the fork's other tokens", async () => {
    const { w, s } = await started();
    const before = w.artifacts.activeTokens(ATT_REPO);
    const r = value<{ token: string; configCommand: string }>(await run(w, s, "refresh_attempt", { attemptId: ATT }));
    const after = w.artifacts.activeTokens(ATT_REPO);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    expect(r.configCommand).toContain(`Authorization: Bearer ${r.token}`);
  });

  it("an attempt that is not the agent's is FORBIDDEN_OWNER on get / refresh / end / verdict / wait", async () => {
    const { w } = await started();
    const { s: other } = await worker(w);
    for (const name of ["get_attempt", "refresh_attempt", "end_attempt", "get_verdict"]) expect(errOf(await run(w, other, name, { attemptId: ATT })), name).toMatchObject({ code: "FORBIDDEN_OWNER" });
    expect(errOf(await run(w, other, "wait", { attemptId: ATT, until: "verdict", timeoutMs: 0 }))).toMatchObject({ code: "FORBIDDEN_OWNER" });
  });

  it("wait: a timeout returns changed:false; a verdict returns changed:true; a terminal state carries the cleanup", async () => {
    const { w, s } = await started();
    w.queen.views.set(ATT, viewOf({ attemptId: ATT, state: "PUSHED" }));
    const timeout = value<Record<string, unknown>>(await run(w, s, "wait", { attemptId: ATT, until: "verdict", timeoutMs: 5000 }));
    expect(timeout).toMatchObject({ changed: false, state: "PUSHED" });
    expect(w.sleeps.filter((ms) => ms === 2000).length).toBeLessThanOrEqual(2);
    w.queen.views.set(ATT, viewOf({ attemptId: ATT, state: "REJECTED", verdict: "rejected" }));
    expect(value(await run(w, s, "wait", { attemptId: ATT, until: "verdict" }))).toMatchObject({ changed: true, state: "REJECTED" });
    w.queen.views.set(ATT, viewOf({ attemptId: ATT, state: "LOST" }));
    expect(value(await run(w, s, "wait", { attemptId: ATT, until: "landed" }))).toMatchObject({ changed: true, state: "LOST", attempt: { cleanup: `remove .queenos/attempts/${ATT}` } });
    expect(errOf(await run(w, s, "wait", { attemptId: ATT, until: "verdict", timeoutMs: 60_000 }))).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("get_verdict returns the verdict note of the head and the gate findings", async () => {
    const { w, s } = await started();
    const head = "c".repeat(40);
    w.queen.views.set(ATT, viewOf({ attemptId: ATT, state: "REJECTED", headSha: head, verdict: "rejected", train: { trainId: "train-1", phase: "EJECTED", raceOutcome: "FAILED", headSha: head, previewUrl: "https://p.dev", summary: "security: nope", reason: "failed: security: nope", score: null } }));
    w.queen.notes.set(head, "Queen-Verdict: REJECTED");
    expect(value(await run(w, s, "get_verdict", { attemptId: ATT }))).toEqual({ headSha: head, verdict: "rejected", findings: ["failed: security: nope"], summary: "security: nope", note: "Queen-Verdict: REJECTED", previewUrl: "https://p.dev" });
  });

  it("end_attempt returns the state and the cleanup, and closes the attempt in the agent's identity", async () => {
    const { w, s, agent } = await started();
    expect(value(await run(w, s, "end_attempt", { attemptId: ATT }))).toEqual({ state: "ABANDONED", cleanup: `remove .queenos/attempts/${ATT}` });
    expect((await w.identity(agent.agentId).attempts())[0]).toMatchObject({ open: false });
  });
});

describe("race tools", () => {
  it("pick maps the attempt to its current train; a terminal attempt is ATTEMPT_EXPIRED; a Queen 409 is CONFLICT", async () => {
    const w = new FakeWorld();
    const { s } = await worker(w);
    w.queen.views.set(ATT, viewOf({ attemptId: ATT, state: "PASSED", trainId: "train-7" }));
    expect(value(await run(w, s, "pick", { hive: HIVE, raceId: "race-1", attemptId: ATT }))).toMatchObject({ outcome: "applied" });
    expect(w.queen.inputs("pick")).toEqual([{ hive: HIVE, raceId: "race-1", user: OWNER, pick: { trainId: "train-7" } }]);
    w.queen.views.set(ATT, viewOf({ attemptId: ATT, state: "LOST" }));
    expect(errOf(await run(w, s, "pick", { hive: HIVE, raceId: "race-1", attemptId: ATT }))).toMatchObject({ code: "ATTEMPT_EXPIRED" });
    w.queen.errors.set("closeRaceEntries", new Error("CONFLICT: race race-1 is DECIDED"));
    expect(errOf(await run(w, s, "close_entries", { hive: HIVE, raceId: "race-1" }))).toEqual({ code: "CONFLICT", message: "race race-1 is DECIDED" });
  });
});
