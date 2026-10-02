import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { parseLedger } from "@queenos/hive-kit";
import { DroneTaskSchema } from "@queenos/queen-types";
import { FakeWorld, remoteOf, setWorld, task } from "./fakes";

afterEach(() => setWorld(null));

describe("DroneWorkflow (Workflows runtime, scripted mode, fake ports)", () => {
  it("runs a full BUILD: real git on MemFS, fake Artifacts remote + Queen", async () => {
    const w = new FakeWorld();
    await w.git.seed("hive-train-wf0000000001");
    setWorld(w);

    const id = "wf-train-1-build";
    await using instance = await introspectWorkflowInstance(env.DRONE_WORKFLOW, id);
    await env.DRONE_WORKFLOW.create({ id, params: DroneTaskSchema.parse(task({ trainId: "wf-train-1", artifactRepo: "hive-train-wf0000000001" })) });
    await instance.waitForStatus("complete");

    const out = (await instance.getOutput()) as { status: string; headSha: string; codeSha: string; ledgerStore: string };
    expect(out).toMatchObject({ action: "BUILD", status: "built", ledgerStore: "git-notes", queenOutcome: "applied" });
    expect(await instance.waitForStepResult({ name: "clone, commit, note, push" })).toMatchObject({ headSha: out.headSha, resumed: false });

    const gen = (await instance.waitForStepResult({ name: "generate change set" })) as { model: string; changeSet: { files: unknown[] } };
    expect(gen.model).toBe("queenos/scripted-drone-v1");
    expect(gen.changeSet.files).toHaveLength(2);

    expect(w.git.pushes.map((p) => [p.url, p.remoteRef])).toEqual([
      [remoteOf("hive-train-wf0000000001"), "main"],
      [remoteOf("hive-train-wf0000000001"), "refs/notes/queen"],
    ]);
    const note = parseLedger((await w.git.repo("hive-train-wf0000000001").readNote(out.codeSha))!);
    expect(note.result).toBe("success");

    const q = w.queen("hive");
    expect(q.calls.map((c) => c.method)).toEqual(["appendAudit", "reportBuildResult", "appendAudit"]);
    expect(q.calls[1]!.input).toEqual({ trainId: "wf-train-1", headSha: out.headSha });
    expect(q.audits().map((a) => a.status)).toEqual(["RUNNING", "PASSED"]);
  });

  it("errors the instance on an invalid task", async () => {
    setWorld(new FakeWorld());
    const id = "wf-bad-task";
    await using instance = await introspectWorkflowInstance(env.DRONE_WORKFLOW, id);
    await env.DRONE_WORKFLOW.create({ id, params: { promptId: "p" } as never });
    await instance.waitForStatus("errored");
    expect((await instance.getError()).message).toMatch(/invalid DroneTask/);
  });
});
