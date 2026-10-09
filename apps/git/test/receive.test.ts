import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGit } from "../src/index";
import { REFUSALS } from "../src/receive";
import { fakePack, HIVE, MAIN_SHA, NEW_SHA, OTHER_SHA, pushBody, pushRequest, readReport, TRAIN_ID, TRAIN_REPO, USER, World, ZERO } from "./fakes";

let world: World;
let logs: string[];

beforeEach(() => {
  world = new World();
  logs = [];
  for (const k of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  }
});

afterEach(() => {
  // Artifacts tokens never appear in logs (§8.2), whatever the test did.
  expect(logs.join("\n")).not.toMatch(/art_v1_/);
  for (const plain of world.tokens.keys()) expect(logs.join("\n")).not.toContain(plain);
  vi.restoreAllMocks();
});

const push = (cmds: [string, string, string][], packBytes = 2048, opts: { chunkedBody?: boolean; scopes?: string; caps?: string } = {}) =>
  handleGit(pushRequest(pushBody(cmds, fakePack(packBytes), opts.caps), opts), world.deps());

describe("pre-receive refusals (§4.3)", () => {
  it("refuses a push to main with report-status ng and remote: lines; nothing reaches the Queen or Artifacts", async () => {
    const res = await push([[MAIN_SHA, NEW_SHA, "refs/heads/main"]], 4096, { chunkedBody: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-receive-pack-result");
    const r = await readReport(res);
    expect(r.lines).toEqual(["unpack ok", `ng refs/heads/main ${REFUSALS.main}`]);
    expect(r.remote).toEqual([
      "QueenOS: push refused",
      `QueenOS:   refs/heads/main: ${REFUSALS.main}`,
      "QueenOS: push a branch instead, e.g. git push origin HEAD:item/<id>",
    ]);
    expect(world.calls.intent).toHaveLength(0);
    expect(world.forks).toHaveLength(0);
    expect(world.received).toHaveLength(0);
  });

  it.each([
    ["a delete", [[OTHER_SHA, ZERO, "refs/heads/old"]], REFUSALS.deletion],
    ["a tag", [[ZERO, NEW_SHA, "refs/tags/v1"]], REFUSALS.branchesOnly],
    ["a notes ref", [[ZERO, NEW_SHA, "refs/notes/verdict"]], REFUSALS.branchesOnly],
    ["a bad item target", [[ZERO, NEW_SHA, "refs/heads/item/has.dot"]], REFUSALS.badItem],
    ["a bad goal target", [[ZERO, NEW_SHA, "refs/heads/goal/"]], REFUSALS.badGoal],
    ["a bad agent suffix", [[ZERO, NEW_SHA, "refs/heads/item/14/bad!"]], REFUSALS.badItem],
    ["a dot-leading agent suffix", [[ZERO, NEW_SHA, "refs/heads/item/14/.hidden"]], REFUSALS.badItem],
    ["an agent suffix with '..'", [[ZERO, NEW_SHA, "refs/heads/goal/tip-jar/a..b"]], REFUSALS.badGoal],
    ["an agent suffix ending in .lock", [[ZERO, NEW_SHA, "refs/heads/item/14/opus.lock"]], REFUSALS.badItem],
    ["an empty agent suffix", [[ZERO, NEW_SHA, "refs/heads/item/14/"]], REFUSALS.badItem],
    ["a bad id before an agent suffix", [[ZERO, NEW_SHA, "refs/heads/item/has.dot/haiku"]], REFUSALS.badItem],
    ["a nested ref under the agent suffix", [[ZERO, NEW_SHA, "refs/heads/goal/tip-jar/haiku/extra"]], REFUSALS.badGoal],
  ] as [string, [string, string, string][], string][])("refuses %s", async (_, cmds, reason) => {
    const r = await readReport(await push(cmds));
    expect(r.lines).toEqual(["unpack ok", `ng ${cmds[0]![2]} ${reason}`]);
    expect(r.remote[0]).toBe("QueenOS: push refused");
    expect(world.calls.intent).toHaveLength(0);
  });

  it("refuses a two-ref push: each ref gets its own reason or 'one branch per submission'", async () => {
    const r = await readReport(
      await push([
        [ZERO, NEW_SHA, "refs/heads/item/14"],
        [MAIN_SHA, NEW_SHA, "refs/heads/main"],
      ]),
    );
    expect(r.lines).toEqual(["unpack ok", `ng refs/heads/item/14 ${REFUSALS.oneBranch}`, `ng refs/heads/main ${REFUSALS.main}`]);
    expect(world.calls.intent).toHaveLength(0);
  });

  it("refuses a read-only token", async () => {
    const r = await readReport(await push([[ZERO, NEW_SHA, "refs/heads/tip-jar"]], 100, { scopes: "read" }));
    expect(r.lines).toEqual(["unpack ok", `ng refs/heads/tip-jar ${REFUSALS.scope}`]);
    expect(world.tokens.size).toBe(0);
  });

  it("answers a client without side-band with a plain report (no remote: lines possible)", async () => {
    const res = await push([[MAIN_SHA, NEW_SHA, "refs/heads/main"]], 100, { caps: "report-status" });
    const r = await readReport(res, false);
    expect(r.lines).toEqual(["unpack ok", `ng refs/heads/main ${REFUSALS.main}`]);
  });

  it("refuses a declared pack over the cap before asking the Queen", async () => {
    const res = await handleGit(pushRequest(pushBody([[ZERO, NEW_SHA, "refs/heads/big"]], fakePack(5000))), world.deps({ maxPackBytes: 1000 }));
    const r = await readReport(res);
    expect(r.lines).toEqual(["unpack ok", `ng refs/heads/big ${REFUSALS.tooLarge}`]);
    expect(world.calls.intent).toHaveLength(0);
  });

  it("prints the Queen's refusal (refuse verdict) and forks nothing", async () => {
    world.intent = { verdict: "refuse", reason: "no item 99 in this hive", messages: ["push refused: no item 99 in this hive"] };
    const r = await readReport(await push([[ZERO, NEW_SHA, "refs/heads/item/99"]]));
    expect(r.lines).toEqual(["unpack ok", "ng refs/heads/item/99 no item 99 in this hive"]);
    expect(r.remote).toEqual(["QueenOS: push refused: no item 99 in this hive"]);
    expect(world.calls.intent).toEqual([{ hive: HIVE, user: USER, ref: "refs/heads/item/99", oldSha: ZERO, newSha: NEW_SHA }]);
    expect(world.forks).toHaveLength(0);
    expect(world.calls.aborted).toHaveLength(0);
  });
});

describe("per-agent branches (item/<id>/<agent>)", () => {
  it.each(["refs/heads/item/14/haiku", "refs/heads/item/14/claude-opus_4.1", "refs/heads/goal/tip-jar/codex"])("passes %s to the Queen unchanged", async (ref) => {
    world.intent = { verdict: "refuse", reason: "stop here", messages: [] };
    const r = await readReport(await push([[ZERO, NEW_SHA, ref]]));
    expect(r.lines).toEqual(["unpack ok", `ng ${ref} stop here`]);
    expect(world.calls.intent).toEqual([{ hive: HIVE, user: USER, ref, oldSha: ZERO, newSha: NEW_SHA }]);
  });
});

describe("accepted push (§4.2)", () => {
  it.each([
    ["chunked", true],
    ["content-length", false],
  ])("intent → fork → forward (ref rewritten, %s) → report-status rewritten → gitPushed → messages", async (_, chunkedBody) => {
    world.intent = { verdict: "accept", trainId: TRAIN_ID, repo: TRAIN_REPO, messages: ["replaces your earlier push cccccccccccc (train t0)"] };
    const res = await push([[ZERO, NEW_SHA, "refs/heads/item/14"]], 70_000, { chunkedBody });
    const r = await readReport(res);

    expect(world.calls.intent).toEqual([{ hive: HIVE, user: USER, ref: "refs/heads/item/14", oldSha: ZERO, newSha: NEW_SHA }]);
    expect(world.forks).toEqual([TRAIN_REPO]);
    // The fork got the client's pack untouched, with the command rewritten onto its main.
    expect(world.received).toHaveLength(1);
    const up = world.received[0]!;
    expect(up.repo).toBe(TRAIN_REPO);
    expect(up.auth).toBe("write");
    expect(up.commands).toEqual([`${MAIN_SHA} ${NEW_SHA} refs/heads/main`]);
    expect(up.caps).toContain("side-band-64k");
    expect(up.packBytes).toBe(70_000);
    if (chunkedBody) expect(up.contentLength).toBeNull();
    else expect(Number(up.contentLength)).toBeGreaterThan(70_000);

    expect(r.lines).toEqual(["unpack ok", "ok refs/heads/item/14"]);
    expect(r.remote).toEqual([
      "Artifacts: stored",
      "QueenOS: replaces your earlier push cccccccccccc (train t0)",
      "QueenOS: submission received → item 14 (joined its race)",
      "QueenOS: train 7a90… · verdict in ~2 min",
      "QueenOS: git fetch origin '+refs/notes/*:refs/notes/*' && git log --notes=verdict -1",
    ]);
    expect(world.calls.pushed).toEqual([
      {
        hive: HIVE,
        trainId: TRAIN_ID,
        repo: TRAIN_REPO,
        ref: "refs/heads/item/14",
        headSha: NEW_SHA,
        baseSha: MAIN_SHA,
        title: "Add a tip jar at /features/tip-jar",
        message: world.pushMessage,
        trailers: { "queen-origin": "agent:claude-code", "queen-replies-to": "e".repeat(40) },
      },
    ]);
    expect(world.calls.aborted).toHaveLength(0);
  });

  it("only hive main read tokens and train-fork write tokens are ever minted", async () => {
    await push([[ZERO, NEW_SHA, "refs/heads/tip-jar"]]);
    const minted = [...world.tokens.values()].map((t) => `${t.scope} ${t.repo}`).sort();
    expect(minted).toEqual([`read ${HIVE}`, `write ${TRAIN_REPO}`]);
  });

  it("re-forks under -r2 when the fresh fork inherits a 503 episode, and deletes the sick one", async () => {
    world.sick.add(TRAIN_REPO);
    const r = await readReport(await push([[ZERO, NEW_SHA, "refs/heads/tip-jar"]]));
    expect(r.lines).toEqual(["unpack ok", "ok refs/heads/tip-jar"]);
    expect(world.forks).toEqual([TRAIN_REPO, `${TRAIN_REPO}-r2`]);
    expect(world.deleted).toEqual([TRAIN_REPO]);
    expect(world.received[0]!.repo).toBe(`${TRAIN_REPO}-r2`);
    expect(world.calls.pushed[0]!.repo).toBe(`${TRAIN_REPO}-r2`);
  });

  it("re-forks under -r2 when the fork call fails with INTERNAL_ERROR (ghost name)", async () => {
    world.forkErrors.set(TRAIN_REPO, "INTERNAL_ERROR");
    const r = await readReport(await push([[ZERO, NEW_SHA, "refs/heads/tip-jar"]]));
    expect(r.lines).toEqual(["unpack ok", "ok refs/heads/tip-jar"]);
    expect(world.received[0]!.repo).toBe(`${TRAIN_REPO}-r2`);
  });
});

describe("failures after the intent (§9)", () => {
  it("calls gitAborted and answers ng 'retry the push' when the upstream dies mid-push", async () => {
    world.receiveMode = "throw";
    const r = await readReport(await push([[ZERO, NEW_SHA, "refs/heads/tip-jar"]], 50_000, { chunkedBody: true }));
    expect(r.lines).toEqual(["unpack ok", `ng refs/heads/tip-jar ${REFUSALS.transient}`]);
    expect(world.calls.aborted).toHaveLength(1);
    expect(world.calls.aborted[0]).toMatchObject({ hive: HIVE, trainId: TRAIN_ID });
    expect(world.calls.aborted[0]!.reason).toMatch(/upstream receive-pack failed/);
    expect(world.calls.pushed).toHaveLength(0);
  });

  it("calls gitAborted on an upstream 500, with evidence in the reason and no token anywhere", async () => {
    world.receiveMode = "500";
    const r = await readReport(await push([[ZERO, NEW_SHA, "refs/heads/tip-jar"]]));
    expect(r.lines[1]).toBe(`ng refs/heads/tip-jar ${REFUSALS.transient}`);
    expect(world.calls.aborted[0]!.reason).toMatch(/HTTP 500 receive-pack body="internal \[redacted\]"/);
  });

  it("calls gitAborted when Artifacts refuses the ref update", async () => {
    world.receiveMode = "ng";
    const r = await readReport(await push([[ZERO, NEW_SHA, "refs/heads/tip-jar"]]));
    expect(r.lines[1]).toBe("ng refs/heads/tip-jar rejected by storage: failed to lock");
    expect(world.calls.aborted).toHaveLength(1);
  });

  it("enforces the size cap while streaming: aborts the upstream, gitAborted, ng 'push too large'", async () => {
    const res = await handleGit(pushRequest(pushBody([[ZERO, NEW_SHA, "refs/heads/big"]], fakePack(20_000)), { chunkedBody: true }), world.deps({ maxPackBytes: 5000 }));
    const r = await readReport(res);
    expect(r.lines).toEqual(["unpack ok", `ng refs/heads/big ${REFUSALS.tooLarge}`]);
    expect(r.remote).toEqual([`QueenOS: push refused: ${REFUSALS.tooLarge}`]);
    expect(world.calls.aborted).toHaveLength(1);
    expect(world.calls.aborted[0]!.reason).toMatch(/pack over 5000 bytes/);
    expect(world.calls.pushed).toHaveLength(0);
    // The upstream never got a complete push.
    expect(world.received.every((p) => p.packBytes <= 5000)).toBe(true);
  });

  it("deletes its own -rN fork on abort (the Queen deletes only the name it chose)", async () => {
    world.sick.add(TRAIN_REPO);
    world.receiveMode = "500";
    await readReport(await push([[ZERO, NEW_SHA, "refs/heads/tip-jar"]]));
    expect(world.deleted).toEqual([TRAIN_REPO, `${TRAIN_REPO}-r2`]);
  });

  it("answers 'intent expired' on a gitPushed CONFLICT", async () => {
    world.pushedError = new Error("CONFLICT: push intent x is no longer open (aborted:transient); retry the push");
    const r = await readReport(await push([[ZERO, NEW_SHA, "refs/heads/tip-jar"]]));
    expect(r.lines[1]).toBe(`ng refs/heads/tip-jar ${REFUSALS.expired}`);
    expect(world.calls.pushed).toHaveLength(1);
    expect(world.calls.aborted).toHaveLength(1);
  });

  it("retries gitPushed once on a transport error (it is idempotent)", async () => {
    let n = 0;
    const deps = world.deps();
    const base = world.queen();
    deps.queen = () => ({
      ...base,
      gitPushed: async (p) => {
        n++;
        if (n === 1) throw new Error("Network connection lost.");
        return base.gitPushed(p);
      },
    });
    const r = await readReport(await handleGit(pushRequest(pushBody([[ZERO, NEW_SHA, "refs/heads/tip-jar"]], fakePack(10))), deps));
    expect(r.lines[1]).toBe("ok refs/heads/tip-jar");
    expect(n).toBe(2);
  });

  it("refuses with 'retry' when the Queen is unreachable at intent time (nothing to abort)", async () => {
    world.intentError = new Error("Durable Object reset");
    const r = await readReport(await push([[ZERO, NEW_SHA, "refs/heads/tip-jar"]]));
    expect(r.lines[1]).toBe(`ng refs/heads/tip-jar ${REFUSALS.transient}`);
    expect(world.calls.aborted).toHaveLength(0);
  });

  it("aborts when the fork cannot be made at all", async () => {
    world.sick.add(TRAIN_REPO).add(`${TRAIN_REPO}-r2`).add(`${TRAIN_REPO}-r3`);
    const r = await readReport(await push([[ZERO, NEW_SHA, "refs/heads/tip-jar"]]));
    expect(r.lines[1]).toBe(`ng refs/heads/tip-jar ${REFUSALS.transient}`);
    expect(world.calls.aborted[0]!.reason).toMatch(/fork failed/);
    expect(world.received).toHaveLength(0);
  });
});
