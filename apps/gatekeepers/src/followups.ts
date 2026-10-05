/**
 * Findings outside the diff (v2 design §3.4). A scan that flags a file the change did not
 * touch is reporting a pre-existing problem: it does not fail the gate, it is filed as a bug
 * (`TrainResult.followUps`, at most 3: security first, P1; policy P2).
 */
import type { FollowUp } from "@queenos/queen-types";
import type { Finding } from "./findings";
import { clip } from "./scribe";

export const MAX_FOLLOW_UPS = 3;
export const PRE_EXISTING_PREFIX = "pre-existing, outside the diff: ";

/** Is this error finding in a real file the change did not touch? (Then it is a follow-up, not a failure.) */
export function isOutOfDiff(f: Finding, changed: ReadonlySet<string> | null, files: Record<string, string>): boolean {
  if (f.severity !== "error" || !changed || changed.size === 0) return false;
  return Object.hasOwn(files, f.file) && !changed.has(f.file);
}

export function followUpsFrom(security: Finding[], policy: Finding[], max = MAX_FOLLOW_UPS): FollowUp[] {
  const out: FollowUp[] = [];
  const seen = new Set<string>();
  const add = (f: Finding, label: "Security" | "Policy", priority: 1 | 2) => {
    const key = `${f.rule}|${f.file}`;
    if (out.length >= max || seen.has(key)) return;
    seen.add(key);
    const where = `${f.file}${f.line ? `:${f.line}` : ""}`;
    out.push({
      kind: "bug",
      title: clip(`${label} scan: ${f.rule} in ${f.file}`, 120),
      body: clip(`The gate's ${label.toLowerCase()} scan flagged ${where}: ${f.message.replace(PRE_EXISTING_PREFIX, "")}. The file is outside the diff of the change that was gated, so it did not fail that gate.`, 1000),
      paths: [f.file.slice(0, 200)],
      priority,
    });
  };
  for (const f of security) add(f, "Security", 1);
  for (const f of policy) add(f, "Policy", 2);
  return out;
}
