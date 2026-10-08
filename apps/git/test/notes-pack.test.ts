import { describe, expect, it } from "vitest";
import { isNotesLsRefs, answerNotesLsRefs, answerNotesFetch, NOTES_REFRESH_TTL_MS, NOTES_CACHE_MAX_HIVES } from "../src/notes-pack.js";
import type { NotesContext } from "../src/notes-pack.js";
import type { NotesProjection } from "@queenos/queen-types";
import { dec, parsePkts, pktText } from "../src/pktline.js";

describe("isNotesLsRefs", () => {
  it("returns true for valid notes ls-refs", () => {
    expect(isNotesLsRefs({ command: "ls-refs", capabilities: [], args: ["ref-prefix refs/notes/"] })).toBe(true);
    expect(isNotesLsRefs({ command: "ls-refs", capabilities: [], args: ["ref-prefix refs/notes/verdict", "ref-prefix refs/tags/"] })).toBe(true);
  });
  it("returns false for mixed heads", () => {
    expect(isNotesLsRefs({ command: "ls-refs", capabilities: [], args: ["ref-prefix refs/notes/", "ref-prefix refs/heads/"] })).toBe(false);
  });
  it("returns false for non-ls-refs", () => {
    expect(isNotesLsRefs({ command: "fetch", capabilities: [], args: ["ref-prefix refs/notes/"] })).toBe(false);
  });
});

describe("answerNotesLsRefs and answerNotesFetch", () => {
  const MOCK_PROJECTIONS: Record<string, NotesProjection> = {
    "refs/notes/verdict": {
      ref: "refs/notes/verdict",
      version: 1,
      notes: [{ sha: "1111111111111111111111111111111111111111", text: "note1" }],
    },
    "refs/notes/review": {
      ref: "refs/notes/review",
      version: 2,
      notes: [{ sha: "2222222222222222222222222222222222222222", text: "note2" }],
    },
    "refs/notes/provenance": {
      ref: "refs/notes/provenance",
      version: 1,
      notes: [],
    },
  };

  const ctx: NotesContext = {
    hive: "test-hive",
    notesFor: async (ref) => {
      return MOCK_PROJECTIONS[ref]!;
    },
  };

  it("handles answerNotesLsRefs", async () => {
    const res = await answerNotesLsRefs(ctx, { command: "ls-refs", capabilities: [], args: ["ref-prefix refs/notes/verdict"] });
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    const pkts = parsePkts(buf);
    expect(pkts.length).toBe(2);
    expect(typeof pkts[0]).toBe("object");
    expect(pktText(pkts[0] as Uint8Array)).toMatch(/^[0-9a-f]{40} refs\/notes\/verdict$/);
    expect(pkts[1]).toBe("flush");
  });

  it("returns null on non-notes want", async () => {
    const res = await answerNotesFetch(ctx, { command: "fetch", capabilities: [], args: ["want 3333333333333333333333333333333333333333"] });
    expect(res).toBeNull();
  });

  it("returns null on empty want", async () => {
    const res = await answerNotesFetch(ctx, { command: "fetch", capabilities: [], args: [] });
    expect(res).toBeNull();
  });

  it("handles valid want and returns packfile without sideband-all", async () => {
    const lsRes = await answerNotesLsRefs(ctx, { command: "ls-refs", capabilities: [], args: [] });
    const lsBuf = new Uint8Array(await lsRes.arrayBuffer());
    const lsPkts = parsePkts(lsBuf);
    const wants = lsPkts.filter((p) => typeof p !== "string").map((p) => pktText(p as Uint8Array).split(" ")[0]!);

    const res = await answerNotesFetch(ctx, { command: "fetch", capabilities: [], args: [`want ${wants[0]}`] });
    expect(res).not.toBeNull();
    const buf = new Uint8Array(await res!.arrayBuffer());
    const pkts = parsePkts(buf);

    expect(pktText(pkts[0] as Uint8Array)).toBe("acknowledgments");
    expect(pktText(pkts[1] as Uint8Array)).toBe("ready");
    expect(pkts[2]).toBe("delim");
    expect(pktText(pkts[3] as Uint8Array)).toBe("packfile");
    
    // pack verification
    const packBand = pkts[4] as Uint8Array;
    expect(packBand[0]).toBe(1);
    const pack = packBand.subarray(1);

    expect(dec.decode(pack.subarray(0, 4))).toBe("PACK");
    const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
    expect(dv.getUint32(4, false)).toBe(2); // version
    const count = dv.getUint32(8, false);
    expect(count).toBe(3); // commit, tree, blob
  });

  it("returns packfile with sideband-all", async () => {
    const lsRes = await answerNotesLsRefs(ctx, { command: "ls-refs", capabilities: [], args: [] });
    const wants = parsePkts(new Uint8Array(await lsRes.arrayBuffer()))
      .filter((p) => typeof p !== "string")
      .map((p) => pktText(p as Uint8Array).split(" ")[0]!);

    const res = await answerNotesFetch(ctx, { command: "fetch", capabilities: ["sideband-all"], args: [`want ${wants[0]}`, "done"] });
    expect(res).not.toBeNull();
    const buf = new Uint8Array(await res!.arrayBuffer());
    const pkts = parsePkts(buf);
    
    expect(pkts[0] instanceof Uint8Array && pkts[0][0] === 1).toBe(true);
    const text0 = pktText(pkts[0] as Uint8Array).slice(1);
    expect(text0).toBe("packfile");
  });
});

