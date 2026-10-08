import { describe, expect, it } from "vitest";
import { isNotesLsRefs, answerNotesLsRefs, answerNotesFetch } from "../src/notes-pack.js";
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
