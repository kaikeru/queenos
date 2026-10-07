import { describe, expect, it, vi } from "vitest";
import { handleGit } from "../src/index";
import { answerNotesFetch, answerNotesLsRefs, isNotesLsRefs, notesHandlers, type NotesHandlers, type V2Command } from "../src/notes-pack";
import { concat, dec, DELIM, FLUSH, parsePkts, pkt, pktText } from "../src/pktline";
import { advertisedRefs, parseAdvert, RECEIVE_PACK_CAPS } from "../src/upload";
import { gitRequest, HIVE, MAIN_SHA, TRAIN_ID, TRAIN_REPO, World } from "./fakes";

const V2 = { "git-protocol": "version=2" };

function v2Body(command: string, args: string[]): Uint8Array {
  return concat(pkt(`command=${command}\n`), pkt("agent=git/2.50.1\n"), pkt("object-format=sha1\n"), DELIM, ...args.map((a) => pkt(`${a}\n`)), FLUSH);
}

const uploadPack = (body: Uint8Array, path = `/git/${HIVE}/git-upload-pack`) =>
  gitRequest(path, { method: "POST", body, headers: { ...V2, "content-type": "application/x-git-upload-pack-request" } });

describe("advertisement filtering", () => {
  it("v0 upload-pack advert keeps HEAD + main only, caps intact minus hidden-want caps", async () => {
    const w = new World();
    const res = await handleGit(gitRequest(`/git/${HIVE}/info/refs?service=git-upload-pack`), w.deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    const body = new Uint8Array(await res.arrayBuffer());
    const a = parseAdvert(body)!;
    expect(a.service).toBe("git-upload-pack");
    expect(a.refs.map((r) => r.name)).toEqual(["HEAD", "refs/heads/main"]);
    expect(a.caps).toContain("symref=HEAD:refs/heads/main");
    expect(a.caps).toContain("side-band-64k");
    expect(a.caps).not.toContain("allow-tip-sha1-in-want");
    expect(w.requests[0]).toMatchObject({ repo: HIVE, scope: "read" });
  });

  it("the push advert is synthesized from the read advert: main only, Artifacts' receive-pack caps, read token", async () => {
    const w = new World();
    const res = await handleGit(gitRequest(`/git/${HIVE}/info/refs?service=git-receive-pack`, { headers: V2 }), w.deps());
    expect(res.headers.get("content-type")).toBe("application/x-git-receive-pack-advertisement");
    const a = parseAdvert(new Uint8Array(await res.arrayBuffer()))!;
    expect(a.service).toBe("git-receive-pack");
    expect(a.refs).toEqual([{ sha: MAIN_SHA, name: "refs/heads/main" }]);
    expect(a.caps).toEqual([...RECEIVE_PACK_CAPS, "object-format=sha1", "agent=queenos-git/1"]);
    expect(w.requests.map((r) => `${r.scope} ${r.endpoint} ${r.protocol}`)).toEqual(["read info/refs?git-upload-pack null"]);
    expect([...w.tokens.values()].every((t) => t.scope === "read")).toBe(true);
  });

  it("a v2 capability advert passes through unchanged", async () => {
    const w = new World();
    const res = await handleGit(gitRequest(`/git/${HIVE}/info/refs?service=git-upload-pack`, { headers: V2 }), w.deps());
    const lines = parsePkts(new Uint8Array(await res.arrayBuffer())).filter((p) => p instanceof Uint8Array).map((p) => pktText(p as Uint8Array));
    expect(lines).toContain("version 2");
    expect(lines).toContain("ls-refs=unborn");
  });

  it("v2 ls-refs is filtered: a mixed heads + notes ls-refs gets heads only, never refs/notes/queen", async () => {
    const w = new World();
    const res = await handleGit(uploadPack(v2Body("ls-refs", ["symrefs", "ref-prefix HEAD", "ref-prefix refs/heads/", "ref-prefix refs/notes/"])), w.deps());
    expect(advertisedRefs(new Uint8Array(await res.arrayBuffer()))).toEqual(["HEAD", "refs/heads/main"]);
    expect(w.calls.notesFor).toHaveLength(0);
  });

  it("v2 fetch and v0 upload-pack stream the upstream pack", async () => {
    const w = new World();
    const res = await handleGit(uploadPack(v2Body("fetch", [`want ${MAIN_SHA}`, "done"])), w.deps());
    expect(res.status).toBe(200);
    expect(dec.decode(new Uint8Array(await res.arrayBuffer()))).toContain("PACKDATA");
    const v0 = await handleGit(gitRequest(`/git/${HIVE}/git-upload-pack`, { method: "POST", body: concat(pkt(`want ${MAIN_SHA}\n`), FLUSH, pkt("done\n")) }), w.deps());
    expect(dec.decode(new Uint8Array(await v0.arrayBuffer()))).toContain("PACKDATA");
  });
});

describe("503 episodes on reads (§9)", () => {
  it("retries info/refs with 2 / 4 s backoff and then succeeds", async () => {
    const w = new World();
    w.fail503.set(`${HIVE} info/refs?git-upload-pack`, 2);
    const res = await handleGit(gitRequest(`/git/${HIVE}/info/refs?service=git-upload-pack`), w.deps());
    expect(res.status).toBe(200);
    expect(w.sleeps).toEqual([2000, 4000]);
  });

  it("retries a buffered upload-pack POST", async () => {
    const w = new World();
    w.fail503.set(`${HIVE} git-upload-pack`, 1);
    const res = await handleGit(uploadPack(v2Body("fetch", [`want ${MAIN_SHA}`, "done"])), w.deps());
    expect(res.status).toBe(200);
    expect(w.requests.filter((r) => r.endpoint === "git-upload-pack")).toHaveLength(2);
  });

  it("gives up after 3 retries with 503 + Retry-After, logging evidence without the token", async () => {
    const w = new World();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    w.fail503.set(`${HIVE} info/refs?git-upload-pack`, 10);
    const res = await handleGit(gitRequest(`/git/${HIVE}/info/refs?service=git-upload-pack`), w.deps());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(w.sleeps).toEqual([2000, 4000, 6000]);
    expect(logs.join("\n")).toMatch(/HTTP 503 info\/refs cf-ray=ray123 body="upstream busy \[redacted\]"/);
    expect(logs.join("\n")).not.toMatch(/art_v1_/);
    vi.restoreAllMocks();
  });
});

describe("notes routing (§7.5, T2n seam)", () => {
  function spyHandlers(over: Partial<NotesHandlers> = {}) {
    const calls: string[] = [];
    const h: NotesHandlers = {
      isNotesLsRefs,
      answerNotesLsRefs: async (ctx, cmd) => {
        calls.push(`ls-refs ${ctx.hive} ${cmd.args.join(",")}`);
        await ctx.notesFor("refs/notes/verdict");
        return new Response(concat(pkt(`${"f".repeat(40)} refs/notes/verdict\n`), FLUSH));
      },
      answerNotesFetch: async (ctx, cmd) => {
        calls.push(`fetch ${ctx.hive} ${cmd.args.join(",")}`);
        return cmd.args.includes(`want ${"f".repeat(40)}`) ? new Response("NOTESPACK") : null;
      },
      ...over,
    };
    return { h, calls };
  }

  it("a notes-only v2 ls-refs is answered by the notes pack (upstream untouched, Queen notesFor called)", async () => {
    const w = new World();
    const { h, calls } = spyHandlers();
    const res = await handleGit(uploadPack(v2Body("ls-refs", ["ref-prefix refs/notes/", "ref-prefix refs/tags/"])), w.deps({}, h));
    expect(advertisedRefs(new Uint8Array(await res.arrayBuffer()))).toEqual(["refs/notes/verdict"]);
    expect(calls).toEqual([`ls-refs ${HIVE} ref-prefix refs/notes/,ref-prefix refs/tags/`]);
    expect(w.calls.notesFor).toEqual([`${HIVE} refs/notes/verdict`]);
    expect(w.requests.filter((r) => r.endpoint === "git-upload-pack")).toHaveLength(0);
  });

  it("a throwing notes ls-refs degrades to 'no refs' (a lone flush)", async () => {
    const w = new World();
    const { h } = spyHandlers({ answerNotesLsRefs: async () => Promise.reject(new Error("notesFor RPC failed")) });
    const res = await handleGit(uploadPack(v2Body("ls-refs", ["ref-prefix refs/notes/"])), w.deps({}, h));
    expect(dec.decode(new Uint8Array(await res.arrayBuffer()))).toBe("0000");
  });

  it("every v2 fetch asks the notes pack first; null or a throw falls through to upstream", async () => {
    const w = new World();
    const { h, calls } = spyHandlers();
    const notes = await handleGit(uploadPack(v2Body("fetch", [`want ${"f".repeat(40)}`, "done"])), w.deps({}, h));
    expect(dec.decode(new Uint8Array(await notes.arrayBuffer()))).toBe("NOTESPACK");
    const heads = await handleGit(uploadPack(v2Body("fetch", [`want ${MAIN_SHA}`, "done"])), w.deps({}, h));
    expect(dec.decode(new Uint8Array(await heads.arrayBuffer()))).toContain("PACKDATA");
    expect(calls).toHaveLength(2);
    const { h: boom } = spyHandlers({ answerNotesFetch: async () => Promise.reject(new Error("x")) });
    const after = await handleGit(uploadPack(v2Body("fetch", [`want ${MAIN_SHA}`, "done"])), w.deps({}, boom));
    expect(dec.decode(new Uint8Array(await after.arrayBuffer()))).toContain("PACKDATA");
  });

  it("the /t/<trainId> view never serves notes", async () => {
    const w = new World();
    w.repos.set(TRAIN_REPO, { main: MAIN_SHA, commits: new Map() });
    w.gateTargets.set(TRAIN_REPO, { trainId: TRAIN_ID, lane: "BUILD", promptId: "p", promptText: "", previewUrl: null, phase: "TESTING", traceId: null, baseSha: null });
    const { h, calls } = spyHandlers();
    await handleGit(uploadPack(v2Body("ls-refs", ["ref-prefix refs/notes/"]), `/git/${HIVE}/t/${TRAIN_ID}/git-upload-pack`), w.deps({}, h));
    await handleGit(uploadPack(v2Body("fetch", [`want ${MAIN_SHA}`, "done"]), `/git/${HIVE}/t/${TRAIN_ID}/git-upload-pack`), w.deps({}, h));
    expect(calls).toHaveLength(0);
  });

  it("the stub contract: the notes-only prefix rule, an empty ls-refs, no fetch claimed", async () => {
    const cmd = (args: string[]): V2Command => ({ command: "ls-refs", capabilities: [], args });
    expect(isNotesLsRefs(cmd(["ref-prefix refs/notes/"]))).toBe(true);
    expect(isNotesLsRefs(cmd(["ref-prefix refs/notes/", "ref-prefix refs/tags/"]))).toBe(true);
    expect(isNotesLsRefs(cmd(["ref-prefix refs/tags/"]))).toBe(false);
    expect(isNotesLsRefs(cmd(["ref-prefix refs/notes/", "ref-prefix refs/heads/"]))).toBe(false);
    expect(isNotesLsRefs(cmd([]))).toBe(false);
    expect(isNotesLsRefs({ command: "fetch", capabilities: [], args: ["ref-prefix refs/notes/"] })).toBe(false);
    const ctx = { hive: HIVE, notesFor: async () => Promise.reject(new Error("unused")) };
    expect(dec.decode(new Uint8Array(await (await answerNotesLsRefs(ctx, cmd(["ref-prefix refs/notes/"]))).arrayBuffer()))).toBe("0000");
    expect(await answerNotesFetch(ctx, { command: "fetch", capabilities: [], args: [] })).toBeNull();
    expect(notesHandlers.answerNotesFetch).toBe(answerNotesFetch);
  });
});
