import { describe, expect, it } from "vitest";
import { AiGatewayError, ledgerFilePath, parseLedger } from "@queenos/hive-kit";
import { DroneTaskSchema } from "@queenos/queen-types";
import { commitAndPush, droneTrailer, generateChangeSet } from "../src/build";
import { readConfig } from "../src/config";
import { DroneFailedError, runDrone } from "../src/orchestrate";
import { SCRIPTED_MODEL, scriptedChangeSet } from "../src/scripted";
import { FakeLlm, FakeWorld, InlineSteps, remoteOf, task } from "./fakes";

const scripted = readConfig({ DRONE_LLM_MODE: "scripted", DRONE_SCRIPTED_DELAY_MS: "1500" });
const live = readConfig({ DRONE_LLM_MODE: "live", DRONE_HARNESS: "single-shot", AI_GATEWAY_ID: "gw" });

async function world(repo = "hive-train-aaaaaaaaaaaa") {
  const w = new FakeWorld();
  const base = await w.git.seed(repo);
  return { w, base };
}

describe("BUILD (scripted)", () => {
  it("clones, commits, notes, pushes and reports to the Queen", async () => {
    const { w, base } = await world();
    const steps = new InlineSteps();
    const out = await runDrone(task(), steps, w.ports(), scripted);

    expect(out).toMatchObject({ action: "BUILD", status: "built", ledgerStore: "git-notes", queenOutcome: "applied" });
    if (out.status !== "built") throw new Error("unreachable");
    expect(out.headSha).toBe(out.codeSha);

    expect(steps.names()).toEqual([
      "clock: start",
      "audit: running",
      "generate change set",
      "clock: generated",
      "clone, commit, note, push",
      "report: build result",
      "audit: passed",
    ]);
    expect(steps.sleeps).toEqual([{ name: "scripted: thinking", ms: 1500 }]);

    // Write token minted for the fork; clone of main at depth 1.
    expect(w.artifacts.calls).toEqual([{ repo: "hive-train-aaaaaaaaaaaa", scope: "write" }]);
    expect(w.git.clones).toEqual([expect.objectContaining({ remote: remoteOf("hive-train-aaaaaaaaaaaa"), ref: "main", depth: 1 })]);

    // Branch pushed, then the notes ref.
    expect(w.git.pushes.map((p) => [p.remoteRef, p.oid])).toEqual([
      ["main", out.codeSha],
      ["refs/notes/queen", expect.stringMatching(/^[0-9a-f]{40}$/)],
    ]);

    // The commit is real: parent = fork base, scripted files, drone trailer, fixed timestamp.
    const repo = w.git.repo("hive-train-aaaaaaaaaaaa");
    const head = await repo.head();
    expect(head?.parents).toEqual([base]);
    expect(head?.message).toContain(droneTrailer(DroneTaskSchema.parse(task())));
    const files = await repo.listFiles();
    for (const f of scriptedChangeSet(DroneTaskSchema.parse(task())).files) expect(files).toContain(f.path);
    expect(files).toContain("src/features/index.js");

    // Ledger note on the code commit.
    const note = parseLedger((await repo.readNote(out.codeSha))!);
    expect(note).toMatchObject({ taskPrompt: task().promptText, model: SCRIPTED_MODEL, temperature: 0, result: "success" });
    expect(note.reasoningSteps.length).toBeGreaterThan(2);
    expect(note.executionTimeMs).toBeGreaterThanOrEqual(0);

    // Queen: RUNNING audit, build result, PASSED audit carrying the same ledger.
    const q = w.queen("hive");
    expect(q.calls.map((c) => c.method)).toEqual(["appendAudit", "reportBuildResult", "appendAudit"]);
    expect(q.calls[1]!.input).toEqual({ trainId: "train-1", headSha: out.headSha, model: SCRIPTED_MODEL, buildMs: expect.any(Number), changedPaths: expect.arrayContaining(["src/features/index.js"]) });
    const [running, passed] = q.audits();
    expect(running).toMatchObject({ promptId: "prompt-1", droneRole: "BUILDER", status: "RUNNING", gitNotesPayload: null });
    expect(passed).toMatchObject({ droneRole: "BUILDER", status: "PASSED", gitNotesPayload: note });
  });

  it("keeps earlier features registered when a second train builds on the first", async () => {
    const { w } = await world();
    await runDrone(task({ promptId: "p-a", promptText: "Add search" }), new InlineSteps(), w.ports(), scripted);
    await runDrone(task({ promptId: "p-b", promptText: "Add export [fail]" }), new InlineSteps(), w.ports(), scripted);
    const registry = (await w.git.repo("hive-train-aaaaaaaaaaaa").readFiles(["src/features/index.js"]))["src/features/index.js"]!;
    expect(registry.match(/^import \* as /gm)).toHaveLength(2);
    expect(registry).toMatch(/add-export-fail-[0-9a-f]{8}\.js/);
    expect(registry).toMatch(/add-search-[0-9a-f]{8}\.js/);
    expect(registry).toContain("export const features = [f0, f1];");
  });

  it("falls back to .queen/ledger/<sha>.json when the notes push is refused", async () => {
    const { w } = await world();
    w.git.rejectNotes = true;
    const out = await runDrone(task(), new InlineSteps(), w.ports(), scripted);
    if (out.status !== "built") throw new Error("expected built");

    expect(out.ledgerStore).toBe("ledger-file");
    expect(out.notesError).toMatch(/refs\/notes/);
    expect(out.headSha).not.toBe(out.codeSha);

    const repo = w.git.repo("hive-train-aaaaaaaaaaaa");
    const ledgerCommit = await repo.head();
    expect(ledgerCommit?.oid).toBe(out.headSha);
    expect(ledgerCommit?.parents).toEqual([out.codeSha]);
    expect(ledgerCommit?.message).toContain(`Queen-Ledger-For: ${out.codeSha}`);
    const files = await repo.readFiles([ledgerFilePath(out.codeSha)]);
    expect(parseLedger(files[ledgerFilePath(out.codeSha)]!)).toMatchObject({ result: "success", model: SCRIPTED_MODEL });

    // Two branch pushes (code, then ledger commit); the Queen tests the ledger commit.
    expect(w.git.pushes.map((p) => p.remoteRef)).toEqual(["main", "main"]);
    expect(w.queen("hive").calls[1]!.input).toMatchObject({ trainId: "train-1", headSha: out.headSha, model: SCRIPTED_MODEL });
  });

  it("a retried commit step recognises its own pushed work (no duplicate commit)", async () => {
    const { w } = await world();
    const t = DroneTaskSchema.parse(task());
    const gen = await generateChangeSet(t, w.ports(), scripted);
    const input = {
      task: t,
      changeSet: gen.changeSet,
      ledger: { taskPrompt: t.promptText, model: gen.model, temperature: 0, reasoningSteps: [], result: "success" as const, executionTimeMs: 1, discardedPaths: [] },
      timestamp: 1_790_000_000,
    };
    const first = await commitAndPush(w.ports(), input);
    const second = await commitAndPush(w.ports(), input);
    expect(first.resumed).toBe(false);
    expect(second).toMatchObject({ resumed: true, codeSha: first.codeSha, headSha: first.headSha });

    w.git.rejectNotes = true; // retry after a ledger-file fallback was pushed
    const t2 = { ...t, trainId: "train-2", promptId: "prompt-2" };
    const input2 = { ...input, task: t2, changeSet: (await generateChangeSet(t2, w.ports(), scripted)).changeSet };
    const fb = await commitAndPush(w.ports(), input2);
    const again = await commitAndPush(w.ports(), input2);
    expect(again).toEqual({ headSha: fb.headSha, codeSha: fb.codeSha, ledgerStore: "ledger-file", resumed: true, changedPaths: fb.changedPaths });
  });

  it("fixed timestamps give the same SHA for the same task on the same base", async () => {
    const t = DroneTaskSchema.parse(task());
    const run = async () => {
      const { w } = await world();
      const gen = await generateChangeSet(t, w.ports(), scripted);
      const ledger = { taskPrompt: "p", model: "m", temperature: 0, reasoningSteps: [], result: "success" as const, executionTimeMs: 1, discardedPaths: [] };
      return (await commitAndPush(w.ports(), { task: t, changeSet: gen.changeSet, ledger, timestamp: 1_790_000_000 })).codeSha;
    };
    expect(await run()).toBe(await run());
  });
});

