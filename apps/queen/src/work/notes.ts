/**
 * The v1 notes projection (docs/human-push-design.md §7; T1). Notes are the outward feedback protocol: a
 * PROJECTION of the Queen's ledger (event log, audits, train and release rows), regenerated on every call and
 * served by the git proxy as `refs/notes/{verdict,review,provenance}`. They are never input to a decision.
 *
 * Pure: the Queen reads the rows (`notesFor`), this module turns them into entries rendered with the T0b
 * `renderNotes`. The same code renders a REWORK's brief (`DroneTask.brief`), so the brief is byte-identical
 * to what `git log --notes=verdict` shows on the rejected commit.
 *
 * Per submission head (a BUILD train's `headSha`, drone or pushed), in ledger order (event seq):
 * - verdict: PASSED / REJECTED by <ROLE> (with its findings) / INFRA from `gate.verdict` events;
 *   SUPERSEDED, REJECTED (lost race, conflict) from the train's EJECTED event; LANDED main@<sha> from MERGED;
 *   then SHIPPED / ROLLED BACK from its release (milestones with no `Queen-Verdict`: the last verdict stays
 *   LANDED, so clients that wait for LANDED stop there). A REWORK seeded from a contributor's head carries
 *   `Queen-Replies-To: <that head>`.
 * - review: the rejected gate's findings (`drone.audit` REJECTED reasoning steps between the train's
 *   enqueue, or its previous verdict, and this verdict; only the train's own when the audit names it).
 * - provenance: who wrote the head (model for drones, `human:` / `agent:` for pushes) and its trace.
 */
import {
  NOTES_REF_PROVENANCE,
  NOTES_REF_REVIEW,
  NOTES_REF_VERDICT,
  NoteEntrySchema,
  NoteFindingSchema,
  renderNotes,
  type NoteEntryInput,
  type NoteFinding,
  type NotesRef,
  type QueenEvent,
  type SubmissionOrigin,
} from "@queenos/queen-types";

/** The last annotated commits per ref (about 30 days). */
export const MAX_NOTES = 1000;
const MAX_FINDINGS = 20;

/** What the projection needs of a BUILD train. */
export interface NotesTrain {
  trainId: string;
  promptId: string;
  seq: number;
  headSha: string | null;
  baseSha: string;
  phase: string;
  reason: string | null;
  landedSha: string | null;
  action: string;
  model: string | null;
  traceId: string | null;
  raceOutcome?: string | null;
  conflict?: { paths: string[]; summary: string } | null;
  origin?: SubmissionOrigin | null;
  /** The branch a pushed submission came from (`refs/heads/...`), when known. */
  ref?: string | null;
}

export interface NotesRelease {
  releaseId: string;
  trainIds: string[];
}

export interface NotesInput {
  /** BUILD trains with a head, any order. */
  trains: readonly NotesTrain[];
  /** `gate.verdict`, `train.enqueued`, `train.phase` (to MERGED / EJECTED) of those trains; `drone.audit` (REJECTED) of their items; `release.phase` of their releases. */
  events: readonly QueenEvent[];
  /** SHIPPED / ROLLED_BACK releases (their member BUILD trains). */
  releases: readonly NotesRelease[];
}

export interface ProjectedNote {
  sha: string;
  text: string;
}

