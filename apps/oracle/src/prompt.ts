/**
 * DECOMPOSE prompt, JSON schema and tolerant parser (v2 design §2.2 step 4).
 * Pure: no I/O, so it is tested directly.
 */
import { DecomposedChildSchema, GENERATED_PATHS, PathPatternSchema, isGeneratedPath, pathsOverlap, type DecomposedChild } from "@queenos/queen-types";

export const MAX_LISTED_FILES = 500;

export function systemPrompt(maxChildren: number): string {
  return [
    "You are the Oracle of QueenOS, a swarm of coding agents that builds a small Cloudflare Worker repo.",
    "Turn the user's goal into work items that agents will build in parallel, each in its own fork of main.",
    "Rules:",
    `- Never return more than ${maxChildren} items. Prefer fewer, independent items ONLY when the goal is one vague or single objective; then 1 item is fine.`,
    "- When the user lists separate goals as bullets or numbered lines, each line is its own item, in order. Merge only true duplicates (the same request twice). Never merge distinct bullets into one umbrella item.",
    "- Each item is a self-contained change one agent can finish alone, with a short title, a body and up to 6 acceptance criteria.",
    `- GENERATED files (${GENERATED_PATHS.join(", ")}) are rebuilt and merged automatically by the registry merge driver. They are NEVER a shared file: they never justify merging items or a dependsOn edge, and must not appear in any item's paths. Do not tell the agent to hand-edit them.`,
    "- Other than generated files, items that must edit the same existing file MUST depend on each other (dependsOn lists sibling keys), so they run in order and do not conflict.",
    "- New features go in new files, which keeps items independent: each feature lives in its own new file src/features/<slug>.js (slug from the feature name), registered automatically.",
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
  const drafts: { child: DecomposedChild; deps: string[]; hadGenerated: boolean }[] = [];
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
    const allPaths = [...new Set((Array.isArray(o.paths) ? o.paths : []).map((p) => str(p).replace(/^\.\//, "")).filter((p) => PathPatternSchema.safeParse(p).success))];
    const hadGenerated = allPaths.some(isGeneratedPath);
    const paths = allPaths.filter((p) => !isGeneratedPath(p)).slice(0, 10);
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
    drafts.push({ child: parsed.data, deps: (Array.isArray(o.dependsOn) ? o.dependsOn : []).map(str), hadGenerated });
  }
  const keys = new Set(drafts.map((d) => d.child.key));
  const byKey = new Map(drafts.map((d) => [d.child.key, d]));
  // An edge whose only shared path was a generated one (both sides list real, disjoint
  // paths and one of them named a generated file) has no justification: drop it.
  const unjustified = (d: (typeof drafts)[number], dep: (typeof drafts)[number]) =>
    (d.hadGenerated || dep.hadGenerated) &&
    d.child.paths.length > 0 &&
    dep.child.paths.length > 0 &&
    pathsOverlap(d.child.paths, dep.child.paths).length === 0;
  return drafts.map((d) => ({
    ...d.child,
    dependsOn: [...new Set(d.deps)]
      .filter((k) => keys.has(k) && k !== d.child.key && !unjustified(d, byKey.get(k)!))
      .slice(0, 6),
  }));
}

export interface PromptBullet {
  /** The bullet text without its marker. */
  text: string;
  /** Nested / continuation lines, trimmed. */
  details: string[];
}

const BULLET = /^ {0,1}(?:[-*\u2022]|\d{1,3}[.)])\s+(\S.*)$/;
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9/]+/g, " ").trim();

/** Explicit top-level bullets / numbered lines of a prompt, plus the leading title text. Exact duplicates are collapsed. */
export function parseBullets(promptText: string): { preface: string; bullets: PromptBullet[] } {
  const prefaceLines: string[] = [];
  const bullets: PromptBullet[] = [];
  const seen = new Set<string>();
  let current: PromptBullet | null = null;
  for (const line of promptText.split(/\r?\n/)) {
    const m = BULLET.exec(line);
    if (m) {
      const text = m[1]!.trim();
      const norm = normalize(text);
      if (seen.has(norm)) {
        current = null; // exact duplicate: drop it and its nested lines
        continue;
      }
      seen.add(norm);
      current = { text, details: [] };
      bullets.push(current);
    } else if (!line.trim()) {
      if (current && current.details.length) current = null;
    } else if (current && /^\s/.test(line)) {
      current.details.push(line.trim());
    } else if (bullets.length === 0) {
      prefaceLines.push(line.trim());
    } else {
      current = null;
    }
  }
  return { preface: prefaceLines.join(" ").trim(), bullets };
}

function overlap(a: string, b: string): number {
  const ta = new Set(normalize(a).split(" ").filter((w) => w.length > 2));
  const tb = new Set(normalize(b).split(" ").filter((w) => w.length > 2));
  if (!ta.size || !tb.size) return 0;
  let n = 0;
  for (const w of ta) if (tb.has(w)) n++;
  return n / (ta.size + tb.size - n);
}

/**
 * Deterministic guard against the LLM collapsing explicit bullets into one
 * umbrella item (2026-10-06 live bug). With >= 2 distinct top-level bullets and
 * fewer children than min(bullets, maxChildren), the model's grouping is not
 * trusted: one child per bullet (title = bullet text), reusing the details of
 * a model child that matches that bullet. Paths are derived only from a
 * matching child (generated paths stripped); dependsOn is dropped because the
 * edges came from the collapsed plan. Otherwise returns `children` untouched.
 */
export function enforceBulletFanout(promptText: string, children: DecomposedChild[], maxChildren: number): DecomposedChild[] {
  const { preface, bullets } = parseBullets(promptText);
  if (bullets.length < 2 || children.length >= Math.min(bullets.length, maxChildren)) return children;
  const picked = bullets.slice(0, maxChildren);
  // Global greedy assignment: best (bullet, child) pairs first, each used once.
  const pairs: { b: number; c: number; score: number }[] = [];
  picked.forEach((bl, bi) =>
    children.forEach((c, ci) => {
      const score = normalize(c.title) === normalize(bl.text) ? 2 : overlap(bl.text, c.title);
      if (score >= 0.6) pairs.push({ b: bi, c: ci, score });
    }),
  );
  pairs.sort((x, y) => y.score - x.score);
  const matchOf = new Map<number, DecomposedChild>();
  const usedChildren = new Set<number>();
  for (const p of pairs) {
    if (matchOf.has(p.b) || usedChildren.has(p.c)) continue;
    matchOf.set(p.b, children[p.c]!);
    usedChildren.add(p.c);
  }
  return picked.map((b, n) => {
    const full = [b.text, ...b.details].join("\n");
    const match = matchOf.get(n);
    const body = [full, preface ? `Part of: ${preface}` : ""].filter(Boolean).join("\n\n");
    return DecomposedChildSchema.parse({
      key: `c${n + 1}`,
      kind: match?.kind ?? "feature",
      title: clip(b.text, 120),
      body: clip(match?.body && !body.includes(match.body) ? `${body}\n\n${match.body}` : body, 2000),
      acceptance: match?.acceptance ?? [],
      priority: match?.priority ?? 2,
      difficulty: match?.difficulty ?? "normal",
      dependsOn: [],
      paths: (match?.paths ?? []).filter((p) => !isGeneratedPath(p)),
      similar: [],
    });
  });
}
