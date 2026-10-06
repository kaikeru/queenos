import { describe, expect, it } from "vitest";
import {
  AppendAuditSchema,
  AuditStatusSchema,
  BuildResultSchema,
  DeployCommandSchema,
  DeployResultSchema,
  DroneActionSchema,
  DroneTaskSchema,
  EscalationReasonSchema,
  EscalationSchema,
  EventQuerySchema,
  FileWorkItemSchema,
  FollowUpSchema,
  GateScoreSchema,
  GateTargetSchema,
  GENERATED_PATHS,
  GitNotesPayloadSchema,
  GUARDRAIL_DEFAULTS,
  GUARDRAIL_MAX,
  GuardrailsSchema,
  HIVE_SETTINGS_DEFAULTS,
  HiveSettingsSchema,
  HiveStatusSchema,
  HourlyMetricSchema,
  LandResultSchema,
  MergeMemberSchema,
  MergeResultSchema,
  MergeTrainSchema,
  MODEL_CATALOG,
  ModelRoleSchema,
  OracleCommandSchema,
  OracleResultSchema,
  PathPatternSchema,
  ProvisionCommandSchema,
  ProvisionResultSchema,
  QueenClientMessageSchema,
  QueenEventSchema,
  QueenServerMessageSchema,
  RaceSchema,
  ReleaseSchema,
  ResolveEscalationSchema,
  RUNBOOK,
  type EscalationAction,
  type EscalationReason,
  BudgetBoostSchema,
  ItemDetailSchema,
  MetricsViewSchema,
  QueueViewSchema,
  ScribeSummarySchema,
  SentinelCommandSchema,
  SentinelVerdictSchema,
  SpanIdSchema,
  SubmitPromptSchema,
  SwarmLeaseRequestSchema,
  SwarmLeaseSchema,
  TraceContextSchema,
  TraceIdSchema,
  TraceparentSchema,
  TraceViewSchema,
  TrainResultSchema,
  UpdateHiveSettingsSchema,
  WorkActionSchema,
  WorkItemSchema,
  escalationActions,
  fnv1a64,
  parseTraceparent,
  pathsOverlap,
  spanIdFor,
  traceIdFromUuid,
  traceparent,
  type AuditEvent,
  type MergeTrain,
  type PromptRun,
} from "./index.js";

const note = {
  taskPrompt: "p",
  model: "m",
  temperature: 0.2,
  reasoningSteps: ["a"],
  result: "success",
  executionTimeMs: 5,
};
const run: PromptRun = { promptId: "p1", namespace: "n", promptText: "t", status: "QUEUED", createdAt: 1 };
const train: MergeTrain = {
  trainId: "t1",
  baseSha: "abc",
  includedPrompts: ["p1"],
  artifactRepo: "r",
  status: "BUILDING",
  createdAt: 1,
};
const audit: AuditEvent = {
  eventId: "e1",
  promptId: "p1",
  droneRole: "BUILDER",
  status: "PASSED",
  gitNotesPayload: GitNotesPayloadSchema.parse(note),
  createdAt: 1,
};

describe("ledger", () => {
  it("parses a valid payload and defaults discardedPaths", () => {
    expect(GitNotesPayloadSchema.parse(note).discardedPaths).toEqual([]);
  });
  it("rejects a bad result enum", () => {
    expect(GitNotesPayloadSchema.safeParse({ ...note, result: "maybe" }).success).toBe(false);
  });
});

describe("telemetry", () => {
  const server = [
    { type: "snapshot", promptRuns: [run], trains: [train], recentAudit: [audit] },
    { type: "prompt.updated", promptRun: run },
    { type: "train.updated", train },
    { type: "audit.appended", event: audit },
    { type: "error", message: "boom" },
    { type: "pong" },
  ];
  it.each(server)("round-trips server $type", (msg) => {
    expect(QueenServerMessageSchema.parse(JSON.parse(JSON.stringify(msg)))).toEqual(msg);
  });
  const client = [
    { type: "subscribe" },
    { type: "ping" },
    { type: "submit_prompt", prompt: { namespace: "n", promptText: "t" } },
  ];
  it.each(client)("round-trips client $type", (msg) => {
    expect(QueenClientMessageSchema.parse(JSON.parse(JSON.stringify(msg)))).toEqual(msg);
  });
});

describe("summary", () => {
  it("rejects summaries over 500 chars", () => {
    expect(ScribeSummarySchema.safeParse({ summary: "x".repeat(501) }).success).toBe(false);
    expect(ScribeSummarySchema.safeParse({ summary: "x".repeat(500) }).success).toBe(true);
  });
});

