import { describe, expect, it } from "vitest";
import { GitNotesPayloadSchema } from "@queenos/queen-types";
import {
  LedgerError,
  MAX_LEDGER_BYTES,
  buildGitNotesPayload,
  ledgerBytes,
  ledgerFilePath,
  parseLedger,
  serializeLedger,
} from "./ledger.js";

const base = {
  taskPrompt: "add a feature",
  model: "claude-opus-5-5",
  temperature: 1,
  reasoningSteps: ["read the repo", "wrote the file"],
  result: "success" as const,
  executionTimeMs: 1234.4,
};

describe("ledger", () => {
  it("builds a schema-valid payload and defaults discardedPaths", () => {
    const p = buildGitNotesPayload(base);
    expect(GitNotesPayloadSchema.parse(p)).toEqual(p);
    expect(p.discardedPaths).toEqual([]);
    expect(p.executionTimeMs).toBe(1234);
  });

  it("rejects invalid input", () => {
    expect(() => buildGitNotesPayload({ ...base, result: "maybe" as "success" })).toThrow(LedgerError);
    expect(() => buildGitNotesPayload({ ...base, executionTimeMs: -1 })).toThrow(/executionTimeMs/);
    expect(() => buildGitNotesPayload({ ...base, model: 3 as unknown as string })).toThrow(/model/);
  });

  it("clips to the 16 KiB Queen limit", () => {
    const p = buildGitNotesPayload({
      ...base,
      taskPrompt: "p".repeat(50_000),
      reasoningSteps: Array.from({ length: 100 }, () => "s".repeat(2_000)),
    });
    expect(p.reasoningSteps.length).toBeLessThanOrEqual(20);
    expect(p.reasoningSteps.every((s) => s.length <= 500)).toBe(true);
    expect(ledgerBytes(p)).toBeLessThanOrEqual(MAX_LEDGER_BYTES);
  });

  it("serializes and parses round-trip; fallback path is keyed by sha", () => {
    const p = buildGitNotesPayload({ ...base, discardedPaths: ["src/x.ts"] });
    expect(parseLedger(serializeLedger(p))).toEqual(p);
    expect(ledgerFilePath("a".repeat(40))).toBe(`.queen/ledger/${"a".repeat(40)}.json`);
    expect(() => ledgerFilePath("../etc")).toThrow(LedgerError);
  });
});
