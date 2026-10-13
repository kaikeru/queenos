import { describe, expect, it } from "vitest";
import type { McpAgentIdentity } from "@queenos/queen-types";
import { configCommand, setupCommand } from "../src/commands";
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
  it("has the 17 tools of spec §6", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      ["close_entries", "create_goal", "end_attempt", "get_attempt", "get_item", "get_verdict", "init_agent", "list_attempts", "list_hives", "list_items", "pick", "refresh_attempt", "resume_agent", "retry_gates", "start_attempt", "wait", "whoami"].sort(),
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
    const out = await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" });
    const r = value<Record<string, string | number>>(out);
    expect(w.artifacts.forks).toEqual([
      { name: BASE_REPO, source: HIVE, readOnly: true },
      { name: ATT_REPO, source: BASE_REPO, readOnly: false },
    ]);
    expect(w.queen.inputs("attemptBaseReady")).toEqual([{ hive: HIVE, itemId: "item-1", baseRepo: BASE_REPO, baseSha: MAIN_SHA }]);
    expect(w.queen.inputs("attemptReady")).toEqual([{ hive: HIVE, attemptId: ATT, repo: ATT_REPO, baseSha: MAIN_SHA, expiresAt: expect.any(Number) }]);
    expect(w.queen.inputs("attemptIntent")[0]).toEqual({ hive: HIVE, owner: OWNER, agent, target: { itemId: "item-1" } });
    expect(r).toMatchObject({ attemptId: ATT, itemId: "item-1", remote: REMOTE(ATT_REPO), baseSha: MAIN_SHA, dir: `.queenos/attempts/${ATT}` });
    expect(r).not.toHaveProperty("token");
    expect(r).not.toHaveProperty("cloneCommand");
    expect(r).not.toHaveProperty("configCommand");
    expect(r.expiresAt).toEqual(expect.any(Number));
    const token = /Bearer (art_v1_[^']+)'/.exec(String(r.setupCommand))![1]!;
    expect(String(r.remote)).not.toContain("art_v1");
    const dir = `.queenos/attempts/${ATT}`;
    expect(r.setupCommand).toBe(
      [
        `git init '${dir}'`,
        `git -C '${dir}' config --local --replace-all 'http.${REMOTE(ATT_REPO)}.extraHeader' 'Authorization: Bearer ${token}'`,
        `git -C '${dir}' remote add origin '${REMOTE(ATT_REPO)}'`,
        `git -C '${dir}' fetch origin main`,
        `git -C '${dir}' checkout -b main FETCH_HEAD`,
      ].join(" && "),
    );
    // The token appears exactly once in the whole result, and never in a URL.
    expect(JSON.stringify(r).split(token)).toHaveLength(2);
    expect(String(r.setupCommand)).not.toMatch(/https:\/\/[^ ]*art_v1/);
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
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, goalId: "goal-1" }))).toEqual({ code: "GOAL_AMBIGUOUS", message: "2 open items", retryable: false, items: [{ itemId: "a", title: "A", status: "READY" }, { itemId: "b", title: "B", status: "READY" }] });
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
    const r = value<{ expiresAt: number; configCommand: string }>(await run(w, s, "refresh_attempt", { attemptId: ATT }));
    const after = w.artifacts.activeTokens(ATT_REPO);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    expect(r).not.toHaveProperty("token");
    expect(r.expiresAt).toEqual(expect.any(Number));
    const token = /Bearer (art_v1_[^']+)'/.exec(r.configCommand)![1]!;
    expect(r.configCommand).toBe(`git -C '.queenos/attempts/${ATT}' config --local --replace-all 'http.${REMOTE(ATT_REPO)}.extraHeader' 'Authorization: Bearer ${token}'`);
    expect(JSON.stringify(r).split(token)).toHaveLength(2);
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
    expect(value(await run(w, s, "get_verdict", { attemptId: ATT }))).toEqual({ headSha: head, verdict: "rejected", kind: null, findings: ["failed: security: nope"], summary: "security: nope", note: "Queen-Verdict: REJECTED", previewUrl: "https://p.dev", regating: null, next: null });
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
    expect(errOf(await run(w, s, "close_entries", { hive: HIVE, raceId: "race-1" }))).toEqual({ code: "CONFLICT", message: "race race-1 is DECIDED", retryable: false });
  });
});