describe("drone task", () => {
  const base = {
    promptId: "p",
    trainId: "t",
    namespace: "n",
    artifactRepo: "n-train-1",
    baseRef: "main",
    promptText: "x",
    role: "LANDER",
  };
  it("defaults action and ragContext", () => {
    expect(DroneTaskSchema.parse(base)).toMatchObject({ action: "BUILD", ragContext: [] });
  });
  it("accepts rework with a summary and rejects a long one", () => {
    expect(DroneTaskSchema.safeParse({ ...base, action: "REWORK", scribeSummary: "s" }).success).toBe(true);
    expect(DroneTaskSchema.safeParse({ ...base, scribeSummary: "x".repeat(501) }).success).toBe(false);
  });
});

describe("audit + results", () => {
  it("audit status is an enum", () => {
    expect(AuditStatusSchema.options).toEqual(["RUNNING", "PASSED", "REJECTED"]);
    expect(AppendAuditSchema.safeParse({ promptId: "p", droneRole: "SECURITY", status: "ok" }).success).toBe(false);
    expect(AppendAuditSchema.parse({ promptId: "p", droneRole: "POLICY", status: "RUNNING" }).gitNotesPayload).toBeNull();
  });
  it("land result requires mainSha when landed", () => {
    expect(LandResultSchema.safeParse({ trainId: "t", landed: true }).success).toBe(false);
    expect(LandResultSchema.safeParse({ trainId: "t", landed: true, mainSha: "abc" }).success).toBe(true);
    expect(LandResultSchema.safeParse({ trainId: "t", landed: false }).success).toBe(true);
  });
  it("build result needs a head sha", () => {
    expect(BuildResultSchema.safeParse({ trainId: "t" }).success).toBe(false);
  });
  it("build result carries optional token usage", () => {
    const base = { trainId: "t", headSha: "abc", model: "@cf/m" };
    expect(BuildResultSchema.parse(base).usage).toBeUndefined();
    expect(BuildResultSchema.parse({ ...base, usage: { inputTokens: 27_100, outputTokens: 2_400, steps: 8 } }).usage).toEqual({ inputTokens: 27_100, outputTokens: 2_400, steps: 8 });
    expect(BuildResultSchema.safeParse({ ...base, usage: { inputTokens: -1, outputTokens: 0 } }).success).toBe(false);
  });
});

describe("MergeTrain train internals", () => {
  const detailed = {
    ...train,
    phase: "LANDING",
    reason: null,
    summary: "All checks green.",
    headSha: "deadbeef",
    landedSha: null,
  };

  it("accepts the optional phase, reason, summary and head sha in train.updated and snapshots", () => {
    const updated = QueenServerMessageSchema.parse({ type: "train.updated", train: detailed });
    expect(updated.type === "train.updated" && updated.train.phase).toBe("LANDING");
    const snap = QueenServerMessageSchema.parse({
      type: "snapshot",
      promptRuns: [run],
      trains: [{ ...detailed, phase: "EJECTED", reason: "failed: boom" }],
      recentAudit: [],
    });
    expect(snap.type === "snapshot" && snap.trains[0]?.reason).toBe("failed: boom");
  });

  it("keeps the new fields optional (older Queens omit them)", () => {
    expect(QueenServerMessageSchema.safeParse({ type: "train.updated", train }).success).toBe(true);
  });

  it("rejects an unknown phase and an over-long summary", () => {
    expect(QueenServerMessageSchema.safeParse({ type: "train.updated", train: { ...train, phase: "NOPE" } }).success).toBe(false);
    expect(
      QueenServerMessageSchema.safeParse({ type: "train.updated", train: { ...train, summary: "x".repeat(501) } }).success,
    ).toBe(false);
  });
});

