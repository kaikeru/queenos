import { describe, expect, it } from "vitest";
import {
  ATTEMPT_REPO_RE,
  ATTEMPT_TOKEN_TTL_S,
  AgentIdSchema,
  AttemptBaseFailedSchema,
  AttemptIdSchema,
  AttemptIntentDecisionSchema,
  AttemptIntentSchema,
  AttemptPushedSchema,
  AttemptReadySchema,
  AttemptResultSchema,
  AttemptSchema,
  AttemptViewSchema,
  AttemptRegateSchema,
  AttemptVerdictKindSchema,
  BASE_PENDING_MAX_WAIT_MS,
  GateCommandSchema,
  MCP_ERROR_RETRYABLE,
  BASE_PENDING_POLL_MS,
  BASE_REPO_RE,
  EventTypeSchema,
  MAX_OPEN_ATTEMPTS_PER_AGENT,
  McpAgentIdentitySchema,
  McpErrorCodeSchema,
  McpToolErrorSchema,
  MergeTrainSchema,
  SubmitPromptSchema,
  WAIT_MAX_MS,
  WorkItemSchema,
  attemptRepoName,
  baseRepoName,
  isTerminalAttemptState,
  parseAttemptRepo,
  parseBaseRepo,
} from "./index.js";

const AG = `ag_${"a".repeat(32)}`;
const ATT = "att_0123456789ab";
const SHA = "c".repeat(40);
const identity = { agentId: AG, name: "opus", model: "claude-opus-5-5", role: "worker" as const, owner: "ada@kaikeru.com" };
const attempt = {
  attemptId: ATT, hive: "demo", itemId: "i1", raceId: null, trainId: "t1", repo: "demo-att-0123456789ab", baseSha: SHA,
  agentId: AG, agentName: "opus", model: "claude-opus-5-5", role: "worker" as const, owner: "ada@kaikeru.com",
  state: "READY" as const, headSha: null, createdAt: 1, expiresAt: 2,
};

describe("attempt ids and constants", () => {
  it("ids are att_<12 hex> and ag_<32 hex>", () => {
    expect(AttemptIdSchema.safeParse(ATT).success).toBe(true);
    expect(AttemptIdSchema.safeParse("att_0123456789AB").success).toBe(false);
    expect(AttemptIdSchema.safeParse("att_0123456789a").success).toBe(false);
    expect(AgentIdSchema.safeParse(AG).success).toBe(true);
    expect(AgentIdSchema.safeParse(`ag_${"a".repeat(31)}`).success).toBe(false);
  });

  it("constants match the spec", () => {
    expect([ATTEMPT_TOKEN_TTL_S, MAX_OPEN_ATTEMPTS_PER_AGENT, WAIT_MAX_MS, BASE_PENDING_POLL_MS, BASE_PENDING_MAX_WAIT_MS]).toEqual([7200, 3, 50_000, 2_000, 30_000]);
  });

  it("terminal states", () => {
    for (const s of ["LOST", "LANDED", "ABANDONED", "EXPIRED", "ABORTED"] as const) expect(isTerminalAttemptState(s)).toBe(true);
    for (const s of ["INTENT", "READY", "PUSHED", "PASSED", "REJECTED", "WON"] as const) expect(isTerminalAttemptState(s)).toBe(false);
  });
});