describe("fix round 1", () => {
  it("start_attempt: attemptBaseReady CONFLICT deletes the new base and is CONFLICT, not ARTIFACTS_UNAVAILABLE", async () => {
    const w = new FakeWorld();
    w.queen.errors.set("attemptBaseReady", new Error("CONFLICT: base watchdog cleared"));
    const { s, agent } = await worker(w);
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toMatchObject({ code: "CONFLICT" });
    expect(w.artifacts.deleted).toContain(BASE_REPO);
    expect(w.artifacts.repos.has(BASE_REPO)).toBe(false);
    expect(w.queen.inputs("attemptBaseReady")).toHaveLength(1);
    expect(w.queen.methods()).not.toContain("attemptsForItem");
    expect((await w.identity(agent.agentId).attempts())[0]).toMatchObject({ open: false });
  });

  it("start_attempt: a Queen throw from attemptReady maps through fromQueen; the fork is deleted and the attempt aborted", async () => {
    const w = new FakeWorld();
    w.queen.errors.set("attemptReady", new Error("NOT_FOUND: attempt gone"));
    const { s } = await worker(w);
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toEqual({ code: "NOT_FOUND", message: "attempt gone", retryable: false });
    expect(w.artifacts.deleted).toContain(ATT_REPO);
    expect(w.queen.methods()).toContain("attemptAborted");
  });

  it("the race base never gets a token", async () => {
    const w = new FakeWorld();
    const { s } = await worker(w);
    value(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }));
    expect(w.artifacts.repos.has(BASE_REPO)).toBe(true);
    expect(w.artifacts.activeTokens(BASE_REPO)).toEqual([]);
  });

  it("an unknown Queen error gives the generic message, no detail or stack", async () => {
    const w = new FakeWorld();
    const { s } = await worker(w);
    w.queen.errors.set("getSnapshot", new Error("secret internal detail at /x/y.ts:1"));
    const e = errOf(await run(w, s, "list_items", { hive: HIVE }));
    expect(e).toEqual({ code: "UNAVAILABLE", message: "the hive is temporarily unavailable; retry", retryable: true, retryAfterMs: 2000 });
  });

  it("every gated tool is NOT_INITIALIZED before init_agent", async () => {
    const w = new FakeWorld();
    const args: Record<string, unknown> = {
      create_goal: { hive: HIVE, title: "t", description: "d" },
      list_items: { hive: HIVE },
      get_item: { hive: HIVE, itemId: "item-1" },
      start_attempt: { hive: HIVE, itemId: "item-1" },
      refresh_attempt: { attemptId: ATT },
      end_attempt: { attemptId: ATT },
      get_attempt: { attemptId: ATT },
      wait: { attemptId: ATT, until: "verdict", timeoutMs: 0 },
      get_verdict: { attemptId: ATT },
      close_entries: { hive: HIVE, raceId: "r" },
      pick: { hive: HIVE, raceId: "r", attemptId: ATT },
      retry_gates: { attemptId: ATT },
    };
    for (const t of TOOLS.filter((x) => !["whoami", "init_agent", "resume_agent"].includes(x.name))) {
      expect(errOf(await run(w, new FakeSession(), t.name, args[t.name] ?? {})), t.name).toMatchObject({ code: "NOT_INITIALIZED" });
    }
  });

  it("wait by itemId: verdict / decided / landed, and the changed:false timeout", async () => {
    const w = new FakeWorld();
    const { s } = await worker(w);
    const detail = (status: string, raceState?: string) => {
      w.queen.getItemDetail = async () => ({ item: { itemId: "item-1", status, waitReason: null }, children: [], trains: [], races: raceState ? [{ raceId: "race-1", state: raceState, trainIds: ["train-1"], winnerTrainId: null }] : [], release: null, escalations: [] }) as never;
    };
    const verdict = (v: "none" | "passed" | "rejected") => {
      w.queen.attemptsForItem = async (itemId: string) => ({ itemId, baseSha: MAIN_SHA, basePending: false, attempts: [viewOf({ attemptId: ATT, verdict: v })] });
    };
    const go = async (until: string) => value<Record<string, unknown>>(await run(w, s, "wait", { hive: HIVE, itemId: "item-1", until, timeoutMs: 2000 }));
    detail("READY");
    verdict("none");
    for (const u of ["verdict", "decided", "landed"]) expect(await go(u), u).toMatchObject({ changed: false });
    verdict("passed");
    expect(await go("verdict")).toMatchObject({ changed: true });
    expect(await go("decided")).toMatchObject({ changed: false });
    detail("READY", "DECIDED");
    expect(await go("decided")).toMatchObject({ changed: true, item: { race: { raceId: "race-1", state: "DECIDED" } } });
    expect(await go("landed")).toMatchObject({ changed: false });
    detail("LANDED");
    expect(await go("landed")).toMatchObject({ changed: true, state: "LANDED" });
  });
});

