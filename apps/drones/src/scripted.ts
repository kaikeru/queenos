/**
 * Deterministic "scripted" LLM for demos and tests (DRONE_LLM_MODE=scripted).
 * The same task always yields the same change set; git and Artifacts still
 * run for real.
 */
import type { DroneTask } from "@queenos/queen-types";
import { validateChangeSet, type ChangeSet } from "./change-set";

export const SCRIPTED_MODEL = "queenos/scripted-drone-v1";

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // drop combining marks: é -> e
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "feature";
}

/** FNV-1a, hex. Stable across runtimes. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function title(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? text;
  return line.trim().slice(0, 80);
}

type ScriptedTask = Pick<DroneTask, "promptId" | "promptText" | "action" | "ragContext"> & { scribeSummary?: string | undefined };

/**
 * Canned change set: `features/<slug>-<id>.md` plus a small TS module. The
 * prompt id keeps two identical prompts from colliding on one path (a no-op
 * commit would fail the build).
 */
export function scriptedChangeSet(task: ScriptedTask): ChangeSet {
  const slug = slugify(task.promptText);
  const id = fnv1a(`${task.promptId}:${task.promptText}`);
  const name = `${slug}-${id}`;
  const ident = `feature_${slug.replace(/-/g, "_")}_${id}`;
  const heading = title(task.promptText);
  const rework = task.action === "REWORK";

  const doc = [
    `# ${heading}`,
    "",
    "> Built by a QueenOS builder drone (scripted mode).",
    "",
    "## Request",
    "",
    task.promptText.trim(),
    "",
    ...(rework && task.scribeSummary ? ["## Rework", "", `Previous attempt failed: ${task.scribeSummary}`, ""] : []),
    ...(task.ragContext.length ? ["## Hive memory consulted", "", ...task.ragContext.slice(0, 5).map((s) => `- ${s.slice(0, 200)}`), ""] : []),
    "## Status",
    "",
    `- module: \`src/features/${name}.ts\``,
    `- flag: \`${ident}\``,
    "",
  ].join("\n");

  const code = [
    `/** ${heading.replace(/\*\//g, "* /")} */`,
    `export const ${ident} = {`,
    `  slug: ${JSON.stringify(slug)},`,
    `  promptId: ${JSON.stringify(task.promptId)},`,
    `  enabled: true,`,
    `  revision: ${rework ? 2 : 1},`,
    `} as const;`,
    "",
  ].join("\n");

  return validateChangeSet({
    files: [
      { path: `features/${name}.md`, content: doc },
      { path: `src/features/${name}.ts`, content: code },
    ],
    reasoningSteps: [
      `Parsed the request: "${heading}".`,
      task.ragContext.length
        ? `Consulted ${task.ragContext.length} hive memory snippet(s) for prior art.`
        : "No hive memory matched; starting from the current train head.",
      ...(rework && task.scribeSummary ? [`Rework: addressed the Scribe summary "${task.scribeSummary.slice(0, 160)}".`] : []),
      `Added feature doc features/${name}.md and module src/features/${name}.ts behind flag ${ident}.`,
      "Kept the change additive so speculative trains ahead of and behind this one stay mergeable.",
    ],
    discardedPaths: [`src/index.ts (wiring ${ident} globally was out of scope)`],
  });
}