describe("repo names", () => {
  it("attemptRepoName and ATTEMPT_REPO_RE round-trip, with the -rN re-fork suffix", () => {
    expect(attemptRepoName("demo", ATT)).toBe("demo-att-0123456789ab");
    expect(parseAttemptRepo("demo-att-0123456789ab")).toEqual({ hive: "demo", attemptId: ATT });
    expect(parseAttemptRepo("my-hive-att-0123456789ab-r2")).toEqual({ hive: "my-hive", attemptId: ATT });
    expect(parseAttemptRepo("demo-att-0123456789ab-rx")).toBeNull();
    expect(parseAttemptRepo("demo-train-0123456789ab")).toBeNull();
  });

  it("baseRepoName and BASE_REPO_RE round-trip, with -rN", () => {
    expect(baseRepoName("demo", "0123456789ab")).toBe("demo-base-0123456789ab");
    expect(parseBaseRepo("demo-base-0123456789ab")).toEqual({ hive: "demo", baseId: "0123456789ab" });
    expect(parseBaseRepo("demo-base-0123456789ab-r3")).toEqual({ hive: "demo", baseId: "0123456789ab" });
    expect(parseBaseRepo("demo-base-0123")).toBeNull();
  });

  it("the attempt and base patterns never match each other's names", () => {
    for (const base of ["demo-base-0123456789ab", "demo-base-0123456789ab-r2", "x-att-0123456789ab-base-0123456789ab"]) expect(ATTEMPT_REPO_RE.test(base), base).toBe(false);
    for (const att of ["demo-att-0123456789ab", "demo-att-0123456789ab-r2", "x-base-0123456789ab-att-0123456789ab"]) expect(BASE_REPO_RE.test(att), att).toBe(false);
  });
});

describe("attempt schemas", () => {
  it("identity, intent (exactly one target), decision", () => {
    expect(McpAgentIdentitySchema.parse(identity)).toEqual(identity);
    expect(McpAgentIdentitySchema.safeParse({ ...identity, role: "boss" }).success).toBe(false);
    expect(McpAgentIdentitySchema.safeParse({ ...identity, name: "../x" }).success).toBe(false);
    const intent = { hive: "demo", owner: "ada@kaikeru.com", agent: identity };
    expect(AttemptIntentSchema.safeParse({ ...intent, target: { itemId: "i1" } }).success).toBe(true);
    expect(AttemptIntentSchema.safeParse({ ...intent, target: { goalId: "g1" } }).success).toBe(true);
    expect(AttemptIntentSchema.safeParse({ ...intent, target: { itemId: "i1", goalId: "g1" } }).success).toBe(false);
    expect(AttemptIntentSchema.safeParse({ ...intent, target: {} }).success).toBe(false);
    const accept = { verdict: "accept", attemptId: ATT, trainId: "t1", repo: "demo-att-0123456789ab", itemId: "i1", raceId: null, expiresAt: 5, base: { kind: "create", baseRepo: "demo-base-0123456789ab" } };
    expect(AttemptIntentDecisionSchema.parse(accept)).toEqual(accept);
    expect(AttemptIntentDecisionSchema.safeParse({ ...accept, base: { kind: "existing", baseRepo: "demo-base-0123456789ab" } }).success).toBe(false); // existing needs baseSha
    expect(AttemptIntentDecisionSchema.parse({ verdict: "refuse", code: "BASE_PENDING", message: "retry" })).toMatchObject({ code: "BASE_PENDING" });
    expect(AttemptIntentDecisionSchema.safeParse({ verdict: "refuse", code: "NOT_INITIALIZED", message: "x" }).success).toBe(false); // not a Queen code
  });

  it("ready / base-failed / pushed", () => {
    expect(AttemptReadySchema.safeParse({ hive: "demo", attemptId: ATT, repo: "demo-att-0123456789ab-r2", baseSha: SHA, expiresAt: 9 }).success).toBe(true);
    expect(AttemptReadySchema.safeParse({ hive: "demo", attemptId: ATT, repo: "r", baseSha: "nope", expiresAt: 9 }).success).toBe(false);
    expect(AttemptBaseFailedSchema.safeParse({ hive: "demo", itemId: "i1", baseRepo: "demo-base-0123456789ab", reason: "x".repeat(201) }).success).toBe(false);
    expect(AttemptBaseFailedSchema.parse({ hive: "demo", itemId: "i1", baseRepo: "b", reason: "503", attemptId: ATT })).toMatchObject({ attemptId: ATT });
    const pushed = { hive: "demo", attemptId: ATT, repo: "demo-att-0123456789ab", after: SHA, title: "Add a tip jar", message: "Add a tip jar\n\nbody" };
    expect(AttemptPushedSchema.parse(pushed)).toEqual(pushed);
    expect(AttemptPushedSchema.safeParse({ ...pushed, title: "x".repeat(121) }).success).toBe(false);
  });

  it("attempt row, view and RPC results", () => {
    expect(AttemptSchema.parse(attempt)).toEqual(attempt);
    const view = { ...attempt, train: null, race: null, verdict: "none" as const };
    expect(AttemptViewSchema.parse(view)).toEqual(view);
    expect(AttemptResultSchema.parse({ ok: true, attempt: view, changed: false })).toMatchObject({ ok: true });
    expect(AttemptResultSchema.parse({ ok: false, code: "ATTEMPT_EXPIRED", message: "gone" })).toMatchObject({ ok: false });
  });

  it("MCP error codes are the spec's §11 table; a tool error body is {code, message <= 200}", () => {
    expect(McpErrorCodeSchema.options).toEqual([
      "NOT_INITIALIZED", "ALREADY_INITIALIZED", "FORBIDDEN_ROLE", "FORBIDDEN_OWNER", "HIVE_NOT_EXTERNAL", "NOT_FOUND", "INVALID_INPUT",
      "ITEM_NOT_ACCEPTING", "GOAL_AMBIGUOUS", "CAP_EXCEEDED", "BASE_PENDING", "BASE_MOVED", "ARTIFACTS_UNAVAILABLE", "ATTEMPT_EXPIRED", "CONFLICT",
      "UNAVAILABLE",
    ]);
    expect(McpToolErrorSchema.safeParse({ code: "CONFLICT", message: "x".repeat(201), retryable: false }).success).toBe(false);
  });
});