const REJ = (over: Record<string, unknown> = {}) => viewOf({ attemptId: ATT, state: "REJECTED", headSha: "c".repeat(40), verdict: "rejected", ...over } as never);

describe("batch B: retryable errors", () => {
  it("every code carries retryable from MCP_ERROR_RETRYABLE; a retryAfterMs makes it retryable and is propagated", async () => {
    const w = new FakeWorld();
    const { s } = await worker(w);
    // not initialised / forbidden / invalid / not found
    expect(errOf(await run(w, new FakeSession(), "list_hives"))).toMatchObject({ code: "NOT_INITIALIZED", retryable: false });
    expect(errOf(await run(w, s, "get_attempt", { attemptId: ATT }))).toMatchObject({ code: "FORBIDDEN_OWNER", retryable: false });
    expect(errOf(await run(w, s, "get_attempt", {}))).toMatchObject({ code: "INVALID_INPUT", retryable: false });
    expect(errOf(await run(w, s, "list_items", { hive: "nope" }))).toMatchObject({ code: "NOT_FOUND", retryable: false });
    // Queen refusals at intent
    const refuse = (code: "CAP_EXCEEDED" | "BASE_PENDING" | "ITEM_NOT_ACCEPTING", retryAfterMs?: number) => {
      w.queen.intents = [{ verdict: "refuse", code, message: "no", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }];
    };
    refuse("CAP_EXCEEDED");
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toEqual({ code: "CAP_EXCEEDED", message: "no", retryable: false });
    refuse("CAP_EXCEEDED", 90_000);
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toEqual({ code: "CAP_EXCEEDED", message: "no", retryable: true, retryAfterMs: 90_000 });
    refuse("ITEM_NOT_ACCEPTING");
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toMatchObject({ code: "ITEM_NOT_ACCEPTING", retryable: false });
    refuse("BASE_PENDING");
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toMatchObject({ code: "BASE_PENDING", retryable: true, retryAfterMs: 2000 });
    // attemptReady refusal keeps its retryAfterMs
    w.queen.intents = [acceptCreate()];
    w.queen.readyRefusal = { ok: false, code: "BASE_MOVED", message: "moved", retryAfterMs: 1500 };
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toMatchObject({ code: "BASE_MOVED", retryable: true, retryAfterMs: 1500 });
  });

  it("ARTIFACTS_UNAVAILABLE is retryable after 5 s; an unknown or UNAVAILABLE Queen error is UNAVAILABLE, not CONFLICT", async () => {
    const w = new FakeWorld();
    w.artifacts.forkErrors.set(BASE_REPO, "INTERNAL");
    const { s } = await worker(w);
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toMatchObject({ code: "ARTIFACTS_UNAVAILABLE", retryable: true, retryAfterMs: 5000 });
    w.queen.errors.set("getSnapshot", new Error("UNAVAILABLE: queen restarting"));
    expect(errOf(await run(w, s, "list_items", { hive: HIVE }))).toMatchObject({ code: "UNAVAILABLE", retryable: true, retryAfterMs: 2000 });
  });
});

