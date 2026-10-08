/**
 * Synthesized v1 notes refs (docs/human-push-design.md §7.5): the proxy answers protocol-v2 `ls-refs` and
 * `fetch` for `refs/notes/{verdict,review,provenance}` itself, from the Queen's `notesFor` projection.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ IMPLEMENTED (T2n). Each ref is served as a deterministic, parentless notes commit built from   │
 * │ the projection: one blob per note (its text), one flat tree keyed by the annotated commit's    │
 * │ 40-hex SHA (`100644`, sorted by name; the empty tree when there are no notes), and a commit     │
 * │ with a fixed author/committer and timestamp, so an unchanged set of notes keeps its SHA. The   │
 * │ fetch answer is a pack v2 with no deltas (zlib via `CompressionStream("deflate")`, SHA-1 via   │
 * │ Web Crypto). Snapshots are cached per (hive, ref): the current one and the one before it, for  │
 * │ at most NOTES_CACHE_MAX_HIVES hives (LRU) and NOTES_CACHE_MAX_BYTES of object data. A fetch    │
 * │ whose want is not cached refreshes the projection at most once per NOTES_REFRESH_TTL_MS per    │
 * │ hive, so an ordinary clone of main costs no Queen RPC most of the time.                        │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Contract with T2 (`src/upload.ts`):
 * - T2 calls these only on the hive root (`/git/<hive>`), never on `/git/<hive>/t/<trainId>`, and only for
 *   protocol v2 requests (`git-protocol: version=2`). The request body is already buffered, gunzipped and
 *   parsed into a {@link V2Command}.
 * - `ls-refs`: T2 asks {@link isNotesLsRefs}; when true it returns {@link answerNotesLsRefs}'s Response as is.
 *   Otherwise T2 forwards upstream and filters the answer to `HEAD` + the default branch (so a mixed
 *   heads + notes ls-refs gets heads only, and `refs/notes/queen` is never advertised).
 * - `fetch`: T2 calls {@link answerNotesFetch} for EVERY v2 fetch on the hive root. Return null when the
 *   wants are not all synthesized notes commits; T2 then forwards the fetch upstream unchanged. This runs on
 *   every clone, so make the "not mine" answer cheap (cache by `(hive, ref, version)`).
 * - Failures: if either function throws, T2 degrades safely: a throwing `answerNotesLsRefs` becomes an
 *   empty ls-refs answer (a lone flush: "no notes refs", §9 "notesFor RPC fails"); a throwing
 *   `answerNotesFetch` falls through to the upstream fetch. Never return a wrong note.
 * - Responses: status 200, `content-type: application/x-git-upload-pack-result`, `cache-control: no-cache`.
 *   The function builds the full body (pkt-lines; `pktline.ts` has `pkt`, `band`, `FLUSH`, `DELIM`).
 * - `ctx.notesFor` is the Queen RPC `notesFor(hive, ref)` (one DO call per invocation; it throws when the
 *   RPC fails). It never needs an Artifacts token.
 */
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
  /** Clock in ms (tests inject one; defaults to `Date.now`). */
  now?: () => number;
}

/** The shape T2 depends on; tests inject fakes of it. */
export interface NotesHandlers {
  isNotesLsRefs(cmd: V2Command): boolean;
  answerNotesLsRefs(ctx: NotesContext, cmd: V2Command): Promise<Response>;
  answerNotesFetch(ctx: NotesContext, cmd: V2Command): Promise<Response | null>;
}

const RESULT_HEADERS = { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-cache" };

/** A fetch whose wants are not cached refreshes the hive's projection at most this often. */
export const NOTES_REFRESH_TTL_MS = 30_000;
/** Hives kept in the snapshot cache (least recently used evicted first). */
export const NOTES_CACHE_MAX_HIVES = 16;
/** Object bytes kept in the snapshot cache across all hives (LRU hives evicted beyond it; the current one stays). */
export const NOTES_CACHE_MAX_BYTES = 32 * 1024 * 1024;
/** Snapshots kept per (hive, ref): the current one and the one before it. */
const SNAPSHOTS_PER_REF = 2;

/** Fixed identity and time: the same notes always give the same commit SHA. */
const IDENT = "QueenOS <queenos@queenos.dev> 1760000000 +0000";
const SHA40_RE = /^[0-9a-f]{40}$/;

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;

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

// ── git objects ─────────────────────────────────────────────────────────

interface GitObject {
  type: typeof OBJ_COMMIT | typeof OBJ_TREE | typeof OBJ_BLOB;
  sha: string;
  body: Uint8Array;
}

/** The objects of one ref's notes commit at one projection version. */
interface Snapshot {
  version: number;
  commitSha: string;
  /** Commit first, then tree, then blobs (name order). */
  objects: GitObject[];
  /** Sum of the object bodies, for the cache budget. */
  bytes: number;
}

const TYPE_NAMES = { [OBJ_COMMIT]: "commit", [OBJ_TREE]: "tree", [OBJ_BLOB]: "blob" } as const;

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", data));
}

