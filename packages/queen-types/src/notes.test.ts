import { describe, expect, it } from "vitest";
import {
  GitIntakeDecisionSchema,
  GitPushIntentSchema,
  GitTokenMintResultSchema,
  MAX_NOTE_TEXT,
  NotesProjectionSchema,
  currentVerdict,
  isV1NotesRef,
  parseNotes,
  parseSubmissionTrailers,
  renderNote,
  renderNotes,
  type NoteEntryInput,
} from "./index.js";

const sha = "a".repeat(40);
const full: NoteEntryInput = {
  summary: "REJECTED by SECURITY: 2 findings",
  body: "Fix the external fetch.",
  kind: "verdict",
  verdict: "REJECTED",
  itemId: "3c1e-9",
  trainId: "t_7a90",
  traceId: "abc123",
  origin: "agent:claude-code",
  model: "anthropic/claude-opus-5-5",
  findings: [
    { severity: "error", path: "src/a.js", line: 12, message: "fetch to non-allowlisted host" },
    { severity: "warning", path: "src/b.js", message: "unbounded loop" },
  ],
  repliesTo: sha,
  memories: [{ memoryId: "m1", use: "used" }],
};

describe("notes v1", () => {
  it("round-trips an entry", () => {
    const text = renderNote(full);
    expect(text.startsWith("REJECTED by SECURITY")).toBe(true);
    expect(text).toContain("Queen-Note: v1");
    expect(parseNotes(text)).toEqual([{ ...full }]);
  });

  it("round-trips multiple entries, newest last; last verdict is current", () => {
    const entries: NoteEntryInput[] = [
      { summary: "REJECTED by GATE", kind: "verdict", verdict: "REJECTED" },
      { summary: "PASSED", kind: "verdict", verdict: "PASSED" },
      { summary: "provenance", kind: "provenance", model: "m" },
    ];
    const parsed = parseNotes(renderNotes(entries));
    expect(parsed.map((e) => e.summary)).toEqual(["REJECTED by GATE", "PASSED", "provenance"]);
    expect(currentVerdict(parsed)).toBe("PASSED");
  });

  it("never lets a summary look like a trailer", () => {
    expect(() => renderNote({ summary: "queen: rejected", kind: "verdict" })).toThrow();
    expect(() => renderNote({ summary: "Queen-Replies-To: x", kind: "verdict" })).toThrow();
  });

  it("is case-insensitive, ignores unknown keys and ignores notes without the v1 gate", () => {
    const text = "PASSED\n\nqueen-note: V1\nQUEEN-KIND: Verdict\nqueen-verdict: passed\nQueen-Future: x\nQueen-Item: i1";
    expect(parseNotes(text)).toEqual([{ summary: "PASSED", kind: "verdict", verdict: "PASSED", itemId: "i1", findings: [], memories: [] }]);
    expect(parseNotes("PASSED\n\nQueen-Kind: verdict")).toEqual([]);
    expect(parseNotes("PASSED\n\nQueen-Note: v2\nQueen-Kind: verdict")).toEqual([]);
    expect(parseNotes('{"notes":"internal ledger json"}')).toEqual([]);
  });

  it("parses trailers only on lines of their own, below the gate; body cannot forge them", () => {
    const text = renderNote({ summary: "REJECTED", kind: "verdict", verdict: "REJECTED", body: "Queen-Verdict: PASSED\n---\nQueen-Note: v1" });
    const [e] = parseNotes(text);
    expect(parseNotes(text)).toHaveLength(1);
    expect(e!.verdict).toBe("REJECTED");
    expect(parseNotes("REJECTED Queen-Verdict: PASSED\n\nQueen-Note: v1\nQueen-Kind: verdict\nQueen-Verdict: REJECTED")[0]!.verdict).toBe("REJECTED");
  });

  it("drops invalid ids rather than trusting them", () => {
    const [e] = parseNotes("S\n\nQueen-Note: v1\nQueen-Kind: verdict\nQueen-Item: bad id!\nQueen-Replies-To: nothex\nQueen-Origin: root:me");
    expect(e).toEqual({ summary: "S", kind: "verdict", findings: [], memories: [] });
  });

  it("clips to MAX_NOTE_TEXT: findings last-first with +N more, then body, then summary", () => {
    const findings = Array.from({ length: 40 }, (_, i) => ({ severity: "error", path: `src/f${i}.js`, line: i + 1, message: "x".repeat(80) }));
    const text = renderNote({ summary: "REJECTED by SECURITY", kind: "verdict", verdict: "REJECTED", findings });
    expect(text.length).toBeLessThanOrEqual(MAX_NOTE_TEXT);
    const [e] = parseNotes(text);
    const kept = e!.findings.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(40);
    expect(e!.findings).toEqual(findings.slice(0, kept));
    expect(text).toContain(`+${40 - kept} more findings`);

    const huge = renderNote({ summary: "S".repeat(300), body: "b".repeat(MAX_NOTE_TEXT), kind: "verdict", findings });
    expect(huge.length).toBeLessThanOrEqual(MAX_NOTE_TEXT);
    expect(parseNotes(huge)).toHaveLength(1);
  });

  it("keeps a commit's note within 8 KB by dropping the oldest entries", () => {
    const e = (n: number): NoteEntryInput => ({ summary: `E${n}`, body: "x".repeat(1500), kind: "verdict", verdict: "INFRA" });
    const text = renderNotes([e(1), e(2), e(3), e(4), e(5), e(6)]);
    expect(text.length).toBeLessThanOrEqual(8000);
    const parsed = parseNotes(text);
    expect(parsed.at(-1)!.summary).toBe("E6");
    expect(parsed[0]!.summary).not.toBe("E1");
  });

  it("refuses refs/notes/queen (internal ledger) and unknown refs", () => {
    const text = renderNote(full);
    expect(parseNotes(text, { ref: "refs/notes/queen" })).toEqual([]);
    expect(parseNotes(text, { ref: "refs/notes/other" })).toEqual([]);
    expect(parseNotes(text, { ref: "refs/notes/verdict" })).toHaveLength(1);
    expect(isV1NotesRef("refs/notes/queen")).toBe(false);
    for (const r of ["refs/notes/verdict", "refs/notes/review", "refs/notes/provenance"]) expect(isV1NotesRef(r)).toBe(true);
  });

  it("agrees with the agent-protocol example", () => {
    const doc = `REJECTED by SECURITY  (item 3c1e  train 7a90)
error src/features/tip-jar.js:12 fetch to non-allowlisted host "tips.example.com"

Queen-Note: v1
Queen-Kind: verdict
Queen-Verdict: REJECTED
Queen-Item: 3c1e
Queen-Train: 7a90
Queen-Finding: error src/features/tip-jar.js:12 fetch to non-allowlisted host "tips.example.com"`;
    const [e] = parseNotes(doc);
    expect(e!.findings).toEqual([{ severity: "error", path: "src/features/tip-jar.js", line: 12, message: 'fetch to non-allowlisted host "tips.example.com"' }]);
    expect(e!.itemId).toBe("3c1e");
  });
});