describe("executors + deployments", () => {
  const deployment = {
    deploymentId: "preview-t1",
    hive: "h",
    environment: "preview",
    trainId: "t1",
    status: "LIVE",
    url: "https://t1-preview.sim.queenos.dev",
    versionId: null,
    commitSha: "abc",
    percent: null,
    summary: null,
    updatedAt: 1,
  };

  it("round-trips deployment.updated and a snapshot with deployments", () => {
    const upd = { type: "deployment.updated", deployment };
    expect(QueenServerMessageSchema.parse(JSON.parse(JSON.stringify(upd)))).toEqual(upd);
    const snap = { type: "snapshot", promptRuns: [], trains: [], recentAudit: [], deployments: [deployment] };
    expect(QueenServerMessageSchema.parse(snap)).toEqual(snap);
  });

  it("keeps snapshot.deployments optional for older Queens", () => {
    const snap = QueenServerMessageSchema.parse({ type: "snapshot", promptRuns: [], trains: [], recentAudit: [] });
    expect(snap.type === "snapshot" && (snap.deployments ?? [])).toEqual([]);
  });

  it("accepts the DEPLOYING phase and a nullable previewUrl on trains", () => {
    const t = { ...train, status: "TESTING", phase: "DEPLOYING", previewUrl: null };
    expect(QueenServerMessageSchema.safeParse({ type: "train.updated", train: t }).success).toBe(true);
    const live = { ...t, phase: "TESTING", previewUrl: "https://x.dev" };
    const parsed = QueenServerMessageSchema.parse({ type: "train.updated", train: live });
    expect(parsed.type === "train.updated" && parsed.train.previewUrl).toBe("https://x.dev");
  });

  it("validates provision and deploy commands/results", () => {
    expect(
      ProvisionCommandSchema.safeParse({ op: "FORK", commandId: "t1-fork-1", hive: "h", trainId: "t1", sourceRepo: "h", forkName: "h-train-t1" })
        .success,
    ).toBe(true);
    expect(ProvisionResultSchema.safeParse({ commandId: "c", op: "FORK", trainId: "t1", ok: "yes" }).success).toBe(false);
    expect(
      DeployCommandSchema.safeParse({ op: "DEPLOY", commandId: "c", hive: "h", environment: "preview", trainId: "t", artifactRepo: "r", commitSha: "s" })
        .success,
    ).toBe(true);
    expect(DeployResultSchema.safeParse({ commandId: "c", op: "DEPLOY", environment: "preview", ok: true, url: "not a url" }).success).toBe(false);
  });
});

// ── v2 contracts (WP0) ─────────────────────────────────────────────────

const UUID = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";
const TRACE = "3f2504e04f8911d39a0c0305e82c3301";
const SPAN = "85944171f73967e8";
const SHA = "a".repeat(40);
const roundTrip = <T>(schema: { parse: (v: unknown) => T }, v: unknown) => schema.parse(JSON.parse(JSON.stringify(v)));

describe("trace ids", () => {
  it.each([
    ["", "cbf29ce484222325"],
    ["a", "af63dc4c8601ec8c"],
    ["foobar", "85944171f73967e8"],
  ])("fnv1a64(%j) = %s (published FNV-1a 64 vectors)", (key, hex) => {
    expect(fnv1a64(key)).toBe(hex);
  });

  it("spanIdFor is FNV-1a 64: deterministic, 16 hex, key-sensitive, UTF-8", () => {
    expect(spanIdFor("foobar")).toBe("85944171f73967e8");
    expect(spanIdFor("t-1")).toBe(spanIdFor("t-1"));
    expect(spanIdFor("t-1")).not.toBe(spanIdFor("t-2"));
    expect(SpanIdSchema.safeParse(spanIdFor("gate:t1:" + SHA)).success).toBe(true);
    // Non-ASCII hashes its UTF-8 bytes (not UTF-16 code units).
    expect(spanIdFor("é")).toBe(fnv1a64("é"));
    expect(spanIdFor("é")).not.toBe(spanIdFor("é".normalize("NFD")));
  });

  it("traceIdFromUuid strips dashes and lowercases (matching the migration SQL)", () => {
    expect(traceIdFromUuid(UUID)).toBe(TRACE);
    expect(TraceIdSchema.safeParse(traceIdFromUuid(UUID)).success).toBe(true);
  });

  it("traceIdFromUuid still yields a valid, deterministic trace id for non-UUID ids", () => {
    const t = traceIdFromUuid("p1");
    expect(TraceIdSchema.safeParse(t).success).toBe(true);
    expect(traceIdFromUuid("p1")).toBe(t);
    expect(traceIdFromUuid("p2")).not.toBe(t);
  });

  it("formats and parses traceparent", () => {
    const tp = traceparent(TRACE, SPAN);
    expect(tp).toBe(`00-${TRACE}-${SPAN}-01`);
    expect(TraceContextSchema.parse({ traceparent: tp })).toEqual({ traceparent: tp });
    expect(parseTraceparent(tp)).toEqual({ traceId: TRACE, spanId: SPAN });
    expect(parseTraceparent("00-xyz")).toBeNull();
    expect(parseTraceparent(`00-${"0".repeat(32)}-${SPAN}-01`)).toBeNull();
    expect(parseTraceparent(`00-${TRACE}-${"0".repeat(16)}-01`)).toBeNull();
    expect(TraceparentSchema.safeParse(`01-${TRACE}-${SPAN}-01`).success).toBe(false);
  });
});

