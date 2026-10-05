/**
 * Builder prompt composition and Queen-written item text (v2 design §2.2 step
 * 6, §3.4). Pure. The gatekeepers' reviewer gets the same `promptText`, so an
 * item's acceptance criteria become review criteria for free.
 */
import type { WorkItem } from "@queenos/queen-types";

/** Upper bound of a composed builder prompt (the Oracle's DECOMPOSE promptText limit). */
export const MAX_PROMPT_CHARS = 16_000;
export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 4000;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * `title\n\nbody\n\nAcceptance criteria:\n- a\n- b`, ≤ MAX_PROMPT_CHARS. Empty
 * parts are left out. A body equal to the title (a one-line prompt) is not repeated.
 */
export function composePrompt(item: Pick<WorkItem, "title" | "body" | "acceptance">): string {
  const parts = [item.title.trim()];
  const body = item.body.trim();
  if (body && body !== parts[0]) parts.push(body);
  const acceptance = item.acceptance.map((a) => a.trim()).filter(Boolean);
  if (acceptance.length) parts.push(`Acceptance criteria:\n${acceptance.map((a) => `- ${a}`).join("\n")}`);
  return clip(parts.join("\n\n"), MAX_PROMPT_CHARS);
}

/** A title from free text: its first non-empty line, whitespace-collapsed, ≤ 120 chars. */
export function titleFromText(text: string): string {
  const line = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  return clip(line || "untitled", MAX_TITLE_CHARS);
}

/** `decompose: false` (v1 semantics) and the DECOMPOSE fallback: title = first line, body = the full text (≤ 4000). */
export function itemTextFromPrompt(promptText: string): { title: string; body: string } {
  return { title: titleFromText(promptText), body: clip(promptText.trim(), MAX_BODY_CHARS) };
}

export interface ReleaseFailure {
  releaseId: string;
  /** ROLLED_BACK (canary) or FAILED (staging or canary deploy). */
  phase: "ROLLED_BACK" | "FAILED";
  summary: string | null;
}

/** The P0 bug the Queen files for a rolled-back or failed release (§3.4): title + body with the verdict and the items it carried. */
export function releaseBugText(r: ReleaseFailure, itemTitles: readonly string[]): { title: string; body: string } {
  const verb = r.phase === "ROLLED_BACK" ? "rolled back" : "failed";
  const summary = (r.summary ?? "").trim() || "no summary";
  const title = clip(`Release ${r.releaseId} ${verb}: ${summary}`, MAX_TITLE_CHARS);
  const lines = [
    `Release ${r.releaseId} ${verb}.`,
    `Verdict: ${summary}`,
    ...(itemTitles.length ? ["", "It carried:", ...itemTitles.map((t) => `- ${t}`)] : []),
    "",
    "Find what in these changes broke the release and fix it on top of current main.",
  ];
  return { title, body: clip(lines.join("\n"), MAX_BODY_CHARS) };
}
