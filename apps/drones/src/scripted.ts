/**
 * Deterministic "scripted" LLM for demos and tests (DRONE_LLM_MODE=scripted).
 * The same task always yields the same change set; git and Artifacts still
 * run for real.
 */
import type { DroneTask } from "@queenos/queen-types";
import { FEATURE_REGISTRY_PATH, renderRegistry } from "@queenos/hive-kit";
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

/** Prompt marker that makes a scripted BUILD ship a real bug (gatekeepers' FAIL_MARKER). */
export const FAIL_MARKER = "[fail]";

// The feature registry helpers live in hive-kit (the merge queue's registry merge driver
// uses them too); re-exported here so existing imports keep working.
export { FEATURE_REGISTRY_PATH, featureModuleName, mergeRegistry, registryModules, renderRegistry } from "@queenos/hive-kit";

/**
 * Canned change set, deployable with the no-build template: the feature doc
 * `features/<slug>-<id>.md`, a JS module `src/features/<slug>-<id>.js` that
 * serves `GET /features/<slug>`, and the updated registry. The prompt id keeps
 * two identical prompts from colliding on one path (a no-op commit would fail
 * the build).
 *
 * A prompt containing `[fail]` ships a bug on its first attempt (BUILD): the
 * module's `guard` throws on every request, so `GET /` returns HTTP 500 and the
 * gatekeepers' smoke test fails for real. The REWORK omits the guard. This
 * mirrors the gatekeepers' scripted runner ("fail once, pass on REWORK").
 */
export function scriptedChangeSet(task: ScriptedTask): ChangeSet {
  const slug = slugify(task.promptText);
  const id = fnv1a(`${task.promptId}:${task.promptText}`);
  const name = `${slug}-${id}`;
  const heading = title(task.promptText);
  const rework = task.action === "REWORK";
  const buggy = !rework && task.promptText.includes(FAIL_MARKER);

  const doc = [
    `# ${heading}`,
    "",
    "> Built by a QueenOS builder drone (scripted mode).",
    "",
    "## Request",
    "",
    task.promptText.trim(),
    "",
    ...(rework && task.scribeSummary ? ["## Rework", "", `Previous attempt failed: ${task.scribeSummary}`, ""] : rework ? ["## Rework", "", "Previous attempt failed its gate; removed the faulty guard.", ""] : []),
    ...(task.ragContext.length ? ["## Hive memory consulted", "", ...task.ragContext.slice(0, 5).map((s) => `- ${s.slice(0, 200)}`), ""] : []),
    "## Status",
    "",
    `- module: \`src/features/${name}.js\``,
    `- route: \`GET /features/${slug}\``,
    "",
  ].join("\n");

  const code = [
    `// ${heading.replace(/[\r\n]+/g, " ")}`,
    `export const slug = ${JSON.stringify(slug)};`,
    `export const promptId = ${JSON.stringify(task.promptId)};`,
    `export const revision = ${rework ? 2 : 1};`,
    "",
    "export function handle() {",
    "  return Response.json({ feature: slug, promptId, revision, enabled: true });",
    "}",
    ...(buggy
      ? [
          "",
          "// Runs on every request. BUG: `flags` is never configured, so this throws.",
          "export function guard() {",
          "  const config = {};",
          "  if (config.flags.enabled) return;",
          "}",
        ]
      : []),
    "",
  ].join("\n");

  return validateChangeSet({
    files: [
      { path: `features/${name}.md`, content: doc },
      { path: `src/features/${name}.js`, content: code },
      { path: FEATURE_REGISTRY_PATH, content: renderRegistry([`${name}.js`]) },
    ],
    reasoningSteps: [
      `Parsed the request: "${heading}".`,
      task.ragContext.length
        ? `Consulted ${task.ragContext.length} hive memory snippet(s) for prior art.`
        : "No hive memory matched; starting from the current train head.",
      ...(rework && task.scribeSummary ? [`Rework: addressed the Scribe summary "${task.scribeSummary.slice(0, 160)}".`] : []),
      `Added feature doc features/${name}.md and module src/features/${name}.js serving GET /features/${slug}.`,
      `Registered the module in ${FEATURE_REGISTRY_PATH} (merged with features already on the train).`,
      "Kept the change additive so speculative trains ahead of and behind this one stay mergeable.",
    ],
    discardedPaths: [`src/index.js (rewriting the router was out of scope)`],
  });
}