describe("pathsOverlap", () => {
  it.each<[string, string[], string[], string[]]>([
    ["equal paths", ["src/theme.js"], ["src/theme.js"], ["src/theme.js"]],
    ["different files", ["src/a.js"], ["src/b.js"], []],
    ["a directory prefix (a holds the dir)", ["src/lib/"], ["src/lib/theme.js"], ["src/lib/"]],
    ["a directory prefix (b holds the dir)", ["src/lib/theme.js"], ["src/lib/"], ["src/lib/theme.js"]],
    ["nested directories", ["src/"], ["src/lib/"], ["src/"]],
    ["a sibling prefix is not a prefix (files)", ["src/a"], ["src/ab"], []],
    ["a sibling prefix is not a prefix (dir vs file)", ["src/a/"], ["src/ab"], []],
    ["a file named like a dir without the slash", ["src/lib"], ["src/lib/x.js"], []],
    ["generated paths never overlap", ["src/features/index.js"], ["src/features/index.js"], []],
    ["a dir never overlaps only a generated path", ["src/features/"], ["src/features/index.js"], []],
    ["generated paths are skipped, others still count", ["src/features/index.js", "src/x.js"], ["src/x.js", "src/features/index.js"], ["src/x.js"]],
    ["empty a", [], ["src/x.js"], []],
    ["empty b", ["src/x.js"], [], []],
    ["returns a's paths in a's order, deduped", ["src/b.js", "src/a.js", "src/b.js"], ["src/"], ["src/b.js", "src/a.js"]],
  ])("%s", (_name, a, b, want) => {
    expect(pathsOverlap(a, b)).toEqual(want);
  });

  it("GENERATED_PATHS is the template registry", () => {
    expect(GENERATED_PATHS).toEqual(["src/features/index.js"]);
  });

  it("PathPatternSchema rejects absolute, parent and glob paths", () => {
    expect(PathPatternSchema.safeParse("src/lib/").success).toBe(true);
    expect(PathPatternSchema.safeParse("/etc/passwd").success).toBe(false);
    expect(PathPatternSchema.safeParse("src/../x").success).toBe(false);
    expect(PathPatternSchema.safeParse("src/*.js").success).toBe(false);
  });
});

