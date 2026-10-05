/**
 * DECOMPOSE prompt, JSON schema and tolerant parser (v2 design §2.2 step 4).
 * Pure: no I/O, so it is tested directly.
 */
import { DecomposedChildSchema, PathPatternSchema, type DecomposedChild } from "@queenos/queen-types";

export const MAX_LISTED_FILES = 500;

export function systemPrompt(maxChildren: number): string {
  return [
    "You are the Oracle of QueenOS, a swarm of coding agents that builds a small Cloudflare Worker repo.",
    "Turn the user's goal into work items that agents will build in parallel, each in its own fork of main.",
    "Rules:",
    `- Prefer fewer, independent items. 1 item is fine. Never return more than ${maxChildren}.`,
    "- Each item is a self-contained change one agent can finish alone, with a short title, a body and up to 6 acceptance criteria.",
    "- Items that must edit the same existing file MUST depend on each other (dependsOn lists sibling keys), so they run in order and do not conflict.",
    "- New features go in new files, which keeps items independent.",
    "- Keys are c1, c2, ... in order. dependsOn may only name other keys from your own answer, and must not form a cycle.",
    "- paths: up to 10 repo-relative files (or directories ending in /) the item is predicted to touch, chosen from the file listing, or new files you expect it to create. No globs, no leading slash.",
    "- kind is feature, bug or chore. priority is 0 (urgent) to 3 (low), default 2. difficulty is normal or hard.",
    "- Items already open are listed so you do not duplicate them; avoid paths they hold when you can.",
    'Reply with JSON only, matching the schema: {"children":[...]}.',
  ].join("\n");
}

export function userPrompt(input: {
  promptText: string;
  files: string[];
  openItems: { itemId: string; title: string; status: string; paths: string[] }[];
}): string {
  const parts = [`Goal:\n${input.promptText}`];
  parts.push(input.files.length ? `Repo files (${input.files.length}):\n${input.files.join("\n")}` : "Repo files: (listing unavailable)");
  if (input.openItems.length) {
    parts.push(
      `Open items:\n${input.openItems.map((i) => `- ${i.title} [${i.status}]${i.paths.length ? ` paths: ${i.paths.join(", ")}` : ""}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

export function decomposeSchema(maxChildren: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["children"],
    properties: {
      children: {
        type: "array",
        minItems: 1,
        maxItems: maxChildren,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "kind", "title", "body", "acceptance", "priority", "difficulty", "dependsOn", "paths"],
          properties: {
            key: { type: "string", pattern: "^c\\d{1,2}$" },
            kind: { type: "string", enum: ["feature", "bug", "chore"] },
            title: { type: "string", maxLength: 120 },
            body: { type: "string", maxLength: 2000 },
            acceptance: { type: "array", maxItems: 6, items: { type: "string", maxLength: 200 } },
            priority: { type: "integer", minimum: 0, maximum: 3 },
            difficulty: { type: "string", enum: ["normal", "hard"] },
            dependsOn: { type: "array", maxItems: 6, items: { type: "string", pattern: "^c\\d{1,2}$" } },
            paths: { type: "array", maxItems: 10, items: { type: "string", maxLength: 200 } },
          },
        },
      },
    },
  };
}

/** Pull a JSON value out of model text: raw, fenced, or surrounded by prose. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const candidates = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const o = t.indexOf("{");
  const c = t.lastIndexOf("}");
  if (o >= 0 && c > o) candidates.push(t.slice(o, c + 1));
  const a = t.indexOf("[");
  const z = t.lastIndexOf("]");
  if (a >= 0 && z > a) candidates.push(t.slice(a, z + 1));
  for (const cand of candidates) {
    try {
      return JSON.parse(cand);
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Tolerant parse: accepts `{children: [...]}` or a bare array; repairs keys,
 * drops invalid paths and dependencies (unknown keys, self, forward-pointing
 * cycles are left to the Queen), caps to `maxChildren`. Returns [] when
 * nothing usable is found.
 */
export function parseDecomposition(text: string, maxChildren: number): DecomposedChild[] {
  const json = extractJson(text);
  const raw: unknown[] = Array.isArray(json) ? json : Array.isArray((json as { children?: unknown })?.children) ? (json as { children: unknown[] }).children : [];
  const used = new Set<string>();
  const drafts: { child: DecomposedChild; deps: string[] }[] = [];
  for (const r of raw.slice(0, maxChildren)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const title = clip(str(o.title), 120);
    if (!title) continue;
    let key = str(o.key);
    if (!/^c\d{1,2}$/.test(key) || used.has(key)) {
      let n = drafts.length + 1;
      while (used.has(`c${n}`)) n++;
      key = `c${n}`;
    }
    used.add(key);
    const paths = [...new Set((Array.isArray(o.paths) ? o.paths : []).map((p) => str(p).replace(/^\.\//, "")).filter((p) => PathPatternSchema.safeParse(p).success))].slice(0, 10);
    const parsed = DecomposedChildSchema.safeParse({
      key,
      kind: o.kind === "bug" || o.kind === "chore" ? o.kind : "feature",
      title,
      body: clip(str(o.body), 2000),
      acceptance: (Array.isArray(o.acceptance) ? o.acceptance : []).map((a) => clip(str(a), 200)).filter(Boolean).slice(0, 6),
      priority: Number.isInteger(o.priority) ? Math.min(3, Math.max(0, o.priority as number)) : 2,
      difficulty: o.difficulty === "hard" ? "hard" : "normal",
      dependsOn: [],
      paths,
      similar: [],
    });
    if (!parsed.success) continue;
    drafts.push({ child: parsed.data, deps: (Array.isArray(o.dependsOn) ? o.dependsOn : []).map(str) });
  }
  const keys = new Set(drafts.map((d) => d.child.key));
  return drafts.map(({ child, deps }) => ({
    ...child,
    dependsOn: [...new Set(deps)].filter((k) => keys.has(k) && k !== child.key).slice(0, 6),
  }));
}
