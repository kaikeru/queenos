/**
 * The v1 notes projection (human-push design §7; T1): pure work/notes.ts, round-tripped through the T0b
 * parser. The DO's notesFor / brief equality are covered in v2-flow.test.ts.
 */
import { describe, expect, it } from "vitest";
import { currentVerdict, parseNotes, type QueenEvent } from "@queenos/queen-types";
import { findingsFromSteps, projectNotes, type NotesInput, type NotesTrain } from "../src/work/notes";

const HEAD = "a".repeat(40);
const REWORK_HEAD = "c".repeat(40);
const MAIN = "d".repeat(40);
const ITEM = "item-1";
const TRACE = "0123456789abcdef0123456789abcdef";

let seq = 0;
function ev(type: QueenEvent["type"], extra: Partial<QueenEvent> = {}): QueenEvent {
  seq += 1;
  return {
    seq,
    eventId: `e${seq}`,
    ts: seq,
    hive: "hive",
    type,
    severity: "info",
    actor: "queen",
    traceId: null,
    spanId: null,
    parentSpanId: null,
    itemId: null,
    trainId: null,
    releaseId: null,
    commandId: null,
    summary: "",
    data: null,
    ...extra,
  };
}

function train(extra: Partial<NotesTrain> = {}): NotesTrain {
  return {
    trainId: "t1",
    promptId: ITEM,
    seq: 1,
    headSha: HEAD,
    baseSha: "b".repeat(40),
    phase: "MERGED",
    reason: null,
    landedSha: MAIN,
    action: "BUILD",
    model: null,
    traceId: TRACE,
    origin: { kind: "human", id: "ada@example.com" },
    ref: "refs/heads/tip-jar",
    ...extra,
  };
}

const audit = (role: "SECURITY" | "REVIEWER", steps: string[], extra: Partial<QueenEvent> = {}) =>
  ev("drone.audit", {
    itemId: ITEM,
    droneRole: role,
    auditStatus: "REJECTED",
    gitNotesPayload: { taskPrompt: "x", model: "m", temperature: 0, reasoningSteps: steps, result: "failure", executionTimeMs: 1, discardedPaths: [] },
    ...extra,
  });