describe("BUILD / REWORK (live LLM via fake gateway)", () => {
  const reply = JSON.stringify({
    files: [{ path: "src/features/theme.js", content: 'export const slug = "theme";\nexport function handle() { return Response.json({ dark: true }); }\n' }],
    reasoningSteps: ["fixed null theme"],
    discardedPaths: ["src/legacy-theme.ts"],
  });

  it("REWORK sends RAG memory + Scribe summary, no temperature, and records the model", async () => {
    const { w } = await world();
    const llm = new FakeLlm(() => reply);
    w.llm = llm;
    const t = task({ action: "REWORK", ragContext: ["theme tokens live in src/theme.ts"], scribeSummary: "Tests failed: theme was null." });
    const out = await runDrone(t, new InlineSteps(), w.ports(), live);

    expect(out).toMatchObject({ action: "REWORK", status: "built" });
    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0]!;
    expect(req.system).toMatch(/QueenOS builder drone/);
    expect(req.messages[0]!.content).toContain("theme tokens live in src/theme.ts");
    expect(req.messages[0]!.content).toContain("Tests failed: theme was null.");
    expect(req).not.toHaveProperty("temperature");

    const passed = w.queen("hive").audits()[1]!;
    expect(passed.gitNotesPayload).toMatchObject({
      model: "@cf/zai-org/glm-5.3-flash",
      reasoningSteps: ["fixed null theme"],
      discardedPaths: ["src/legacy-theme.ts"],
    });
    const repo = w.git.repo("hive-train-aaaaaaaaaaaa");
    expect(Object.keys(await repo.readFiles(["src/features/theme.js"]))).toEqual(["src/features/theme.js"]);
    // The model never touched the registry: the drone registered the new module for it.
    expect((await repo.readFiles(["src/features/index.js"]))["src/features/index.js"]).toContain('import * as f0 from "./theme.js";');
    // The prompt carries the repo's real file list; the Queen hears which model built it.
    expect(req.messages[0]!.content).toContain("<repo_files>");
    expect(w.queen("hive").calls.find((c) => c.method === "reportBuildResult")?.input).toMatchObject({ model: "@cf/zai-org/glm-5.3-flash", buildMs: expect.any(Number) });
    expect(w.artifacts.calls.map((c) => c.scope)).toEqual(["read", "write"]);
  });

  it("repairs once, then falls over models; exhausting them reports a failed train and a REJECTED audit (no step retries)", async () => {
    const { w } = await world();
    const llm = new FakeLlm(() => "I cannot produce JSON today");
    w.llm = llm;
    const steps = new InlineSteps();
    await expect(runDrone(task(), steps, w.ports(), live)).rejects.toBeInstanceOf(DroneFailedError);

    expect(steps.log.find((l) => l.name === "generate change set")).toEqual({ name: "generate change set", attempts: 1, ok: false });
    expect(llm.requests).toHaveLength(2); // first try + the single repair turn on the only model
    const q = w.queen("hive");
    const failure = q.calls.find((c) => c.method === "reportTrainResult");
    expect(failure?.input).toMatchObject({ trainId: "train-1", passed: false, summary: expect.stringMatching(/generation: no usable change set from @cf\/zai-org\/glm-5.3-flash: no JSON object/) });
    expect(q.audits().map((a) => a.status)).toEqual(["RUNNING", "REJECTED"]);
    expect(q.audits()[1]!.gitNotesPayload).toMatchObject({ result: "failure" });
    expect(w.git.pushes).toEqual([]);
  });

  it("does not retry non-retryable gateway errors (401)", async () => {
    const { w } = await world();
    w.llm = new FakeLlm(() => new AiGatewayError("AI run failed: 401 bad token", 401, false));
    const steps = new InlineSteps();
    await expect(runDrone(task(), steps, w.ports(), live)).rejects.toThrow(/401/);
    expect(steps.log.find((l) => l.name === "generate change set")?.attempts).toBe(1);
  });
});

