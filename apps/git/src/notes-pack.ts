/**
 * Synthesized v1 notes refs (docs/human-push-design.md §7.5): the proxy answers protocol-v2 `ls-refs` and
 * `fetch` for `refs/notes/{verdict,review,provenance}` itself, from the Queen's `notesFor` projection.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ STUB. Task T2n owns this file and replaces the bodies of answerNotesLsRefs / answerNotesFetch    │
 * │ (snapshot commit/tree/blob builder, pack v2 writer, `done` / `sideband-all`, the cache by       │
 * │ (hive, ref, version)). T2 (`upload.ts`) owns the call sites and relies only on the contract    │
 * │ below; keep these exported names and signatures.                                               │
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
import { FLUSH } from "./pktline.js";

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

/** The shape T2 depends on; tests inject fakes of it. */
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

/** STUB (T2n): answers "no notes refs" until the pack builder lands. */
export async function answerNotesLsRefs(ctx: NotesContext, cmd: V2Command): Promise<Response> {
  void ctx;
  void cmd;
  return new Response(FLUSH, { headers: RESULT_HEADERS });
}

/** STUB (T2n): never claims a fetch until the pack builder lands. */
export async function answerNotesFetch(ctx: NotesContext, cmd: V2Command): Promise<Response | null> {
  void ctx;
  void cmd;
  return null;
}

export const notesHandlers: NotesHandlers = { isNotesLsRefs, answerNotesLsRefs, answerNotesFetch };
