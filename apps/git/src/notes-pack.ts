import type { NotesProjection, NotesRef } from "@queenos/queen-types";
import { V1_NOTES_REFS } from "@queenos/queen-types";
import { FLUSH, DELIM, pkt, band, concat, enc } from "./pktline.js";

/** A parsed protocol v2 command request (gitprotocol-v2(5) `command-request`). */
export interface V2Command {
  /** The `command=<name>` value: `ls-refs`, `fetch`, `object-info`, … */
  command: string;
  /** The capability lines between `command=` and the delim packet (`agent=…`, `object-format=…`). */
  capabilities: string[];
  /** The argument lines after the delim packet, without their trailing LF (`ref-prefix …`, `want …`, `done`). */
  args: string[];
}

export interface NotesContext {
  hive: string;
  /** The Queen's projection of one notes ref (`QueenNode.notesFor`). Throws when the RPC fails. */
  notesFor(ref: NotesRef): Promise<NotesProjection>;
}

export interface NotesHandlers {
  isNotesLsRefs(cmd: V2Command): boolean;
  answerNotesLsRefs(ctx: NotesContext, cmd: V2Command): Promise<Response>;
  answerNotesFetch(ctx: NotesContext, cmd: V2Command): Promise<Response | null>;
}

const RESULT_HEADERS = { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-cache" };

/**
 * §7.5 notes-only rule: an `ls-refs` whose `ref-prefix` list is non-empty, names at least one `refs/notes/`
 * prefix, and otherwise only `refs/tags/` (git adds that for tag following).
 */
export function isNotesLsRefs(cmd: V2Command): boolean {
  if (cmd.command !== "ls-refs") return false;
  const prefixes = cmd.args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice("ref-prefix ".length));
  return (
    prefixes.length > 0 &&
    prefixes.some((p) => p.startsWith("refs/notes/")) &&
    prefixes.every((p) => p.startsWith("refs/notes/") || p.startsWith("refs/tags/"))
  );
}

interface SnapshotInfo {
  commitSha: string;
  commitText: Uint8Array;
  treeSha: string;
  treeBody: Uint8Array;
  blobs: { sha: string; data: Uint8Array }[];
}

const snapshotCache = new Map<string, SnapshotInfo>();
const commitToSnapshot = new Map<string, SnapshotInfo>();

async function sha1Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-1", data);
  const arr = Array.from(new Uint8Array(hash));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha1Bytes(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", data));
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  void writer.write(data).then(() => writer.close());
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concat(...chunks);
}

function encodeVarint(type: number, size: number): Uint8Array {
  const bytes = [];
  let b0 = ((type & 7) << 4) | (size & 0x0f);
  let s = Math.floor(size / 16);
  if (s > 0) {
    b0 |= 0x80;
    bytes.push(b0);
    while (s > 0) {
      let b = s & 0x7f;
      s = Math.floor(s / 128);
      if (s > 0) b |= 0x80;
      bytes.push(b);
    }
  } else {
    bytes.push(b0);
  }
  return new Uint8Array(bytes);
}

async function getOrBuildSnapshot(hive: string, proj: NotesProjection): Promise<SnapshotInfo> {
  const cacheKey = `${hive}:${proj.ref}:${proj.version}`;
  const existing = snapshotCache.get(cacheKey);
  if (existing) return existing;

  const blobs = [];
  for (const note of proj.notes) {
    const textBytes = enc.encode(note.text);
    const header = enc.encode(`blob ${textBytes.length}\0`);
    const sha = await sha1Hex(concat(header, textBytes));
    blobs.push({ sha: note.sha, actualSha: sha, textBytes });
  }

  blobs.sort((a, b) => a.sha.localeCompare(b.sha));

  let treeBody: Uint8Array;
  if (blobs.length === 0) {
    treeBody = new Uint8Array(0);
  } else {
    const treeEntries = [];
    for (const b of blobs) {
      const hexSha = b.actualSha;
      const binSha = new Uint8Array(20);
      for (let i = 0; i < 20; i++) binSha[i] = parseInt(hexSha.slice(i * 2, i * 2 + 2), 16);
      treeEntries.push(concat(enc.encode(`100644 ${b.sha}\0`), binSha));
    }
    treeBody = concat(...treeEntries);
  }

  const treeHeader = enc.encode(`tree ${treeBody.length}\0`);
  const treeSha = await sha1Hex(concat(treeHeader, treeBody));

  const commitText = enc.encode(
    `tree ${treeSha}\nauthor QueenOS <queenos@queenos.dev> 1760000000 +0000\ncommitter QueenOS <queenos@queenos.dev> 1760000000 +0000\n\nnotes ${proj.ref}\n`
  );
  const commitHeader = enc.encode(`commit ${commitText.length}\0`);
  const commitSha = await sha1Hex(concat(commitHeader, commitText));

  const snap: SnapshotInfo = {
    commitSha,
    commitText,
    treeSha,
    treeBody,
    blobs: blobs.map((b) => ({ sha: b.actualSha, data: b.textBytes })),
  };

  snapshotCache.set(cacheKey, snap);
  commitToSnapshot.set(`${hive}:${commitSha}`, snap);
  return snap;
}