describe("batch B: verdict kind", () => {
  async function withAttempt() {
    const w = new FakeWorld();
    const { s } = await worker(w);
    value(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }));
    return { w, s };
  }

  it("get_verdict: findings kind lists the note's Queen-Finding lines and says fix and push", async () => {
    const { w, s } = await withAttempt();
    const head = "c".repeat(40);
    w.queen.views.set(ATT, REJ({ verdictKind: "findings", train: { trainId: "train-1", phase: "EJECTED", raceOutcome: "FAILED", headSha: head, previewUrl: null, summary: "s", reason: "failed: x", score: null } }));
    w.queen.notes.set(head, 'Queen-Verdict: REJECTED\nQueen-Finding: error src/a.js:3 bad fetch\nQueen-Finding: warn src/b.js nit');
    expect(value(await run(w, s, "get_verdict", { attemptId: ATT }))).toMatchObject({ kind: "findings", findings: ["error src/a.js:3 bad fetch", "warn src/b.js nit"], next: "fix and push", regating: null });
  });

  it("get_verdict: infra kind has no findings and says retry_gates; regating passes through", async () => {
    const { w, s } = await withAttempt();
    w.queen.views.set(ATT, REJ({ verdictKind: "infra", train: { trainId: "train-1", phase: "EJECTED", raceOutcome: "FAILED", headSha: "c".repeat(40), previewUrl: null, summary: "Infrastructure: x", reason: "boom", score: null } }));
    expect(value(await run(w, s, "get_verdict", { attemptId: ATT }))).toMatchObject({ kind: "infra", findings: [], next: "retry_gates" });
    w.queen.views.set(ATT, viewOf({ attemptId: ATT, state: "PUSHED", headSha: "d".repeat(40), regating: { round: 1, of: 3, notBefore: 5 } }));
    expect(value(await run(w, s, "get_verdict", { attemptId: ATT }))).toMatchObject({ kind: null, regating: { round: 1, of: 3, notBefore: 5 }, next: null });
  });

  it("get_attempt reads the new view fields as null on an older Queen and passes them on a newer one", async () => {
    const { w, s } = await withAttempt();
    w.queen.views.set(ATT, viewOf({ attemptId: ATT, state: "PUSHED" }));
    expect(value(await run(w, s, "get_attempt", { attemptId: ATT }))).toMatchObject({ verdictKind: null, regating: null });
    w.queen.views.set(ATT, REJ({ verdictKind: "infra" }));
    expect(value(await run(w, s, "get_attempt", { attemptId: ATT }))).toMatchObject({ verdictKind: "infra" });
  });
});

