import { z } from "zod";
import { MAX_NOTE_TEXT, MAX_NOTE_TOTAL } from "./executors.js";
import { TRAILER_RE } from "./inbox.js";

/**
 * Note format v1 (docs/human-push-design.md §7, docs/agent-protocol.md §4). Notes are the outward feedback
 * protocol: a projection of the Queen's ledger, served by the git proxy, never authority. The Queen, the
 * proxy, the drones and the plugin all use `renderNote` / `parseNotes`; nobody hand-formats a note.
 */

// ── refs ────────────────────────────────────────────────────────────────

export const NOTES_REF_VERDICT = "refs/notes/verdict";
export const NOTES_REF_REVIEW = "refs/notes/review";
export const NOTES_REF_PROVENANCE = "refs/notes/provenance";
/** The three refs the proxy serves (v1 notes). */
export const V1_NOTES_REFS = [NOTES_REF_VERDICT, NOTES_REF_REVIEW, NOTES_REF_PROVENANCE] as const;
export const NotesRefSchema = z.enum(V1_NOTES_REFS);
export type NotesRef = z.infer<typeof NotesRefSchema>;
/** The INTERNAL Cognitive Ledger (`GitNotesPayload` JSON; hive-kit `NOTES_REF`). Never v1, never served. */
export const INTERNAL_NOTES_REF = "refs/notes/queen";

/** True for the three served v1 refs; false for `refs/notes/queen` and everything else. */
export function isV1NotesRef(ref: string): ref is NotesRef {
  return (V1_NOTES_REFS as readonly string[]).includes(ref);
}

// ── schema ──────────────────────────────────────────────────────────────

export const NOTE_VERSION = "v1";
export const NoteKindSchema = z.enum(["verdict", "finding", "rework-brief", "provenance", "memory"]);
export type NoteKind = z.infer<typeof NoteKindSchema>;
export const NoteVerdictSchema = z.enum(["PASSED", "REJECTED", "INFRA", "LANDED", "SUPERSEDED"]);
export type NoteVerdict = z.infer<typeof NoteVerdictSchema>;

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Sha40 = z.string().regex(/^[0-9a-f]{40}$/);
const OneLine = (max: number) => z.string().min(1).max(max).regex(/^[^\r\n]*$/, "single line");

export const NoteFindingSchema = z.object({
  severity: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,15}$/),
  /** No whitespace. */
  path: z.string().regex(/^\S{1,300}$/),
  line: z.number().int().min(1).optional(),
  message: OneLine(500),
});
export type NoteFinding = z.infer<typeof NoteFindingSchema>;

export const NoteMemorySchema = z.object({ memoryId: Id, use: z.enum(["used", "ignored"]) });
export type NoteMemory = z.infer<typeof NoteMemorySchema>;

export const NoteEntrySchema = z.object({
  /** Starts with the verdict word (`REJECTED by SECURITY: ...`), never `queen:` (it would parse as a trailer). */
  summary: OneLine(300).refine((s) => !TRAILER_RE.test(s.trim()), "summary must not look like a Queen trailer"),
  body: z.string().max(MAX_NOTE_TEXT).optional(),
  kind: NoteKindSchema,
  verdict: NoteVerdictSchema.optional(),
  itemId: Id.optional(),
  trainId: Id.optional(),
  traceId: Id.optional(),
  /** `drone:<id>` | `human:<email>` | `agent:<id>`. */
  origin: z.string().regex(/^(drone|human|agent):\S{1,320}$/).optional(),
  model: z.string().regex(/^\S{1,128}$/).optional(),
  findings: z.array(NoteFindingSchema).max(100).default([]),
  repliesTo: Sha40.optional(),
  memories: z.array(NoteMemorySchema).max(50).default([]),
});
export type NoteEntry = z.infer<typeof NoteEntrySchema>;
export type NoteEntryInput = z.input<typeof NoteEntrySchema>;

// ── render ──────────────────────────────────────────────────────────────

const ENTRY_SEP = "---";
const TRAILER_LIKE = /^\s*queen(?:-[a-z]+)*\s*:/i;