/** A loose object: SHA-1 over `<type> <len>\0<body>`. */
async function gitObject(type: GitObject["type"], body: Uint8Array): Promise<GitObject> {
  const sha = toHex(await sha1(concat(enc.encode(`${TYPE_NAMES[type]} ${body.length}\0`), body)));
  return { type, sha, body };
}

/**
 * Build the notes commit for one projection: blobs (note text), a flat tree of `100644 <annotated sha>`
 * entries in byte order, and a parentless commit with fixed identity whose message is `notes <ref>`.
 * Throws on a malformed or duplicated annotated SHA (the caller skips the ref rather than serve a bad tree).
 */
async function buildSnapshot(proj: NotesProjection): Promise<Snapshot> {
  const names = new Set<string>();
  const entries: { name: string; blob: GitObject }[] = [];
  for (const note of proj.notes) {
    if (!SHA40_RE.test(note.sha)) throw new Error(`bad annotated sha ${JSON.stringify(note.sha)}`);
    if (names.has(note.sha)) throw new Error(`duplicate note for ${note.sha}`);
    names.add(note.sha);
    entries.push({ name: note.sha, blob: await gitObject(OBJ_BLOB, enc.encode(note.text)) });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const tree = await gitObject(
    OBJ_TREE,
    concat(...entries.flatMap((e) => [enc.encode(`100644 ${e.name}\0`), fromHex(e.blob.sha)])),
  );
  const commit = await gitObject(
    OBJ_COMMIT,
    enc.encode(`tree ${tree.sha}\nauthor ${IDENT}\ncommitter ${IDENT}\n\nnotes ${proj.ref}\n`),
  );

  const objects = [commit, tree];
  const seen = new Set([commit.sha, tree.sha]);
  for (const e of entries) {
    if (seen.has(e.blob.sha)) continue; // two notes with the same text share one blob
    seen.add(e.blob.sha);
    objects.push(e.blob);
  }
  return { version: proj.version, commitSha: commit.sha, objects, bytes: objects.reduce((n, o) => n + o.body.length, 0) };
}

// ── cache ───────────────────────────────────────────────────────────────

interface HiveCache {
  /** When the projection of all three refs was last fetched from the Queen (-Infinity: never). */
  refreshedAt: number;
  /** The refresh in flight, so concurrent misses share one round of RPCs. */
  refreshing: Promise<void> | null;
  /** Per ref, newest version first, at most SNAPSHOTS_PER_REF. */
  refs: Map<NotesRef, Snapshot[]>;
}

/** Map order is recency: the first entry is the least recently used hive. */
const hives = new Map<string, HiveCache>();

/** The hive's cache entry, marked most recently used (created when missing; LRU hives evicted beyond the cap). */
function touchHive(hive: string): HiveCache {
  let h = hives.get(hive);
  if (h) hives.delete(hive);
  else h = { refreshedAt: -Infinity, refreshing: null, refs: new Map() };
  hives.set(hive, h);
  while (hives.size > NOTES_CACHE_MAX_HIVES) hives.delete(hives.keys().next().value!);
  return h;
}

/** Evict least recently used hives (never `keep`) until the cached object bytes fit the budget. */
function enforceByteBudget(keep: string): void {
  let total = 0;
  for (const h of hives.values()) for (const list of h.refs.values()) for (const s of list) total += s.bytes;
  for (const [name, h] of hives) {
    if (total <= NOTES_CACHE_MAX_BYTES) return;
    if (name === keep) continue;
    for (const list of h.refs.values()) for (const s of list) total -= s.bytes;
    hives.delete(name);
  }
}

/** The snapshot for this projection, built and stored unless that version is already cached. */
async function snapshotFor(hive: string, h: HiveCache, proj: NotesProjection): Promise<Snapshot> {
  const cached = h.refs.get(proj.ref)?.find((s) => s.version === proj.version);
  if (cached) return cached;
  const snap = await buildSnapshot(proj);
  const list = (h.refs.get(proj.ref) ?? []).filter((s) => s.version !== proj.version);
  list.push(snap);
  list.sort((a, b) => b.version - a.version);
  h.refs.set(proj.ref, list.slice(0, SNAPSHOTS_PER_REF));
  enforceByteBudget(hive);
  return snap;
}

/** The cached snapshot whose commit is `sha` for this hive (searches only the bounded store). */
function findSnapshot(h: HiveCache, sha: string): Snapshot | undefined {
  for (const list of h.refs.values()) for (const s of list) if (s.commitSha === sha) return s;
  return undefined;
}

/** Fetch every v1 ref's projection in parallel and cache the snapshots; a failing ref is skipped. */
function refresh(ctx: NotesContext, h: HiveCache, now: number): Promise<void> {
  if (h.refreshing) return h.refreshing;
  h.refreshedAt = now;
  const p = Promise.all(
    V1_NOTES_REFS.map(async (ref) => {
      try {
        await snapshotFor(ctx.hive, h, await ctx.notesFor(ref));
      } catch {
        // skipped: its wants stay unknown and the fetch falls through upstream
      }
    }),
  ).then(() => undefined);
  h.refreshing = p.finally(() => {
    h.refreshing = null;
  });
  return h.refreshing;
}

// ── pack ────────────────────────────────────────────────────────────────

/** zlib stream (RFC 1950) of `data`. */
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const w = cs.writable.getWriter();
  w.write(data).catch(() => undefined);
  w.close().catch(() => undefined);
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** Pack object header (gitformat-pack(5)): type in bits 4-6, size in 4 bits then 7-bit groups, MSB = more. */
function objectHeader(type: number, size: number): Uint8Array {
  const out: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(b | 0x80);
    b = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(b);
  return new Uint8Array(out);
}

/** A version 2 pack of whole (undeltified) objects with its SHA-1 trailer. */
async function writePack(objects: GitObject[]): Promise<Uint8Array> {
  const head = new Uint8Array(12);
  head.set(enc.encode("PACK"), 0);
  const dv = new DataView(head.buffer);
  dv.setUint32(4, 2);
  dv.setUint32(8, objects.length);
  const parts: Uint8Array[] = [head];
  for (const o of objects) parts.push(objectHeader(o.type, o.body.length), await deflate(o.body));
  const body = concat(...parts);
  return concat(body, await sha1(body));
}

// ── handlers ────────────────────────────────────────────────────────────

/**
 * Advertise the notes refs matching the `ref-prefix` list (all three when there is none), each at the commit
 * built from a fresh `notesFor` projection. A ref whose RPC or build fails is left out; the answer always
 * ends with a flush. Querying all three refs counts as the hive's refresh for {@link answerNotesFetch}.
 */
export async function answerNotesLsRefs(ctx: NotesContext, cmd: V2Command): Promise<Response> {
  const prefixes = cmd.args.filter((a) => a.startsWith("ref-prefix ")).map((a) => a.slice("ref-prefix ".length));
  const refs = V1_NOTES_REFS.filter((r) => prefixes.length === 0 || prefixes.some((p) => r.startsWith(p)));
  const h = touchHive(ctx.hive);
  if (refs.length === V1_NOTES_REFS.length) h.refreshedAt = (ctx.now ?? Date.now)();

  const lines = await Promise.all(
    refs.map(async (ref) => {
      try {
        const snap = await snapshotFor(ctx.hive, h, await ctx.notesFor(ref));
        return pkt(`${snap.commitSha} ${ref}\n`);
      } catch {
        return null; // §9: a failing ref is simply not advertised
      }
    }),
  );
  const out = lines.filter((l): l is Uint8Array => l !== null);
  out.push(FLUSH);
  return new Response(concat(...out), { headers: RESULT_HEADERS });
}

/**
 * Serve a fetch whose wants are all synthesized notes commits of this hive; null otherwise (T2 forwards it
 * upstream). An unknown want triggers one refresh of the projection if the last one is older than
 * NOTES_REFRESH_TTL_MS; within the TTL it is answered null with no RPC (the ordinary-clone path).
 * The pack holds each wanted commit with its tree and blobs, deduplicated, no deltas.
 */
export async function answerNotesFetch(ctx: NotesContext, cmd: V2Command): Promise<Response | null> {
  const wants = cmd.args.filter((a) => a.startsWith("want ")).map((a) => a.slice("want ".length).trim());
  if (wants.length === 0) return null;

  const h = touchHive(ctx.hive);
  let snaps = wants.map((w) => findSnapshot(h, w));
  if (snaps.some((s) => !s)) {
    const now = (ctx.now ?? Date.now)();
    if (!h.refreshing && now - h.refreshedAt < NOTES_REFRESH_TTL_MS) return null;
    await refresh(ctx, h, now);
    snaps = wants.map((w) => findSnapshot(h, w));
    if (snaps.some((s) => !s)) return null;
  }

  const objects = new Map<string, GitObject>();
  for (const s of snaps as Snapshot[]) for (const o of s.objects) if (!objects.has(o.sha)) objects.set(o.sha, o);
  const pack = await writePack([...objects.values()]);

  const sidebandAll = cmd.capabilities.includes("sideband-all") || cmd.args.includes("sideband-all");
  const done = cmd.args.includes("done");
  // Section headers ride band 1 under sideband-all, plain otherwise; the pack is always on band 1.
  const section = (s: string) => (sidebandAll ? band(1, enc.encode(s)) : pkt(s));
  const out: Uint8Array[] = [];
  if (!done) out.push(section("acknowledgments\n"), section("ready\n"), DELIM);
  out.push(section("packfile\n"), band(1, pack), FLUSH);
  return new Response(concat(...out), { headers: RESULT_HEADERS });
}

export const notesHandlers: NotesHandlers = { isNotesLsRefs, answerNotesLsRefs, answerNotesFetch };