describe("batch B: retry_gates", () => {
  async function withAttempt() {
    const w = new FakeWorld();
    const { s } = await worker(w);
    value(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }));
    return { w, s };
  }

  it("re-gates through the Queen with the agent's owner and id", async () => {
    const { w, s } = await withAttempt();
    w.queen.regate = (i) => ({ ok: true, changed: true, attempt: viewOf({ attemptId: i.attemptId, state: "PUSHED", trainId: "train-9" }) });
    expect(value(await run(w, s, "retry_gates", { attemptId: ATT }))).toEqual({ changed: true, state: "PUSHED", trainId: "train-9", race: null });
    expect(w.queen.inputs("attemptRegate")).toEqual([{ hive: HIVE, attemptId: ATT, owner: OWNER, agentId: expect.stringMatching(/^ag_/) }]);
  });

  it("a Queen refusal keeps code and retryAfterMs; CAP_EXCEEDED with a wait is retryable", async () => {
    const { w, s } = await withAttempt();
    w.queen.regate = () => ({ ok: false, code: "CAP_EXCEEDED", message: "one a minute", retryAfterMs: 42_000 });
    expect(errOf(await run(w, s, "retry_gates", { attemptId: ATT }))).toEqual({ code: "CAP_EXCEEDED", message: "one a minute", retryable: true, retryAfterMs: 42_000 });
    w.queen.regate = () => ({ ok: false, code: "CONFLICT", message: "push a fix" });
    expect(errOf(await run(w, s, "retry_gates", { attemptId: ATT }))).toMatchObject({ code: "CONFLICT", retryable: false });
    w.queen.regate = () => ({ ok: false, code: "ITEM_NOT_ACCEPTING", message: "decided without this head" });
    expect(errOf(await run(w, s, "retry_gates", { attemptId: ATT }))).toEqual({ code: "ITEM_NOT_ACCEPTING", message: "decided without this head", retryable: false });
  });

  it("someone else's attempt is FORBIDDEN_OWNER; a Queen without the RPC is UNAVAILABLE, not retryable", async () => {
    const { w, s } = await withAttempt();
    const { s: other } = await worker(w);
    expect(errOf(await run(w, other, "retry_gates", { attemptId: ATT }))).toMatchObject({ code: "FORBIDDEN_OWNER" });
    expect(errOf(await run(w, s, "retry_gates", { attemptId: ATT }))).toEqual({ code: "UNAVAILABLE", message: "retry_gates needs a newer Queen", retryable: false });
  });
});

describe("batch B: requireHive", () => {
  it("get_item, wait by item, close_entries and pick answer NOT_FOUND for an unknown hive without touching the Queen", async () => {
    const w = new FakeWorld();
    const { s } = await worker(w);
    const before = w.queen.calls.length;
    for (const [name, args] of [
      ["get_item", { hive: "nope", itemId: "item-1" }],
      ["wait", { hive: "nope", itemId: "item-1", until: "verdict", timeoutMs: 0 }],
      ["close_entries", { hive: "nope", raceId: "r" }],
      ["pick", { hive: "nope", raceId: "r", attemptId: ATT }],
    ] as const) {
      expect(errOf(await run(w, s, name, args)), name).toMatchObject({ code: "NOT_FOUND", message: "hive nope not found" });
    }
    expect(w.queen.calls.length).toBe(before);
  });
});

describe("batch B: happy-path reads", () => {
  it("list_items filters by state; get_item shows the race with candidate kinds; list_attempts and get_attempt", async () => {
    const w = new FakeWorld();
    const { s } = await worker(w);
    w.queen.items = [
      { itemId: "i1", title: "A", kind: "TASK", status: "READY", waitReason: "awaiting submissions", parentId: null },
      { itemId: "i2", title: "B", kind: "TASK", status: "LANDED", parentId: "g" },
    ] as never;
    expect(value<unknown[]>(await run(w, s, "list_items", { hive: HIVE }))).toEqual([
      { itemId: "i1", title: "A", kind: "TASK", status: "READY", waitReason: "awaiting submissions", parentId: null },
      { itemId: "i2", title: "B", kind: "TASK", status: "LANDED", waitReason: null, parentId: "g" },
    ]);
    expect(value<unknown[]>(await run(w, s, "list_items", { hive: HIVE, state: "LANDED" }))).toHaveLength(1);

    const started = value(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }));
    expect(started).toMatchObject({ attemptId: ATT });
    w.queen.views.set(ATT, REJ({ verdictKind: "infra", train: { trainId: "train-1", phase: "EJECTED", raceOutcome: "FAILED", headSha: null, previewUrl: "https://p.dev", summary: null, reason: null, score: null } }));
    w.queen.getItemDetail = async (itemId: string) =>
      ({ item: { itemId, status: "READY" }, children: [], trains: [], races: [{ raceId: "race-1", state: "RACING", trainIds: ["train-1"], entryClosesAt: 77, winnerTrainId: null }], release: null, escalations: [] }) as never;
    expect(value(await run(w, s, "get_item", { hive: HIVE, itemId: "item-1" }))).toMatchObject({
      race: { raceId: "race-1", state: "RACING", baseSha: MAIN_SHA, entryClosesAt: 77, candidates: [{ attemptId: ATT, agent: "opus", claimedModel: "claude-opus-5-5", verdict: "rejected", kind: "infra", previewUrl: "https://p.dev" }] },
    });

    const list = value<{ attemptId: string }[]>(await run(w, s, "list_attempts"));
    expect(list.map((a) => a.attemptId)).toEqual([ATT]);
    expect(value(await run(w, s, "get_attempt", { attemptId: ATT }))).toMatchObject({ attemptId: ATT, state: "REJECTED", verdictKind: "infra", regating: null });
    w.queen.views.set(ATT, viewOf({ attemptId: ATT, state: "LOST" }));
    expect(value(await run(w, s, "get_attempt", { attemptId: ATT }))).toMatchObject({ cleanup: `remove .queenos/attempts/${ATT}` });
  });
});

