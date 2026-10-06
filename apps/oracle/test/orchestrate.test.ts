import { describe, expect, it } from "vitest";
import { runOracle } from "../src/orchestrate";
import { FakeWorld, InlineSteps, decomposeCmd, permanent, retryable, triageCmd } from "./fakes";

const answer = (children: object[]) => JSON.stringify({ children });
const c = (key: string, over: object = {}) => ({ key, kind: "feature", title: `Item ${key}`, body: "body", acceptance: [], priority: 2, difficulty: "normal", dependsOn: [], paths: [`src/${key}.js`], ...over });

describe("runOracle DECOMPOSE", () => {
  it("lists repo files, calls the LLM with the schema, dedupes, indexes and reports", async () => {
    const w = new FakeWorld();
    w.llm.script = [answer([c("c1"), c("c2", { dependsOn: ["c1"] })])];
    w.memory.similar = [[{ itemId: "i9", score: 0.93 }], []];
    const steps = new InlineSteps();
    const res = await runOracle(decomposeCmd(), steps, w.ports());

    expect(res).toMatchObject({ commandId: "g1-decompose-1", op: "DECOMPOSE", ok: true, queenOutcome: "applied" });
    expect(steps.log.map((s) => s.name)).toEqual(["repo: list files", "decompose: llm", "dedupe: children", "index: children", "report"]);
    const req = w.llm.requests[0]!;
    expect(req.model).toBe("@cf/test/planner");
    expect(req.temperature).toBe(0);
    expect(req.responseFormat?.type).toBe("json_schema");
    expect(req.messages[0]!.content).toContain("src/features/index.js");
    expect(req.messages[0]!.content).toContain("Fix header [READY] paths: src/header.js");

    expect(w.memory.indexed[0]!.items.map((i) => i.id)).toEqual(["g1-c1", "g1-c2"]);
    const reported = w.queen.results[0]!;
    expect(reported.ok).toBe(true);
    expect(reported.children).toHaveLength(2);
    expect(reported.children![0]!.similar).toEqual([{ itemId: "i9", score: 0.93 }]);
    expect(reported.children![1]).toMatchObject({ dependsOn: ["c1"], paths: ["src/c2.js"], similar: [] });
    expect(reported.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(w.queenHives).toEqual(["demo"]);
    expect(w.metrics[0]).toMatchObject({ type: "oracle", hive: "demo", outcome: "ok" });
  });

  it("caps children at limits.maxChildren", async () => {
    const w = new FakeWorld();
    w.llm.script = [answer([c("c1"), c("c2"), c("c3")])];
    await runOracle(decomposeCmd({ limits: { maxChildren: 2 } }), new InlineSteps(), w.ports());
    expect(w.queen.results[0]!.children).toHaveLength(2);
  });

  it("an empty repo listing (failure) still decomposes", async () => {
    const w = new FakeWorld();
    w.repo.error = new Error("clone failed");
    w.llm.script = [answer([c("c1")])];
    await runOracle(decomposeCmd(), new InlineSteps(), w.ports());
    expect(w.llm.requests[0]!.messages[0]!.content).toContain("listing unavailable");
    expect(w.queen.results[0]!.ok).toBe(true);
  });

  it("falls back to the next model when the first fails permanently", async () => {
    const w = new FakeWorld();
    w.llm.script = [permanent(), answer([c("c1")])];
    await runOracle(decomposeCmd(), new InlineSteps(), w.ports());
    expect(w.llm.requests.map((r) => r.model)).toEqual(["@cf/test/planner", "@cf/test/fallback"]);
    expect(w.queen.results[0]).toMatchObject({ ok: true, model: "@cf/test/fallback" });
  });

  it("retries a retryable error once on the same model", async () => {
    const w = new FakeWorld();
    w.llm.script = [retryable(), answer([c("c1")])];
    await runOracle(decomposeCmd(), new InlineSteps(), w.ports());
    expect(w.llm.requests.map((r) => r.model)).toEqual(["@cf/test/planner", "@cf/test/planner"]);
    expect(w.queen.results[0]!.ok).toBe(true);
  });

  it("reports ok:false when every model fails or answers garbage (Queen falls back to one item)", async () => {
    const w = new FakeWorld();
    w.llm.script = ["not json at all"];
    const res = await runOracle(decomposeCmd(), new InlineSteps(), w.ports());
    expect(res.ok).toBe(false);
    expect(w.queen.results[0]).toMatchObject({ ok: false, op: "DECOMPOSE", itemId: "g1" });
    expect(w.queen.results[0]!.children).toBeUndefined();
    expect(w.queen.results[0]!.summary).toMatch(/Decompose failed/);
    expect(w.memory.indexed).toHaveLength(0);
    expect(w.metrics[0]).toMatchObject({ outcome: "failed" });
  });

  it("reports ok:false without an AI binding", async () => {
    const w = new FakeWorld();
    w.withLlm = false;
    await runOracle(decomposeCmd(), new InlineSteps(), w.ports());
    expect(w.queen.results[0]!.ok).toBe(false);
  });

  it("vector failure gives similar: [] and still reports the children", async () => {
    const w = new FakeWorld();
    w.llm.script = [answer([c("c1")])];
    w.memory.findError = new Error("vectorize down");
    w.memory.indexError = new Error("vectorize down");
    const steps = new InlineSteps();
    const res = await runOracle(decomposeCmd(), steps, w.ports());
    expect(res.ok).toBe(true);
    expect(w.queen.results[0]!.children![0]!.similar).toEqual([]);
    expect(steps.log.filter((s) => !s.ok).map((s) => s.name)).toEqual(["dedupe: children", "index: children"]);
  });

  it("retries the report step and treats a permanent Queen error as rejected", async () => {
    const w = new FakeWorld();
    w.llm.script = [answer([c("c1")])];
    w.queen.error = new Error("NOT_FOUND: no such item");
    const res = await runOracle(decomposeCmd(), new InlineSteps(), w.ports());
    expect(res.queenOutcome).toMatch(/^rejected: NOT_FOUND/);
  });

  it("throws on an invalid command (never reported: no commandId)", async () => {
    await expect(runOracle({ op: "NOPE" }, new InlineSteps(), new FakeWorld().ports())).rejects.toThrow(/invalid OracleCommand/);
  });
});

describe("runOracle DECOMPOSE bullet fan-out guard", () => {
  const slugs = ["quote", "uuid", "time", "dice", "coin", "echo", "ping", "hash", "color", "lorem", "joke", "fact"];
  const bullets = slugs.map((s) => `- Add a /features/${s} endpoint returning ${s} JSON`);
  const prompt12 = `Add twelve /features utility endpoints to Pulse\n\n${bullets.join("\n")}`;
  const cmd12 = (over = {}) => decomposeCmd({ promptText: prompt12, limits: { maxChildren: 16 }, ...over });

  it("12 bullets collapsed into one merged child fan out to 12 children", async () => {
    const w = new FakeWorld();
    w.llm.script = [
      answer([c("c1", { title: "Add twelve /features utility endpoints to Pulse", body: "register each route in src/features/index.js", paths: ["src/features/index.js", "src/features/"] })]),
    ];
    await runOracle(cmd12(), new InlineSteps(), w.ports());
    const kids = w.queen.results[0]!.children!;
    expect(kids).toHaveLength(12);
    expect(kids.map((k) => k.key)).toEqual(Array.from({ length: 12 }, (_, n) => `c${n + 1}`));
    expect(kids[1]!.title).toBe("Add a /features/uuid endpoint returning uuid JSON");
    expect(kids.every((k) => k.dependsOn.length === 0 && !k.paths.includes("src/features/index.js"))).toBe(true);
    expect(w.memory.indexed[0]!.items).toHaveLength(12);
  });

  it("reuses the model's per-bullet details when they match", async () => {
    const w = new FakeWorld();
    w.llm.script = [answer([c("c1", { title: "Add a /features/uuid endpoint returning uuid JSON", body: "use crypto.randomUUID() and return it in a long body", acceptance: ["returns 200"], paths: ["src/features/uuid.js", "src/features/index.js"] })])];
    await runOracle(cmd12(), new InlineSteps(), w.ports());
    const kids = w.queen.results[0]!.children!;
    expect(kids).toHaveLength(12);
    const uuid = kids.find((k) => k.title.includes("uuid"))!;
    expect(uuid).toMatchObject({ acceptance: ["returns 200"], paths: ["src/features/uuid.js"] });
    expect(uuid.body).toContain("crypto.randomUUID");
  });

  it("trusts the model when it returns one child per bullet", async () => {
    const w = new FakeWorld();
    w.llm.script = [answer(slugs.map((_, n) => c(`c${n + 1}`)))];
    await runOracle(cmd12(), new InlineSteps(), w.ports());
    expect(w.queen.results[0]!.children!.map((k) => k.title)).toEqual(slugs.map((_, n) => `Item c${n + 1}`));
  });

  it("allows fewer children for exact duplicate bullets, and caps at maxChildren", async () => {
    const w = new FakeWorld();
    const text = "- Add /a endpoint\n- Add /b endpoint\n- add /a endpoint!\n";
    w.llm.script = [answer([c("c1"), c("c2")])];
    await runOracle(decomposeCmd({ promptText: text }), new InlineSteps(), w.ports());
    expect(w.queen.results[0]!.children).toHaveLength(2);
    w.llm.script = [answer([c("c1")])];
    await runOracle(cmd12({ limits: { maxChildren: 5 } }), new InlineSteps(), w.ports());
    expect(w.queen.results[1]!.children).toHaveLength(5);
  });

  it("a vague single-goal prompt keeps the model's grouping", async () => {
    const w = new FakeWorld();
    w.llm.script = [answer([c("c1", { title: "Add a footer and an about page" })])];
    await runOracle(decomposeCmd(), new InlineSteps(), w.ports());
    expect(w.queen.results[0]!.children).toHaveLength(1);
    // a single bullet is not a list either
    await runOracle(decomposeCmd({ promptText: "Polish things\n- make the header nicer" }), new InlineSteps(), w.ports());
    expect(w.queen.results[1]!.children).toHaveLength(1);
  });

  it("strips generated paths from every child and drops generated-only dependsOn edges", async () => {
    const w = new FakeWorld();
    w.llm.script = [
      answer([
        c("c1", { paths: ["src/features/a.js", "src/features/index.js"] }),
        c("c2", { paths: ["src/features/b.js", "src/features/index.js"], dependsOn: ["c1"] }),
        c("c3", { paths: ["src/shared.js", "src/features/index.js"] }),
        c("c4", { paths: ["src/shared.js"], dependsOn: ["c3"] }),
      ]),
    ];
    await runOracle(decomposeCmd(), new InlineSteps(), w.ports());
    const kids = w.queen.results[0]!.children!;
    expect(kids.flatMap((k) => k.paths)).not.toContain("src/features/index.js");
    expect(kids[0]!.paths).toEqual(["src/features/a.js"]);
    expect(kids[1]!.dependsOn).toEqual([]);
    expect(kids[3]!.dependsOn).toEqual(["c3"]); // real shared file: edge kept
  });
});

describe("runOracle TRIAGE", () => {
  it("finds similar items (excluding itself), indexes the item and reports", async () => {
    const w = new FakeWorld();
    w.memory.similar = [{ itemId: "i3", score: 0.95 }];
    const steps = new InlineSteps();
    const res = await runOracle(triageCmd(), steps, w.ports());
    expect(res).toMatchObject({ op: "TRIAGE", ok: true });
    expect(steps.log.map((s) => s.name)).toEqual(["triage: similar", "triage: index", "report"]);
    expect(w.memory.finds[0]).toMatchObject({ namespace: "demo", opts: { topK: 5, excludeIds: ["b1"] } });
    expect(w.memory.indexed[0]!.items[0]!.id).toBe("b1");
    expect(w.queen.results[0]).toMatchObject({ commandId: "b1-triage-1", ok: true, similar: [{ itemId: "i3", score: 0.95 }] });
    expect(w.llm.requests).toHaveLength(0);
  });

  it("vector failure -> similar: []", async () => {
    const w = new FakeWorld();
    w.memory.findError = new Error("down");
    await runOracle(triageCmd(), new InlineSteps(), w.ports());
    expect(w.queen.results[0]).toMatchObject({ ok: true, similar: [] });
  });
});
