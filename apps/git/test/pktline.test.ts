import { describe, expect, it } from "vitest";
import { band, concat, dec, demuxSideband, enc, FLUSH, MAX_BAND_DATA, parsePkts, pkt, PktReader, pktText, remoteLine } from "../src/pktline";
import { chunked } from "./fakes";

describe("pkt-line", () => {
  it("emits length-prefixed packets and the special packets", () => {
    expect(dec.decode(pkt("a\n"))).toBe("0006a\n");
    expect(dec.decode(pkt(""))).toBe("0004");
    expect(dec.decode(FLUSH)).toBe("0000");
    expect(() => pkt(new Uint8Array(70000))).toThrow(/too long/);
  });

  it("parses data, flush, delim and response-end packets", () => {
    const pkts = parsePkts(enc.encode("0008abcd000100000002"));
    expect(pkts.map((p) => (typeof p === "string" ? p : dec.decode(p)))).toEqual(["abcd", "delim", "flush", "end"]);
    expect(() => parsePkts(enc.encode("0009abc"))).toThrow(/short/);
    expect(() => parsePkts(enc.encode("zzzz"))).toThrow(/bad pkt-line length/);
  });

  it("splits large side-band data into 64k packets and demuxes it back", () => {
    const data = new Uint8Array(MAX_BAND_DATA * 2 + 10).map((_, i) => i % 256);
    const muxed = concat(remoteLine("hello\nworld"), band(1, data), band(3, enc.encode("fatal")), FLUSH);
    const pkts = parsePkts(muxed).filter((p) => p instanceof Uint8Array);
    expect(pkts).toHaveLength(5); // 1 progress, 3 data, 1 fatal
    const d = demuxSideband(muxed);
    expect(d.data).toEqual(data);
    expect(d.progress.map((p) => dec.decode(p))).toEqual(["hello world\n"]);
    expect(dec.decode(d.fatal[0]!)).toBe("fatal");
  });

  it("reads packets across chunk boundaries and hands on the exact remainder", async () => {
    const body = concat(pkt("cmd one\n"), pkt("cmd two\n"), FLUSH, enc.encode("PACKBYTES-0123456789"));
    const r = new PktReader(chunked(body, 3).getReader());
    const first = await r.next();
    const second = await r.next();
    expect([pktText(first as Uint8Array), pktText(second as Uint8Array)]).toEqual(["cmd one", "cmd two"]);
    expect(await r.next()).toBe("flush");
    expect(r.consumed).toBe(body.length - 20);
    const rest = await new Response(new ReadableStream({ start: async (c) => {
      const rr = r.rest();
      for (;;) {
        const { done, value } = await rr.read();
        if (done) break;
        c.enqueue(value);
      }
      c.close();
    } })).text();
    expect(rest).toBe("PACKBYTES-0123456789");
  });

  it("returns null at a clean end and throws on a truncated packet", async () => {
    expect(await new PktReader(chunked(new Uint8Array(0)).getReader()).next()).toBeNull();
    await expect(new PktReader(chunked(enc.encode("0010abc")).getReader()).next()).rejects.toThrow(/short/);
  });
});