export async function answerNotesLsRefs(ctx: NotesContext, cmd: V2Command): Promise<Response> {
  const prefixes = cmd.args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice("ref-prefix ".length));
  const refMatches = V1_NOTES_REFS.filter((r: string) => prefixes.length === 0 || prefixes.some((p) => r.startsWith(p)));

  const out: Uint8Array[] = [];
  for (const ref of refMatches) {
    try {
      const proj = await ctx.notesFor(ref as NotesRef);
      const snap = await getOrBuildSnapshot(ctx.hive, proj);
      out.push(pkt(`${snap.commitSha} ${ref}\n`));
    } catch {
      // Ignore
    }
  }
  out.push(FLUSH);

  return new Response(concat(...out), { headers: RESULT_HEADERS });
}

export async function answerNotesFetch(ctx: NotesContext, cmd: V2Command): Promise<Response | null> {
  const wants = cmd.args.filter((a) => a.startsWith("want ")).map((a) => a.slice("want ".length).trim());
  if (wants.length === 0) return null;

  let allKnown = true;
  for (const want of wants) {
    if (!commitToSnapshot.has(`${ctx.hive}:${want}`)) {
      allKnown = false;
      break;
    }
  }

  if (!allKnown) {
    for (const ref of V1_NOTES_REFS) {
      try {
        const proj = await ctx.notesFor(ref as NotesRef);
        await getOrBuildSnapshot(ctx.hive, proj);
      } catch {
        // Ignore fetch errors, we'll just fail the condition below
      }
    }
    for (const want of wants) {
      if (!commitToSnapshot.has(`${ctx.hive}:${want}`)) {
        return null;
      }
    }
  }

  const objects = new Map<string, { type: number; data: Uint8Array }>();
  for (const want of wants) {
    const snap = commitToSnapshot.get(`${ctx.hive}:${want}`)!;
    if (!objects.has(snap.commitSha)) {
      objects.set(snap.commitSha, { type: 1, data: snap.commitText });
    }
    if (!objects.has(snap.treeSha)) {
      objects.set(snap.treeSha, { type: 2, data: snap.treeBody });
    }
    for (const b of snap.blobs) {
      if (!objects.has(b.sha)) {
        objects.set(b.sha, { type: 3, data: b.data });
      }
    }
  }

  const packObjects = Array.from(objects.values());
  const header = new Uint8Array(12);
  const dataView = new DataView(header.buffer);
  header.set(enc.encode("PACK"), 0);
  dataView.setUint32(4, 2, false);
  dataView.setUint32(8, packObjects.length, false);

  const packParts: Uint8Array[] = [header];
  for (const obj of packObjects) {
    packParts.push(encodeVarint(obj.type, obj.data.length));
    packParts.push(await deflate(obj.data));
  }

  const payloadToHash = concat(...packParts);
  const trailer = await sha1Bytes(payloadToHash);
  const packBytes = concat(payloadToHash, trailer);

  const sidebandAll = cmd.capabilities.includes("sideband-all") || cmd.args.includes("sideband-all");
  const done = cmd.args.includes("done");

  const out: Uint8Array[] = [];
  if (sidebandAll) {
    if (!done) {
      out.push(band(1, enc.encode("acknowledgments\n")));
      out.push(band(1, enc.encode("ready\n")));
      out.push(DELIM);
    }
    out.push(band(1, enc.encode("packfile\n")));
    out.push(band(1, packBytes));
    out.push(FLUSH);
  } else {
    if (!done) {
      out.push(pkt("acknowledgments\n"));
      out.push(pkt("ready\n"));
      out.push(DELIM);
    }
    out.push(pkt("packfile\n"));
    out.push(band(1, packBytes));
    out.push(FLUSH);
  }

  return new Response(concat(...out), { headers: RESULT_HEADERS });
}

export const notesHandlers: NotesHandlers = { isNotesLsRefs, answerNotesLsRefs, answerNotesFetch };