describe("additive fields on existing contracts", () => {
  it("SubmitPrompt.entryWindowMs is optional, 0..1 h", () => {
    expect(SubmitPromptSchema.parse({ namespace: "demo", promptText: "x", entryWindowMs: 60_000 }).entryWindowMs).toBe(60_000);
    expect(SubmitPromptSchema.parse({ namespace: "demo", promptText: "x" })).not.toHaveProperty("entryWindowMs");
    expect(SubmitPromptSchema.safeParse({ namespace: "demo", promptText: "x", entryWindowMs: 3_600_001 }).success).toBe(false);
  });

  it("MergeTrain.attemptId and WorkItem.entryWindowMs are optional", () => {
    const train = { trainId: "t", baseSha: "b", includedPrompts: [], artifactRepo: "r", status: "BUILDING", createdAt: 1 };
    expect(MergeTrainSchema.parse({ ...train, attemptId: ATT })).toMatchObject({ attemptId: ATT });
    expect(MergeTrainSchema.parse(train)).not.toHaveProperty("attemptId");
    expect(WorkItemSchema.shape.entryWindowMs.safeParse(undefined).success).toBe(true);
    expect(WorkItemSchema.shape.entryWindowMs.safeParse(3_600_001).success).toBe(false);
  });

  it("attempt event types exist", () => {
    expect(EventTypeSchema.options).toEqual(expect.arrayContaining(["attempt.intent", "attempt.state", "attempt.base"]));
  });
});

