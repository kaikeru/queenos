import { describe, expect, it } from "vitest";
import {
  AppendAuditSchema,
  AuditStatusSchema,
  BuildResultSchema,
  DroneTaskSchema,
  GitNotesPayloadSchema,
  LandResultSchema,
  QueenClientMessageSchema,
  QueenServerMessageSchema,
  ScribeSummarySchema,
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