function findingLine(f: NoteFinding): string {
  return `Queen-Finding: ${f.severity} ${f.path}${f.line ? `:${f.line}` : ""} ${f.message}`;
}

/** Make free text safe to sit above the trailer block: no trailer-looking lines, no entry separators. */
function escapeProse(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => (TRAILER_LIKE.test(l) || l.trim() === ENTRY_SEP ? `> ${l}` : l))
    .join("\n");
}

function trailerLines(e: NoteEntry, findings: NoteFinding[]): string[] {
  const t = [`Queen-Note: ${NOTE_VERSION}`, `Queen-Kind: ${e.kind}`];
  if (e.verdict) t.push(`Queen-Verdict: ${e.verdict}`);
  if (e.itemId) t.push(`Queen-Item: ${e.itemId}`);
  if (e.trainId) t.push(`Queen-Train: ${e.trainId}`);
  if (e.traceId) t.push(`Queen-Trace: ${e.traceId}`);
  if (e.origin) t.push(`Queen-Origin: ${e.origin}`);
  if (e.model) t.push(`Queen-Model: ${e.model}`);
  for (const f of findings) t.push(findingLine(f));
  if (e.repliesTo) t.push(`Queen-Replies-To: ${e.repliesTo}`);
  for (const m of e.memories) t.push(`Queen-Memory: ${m.memoryId} ${m.use}`);
  return t;
}