describe("v2 schemas round-trip", () => {
  const source = { kind: "user", actor: "kyle@example.com" };
  const item = {
    itemId: "g1-c1",
    hive: "demo",
    kind: "feature",
    title: "Dark mode",
    body: "Add a dark theme",
    acceptance: ["toggle visible at /"],
    priority: 2,
    status: "READY",
    parentId: "g1",
    rootId: "g1",
    depth: 1,
    dependsOn: [],
    source,
    traceId: TRACE,
    spanId: SPAN,
    difficulty: "hard",
    bestOf: null,
    attempts: 0,
    conflicts: 1,
    paths: ["src/lib/theme.js"],
    waitReason: "affinity: src/lib/theme.js held by g1-c2",
    duplicateOf: null,
    blockedReason: null,
    releaseId: null,
    escalationId: null,
    createdAt: 1,
    updatedAt: 2,
  };
  const race = {
    raceId: "r1",
    itemId: "g1-c1",
    width: 3,
    state: "DECIDED",
    trainIds: ["t1", "t2", "t3"],
    winnerTrainId: "t2",
    reason: "won: reviewer approved (4/0)",
    deadlineAt: 10,
    createdAt: 1,
    decidedAt: 11,
  };
  const escalation = {
    escalationId: "e1",
    hive: "demo",
    reason: "APPROVAL_REQUIRED",
    status: "OPEN",
    subject: { type: "release", id: "rel1" },
    traceId: TRACE,
    summary: "staging green",
    actions: ["ship", "hold"],
    createdAt: 1,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
  };
  const hiveStatus = {
    hive: "demo",
    mode: "sim",
    settings: HIVE_SETTINGS_DEFAULTS,
    effectiveAutonomy: "supervised",
    degradedBy: ["ERROR_BUDGET_EXHAUSTED"],
    headline: "NEEDS_YOU",
    budget: { day: "2026-10-05", creditsUsed: 12.5, creditsLimit: 50_000, dispatches: 3, dispatchLimit: 400 },
    slo: { window: 20, attempted: 4, failed: 1, target: 0.9, errorBudgetRemaining: 1, exhausted: false },
    counts: { READY: 2, ACTIVE: 3 },
    throughput: { shipped24h: 1, landed24h: 2, leadTimeP50Ms: 600_000, firstTryPassRate: 0.5 },
    concurrency: {
      activeBuilds: 5,
      slots: 24,
      leasedSlots: 60,
      affinityWaits: 1,
      queueDepth: 2,
      waitingToBoard: 1,
      landed1h: 4,
      conflicts24h: 1,
      bisects24h: 0,
      queueWaitP50Ms: null,
    },
  };
  const event = {
    seq: 7,
    eventId: "ev1",
    ts: 5,
    hive: "demo",
    type: "drone.audit",
    severity: "info",
    actor: "drone:BUILDER",
    traceId: TRACE,
    spanId: SPAN,
    parentSpanId: null,
    itemId: "g1-c1",
    trainId: "t1",
    releaseId: null,
    commandId: null,
    summary: "BUILDER PASSED",
    data: { k: 1 },
    droneRole: "BUILDER",
    auditStatus: "PASSED",
    gitNotesPayload: GitNotesPayloadSchema.parse(note),
  };
  const member = { trainId: "t1", promptId: "p1", artifactRepo: "demo-train-t1", headSha: SHA, title: "Dark mode" };

  it.each<[string, { parse: (v: unknown) => unknown }, unknown]>([
    ["WorkItem", WorkItemSchema, item],
    ["FollowUp", FollowUpSchema, { kind: "bug", title: "404 badge", body: "b", paths: ["README.md"], priority: 2 }],
    ["FileWorkItem", FileWorkItemSchema, { kind: "chore", title: "t", body: "", acceptance: [], priority: 1, dependsOn: [], paths: [], bestOf: 3, difficulty: "hard" }],
    ["WorkAction", WorkActionSchema, { action: "not_duplicate", note: "distinct" }],
    ["Guardrails", GuardrailsSchema, GUARDRAIL_DEFAULTS],
    ["Race", RaceSchema, race],
    ["OracleCommand DECOMPOSE", OracleCommandSchema, {
      op: "DECOMPOSE",
      commandId: "g1-decompose-1",
      hive: "demo",
      itemId: "g1",
      trace: { traceparent: traceparent(TRACE, SPAN) },
      promptText: "- a\n- b",
      model: { model: "@cf/zai-org/glm-5.3-flash", tier: "fast", role: "planner", reason: "planner", fallbacks: [] },
      openItems: [{ itemId: "x", title: "X", status: "ACTIVE", paths: ["src/x.js"] }],
      limits: { maxChildren: 8 },
    }],
    ["OracleCommand TRIAGE", OracleCommandSchema, { op: "TRIAGE", commandId: "b1-triage-1", hive: "demo", itemId: "b1", kind: "bug", title: "t", body: "b" }],
    ["OracleResult", OracleResultSchema, {
      commandId: "g1-decompose-1",
      op: "DECOMPOSE",
      itemId: "g1",
      ok: true,
      children: [{ key: "c1", kind: "feature", title: "A", body: "", acceptance: [], priority: 2, difficulty: "normal", dependsOn: [], paths: ["src/a.js"], similar: [{ itemId: "x", score: 0.5 }] }],
      model: "@cf/zai-org/glm-5.3-flash",
      usage: { inputTokens: 1200, outputTokens: 300 },
      summary: "",
    }],
    ["Escalation", EscalationSchema, escalation],
    ["ResolveEscalation", ResolveEscalationSchema, { action: "ship" }],
    ["HiveSettings", HiveSettingsSchema, HIVE_SETTINGS_DEFAULTS],
    ["UpdateHiveSettings", UpdateHiveSettingsSchema, { autonomy: "paused", guardrails: { maxQueueBatch: 1 }, budget: { dailyCredits: 10 } }],
    ["HiveStatus", HiveStatusSchema, hiveStatus],
    ["QueenEvent", QueenEventSchema, event],
    ["EventQuery", EventQuerySchema, { traceId: TRACE, typePrefix: "queue", before: 10, limit: 50 }],
    ["TraceView", TraceViewSchema, {
      traceId: TRACE,
      spans: [{ spanId: SPAN, parentSpanId: null, name: "item g1-c1", kind: "item", startTs: 1, endTs: null, outcome: null }],
      events: [event],
      links: [TRACE],
    }],
    ["HourlyMetric", HourlyMetricSchema, { bucket: 3_600_000, name: "builds", labels: { model: "m" }, count: 1, sum: 2, min: 2, max: 2 }],
    ["MergeResult", MergeResultSchema, {
      trainId: "car1",
      ok: true,
      headSha: SHA,
      baseSha: SHA,
      merged: ["t1"],
      conflicts: [{ trainId: "t2", kind: "content", paths: ["src/lib/format.js"], summary: "both edit format.js" }],
      fastForward: false,
      mergeMs: 1500,
      summary: "1 merged, 1 conflict",
    }],
    ["GateTarget", GateTargetSchema, {
      trainId: "car1",
      lane: "QUEUE",
      promptId: "p1",
      promptText: "queue car car1: 1 members",
      previewUrl: null,
      phase: "TESTING",
      traceId: null,
      baseSha: SHA,
      members: [{ ...member, traceId: TRACE, smokePaths: ["/features/dark"] }],
    }],
    ["SwarmLeaseRequest", SwarmLeaseRequestSchema, { hive: "demo", want: 24, ttlMs: 120_000 }],
    ["SwarmLease", SwarmLeaseSchema, { hive: "demo", granted: 24, expiresAt: 9, globalActive: 30, globalCeiling: 60, aiRpmCeiling: 240 }],
    ["GateScore", GateScoreSchema, { review: "approved", satisfied: 3, missing: 0, changedFiles: 2, changedBytes: 3100, checks: 4 }],
  ])("%s", (_name, schema, value) => {
    expect(roundTrip(schema, value)).toEqual(value);
  });

  it("applies the documented defaults", () => {
    const v1ish: Record<string, unknown> = { ...item };
    delete v1ish.conflicts;
    delete v1ish.paths;
    delete v1ish.waitReason;
    expect(WorkItemSchema.parse(v1ish)).toMatchObject({ conflicts: 0, paths: [], waitReason: null });
    expect(MergeResultSchema.parse({ trainId: "car1", ok: false })).toEqual({ trainId: "car1", ok: false, merged: [], conflicts: [], fastForward: false, summary: "" });
    expect(FileWorkItemSchema.parse({ kind: "feature", title: "t" })).toMatchObject({ body: "", priority: 2, acceptance: [], dependsOn: [], paths: [] });
    expect(FileWorkItemSchema.safeParse({ kind: "goal", title: "t" }).success).toBe(false);
  });

  it("rejects a merge member with a short sha and a lease over 1000", () => {
    expect(MergeMemberSchema.safeParse({ ...member, headSha: "abc" }).success).toBe(false);
    expect(SwarmLeaseRequestSchema.safeParse({ hive: "h", want: 1001, ttlMs: 60_000 }).success).toBe(false);
  });

  it("has a runbook entry, with actions, for every escalation reason", () => {
    for (const reason of EscalationReasonSchema.options) {
      expect(RUNBOOK[reason].what.length).toBeGreaterThan(0);
      expect(escalationActions(reason).length).toBeGreaterThan(0);
    }
    expect(escalationActions("APPROVAL_REQUIRED")).toEqual(["ship", "hold"]);
    expect(escalationActions("REWORK_EXHAUSTED")).toEqual(["retry", "cancel"]);
  });

  it("has runbook text for every reason x action pair the Queen can open", () => {
    // Default actions per reason, plus the narrowed sets the planners pass explicitly.
    const offered: [EscalationReason, EscalationAction[]][] = [
      ...EscalationReasonSchema.options.map((r): [EscalationReason, EscalationAction[]] => [r, escalationActions(r)]),
      ["SENTINEL_INCONCLUSIVE", ["ack"]],
      ["GUARDRAIL_TRIPPED", ["ack"]],
      ["EXECUTOR_LOST", ["ack"]],
    ];
    for (const [reason, actions] of offered) {
      for (const a of actions) expect(RUNBOOK[reason].actions[a]?.length, `${reason} x ${a}`).toBeGreaterThan(0);
    }
    expect(RUNBOOK.SENTINEL_INCONCLUSIVE.actions.ack).toBeDefined();
  });

  it("parses the REST views and the additive v12 fields", () => {
    expect(QueueViewSchema.parse({ cars: [], waiting: [], conflicts: [], bisects: [] }).cars).toEqual([]);
    expect(MetricsViewSchema.parse({ rollups: [], hive: null, source: "ae" }).source).toBe("ae");
    expect(ItemDetailSchema.safeParse({ item: {}, children: [], trains: [], races: [], release: null, escalations: [] }).success).toBe(false);
    const train = { trainId: "t", baseSha: "b", includedPrompts: [], artifactRepo: "r", status: "BUILDING", createdAt: 1 };
    expect(MergeTrainSchema.parse({ ...train, carSeq: 3, fastForward: true })).toMatchObject({ carSeq: 3, fastForward: true });
    expect(MergeTrainSchema.parse(train)).not.toHaveProperty("carSeq");
    expect(BudgetBoostSchema.safeParse({ day: "2026-10-05", dailyCredits: 1, dailyDispatches: 2 }).success).toBe(true);
    expect(BudgetBoostSchema.safeParse({ day: "today", dailyCredits: 1, dailyDispatches: 2 }).success).toBe(false);
  });

  it("allows 24 oracle children", () => {
    expect(GuardrailsSchema.parse({ ...GUARDRAIL_DEFAULTS, maxChildrenPerItem: 24 }).maxChildrenPerItem).toBe(24);
    expect(GUARDRAIL_MAX.maxChildrenPerItem).toBe(24);
    expect(GuardrailsSchema.safeParse({ ...GUARDRAIL_DEFAULTS, maxChildrenPerItem: 25 }).success).toBe(false);
    expect(OracleResultSchema).toBeDefined();
  });

  it("keeps guardrail defaults inside GUARDRAIL_MAX and the schema", () => {
    expect(GuardrailsSchema.parse(GUARDRAIL_MAX)).toEqual(GUARDRAIL_MAX);
    for (const k of Object.keys(GUARDRAIL_DEFAULTS) as (keyof typeof GUARDRAIL_DEFAULTS)[]) {
      expect(GUARDRAIL_DEFAULTS[k]).toBeLessThanOrEqual(GUARDRAIL_MAX[k]);
    }
  });

  it("round-trips the v2 server messages, a batch and a v2 snapshot", () => {
    const deltas = [
      { type: "item.updated", item },
      { type: "race.updated", race },
      { type: "escalation.updated", escalation },
      { type: "hive.updated", hive: hiveStatus },
      { type: "event.appended", event },
      { type: "train.updated", train: { ...train, lane: "QUEUE", members: ["t1", "t2"], carId: null } },
    ];
    for (const m of deltas) expect(roundTrip(QueenServerMessageSchema, m)).toEqual(m);
    const batch = { type: "batch", messages: deltas };
    expect(roundTrip(QueenServerMessageSchema, batch)).toEqual(batch);
    expect(QueenServerMessageSchema.safeParse({ type: "batch", messages: [batch] }).success).toBe(false);
    const snap = { type: "snapshot", promptRuns: [run], trains: [train], recentAudit: [audit], items: [item], escalations: [escalation], races: [race], hive: hiveStatus, recentEvents: [event] };
    expect(roundTrip(QueenServerMessageSchema, snap)).toEqual(snap);
  });

  it("round-trips the v2 fields on existing schemas", () => {
    const followUp = { kind: "bug", title: "t", body: "b", paths: [], priority: 2 };
    const v2train = {
      ...train,
      traceId: TRACE,
      raceId: "r1",
      candidate: 1,
      raceOutcome: "WON",
      score: { review: "skipped", satisfied: 0, missing: 0, changedFiles: 1, changedBytes: 10, checks: 3 },
      lane: "BUILD",
      carId: "car1",
      passedSeq: 4,
      conflict: { trainId: "t1", kind: "unsupported", paths: [], summary: "add/add" },
      changedPaths: ["src/a.js"],
      waitForCarSeq: null,
    };
    expect(roundTrip(QueenServerMessageSchema, { type: "train.updated", train: v2train })).toEqual({ type: "train.updated", train: v2train });
    const tp = traceparent(TRACE, SPAN);
    const tr = { trainId: "t", passed: true, summary: "ok", score: v2train.score, followUps: [followUp] };
    expect(roundTrip(TrainResultSchema, tr)).toEqual(tr);
    const br = { trainId: "t", headSha: SHA, verified: true, followUps: [followUp], changedPaths: ["src/a.js"] };
    expect(roundTrip(BuildResultSchema, br)).toEqual(br);
    const sp = { namespace: "n", promptText: "t", decompose: true, bestOf: 3, priority: 0 };
    expect(roundTrip(SubmitPromptSchema, sp)).toEqual(sp);
    const task = DroneTaskSchema.parse({
      promptId: "car1",
      trainId: "car1",
      namespace: "n",
      artifactRepo: "n-train-car1",
      baseRef: "main",
      promptText: "queue car car1: 1 members",
      role: "LANDER",
      action: "MERGE",
      trace: { traceparent: tp },
      members: [member],
    });
    expect(task.members).toEqual([member]);
    for (const cmd of [
      { op: "FORK", commandId: "c", hive: "h", trainId: "t", sourceRepo: "h", forkName: "h-train-t", trace: { traceparent: tp } },
      { op: "DELETE", commandId: "c", hive: "h", trainId: "t", repo: "r", trace: { traceparent: tp } },
    ]) {
      expect(roundTrip(ProvisionCommandSchema, cmd)).toEqual(cmd);
    }
    for (const cmd of [
      { op: "DEPLOY", commandId: "c", hive: "h", environment: "preview", artifactRepo: "r", commitSha: "s", trace: { traceparent: tp } },
      { op: "TEARDOWN", commandId: "c", hive: "h", environment: "preview", trace: { traceparent: tp } },
      { op: "ROLLBACK", commandId: "c", hive: "h", environment: "prod", toVersionId: "v", trace: { traceparent: tp } },
    ]) {
      expect(roundTrip(DeployCommandSchema, cmd)).toEqual(cmd);
    }
    expect(SentinelCommandSchema.parse({ commandId: "c", hive: "h", releaseId: "r", environment: "staging", scriptName: "h-staging", url: "https://x.dev", trace: { traceparent: tp } }).trace).toEqual({ traceparent: tp });
    const verdict = { commandId: "c", releaseId: "r", environment: "staging", verdict: "ROLLBACK", metrics: { requests: 0, errorRate: 0, p99Ms: null, baselineErrorRate: null }, summary: "never ready", inconclusive: true };
    expect(roundTrip(SentinelVerdictSchema, verdict)).toEqual(verdict);
    const rel = { releaseId: "r", hive: "h", headSha: SHA, trainIds: [], phase: "STAGING", canaryPercent: null, stagingUrl: null, prodUrl: null, candidateVersionId: null, stableVersionId: null, tappedBy: null, tappedAt: null, summary: null, createdAt: 1, updatedAt: 1, traceId: TRACE };
    expect(roundTrip(ReleaseSchema, rel)).toEqual(rel);
  });
});