describe("LAND", () => {
  async function landWorld() {
    const { w } = await world();
    await w.git.seed("hive");
    // The builder already pushed a train head to the fork.
    const built = await runDrone(task(), new InlineSteps(), w.ports(), scripted);
    if (built.status !== "built") throw new Error("setup");
    return { w, head: built.headSha };
  }

  it("pushes the train head to the hive repo's main and reports the new main SHA", async () => {
    const { w, head } = await landWorld();
    w.git.pushes.length = 0;
    const steps = new InlineSteps();
    const out = await runDrone(task({ role: "LANDER", action: "LAND", baseRef: head }), steps, w.ports(), scripted);

    expect(out).toMatchObject({ action: "LAND", status: "landed", mainSha: head, queenOutcome: "applied" });
    expect(w.artifacts.calls.slice(-2)).toEqual([
      { repo: "hive-train-aaaaaaaaaaaa", scope: "read" },
      { repo: "hive", scope: "write" },
    ]);
    expect(w.git.pushes).toEqual([{ url: remoteOf("hive"), ref: "refs/heads/queen-land", remoteRef: "refs/heads/main", oid: head }]);

    const q = w.queen("hive");
    const land = q.calls.find((c) => c.method === "reportLandResult");
    expect(land?.input).toMatchObject({ trainId: "train-1", landed: true, mainSha: head });
    expect(q.audits().slice(-2)).toEqual([
      expect.objectContaining({ droneRole: "LANDER", status: "RUNNING" }),
      expect.objectContaining({ droneRole: "LANDER", status: "PASSED", gitNotesPayload: expect.objectContaining({ result: "success" }) }),
    ]);
    expect(steps.names()).toContain("land: push train head to hive main");
  });

  it("reports landed:false on a non-fast-forward", async () => {
    const { w, head } = await landWorld();
    w.git.nonFastForward.add(remoteOf("hive"));
    const out = await runDrone(task({ role: "LANDER", action: "LAND", baseRef: head }), new InlineSteps(), w.ports(), scripted);

    expect(out).toMatchObject({ status: "not-landed", summary: expect.stringMatching(/not a fast-forward/) });
    const q = w.queen("hive");
    expect(q.calls.find((c) => c.method === "reportLandResult")?.input).toEqual({
      trainId: "train-1",
      landed: false,
      summary: expect.stringMatching(/hive\/main moved/),
    });
    expect(q.audits().at(-1)).toMatchObject({ droneRole: "LANDER", status: "REJECTED" });
  });

  it("a 503 that outlasts every retry is reported landed:false with cause infra + this instance's id (not a plain failure)", async () => {
    const { w, head } = await landWorld();
    const access = w.artifacts.access.bind(w.artifacts);
    let hiveCalls = 0;
    w.artifacts.access = async (repo, scope) => {
      if (repo === "hive") {
        hiveCalls++;
        throw Object.assign(new Error("HTTP Error: 503 Service Unavailable"), { name: "HttpError" });
      }
      return access(repo, scope);
    };
    const net = { attempts: 2, random: () => 0, sleep: async () => undefined };
    const steps = new InlineSteps();
    const out = await runDrone(task({ role: "LANDER", action: "LAND", baseRef: head }), steps, w.ports(), scripted, { net });
    expect(out).toMatchObject({ status: "not-landed", summary: expect.stringMatching(/Lander failed: .*503/) });
    expect(hiveCalls).toBe(2 * 4); // in-step tries x (1 + LAND_STEP retries): transient stays retryable
    expect(w.queen("hive").calls.find((c) => c.method === "reportLandResult")?.input).toMatchObject({
      trainId: "train-1", landed: false, cause: "infra", commandId: "train-1-land",
    });
  });

  it("a 503 then success lands normally", async () => {
    const { w, head } = await landWorld();
    const access = w.artifacts.access.bind(w.artifacts);
    let n = 0;
    w.artifacts.access = async (repo, scope) => {
      if (repo === "hive" && ++n === 1) throw Object.assign(new Error("HTTP Error: 503 Service Unavailable"), { name: "HttpError" });
      return access(repo, scope);
    };
    const net = { attempts: 3, random: () => 0, sleep: async () => undefined };
    const out = await runDrone(task({ role: "LANDER", action: "LAND", baseRef: head }), new InlineSteps(), w.ports(), scripted, { net });
    expect(out).toMatchObject({ status: "landed", mainSha: head });
    expect((w.queen("hive").calls.find((c) => c.method === "reportLandResult")!.input as { cause?: string }).cause).toBeUndefined();
  });

  it("reports landed:false when the train head is not in the fork", async () => {
    const { w } = await landWorld();
    const out = await runDrone(task({ role: "LANDER", action: "LAND", baseRef: "f".repeat(40) }), new InlineSteps(), w.ports(), scripted);
    expect(out).toMatchObject({ status: "not-landed", summary: expect.stringMatching(/not in fork/) });
  });
});

describe("input validation", () => {
  it("rejects a malformed task without retrying", async () => {
    const { w } = await world();
    await expect(runDrone({ trainId: "x" }, new InlineSteps(), w.ports(), scripted)).rejects.toBeInstanceOf(DroneFailedError);
  });
});