describe("notes snapshot cache", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const proj = (ref: string, version: number, notes: { sha: string; text: string }[]): NotesProjection =>
    ({ ref, version, notes }) as NotesProjection;

  /** A ctx whose projections can change between calls; counts notesFor RPCs and uses a fake clock. */
  function harness(hive: string, initial: (ref: string) => NotesProjection) {
    const state = { project: initial, calls: 0, time: 0 };
    const ctx: NotesContext = {
      hive,
      now: () => state.time,
      notesFor: async (ref) => {
        state.calls++;
        return state.project(ref);
      },
    };
    return { state, ctx };
  }
  const ls = async (ctx: NotesContext, prefix?: string) => {
    const res = await answerNotesLsRefs(ctx, { command: "ls-refs", capabilities: [], args: prefix ? [`ref-prefix ${prefix}`] : [] });
    const out: Record<string, string> = {};
    for (const p of parsePkts(new Uint8Array(await res.arrayBuffer()))) {
      if (typeof p === "string") continue;
      const [sha, ref] = pktText(p).split(" ");
      out[ref!] = sha!;
    }
    return out;
  };
  const fetchSha = (ctx: NotesContext, sha: string) =>
    answerNotesFetch(ctx, { command: "fetch", capabilities: [], args: [`want ${sha}`] });
  const empty = (ref: string) => proj(ref, 1, []);

  it("gives the same commit SHA for unchanged notes and a new one when they change", async () => {
    const { state, ctx } = harness("det", (ref) => proj(ref, 1, [{ sha: A, text: "x" }]));
    const first = await ls(ctx, "refs/notes/verdict");
    expect(await ls(ctx, "refs/notes/verdict")).toEqual(first);
    state.project = (ref) => proj(ref, 2, [{ sha: A, text: "y" }]);
    expect((await ls(ctx, "refs/notes/verdict"))["refs/notes/verdict"]).not.toBe(first["refs/notes/verdict"]);
  });

  it("shares one blob between notes with identical text", async () => {
    const { ctx } = harness("dedupe", (ref) => proj(ref, 1, [{ sha: A, text: "same" }, { sha: B, text: "same" }]));
    const sha = (await ls(ctx, "refs/notes/verdict"))["refs/notes/verdict"]!;
    const res = await fetchSha(ctx, sha);
    const pkts = parsePkts(new Uint8Array(await res!.arrayBuffer()));
    const pack = (pkts[4] as Uint8Array).subarray(1);
    expect(new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(8, false)).toBe(3); // commit, tree, 1 blob
  });

  it("leaves a ref with a malformed or duplicate annotated SHA out of ls-refs", async () => {
    const { ctx } = harness("bad", (ref) =>
      ref === "refs/notes/verdict"
        ? proj(ref, 1, [{ sha: "nothex", text: "x" }])
        : ref === "refs/notes/review"
          ? proj(ref, 1, [{ sha: A, text: "x" }, { sha: A, text: "y" }])
          : empty(ref),
    );
    expect(Object.keys(await ls(ctx))).toEqual(["refs/notes/provenance"]);
  });

  it("omits a ref whose RPC fails and still ends with a flush", async () => {
    const ctx: NotesContext = {
      hive: "rpcfail",
      notesFor: async (ref) => {
        if (ref === "refs/notes/review") throw new Error("boom");
        return empty(ref);
      },
    };
    expect(Object.keys(await ls(ctx)).sort()).toEqual(["refs/notes/provenance", "refs/notes/verdict"]);
  });

  it("answers an unknown want with null and no RPC inside the refresh TTL", async () => {
    const { state, ctx } = harness("ttl", empty);
    await ls(ctx); // full ls-refs counts as the refresh
    const before = state.calls;
    state.time = NOTES_REFRESH_TTL_MS - 1;
    expect(await fetchSha(ctx, "c".repeat(40))).toBeNull();
    expect(state.calls).toBe(before);
  });

  it("refreshes once the TTL has passed and serves a commit created since", async () => {
    const { state, ctx } = harness("refresh", empty);
    await ls(ctx);
    state.project = (ref) => proj(ref, 2, ref === "refs/notes/verdict" ? [{ sha: A, text: "new" }] : []);
    // learn the new commit SHA through a second hive harness over the same data
    const peek = harness("refresh-peek", state.project);
    const newSha = (await ls(peek.ctx, "refs/notes/verdict"))["refs/notes/verdict"]!;

    state.time = NOTES_REFRESH_TTL_MS + 1;
    const before = state.calls;
    const res = await fetchSha(ctx, newSha);
    expect(res).not.toBeNull();
    expect(state.calls - before).toBe(3);
    // refreshed at the new time, so another unknown want is null with no further RPC
    expect(await fetchSha(ctx, "c".repeat(40))).toBeNull();
    expect(state.calls - before).toBe(3);
  });

  it("shares one refresh between concurrent unknown wants", async () => {
    const { state, ctx } = harness("concurrent", empty);
    const unknown = "d".repeat(40);
    const before = state.calls;
    await Promise.all([fetchSha(ctx, unknown), fetchSha(ctx, unknown), fetchSha(ctx, unknown)]);
    expect(state.calls - before).toBe(3); // one round over the three refs, not nine
  });

  it("keeps the previous snapshot fetchable after the ref moves on", async () => {
    const { state, ctx } = harness("prev", (ref) => proj(ref, 1, [{ sha: A, text: "v1" }]));
    const old = (await ls(ctx, "refs/notes/verdict"))["refs/notes/verdict"]!;
    state.project = (ref) => proj(ref, 2, [{ sha: A, text: "v2" }]);
    await ls(ctx, "refs/notes/verdict");
    const before = state.calls;
    expect(await fetchSha(ctx, old)).not.toBeNull();
    expect(state.calls).toBe(before);

    state.project = (ref) => proj(ref, 3, [{ sha: A, text: "v3" }]);
    await ls(ctx, "refs/notes/verdict"); // v1 falls out: only the current and previous are kept
    state.time = NOTES_REFRESH_TTL_MS * 10;
    state.project = (ref) => proj(ref, 3, [{ sha: A, text: "v3" }]);
    expect(await fetchSha(ctx, old)).toBeNull();
  });

  it("evicts the least recently used hive beyond the cap", async () => {
    const hs = Array.from({ length: NOTES_CACHE_MAX_HIVES + 1 }, (_, i) => harness(`lru-${i}`, empty));
    const shas: string[] = [];
    for (const h of hs) shas.push((await ls(h.ctx, "refs/notes/verdict"))["refs/notes/verdict"]!);

    // lru-0 was evicted: its cache is gone, so its own commit is unknown and a fetch refreshes (3 RPCs)
    const first = hs[0]!;
    const before = first.state.calls;
    await fetchSha(first.ctx, shas[0]!);
    expect(first.state.calls - before).toBe(3);

    // the most recent hive is still cached: no RPC
    const last = hs[hs.length - 1]!;
    const lastBefore = last.state.calls;
    expect(await fetchSha(last.ctx, shas[shas.length - 1]!)).not.toBeNull();
    expect(last.state.calls).toBe(lastBefore);
  });
});