describe("v1 payloads (no v2 fields) still parse unchanged", () => {
  it.each<[string, { parse: (v: unknown) => unknown }, unknown]>([
    ["MergeTrain", MergeTrainSchema, train],
    ["TrainResult", TrainResultSchema, { trainId: "t", passed: false, summary: "boom" }],
    ["BuildResult", BuildResultSchema, { trainId: "t", headSha: "abc" }],
    ["SubmitPrompt", SubmitPromptSchema, { namespace: "n", promptText: "t" }],
    ["ProvisionCommand", ProvisionCommandSchema, { op: "FORK", commandId: "c", hive: "h", trainId: "t", sourceRepo: "h", forkName: "f" }],
    ["DeployCommand", DeployCommandSchema, { op: "TEARDOWN", commandId: "c", hive: "h", environment: "preview" }],
    ["SentinelVerdict", SentinelVerdictSchema, { commandId: "c", releaseId: "r", environment: "canary", verdict: "PROMOTE", metrics: { requests: 1, errorRate: 0, p99Ms: 3, baselineErrorRate: 0 }, summary: "ok" }],
    ["Snapshot", QueenServerMessageSchema, { type: "snapshot", promptRuns: [run], trains: [train], recentAudit: [audit] }],
  ])("%s", (_name, schema, value) => {
    expect(roundTrip(schema, value)).toEqual(value);
  });

  it("keeps the v1 drone actions and model roles, adding MERGE and planner", () => {
    expect(DroneActionSchema.options).toEqual(["BUILD", "LAND", "REWORK", "MERGE"]);
    expect(ModelRoleSchema.options).toEqual(["builder", "rework", "scribe", "genesis", "planner"]);
    expect(MODEL_CATALOG.filter((m) => m.roles.includes("planner")).map((m) => m.label)).toEqual(["DeepSeek V4 Flash", "GLM-5.3 Flash"]);
  });
});