describe("fix wave: the retryable contract, verdict kind, regate, gate notBefore", () => {
  it("every code has a retryable default: only BASE_PENDING, BASE_MOVED, ARTIFACTS_UNAVAILABLE and UNAVAILABLE", () => {
    expect(Object.keys(MCP_ERROR_RETRYABLE).sort()).toEqual([...McpErrorCodeSchema.options].sort());
    expect(McpErrorCodeSchema.options.filter((c) => MCP_ERROR_RETRYABLE[c]).sort()).toEqual(["ARTIFACTS_UNAVAILABLE", "BASE_MOVED", "BASE_PENDING", "UNAVAILABLE"]);
  });

  it("a tool error body is {code, message, retryable, retryAfterMs?, items?}", () => {
    expect(McpToolErrorSchema.parse({ code: "UNAVAILABLE", message: "retry", retryable: true, retryAfterMs: 2000 })).toEqual({ code: "UNAVAILABLE", message: "retry", retryable: true, retryAfterMs: 2000 });
    expect(McpToolErrorSchema.safeParse({ code: "CONFLICT", message: "x" }).success).toBe(false); // retryable is required
    expect(McpToolErrorSchema.safeParse({ code: "CAP_EXCEEDED", message: "x", retryable: true, retryAfterMs: 3_600_001 }).success).toBe(false);
    expect(McpToolErrorSchema.parse({ code: "GOAL_AMBIGUOUS", message: "x", retryable: false, items: [{ itemId: "a", title: "A", status: "READY" }] }).items).toHaveLength(1);
  });

  it("Queen refusals may carry retryAfterMs (old peers omit it); CONFLICT is a refusal code (attemptRegate)", () => {
    expect(AttemptIntentDecisionSchema.parse({ verdict: "refuse", code: "CAP_EXCEEDED", message: "hourly", retryAfterMs: 60_000 })).toMatchObject({ retryAfterMs: 60_000 });
    expect(AttemptIntentDecisionSchema.parse({ verdict: "refuse", code: "CAP_EXCEEDED", message: "hourly" })).not.toHaveProperty("retryAfterMs");
    expect(AttemptResultSchema.parse({ ok: false, code: "CONFLICT", message: "push first", retryAfterMs: 1 })).toMatchObject({ code: "CONFLICT", retryAfterMs: 1 });
    expect(AttemptResultSchema.safeParse({ ok: false, code: "CAP_EXCEEDED", message: "x", retryAfterMs: -1 }).success).toBe(false);
    expect(AttemptRegateSchema.parse({ hive: "demo", attemptId: ATT, owner: "ada@kaikeru.com", agentId: AG })).toMatchObject({ attemptId: ATT });
  });

  it("the view carries verdictKind, regating and the train's gateInfraRounds (optional for older peers)", () => {
    expect(AttemptVerdictKindSchema.options).toEqual(["findings", "infra"]);
    const train = { trainId: "t1", phase: "TESTING", raceOutcome: "RACING", headSha: SHA, previewUrl: null, summary: null, reason: null, score: null };
    const view = { ...attempt, state: "PUSHED" as const, train: { ...train, gateInfraRounds: 2 }, race: null, verdict: "pending" as const, verdictKind: null, regating: { round: 2, of: 3, notBefore: 99 } };
    expect(AttemptViewSchema.parse(view)).toEqual(view);
    const old = { ...attempt, train, race: null, verdict: "none" as const };
    expect(AttemptViewSchema.parse(old)).toEqual(old);
    expect(AttemptViewSchema.safeParse({ ...view, verdictKind: "flaky" }).success).toBe(false);
    expect(AttemptSchema.parse({ ...attempt, regates: 1, lastRegateAt: 5 })).toMatchObject({ regates: 1, lastRegateAt: 5 });
  });

  it("GateCommand.notBefore is optional epoch ms", () => {
    const cmd = { kind: "gate", commandId: "gate-r-h-q3", trace: { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` }, hive: "demo", trainId: "t1", repo: "r", branch: "main", after: SHA };
    expect(GateCommandSchema.parse(cmd)).not.toHaveProperty("notBefore");
    expect(GateCommandSchema.parse({ ...cmd, notBefore: 1_700_000_000_000 })).toMatchObject({ notBefore: 1_700_000_000_000 });
    expect(GateCommandSchema.safeParse({ ...cmd, notBefore: 1.5 }).success).toBe(false);
  });
});