function clip(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Render one entry, at most `MAX_NOTE_TEXT` characters. When too long: findings are dropped last-first
 * (a "+N more findings" line replaces them), then the body is clipped, then the summary.
 */
export function renderNote(input: NoteEntryInput): string {
  const e = NoteEntrySchema.parse(input);
  const assemble = (summary: string, body: string, findings: NoteFinding[], dropped: number): string => {
    const prose = [body, dropped > 0 ? `+${dropped} more findings` : ""].filter(Boolean).join("\n");
    return [summary, ...(prose ? ["", prose] : []), "", ...trailerLines(e, findings)].join("\n");
  };
  const body = e.body ? escapeProse(e.body).trim() : "";
  let kept = e.findings.length;
  let out = assemble(e.summary, body, e.findings, 0);
  while (out.length > MAX_NOTE_TEXT && kept > 0) {
    kept -= 1;
    out = assemble(e.summary, body, e.findings.slice(0, kept), e.findings.length - kept);
  }
  if (out.length > MAX_NOTE_TEXT) {
    const over = out.length - MAX_NOTE_TEXT;
    out = assemble(e.summary, clip(body, body.length - over), e.findings.slice(0, kept), e.findings.length - kept);
  }
  if (out.length > MAX_NOTE_TEXT) {
    const over = out.length - MAX_NOTE_TEXT;
    out = assemble(clip(e.summary, e.summary.length - over), "", e.findings.slice(0, kept), e.findings.length - kept);
  }
  return out;
}

/**
 * Render a commit's note: its entries in order, newest last, separated by a `---` line, at most
 * `MAX_NOTE_TOTAL` characters (the OLDEST entries are dropped to fit).
 */
export function renderNotes(entries: readonly NoteEntryInput[]): string {
  const parts = entries.map(renderNote);
  const join = () => parts.join(`\n${ENTRY_SEP}\n`);
  while (parts.length > 1 && join().length > MAX_NOTE_TOTAL) parts.shift();
  return join();
}

// ── parse ───────────────────────────────────────────────────────────────

const FINDING_RE = /^(\S+)\s+(\S+?)(?::(\d+))?\s+(.+)$/;
const MEMORY_RE = /^(\S+)\s+(used|ignored)$/i;

function parseEntry(chunk: string): NoteEntry | null {
  const lines = chunk.replace(/\r/g, "").split("\n");
  // The version gate: the LAST `Queen-Note: v1` line opens the trailer block (body text can't forge one).
  let gate = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = TRAILER_RE.exec(lines[i]!.trim());
    if (m && m[1]!.toLowerCase() === "queen-note") {
      if (m[2]!.toLowerCase() === NOTE_VERSION) gate = i;
      break;
    }
  }
  if (gate < 0) return null;

  const raw = new Map<string, string>();
  const findings: NoteFinding[] = [];
  const memories: NoteMemory[] = [];
  for (const line of lines.slice(gate + 1)) {
    const m = TRAILER_RE.exec(line.trim());
    if (!m) continue; // trailers sit on lines of their own; anything else is ignored
    const key = m[1]!.toLowerCase();
    const val = m[2]!;
    if (key === "queen-finding") {
      const f = FINDING_RE.exec(val);
      const parsed = f
        ? NoteFindingSchema.safeParse({ severity: f[1], path: f[2], ...(f[3] ? { line: Number(f[3]) } : {}), message: f[4] })
        : null;
      if (parsed?.success) findings.push(parsed.data);
    } else if (key === "queen-memory") {
      const mm = MEMORY_RE.exec(val);
      const parsed = mm ? NoteMemorySchema.safeParse({ memoryId: mm[1], use: mm[2]!.toLowerCase() }) : null;
      if (parsed?.success) memories.push(parsed.data);
    } else {
      raw.set(key, val); // last occurrence wins; unknown keys are simply never read
    }
  }

  const kind = NoteKindSchema.safeParse(raw.get("queen-kind")?.toLowerCase());
  if (!kind.success) return null; // unknown or missing kind: not an entry this reader understands

  const before = lines.slice(0, gate);
  const first = before.findIndex((l) => l.trim() !== "");
  if (first < 0) return null;
  const summary = before[first]!.trim().slice(0, 300);
  const body = before.slice(first + 1).join("\n").trim();

  const pick = <T>(schema: z.ZodType<T>, key: string, transform: (s: string) => string = (s) => s): T | undefined => {
    const v = raw.get(key);
    const r = v === undefined ? null : schema.safeParse(transform(v));
    return r?.success ? r.data : undefined;
  };
  const entry: NoteEntryInput = {
    summary,
    kind: kind.data,
    findings,
    memories,
    ...(body ? { body: body.slice(0, MAX_NOTE_TEXT) } : {}),
  };
  const verdict = pick(NoteVerdictSchema, "queen-verdict", (s) => s.toUpperCase());
  if (verdict) entry.verdict = verdict;
  const itemId = pick(Id, "queen-item");
  if (itemId) entry.itemId = itemId;
  const trainId = pick(Id, "queen-train");
  if (trainId) entry.trainId = trainId;
  const traceId = pick(Id, "queen-trace");
  if (traceId) entry.traceId = traceId;
  const origin = pick(NoteEntrySchema.shape.origin.unwrap(), "queen-origin");
  if (origin) entry.origin = origin;
  const model = pick(NoteEntrySchema.shape.model.unwrap(), "queen-model");
  if (model) entry.model = model;
  const repliesTo = pick(Sha40, "queen-replies-to", (s) => s.toLowerCase());
  if (repliesTo) entry.repliesTo = repliesTo;

  const out = NoteEntrySchema.safeParse(entry);
  return out.success ? out.data : null; // e.g. a summary that looks like a trailer
}

/**
 * Parse a commit's note into its v1 entries, oldest first (newest last). Entries without `Queen-Note: v1`
 * (or with an unknown kind) are skipped; unknown keys are ignored; keys are case-insensitive.
 *
 * Pass `ref` when known: `refs/notes/queen` (the internal Cognitive Ledger JSON) and any ref that is not one
 * of the three served v1 refs yield `[]`, never an attempt to parse.
 */
export function parseNotes(text: string, opts: { ref?: string } = {}): NoteEntry[] {
  if (opts.ref !== undefined && !isV1NotesRef(opts.ref)) return [];
  const chunks: string[] = [];
  let cur: string[] = [];
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (line.trim() === ENTRY_SEP) {
      chunks.push(cur.join("\n"));
      cur = [];
    } else cur.push(line);
  }
  chunks.push(cur.join("\n"));
  const out: NoteEntry[] = [];
  for (const c of chunks) {
    const e = parseEntry(c);
    if (e) out.push(e);
  }
  return out;
}

/** The current verdict of a commit: the last entry that carries a `Queen-Verdict`. */
export function currentVerdict(entries: readonly NoteEntry[]): NoteVerdict | undefined {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.verdict) return entries[i]!.verdict;
  return undefined;
}
