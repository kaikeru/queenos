/**
 * git pkt-line framing (gitprotocol-common(5)): a 4-hex-digit length that counts itself, then the payload.
 * Special packets: 0000 flush, 0001 delim (protocol v2), 0002 response-end (protocol v2).
 * Side-band: the first payload byte is the band (1 data, 2 progress / `remote:` text, 3 fatal error).
 */

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export const ZERO_SHA = "0".repeat(40);
/** Max payload of one pkt-line (65520 - 4 length bytes). */
export const MAX_PKT_PAYLOAD = 65516;
/** Max data per side-band-64k packet (one byte goes to the band number). */
export const MAX_BAND_DATA = MAX_PKT_PAYLOAD - 1;

export const FLUSH = enc.encode("0000");
export const DELIM = enc.encode("0001");
export const RESPONSE_END = enc.encode("0002");

export type Pkt = Uint8Array | "flush" | "delim" | "end";

export function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** One data pkt-line. Throws on an oversized payload (callers split, e.g. {@link band}). */
export function pkt(data: string | Uint8Array): Uint8Array {
  const b = typeof data === "string" ? enc.encode(data) : data;
  if (b.length > MAX_PKT_PAYLOAD) throw new Error(`pkt-line payload too long (${b.length})`);
  return concat(enc.encode((b.length + 4).toString(16).padStart(4, "0")), b);
}

/** `data` on side-band `n`, split into as many packets as needed (an empty payload gives one packet). */
export function band(n: 1 | 2 | 3, data: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  let i = 0;
  do {
    out.push(pkt(concat(new Uint8Array([n]), data.subarray(i, i + MAX_BAND_DATA))));
    i += MAX_BAND_DATA;
  } while (i < data.length);
  return concat(...out);
}

/** A `remote: <text>` line on side-band 2 (newlines inside the text are flattened). */
export function remoteLine(text: string): Uint8Array {
  return band(2, enc.encode(`${text.replace(/[\r\n]+/g, " ")}\n`));
}

/** The text of a data packet, without its trailing LF. */
export function pktText(p: Uint8Array): string {
  return dec.decode(p).replace(/\n$/, "");
}

/** Parse the length prefix, or throw on a malformed one. */
function lengthOf(head: Uint8Array): number {
  const s = dec.decode(head);
  if (!/^[0-9a-f]{4}$/i.test(s)) throw new Error(`bad pkt-line length ${JSON.stringify(s)}`);
  return parseInt(s, 16);
}

/** Every packet of a fully buffered pkt-line body (a trailing partial packet throws). */
export function parsePkts(buf: Uint8Array): Pkt[] {
  const out: Pkt[] = [];
  let o = 0;
  while (o < buf.length) {
    if (buf.length - o < 4) throw new Error("short pkt-line header");
    const len = lengthOf(buf.subarray(o, o + 4));
    if (len < 4) {
      if (len === 3) throw new Error("bad pkt-line length 0003");
      out.push(len === 0 ? "flush" : len === 1 ? "delim" : "end");
      o += 4;
      continue;
    }
    if (o + len > buf.length) throw new Error("short pkt-line");
    out.push(buf.slice(o + 4, o + len));
    o += len;
  }
  return out;
}

/** The packets of a side-band stream split by band (band 1 concatenated; bands 2 and 3 kept as payloads). */
export function demuxSideband(buf: Uint8Array): { data: Uint8Array; progress: Uint8Array[]; fatal: Uint8Array[] } {
  const data: Uint8Array[] = [];
  const progress: Uint8Array[] = [];
  const fatal: Uint8Array[] = [];
  for (const p of parsePkts(buf)) {
    if (typeof p === "string") continue;
    if (p[0] === 1) data.push(p.subarray(1));
    else if (p[0] === 2) progress.push(p.subarray(1));
    else if (p[0] === 3) fatal.push(p.subarray(1));
  }
  return { data: concat(...data), progress, fatal };
}

/**
 * Incremental pkt-line reader over a byte stream. Reads only as many bytes as the packets it returns need,
 * so the rest of the stream (a receive-pack's pack data) can be handed on untouched with {@link rest}.
 */
export class PktReader {
  private buf: Uint8Array = new Uint8Array(0);
  /** Bytes consumed by the packets returned so far. */
  consumed = 0;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(n: number): Promise<boolean> {
    while (this.buf.length < n) {
      const { done, value } = await this.reader.read();
      if (done) return false;
      this.buf = this.buf.length ? concat(this.buf, value) : value;
    }
    return true;
  }

  /** The next packet, or null at the end of the stream. Throws on a truncated packet. */
  async next(): Promise<Pkt | null> {
    if (!(await this.fill(4))) {
      if (this.buf.length) throw new Error("short pkt-line header");
      return null;
    }
    const len = lengthOf(this.buf.subarray(0, 4));
    if (len < 4) {
      if (len === 3) throw new Error("bad pkt-line length 0003");
      this.buf = this.buf.subarray(4);
      this.consumed += 4;
      return len === 0 ? "flush" : len === 1 ? "delim" : "end";
    }
    if (!(await this.fill(len))) throw new Error("short pkt-line");
    const p = this.buf.slice(4, len);
    this.buf = this.buf.subarray(len);
    this.consumed += len;
    return p;
  }

  /** The unread remainder of the stream (bytes already buffered first). Call once, after the last next(). */
  rest(): ReadableStreamDefaultReader<Uint8Array> {
    const first = this.buf;
    this.buf = new Uint8Array(0);
    const r = this.reader;
    let sentFirst = first.length === 0;
    return new ReadableStream<Uint8Array>({
      async pull(c) {
        if (!sentFirst) {
          sentFirst = true;
          c.enqueue(first);
          return;
        }
        const { done, value } = await r.read();
        if (done) c.close();
        else c.enqueue(value);
      },
      cancel(reason) {
        return r.cancel(reason);
      },
    }).getReader();
  }
}

export function bytesReader(b: Uint8Array): PktReader {
  return new PktReader(new Response(b).body!.getReader());
}

/** Read a stream to the end, discarding it (lets a client finish its upload before we answer). */
export async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<number> {
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return n;
      n += value.length;
    }
  } catch {
    return n;
  }
}