describe("notes projection", () => {
  it("a pushed submission that passes, lands and ships: PASSED, LANDED, SHIPPED in order; the last verdict is LANDED", () => {
    const events = [
      ev("train.enqueued", { trainId: "t1" }),
      ev("gate.verdict", { trainId: "t1", summary: "gate passed: all checks green", data: { outcome: "PASSED", applied: "applied" } }),
      ev("gate.verdict", { trainId: "t1", summary: "gate passed: replay", data: { outcome: "PASSED", applied: "ignored:duplicate" } }),
      ev("train.phase", { trainId: "t1", data: { from: "LANDING", to: "MERGED" } }),
      ev("release.phase", { releaseId: "r1", data: { from: "CANARY", to: "SHIPPED" } }),
    ];
    const input: NotesInput = { trains: [train()], events, releases: [{ releaseId: "r1", trainIds: ["t1"] }] };
    const [note] = projectNotes(input, "refs/notes/verdict");
    expect(note!.sha).toBe(HEAD);
    const entries = parseNotes(note!.text, { ref: "refs/notes/verdict" });
    expect(entries.map((e) => e.summary)).toEqual(["PASSED: all checks green", `LANDED main@ddddddd (${MAIN})`, "SHIPPED in release r1"]);
    expect(entries.map((e) => e.verdict)).toEqual(["PASSED", "LANDED", undefined]);
    expect(currentVerdict(entries)).toBe("LANDED");
    expect(entries[0]).toMatchObject({ kind: "verdict", itemId: ITEM, trainId: "t1", traceId: TRACE, origin: "human:ada@example.com" });
    const prov = parseNotes(projectNotes(input, "refs/notes/provenance")[0]!.text);
    expect(prov).toEqual([expect.objectContaining({ kind: "provenance", summary: "PUSHED by human:ada@example.com" })]);
    expect(projectNotes(input, "refs/notes/review")).toEqual([]);
  });

  it("a rejection: REJECTED by <role> with its findings on verdict and review; the findings round-trip through parseNotes", () => {
    const events = [
      ev("train.enqueued", { trainId: "t1" }),
      audit("SECURITY", ["security: 1 finding(s) in 3 files", "[error] egress-allowlist src/features/tip-jar.js:12: fetch to non-allowlisted host \"tips.example.com\""]),
      audit("REVIEWER", ["verdict: REJECT", "missing: takes tips", "feedback: no"]),
      ev("train.phase", { trainId: "t1", data: { from: "TESTING", to: "EJECTED", reason: "failed: x" } }),
      ev("gate.verdict", { trainId: "t1", summary: "gate failed: fetch to a non-allowlisted host", data: { outcome: "FAILED", applied: "applied" } }),
      audit("SECURITY", ["[error] late src/x.js:1: after the verdict"]),
    ];
    const input: NotesInput = { trains: [train({ phase: "EJECTED", landedSha: null })], events, releases: [] };
    const verdict = parseNotes(projectNotes(input, "refs/notes/verdict")[0]!.text);
    expect(verdict).toHaveLength(1);
    expect(verdict[0]).toMatchObject({ verdict: "REJECTED", summary: "REJECTED by SECURITY: fetch to a non-allowlisted host" });
    expect(verdict[0]!.body).toMatch(/^Push a fix to tip-jar, or hand off/);
    expect(verdict[0]!.findings).toEqual([
      { severity: "error", path: "src/features/tip-jar.js", line: 12, message: 'egress-allowlist: fetch to non-allowlisted host "tips.example.com"' },
      { severity: "error", path: "acceptance", message: "not satisfied: takes tips" },
    ]);
    const review = parseNotes(projectNotes(input, "refs/notes/review")[0]!.text);
    expect(review).toEqual([expect.objectContaining({ kind: "finding", summary: "Findings: 2 from SECURITY, REVIEWER", findings: verdict[0]!.findings })]);
  });

  it("per-train findings: an audit naming its train (and head) counts only for it; an INFRA round's audits are not the later verdict's", () => {
    const SIB = "e".repeat(40);
    const events = [
      ev("train.enqueued", { trainId: "t1" }),
      ev("train.enqueued", { trainId: "t2" }),
      // An infra round on t1: its POLICY "rejection" is the gate failing to run, not a finding of the final verdict.
      audit("SECURITY", ["[error] infra src/infra.js:1: could not clone"], { trainId: "t1", data: { commitSha: HEAD } }),
      ev("gate.verdict", { trainId: "t1", summary: "gate could not run (infrastructure; re-gating): 503", data: { outcome: "INFRA", applied: "applied" } }),
      audit("SECURITY", ["[error] mine src/mine.js:1: t1's finding"], { trainId: "t1", data: { commitSha: HEAD } }),
      audit("SECURITY", ["[error] sibling src/sibling.js:1: t2's finding"], { trainId: "t2", data: { commitSha: SIB } }),
      audit("SECURITY", ["[error] stale src/stale.js:1: an older head of t1"], { trainId: "t1", data: { commitSha: "f".repeat(40) } }),
      audit("REVIEWER", ["missing: legacy audit without a train"]),
      ev("gate.verdict", { trainId: "t1", summary: "gate failed: x", data: { outcome: "FAILED", applied: "applied" } }),
      ev("gate.verdict", { trainId: "t2", summary: "gate failed: y", data: { outcome: "FAILED", applied: "applied" } }),
    ];
    const input: NotesInput = { trains: [train({ phase: "EJECTED", landedSha: null }), train({ trainId: "t2", seq: 2, headSha: SIB, phase: "EJECTED", landedSha: null })], events, releases: [] };
    const notes = projectNotes(input, "refs/notes/verdict");
    const rejected = (sha: string) => parseNotes(notes.find((n) => n.sha === sha)!.text).find((e) => e.verdict === "REJECTED")!;
    expect(rejected(HEAD).findings!.map((f) => f.path)).toEqual(["src/mine.js", "acceptance"]);
    expect(rejected(SIB).findings!.map((f) => f.path)).toEqual(["src/sibling.js", "acceptance"]);
  });

  it("infra: re-gating rounds say so; INFRA_EXHAUSTED (or an infra-stopped EJECTED row without one) is an INFRA verdict, never REJECTED", () => {
    const infraSummary = "Infrastructure: gate could not run after 4 tries: gate could not run: Reviewer unavailable";
    const regate = ev("gate.verdict", { trainId: "t1", summary: "gate could not run (infrastructure; re-gate 1/3 in 20 s): empty", data: { outcome: "INFRA", applied: "applied", gateInfraRound: 1, of: 3 } });
    const ejected = ev("train.phase", { trainId: "t1", data: { to: "EJECTED", reason: `failed in race: ${infraSummary}` } });
    const exhausted = ev("gate.verdict", { trainId: "t1", summary: "gate could not run after 4 tries (infrastructure); not a verdict on the change: empty", data: { outcome: "INFRA_EXHAUSTED", applied: "applied", tries: 4 } });
    const pushed = train({ phase: "EJECTED", landedSha: null, raceOutcome: "FAILED", summary: infraSummary });
    const verdicts = (events: QueenEvent[], t: NotesTrain = pushed) => parseNotes(projectNotes({ trains: [t], events, releases: [] }, "refs/notes/verdict")[0]!.text);

    const full = verdicts([regate, ejected, exhausted]);
    expect(full.map((e) => e.verdict)).toEqual(["INFRA", "INFRA"]);
    expect(currentVerdict(full)).toBe("INFRA");
    expect(full[1]!.summary).toBe("INFRA: the gate could not run after 4 tries; this is not a verdict on your change. Call retry_gates (MCP) or push again.");
    // An older row: the EJECTED event alone (no INFRA_EXHAUSTED) still reads as infra.
    const old = verdicts([regate, ejected]);
    expect(old.map((e) => e.verdict)).toEqual(["INFRA", "INFRA"]);
    expect(old[1]!.summary).toBe("INFRA: the gate could not run; this is not a verdict on your change. Call retry_gates (MCP) or push again.");
    // A drone train: no MCP advice; a stale INFRA_EXHAUSTED (not applied) is no verdict.
    const drone = verdicts([exhausted], train({ phase: "EJECTED", landedSha: null, origin: null, ref: null, summary: null }));
    expect(drone.find((e) => e.verdict === "INFRA")!.summary).toBe("INFRA: the gate could not run after 4 tries; this is not a verdict on the change.");
    const stale = projectNotes({ trains: [train({ phase: "EJECTED", landedSha: null, summary: null })], events: [ev("gate.verdict", { trainId: "t1", summary: "x", data: { outcome: "INFRA_EXHAUSTED", applied: "ignored:stale", tries: 4 } })], releases: [] }, "refs/notes/verdict");
    expect(stale.flatMap((n) => parseNotes(n.text)).filter((e) => e.verdict)).toEqual([]);
  });

  it("superseded, lost races and conflicts become verdicts; a seeded REWORK replies to the contributor's head", () => {
    const events = [
      ev("train.phase", { trainId: "t1", data: { to: "EJECTED", reason: "superseded by push ccccccc" } }),
      ev("train.phase", { trainId: "t3", data: { to: "EJECTED", reason: "failed: conflict" } }),
      ev("gate.verdict", { trainId: "t2", summary: "gate passed: ok", data: { outcome: "PASSED", applied: "applied" } }),
    ];
    const trains = [
      train({ phase: "EJECTED" }),
      train({ trainId: "t2", seq: 2, headSha: REWORK_HEAD, baseSha: HEAD, action: "REWORK", origin: null, model: "@cf/zai-org/glm-5.3", ref: null }),
      train({ trainId: "t3", seq: 3, headSha: "e".repeat(40), conflict: { paths: ["src/a.js"], summary: "conflict" } }),
    ];
    const notes = projectNotes({ trains, events, releases: [] }, "refs/notes/verdict");
    const by = Object.fromEntries(notes.map((n) => [n.sha, parseNotes(n.text)]));
    expect(by[HEAD]![0]).toMatchObject({ verdict: "SUPERSEDED", summary: "SUPERSEDED: superseded by push ccccccc" });
    expect(by[REWORK_HEAD]![0]).toMatchObject({ verdict: "PASSED", repliesTo: HEAD, origin: "drone:t2" });
    expect(by["e".repeat(40)]![0]).toMatchObject({ verdict: "REJECTED", summary: "REJECTED (CONFLICT): conflicts with work that landed: src/a.js" });
    // Newest head first.
    expect(notes.map((n) => n.sha)).toEqual(["e".repeat(40), REWORK_HEAD, HEAD]);
    const prov = parseNotes(projectNotes({ trains, events, releases: [] }, "refs/notes/provenance").find((n) => n.sha === REWORK_HEAD)!.text);
    expect(prov[0]).toMatchObject({ kind: "provenance", model: "@cf/zai-org/glm-5.3", summary: "BUILT by @cf/zai-org/glm-5.3 (REWORK)", repliesTo: HEAD });
  });

  it("trains without a valid head are not annotated; findings parsing ignores prose", () => {
    expect(projectNotes({ trains: [train({ headSha: null }), train({ trainId: "t9", headSha: "not-a-sha" })], events: [], releases: [] }, "refs/notes/provenance")).toEqual([]);
    expect(findingsFromSteps(["policy: 2 files scanned, no findings", "[warning] rule a.js: m", "missing:  x "])).toEqual([
      { severity: "warning", path: "a.js", message: "rule: m" },
      { severity: "error", path: "acceptance", message: "not satisfied: x" },
    ]);
  });
});