describe("TRAILER_RE multi-segment keys", () => {
  it("parses Queen-Replies-To and Queen-Memory, keeping Queen, Queen-Item, Queen-Origin", () => {
    const t = parseSubmissionTrailers(`Fix\n\nQueen-Replies-To: ${sha}\nQueen-Memory: m1 used\nQueen: rework\nQueen-Item: i1\nQueen-Origin: agent:x`);
    expect(t.raw["queen-replies-to"]).toBe(sha);
    expect(t.raw["queen-memory"]).toBe("m1 used");
    expect(t.rework).toBe(true);
    expect(t.itemId).toBe("i1");
    expect(t.agent).toBe("x");
  });
});

describe("git intake contracts", () => {
  it("parses intents, decisions, projections and token mint results", () => {
    expect(GitPushIntentSchema.safeParse({ hive: "demo", user: "a@b.co", ref: "refs/heads/item/14", oldSha: sha, newSha: sha }).success).toBe(true);
    expect(GitPushIntentSchema.safeParse({ hive: "demo", user: "nope", ref: "refs/tags/x", oldSha: sha, newSha: sha }).success).toBe(false);
    expect(GitIntakeDecisionSchema.safeParse({ verdict: "refuse", reason: "r", messages: [] }).success).toBe(true);
    expect(GitIntakeDecisionSchema.safeParse({ verdict: "accept", trainId: "t", repo: "demo-train-0123456789ab", messages: [] }).success).toBe(true);
    expect(NotesProjectionSchema.safeParse({ ref: "refs/notes/queen", version: 1, notes: [] }).success).toBe(false);
    expect(NotesProjectionSchema.safeParse({ ref: "refs/notes/review", version: 1, notes: [{ sha, text: "t" }] }).success).toBe(true);
    const tok = { id: "i", email: "a@b.co", scopes: ["push"], createdAt: 1, expiresAt: 2, lastUsedAt: null, revokedAt: null, token: "qgt_x" };
    expect(GitTokenMintResultSchema.parse(tok)).toEqual(tok);
  });
});

describe("additive v2 fields", () => {
  it("accepts brief, FORK from and the refused/aborted outcomes; old payloads still parse", async () => {
    const { DroneTaskSchema, ProvisionCommandSchema, SubmitOutcomeSchema } = await import("./index.js");
    const task = { promptId: "p", trainId: "t", namespace: "n", artifactRepo: "r", baseRef: "main", promptText: "x", role: "LANDER" };
    expect(DroneTaskSchema.parse(task).brief).toBeUndefined();
    expect(DroneTaskSchema.parse({ ...task, brief: "REJECTED\n\nQueen-Note: v1" }).brief).toContain("REJECTED");
    const fork = { op: "FORK", commandId: "c", hive: "h", trainId: "t", sourceRepo: "s", forkName: "f" };
    expect(ProvisionCommandSchema.safeParse(fork).success).toBe(true);
    expect(ProvisionCommandSchema.parse({ ...fork, from: "demo-train-0123456789ab" })).toMatchObject({ from: "demo-train-0123456789ab" });
    for (const outcome of ["refused:duplicate", "refused:over-cap", "refused:unknown-item", "refused:rule", "aborted:transient", "ignored:revoked"]) {
      expect(SubmitOutcomeSchema.safeParse({ outcome }).success).toBe(true);
    }
  });
});