const SHA40 = /^[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function oneLine(s: string, max: number): string {
  const t = s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function short(sha: string | null | undefined): string {
  return (sha ?? "").slice(0, 7);
}

/** `drone:<trainId>` | `human:<email>` | `agent:<name>@<email>`. */
export function originLabel(t: Pick<NotesTrain, "origin" | "trainId">): string {
  const o = t.origin;
  const raw = o && o.kind !== "drone" ? `${o.kind}:${o.id}` : `drone:${o?.id ?? t.trainId}`;
  return raw.replace(/\s+/g, "");
}

function contributed(t: NotesTrain): boolean {
  return !!t.origin && t.origin.kind !== "drone";
}

/** Findings from a gatekeeper audit's reasoning steps (`[error] rule file:line: message`, reviewer `missing: …`). */
export function findingsFromSteps(steps: readonly string[]): NoteFinding[] {
  const out: NoteFinding[] = [];
  for (const step of steps) {
    let candidate: unknown = null;
    const scan = /^\[(error|warning)\]\s+(\S+)\s+(\S+?)(?::(\d+))?:\s+(.+)$/.exec(step.trim());
    const missing = /^missing:\s*(.+)$/i.exec(step.trim());
    if (scan) {
      candidate = { severity: scan[1], path: scan[3], ...(scan[4] ? { line: Number(scan[4]) } : {}), message: oneLine(`${scan[2]}: ${scan[5]}`, 500) };
    } else if (missing) {
      candidate = { severity: "error", path: "acceptance", message: oneLine(`not satisfied: ${missing[1]}`, 500) };
    }
    const f = candidate ? NoteFindingSchema.safeParse(candidate) : null;
    if (f?.success) out.push(f.data);
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

interface Dated {
  seq: number;
  entry: NoteEntryInput;
}

function stripGatePrefix(summary: string): string {
  return summary.replace(/^gate (passed|failed|could not run[^:]*):\s*/i, "");
}

/** The seq of the train's latest `gate.verdict` before `seq` (an INFRA round's audits are not this verdict's), or 0. */
function lastVerdictBefore(mine: readonly QueenEvent[], seq: number): number {
  return mine.filter((e) => e.type === "gate.verdict" && e.seq < seq).at(-1)?.seq ?? 0;
}

/**
 * The REJECTED audits behind one gate verdict of `t`, strictly between `from` and `to` (seq). An audit that names
 * its train (gatekeepers send `trainId`, and the head as `data.commitSha`) counts only for that train and head, so
 * race siblings of one item never share findings. An older audit without a train falls back to the item.
 */
function gateAudits(t: NotesTrain, events: readonly QueenEvent[], from: number, to: number): QueenEvent[] {
  return events.filter((a) => {
    if (a.type !== "drone.audit" || a.auditStatus !== "REJECTED" || a.seq <= from || a.seq >= to) return false;
    if (!a.trainId) return a.itemId === t.promptId;
    if (a.trainId !== t.trainId) return false;
    const sha = a.data?.commitSha;
    return typeof sha !== "string" || !t.headSha || sha === t.headSha;
  });
}

/** Every verdict / review / provenance entry of one train, in ledger order. */
function trainEntries(t: NotesTrain, input: NotesInput, byHead: ReadonlyMap<string, NotesTrain[]>): Record<NotesRef, Dated[]> {
  const out: Record<NotesRef, Dated[]> = { [NOTES_REF_VERDICT]: [], [NOTES_REF_REVIEW]: [], [NOTES_REF_PROVENANCE]: [] } as Record<NotesRef, Dated[]>;
  const mine = input.events.filter((e) => e.trainId === t.trainId).sort((a, b) => a.seq - b.seq);
  const start = mine.find((e) => e.type === "train.enqueued")?.seq ?? mine[0]?.seq ?? 0;
  const origin = originLabel(t);
  // A REWORK forked from a contributor's rejected head answers it.
  const repliesTo =
    t.action === "REWORK" && SHA40.test(t.baseSha) && (byHead.get(t.baseSha) ?? []).some((x) => x.promptId === t.promptId && contributed(x)) ? t.baseSha : undefined;
  const common = {
    ...(ID.test(t.promptId) ? { itemId: t.promptId } : {}),
    ...(ID.test(t.trainId) ? { trainId: t.trainId } : {}),
    ...(t.traceId && ID.test(t.traceId) ? { traceId: t.traceId } : {}),
    origin,
    ...(repliesTo ? { repliesTo } : {}),
  };
  const branch = t.ref?.replace(/^refs\/heads\//, "") ?? null;
  const next = contributed(t)
    ? `Push a fix to ${branch ?? "your branch"}, or hand off: a "Queen: rework" trailer, or "Let the swarm fix it" on item ${t.promptId}.`
    : "The swarm reworks it.";

  for (const e of mine) {
    if (e.type === "gate.verdict") {
      const data = e.data ?? {};
      if (data.applied !== undefined && data.applied !== "applied") continue;
      const text = oneLine(stripGatePrefix(e.summary), 240);
      if (data.outcome === "PASSED") {
        out[NOTES_REF_VERDICT].push({ seq: e.seq, entry: { ...common, kind: "verdict", verdict: "PASSED", summary: oneLine(`PASSED: ${text || "every gate passed"}`, 300) } });
      } else if (data.outcome === "INFRA") {
        out[NOTES_REF_VERDICT].push({ seq: e.seq, entry: { ...common, kind: "verdict", verdict: "INFRA", summary: oneLine(`INFRA: the gate could not run; the Queen re-gates it (${text})`, 300) } });
      } else if (data.outcome === "FAILED") {
        const audits = gateAudits(t, input.events, Math.max(start, lastVerdictBefore(mine, e.seq)), e.seq);
        const roles = [...new Set(audits.map((a) => a.droneRole ?? "GATE"))];
        const findings = audits.flatMap((a) => findingsFromSteps(a.gitNotesPayload?.reasoningSteps ?? [])).slice(0, MAX_FINDINGS);
        const by = roles[0] ?? "GATE";
        out[NOTES_REF_VERDICT].push({
          seq: e.seq,
          entry: { ...common, kind: "verdict", verdict: "REJECTED", summary: oneLine(`REJECTED by ${by}: ${text || "the gate failed"}`, 300), body: next, findings },
        });
        if (findings.length) {
          out[NOTES_REF_REVIEW].push({
            seq: e.seq,
            entry: { ...common, kind: "finding", summary: oneLine(`Findings: ${findings.length} from ${roles.join(", ") || "the gate"}`, 300), findings },
          });
        }
      }
    } else if (e.type === "train.phase") {
      const to = e.data?.to;
      if (to === "MERGED") {
        const landed = t.landedSha && SHA40.test(t.landedSha) ? t.landedSha : null;
        out[NOTES_REF_VERDICT].push({ seq: e.seq, entry: { ...common, kind: "verdict", verdict: "LANDED", summary: `LANDED main@${landed ? short(landed) : "?"}${landed ? ` (${landed})` : ""}` } });
      } else if (to === "EJECTED") {
        const reason = String(e.data?.reason ?? t.reason ?? "");
        if (/^superseded/i.test(reason)) {
          out[NOTES_REF_VERDICT].push({ seq: e.seq, entry: { ...common, kind: "verdict", verdict: "SUPERSEDED", summary: oneLine(`SUPERSEDED: ${reason}`, 300) } });
        } else if (/^lost race/i.test(reason)) {
          out[NOTES_REF_VERDICT].push({ seq: e.seq, entry: { ...common, kind: "verdict", verdict: "REJECTED", summary: oneLine(`REJECTED (lost the race): ${reason}`, 300) } });
        } else if (t.conflict) {
          const paths = t.conflict.paths.slice(0, 5).join(", ");
          out[NOTES_REF_VERDICT].push({
            seq: e.seq,
            entry: {
              ...common,
              kind: "verdict",
              verdict: "REJECTED",
              summary: oneLine(`REJECTED (CONFLICT): conflicts with work that landed: ${paths || t.conflict.summary}`, 300),
              body: contributed(t) ? "Rebase on origin/main and push the branch again, or hand off." : "The swarm reworks it on top of main.",
            },
          });
        }
      }
    }
  }
  for (const r of input.releases) {
    if (!r.trainIds.includes(t.trainId)) continue;
    const ev = input.events.filter((e) => e.type === "release.phase" && e.releaseId === r.releaseId).sort((a, b) => a.seq - b.seq);
    for (const e of ev) {
      const to = e.data?.to;
      if (to === "SHIPPED") out[NOTES_REF_VERDICT].push({ seq: e.seq, entry: { ...common, kind: "verdict", summary: oneLine(`SHIPPED in release ${r.releaseId}`, 300) } });
      else if (to === "ROLLED_BACK") out[NOTES_REF_VERDICT].push({ seq: e.seq, entry: { ...common, kind: "verdict", summary: oneLine(`ROLLED BACK: release ${r.releaseId} was rolled back`, 300) } });
    }
  }
  const model = !contributed(t) && t.model && /^\S{1,128}$/.test(t.model) ? t.model : undefined;
  out[NOTES_REF_PROVENANCE].push({
    seq: start,
    entry: {
      ...common,
      kind: "provenance",
      summary: contributed(t) ? `PUSHED by ${origin}` : `BUILT by ${model ?? "a drone"} (${t.action})`,
      ...(model ? { model } : {}),
    },
  });
  return out;
}

/** Entries that fail the v1 schema are dropped (never a wrong note, never a throw). */
function valid(e: NoteEntryInput): boolean {
  return NoteEntrySchema.safeParse(e).success;
}

/**
 * The projection of one ref: one note per annotated head (its entries newest last, rendered with
 * `renderNotes`, ≤ MAX_NOTE_TOTAL), newest head first, at most MAX_NOTES.
 */
export function projectNotes(input: NotesInput, ref: NotesRef): ProjectedNote[] {
  const byHead = new Map<string, NotesTrain[]>();
  for (const t of input.trains) {
    if (!t.headSha || !SHA40.test(t.headSha)) continue;
    const list = byHead.get(t.headSha) ?? [];
    list.push(t);
    byHead.set(t.headSha, list);
  }
  const notes: { sha: string; last: number; text: string }[] = [];
  for (const [sha, trains] of byHead) {
    const dated = trains
      .sort((a, b) => a.seq - b.seq)
      .flatMap((t) => trainEntries(t, input, byHead)[ref])
      .filter((d) => valid(d.entry))
      .sort((a, b) => a.seq - b.seq);
    if (!dated.length) continue;
    notes.push({ sha, last: Math.max(...trains.map((t) => t.seq)), text: renderNotes(dated.map((d) => d.entry)) });
  }
  return notes
    .sort((a, b) => b.last - a.last)
    .slice(0, MAX_NOTES)
    .map(({ sha, text }) => ({ sha, text }));
}