describe("batch B: I4 base pin after a transport throw", () => {
  it("attemptBaseReady throws once, the retry answers (duplicate): the pinned base is kept and the attempt continues", async () => {
    const w = new FakeWorld();
    const real = w.queen.attemptBaseReady.bind(w.queen);
    let n = 0;
    w.queen.attemptBaseReady = async (i) => {
      await real(i);
      if (++n === 1) throw new Error("Network connection lost");
      return { outcome: "ignored:duplicate" };
    };
    const { s } = await worker(w);
    expect((await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" })).ok).toBe(true);
    expect(n).toBe(2);
    expect(w.artifacts.deleted).not.toContain(BASE_REPO);
    expect(w.queen.methods()).not.toContain("attemptBaseFailed");
    expect(w.artifacts.forks.map((f) => f.name)).toEqual([BASE_REPO, ATT_REPO]);
  });

  it("a definite Queen refusal on the retry deletes the base", async () => {
    const w = new FakeWorld();
    let n = 0;
    w.queen.attemptBaseReady = async () => {
      throw new Error(++n === 1 ? "Network connection lost" : "CONFLICT: base watchdog cleared");
    };
    const { s } = await worker(w);
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toMatchObject({ code: "CONFLICT" });
    expect(w.artifacts.deleted).toContain(BASE_REPO);
  });

  it("two transport throws: the base is NOT deleted, the attempt is closed, the error is UNAVAILABLE and retryable", async () => {
    const w = new FakeWorld();
    w.queen.errors.set("attemptBaseReady", new Error("Network connection lost"));
    const { s, agent } = await worker(w);
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(w.queen.inputs("attemptBaseReady")).toHaveLength(2);
    expect(w.artifacts.deleted).not.toContain(BASE_REPO);
    expect(w.queen.methods()).toContain("attemptBaseFailed");
    expect((await w.identity(agent.agentId).attempts())[0]).toMatchObject({ open: false });
  });
});

describe("batch B: shell-safe commands", () => {
  it("a hostile remote or token is refused (ARTIFACTS_UNAVAILABLE), never interpolated", async () => {
    const w = new FakeWorld();
    const { s } = await worker(w);
    const real = w.artifacts.get.bind(w.artifacts);
    w.artifacts.get = async (name: string) => ({ ...(await real(name)), info: async () => ({ remote: "https://x.test/a'; rm -rf ~ #" }) });
    expect(errOf(await run(w, s, "start_attempt", { hive: HIVE, itemId: "item-1" }))).toMatchObject({ code: "ARTIFACTS_UNAVAILABLE", retryable: true });
    expect(w.artifacts.deleted).toContain(ATT_REPO);
  });

  it("a hostile token is refused too", () => {
    expect(() => setupCommand(REMOTE(ATT_REPO), "tok'; rm -rf ~ #", "d")).toThrow(/unexpected remote or token/);
    expect(() => configCommand(REMOTE(ATT_REPO), "ok_token?expires=1", "d")).not.toThrow();
  });
});
