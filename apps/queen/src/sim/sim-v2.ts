/**
 * v2 sim helpers (design §6): sim paths, the Oracle fake's pure logic, the
 * sim-main log behind the MERGE fake, build jitter and the demo prompts.
 * Everything here is pure or takes a store; sim-ports.ts schedules it.
 */
import type { DecomposedChildInput, FollowUp, MergeConflict, SimilarItem } from "@queenos/queen-types";

// ── markers ──────────────────────────────────────────────────────────────

/** Two items carrying it change `src/lib/shared.js` without predicting it: the merge-conflict demo. */
export const COLLIDE_MARKER = "[collide]";
/** Passes alone, fails the integration gate when merged on top of other changes. */
export const BATCH_FAIL_MARKER = "[batch-fail]";
/** The Oracle fake answers `ok: false` (fallback demo). */
export const DECOMPOSE_FAIL_MARKER = "[decompose-fail]";
export const HARD_MARKER = "[hard]";
export const RACE_MARKER = "[race]";
export const SPOT_BUG_MARKER = "[spot-bug]";
export const GATE_SPOT_MARKER = "[gate-spot]";
/** Staging gets `inconclusive: true` and ROLLBACK. */
export const INCONCLUSIVE_MARKER = "[inconclusive]";
const TOUCH_RE = /\[touch:([^\]\s]+)\]/g;

/** Sim defaults (§6): the Queen's sim env must be configured with these (Phase 2). */
export const SIM_SWARM_MAX_ACTIVE_BUILDS = 1000;
export const SIM_MAX_ACTIVE_TRAINS = 64;
/** Build delays are jittered in this window from a hash of the trainId. */
export const SIM_BUILD_JITTER_MS = { min: 4000, max: 12_000 } as const;

export const SHARED_PATH = "src/lib/shared.js";
export const FEATURES_INDEX_PATH = "src/features/index.js";
/** Generated files never conflict. */
export const isGeneratedPath = (p: string) => p === FEATURES_INDEX_PATH;

/** FNV-1a, non-negative. */
export function hashInt(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Build time for a train in [min, max], stable per trainId (builds overlap and finish out of order). */
export function jitteredBuildMs(trainId: string, range: { min: number; max: number } = SIM_BUILD_JITTER_MS): number {
  return range.min + (hashInt(`jitter:${trainId}`) % (range.max - range.min + 1));
}

// ── sim paths ────────────────────────────────────────────────────────────

const STOP = new Set(["add", "the", "and", "for", "with", "that", "this", "from", "returning", "endpoint"]);
const stripMarkers = (text: string) => text.replace(/\[[a-z-]+(?::[^\]]*)?\]/gi, " ").replace(/\(after \d+\)/gi, " ").replace(/depends on #\d+/gi, " ");

/** `[touch:<path>]` markers in `text`, in order, deduplicated. */
export function touchPaths(text: string): string[] {
  return [...new Set([...text.matchAll(TOUCH_RE)].map((m) => m[1]!))];
}

/** Stable per-text slug: a few content words plus a hash, so distinct items never share a file. */
export function simSlug(text: string): string {
  const ws = (stripMarkers(text).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w)).slice(0, 3);
  return `${ws.join("-") || "change"}-${hashInt(stripMarkers(text).trim().toLowerCase()).toString(16).slice(0, 4)}`;
}

/**
 * Paths a sim build changes: its feature file, the generated index, each
 * `[touch:]` path (predicted), and `src/lib/shared.js` for `[collide]`
 * (unpredicted). A rework after a merge conflict drops the shared file.
 */
export function simChangedPaths(text: string, opts: { dropShared?: boolean } = {}): string[] {
  const paths = [`src/features/${simSlug(text)}.js`, FEATURES_INDEX_PATH, ...touchPaths(text)];
  if (text.includes(COLLIDE_MARKER) && !opts.dropShared) paths.push(SHARED_PATH);
  return [...new Set(paths)];
}

export const isMergeConflictRework = (scribeSummary: string | undefined) => !!scribeSummary?.startsWith("Merge conflict");

// ── Oracle fake ──────────────────────────────────────────────────────────

const OPEN_STATUSES_CLOSED = new Set(["LANDED", "SHIPPED", "FAILED", "DUPLICATE", "CANCELLED"]);
export const isOpenStatus = (status: string) => !OPEN_STATUSES_CLOSED.has(status);

const BULLET_RE = /^\s*(?:[-*•]|\d+\.)\s+(.*\S)\s*$/;

/** Split a prompt into parts: bullet lines (`-`, `*`, `•`, `1.`), else `;`-separated, else the whole prompt. */
export function splitPrompt(prompt: string): string[] {
  const lines = prompt.split(/\r?\n/);
  const bullets = lines.map((l) => BULLET_RE.exec(l)?.[1]).filter((x): x is string => !!x);
  const parts = bullets.length ? bullets : prompt.split(";");
  const cleaned = parts.map((p) => p.trim()).filter(Boolean);
  return cleaned.length ? cleaned : [prompt.trim()];
}

const wordSet = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);

export function jaccard(a: string, b: string): number {
  const x = wordSet(a);
  const y = wordSet(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

export const SIMILAR_THRESHOLD = 0.8;

/** Open items whose title overlaps `title` by Jaccard >= 0.8 (at most `max`). */
export function findSimilar(title: string, items: { itemId: string; title: string; status: string }[], max: number, exceptId?: string): SimilarItem[] {
  return items
    .filter((i) => i.itemId !== exceptId && isOpenStatus(i.status) && jaccard(title, i.title) >= SIMILAR_THRESHOLD)
    .slice(0, max)
    .map((i) => ({ itemId: i.itemId, score: 0.95 }));
}

export function childKind(part: string): "feature" | "bug" | "chore" {
  const text = part.replace(/\[[a-z:-][^\]]*\]/gi, " "); // markers like [spot-bug] are not words
  if (/\b(fix|bug|broken)\b/i.test(text)) return "bug";
  if (/\b(chore|rename|bump|refactor|cleanup)\b/i.test(text)) return "chore";
  return "feature";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Oracle DECOMPOSE: one child per part (at most `maxChildren`, never more than
 * the contract's 24). Keeps `[collide]`, `[race]` and the other build markers
 * in title/body so the sim builder and filing logic still see them; consumes
 * `[hard]`, `(after N)` / `depends on #N` and `[touch:p]` (into `paths`).
 */
export function simDecompose(
  prompt: string,
  openItems: { itemId: string; title: string; status: string }[],
  maxChildren: number,
): DecomposedChildInput[] {
  const parts = splitPrompt(prompt).slice(0, Math.min(maxChildren, 24));
  return parts.map((part, i) => {
    const key = `c${i + 1}`;
    const after = /\(after (\d+)\)|depends on #(\d+)/i.exec(part);
    const n = after ? Number(after[1] ?? after[2]) : 0;
    const dependsOn = n >= 1 && n <= parts.length && n !== i + 1 ? [`c${n}`] : [];
    const title = clip(
      part
        .replace(/\[hard\]/gi, "")
        .replace(TOUCH_RE, "")
        .replace(/\(after \d+\)/gi, "")
        .replace(/depends on #\d+/gi, "")
        .replace(/\s+/g, " ")
        .trim() || part,
      120,
    );
    const plain = title.replace(/\[[a-z-]+\]/gi, "").replace(/\s+/g, " ").trim() || title;
    return {
      key,
      kind: childKind(part),
      title,
      body: clip(part, 2000),
      acceptance: [clip(`${plain} is visible at /`, 200)],
      // `[race]` races the child (hardWidth 3 through the race policy), like `[hard]`.
      difficulty: /\[hard\]|\[race\]/i.test(part) ? ("hard" as const) : ("normal" as const),
      dependsOn,
      paths: touchPaths(part).slice(0, 10),
      similar: findSimilar(plain, openItems, 3),
    };
  });
}

// ── demo prompts ─────────────────────────────────────────────────────────

const SWARM_WORDS = [
  "otter", "falcon", "maple", "comet", "harbor", "lantern", "meadow", "quartz", "willow", "ember", "glacier", "pebble",
  "saffron", "tundra", "velvet", "zephyr", "acorn", "bramble", "cobalt", "dune", "fjord", "garnet", "heron", "indigo",
  "juniper", "kelp", "lichen", "mosaic", "nectar", "orchid", "prairie", "quill",
];

/**
 * The "Swarm" demo prompt: a title line (`Ship a swarm of n feature endpoints`;
 * splitPrompt ignores non-bullet lines when bullets exist, so it is the goal's
 * title and never an item) then `n` bullets `Add a /features/<word> endpoint
 * returning <word> facts`; two carry `[collide]`, one `[batch-fail]`, one
 * `[race]` (spread through the list; for small n they land on distinct bullets).
 */
export function demoSwarmPrompt(n: number): string {
  const count = Math.max(1, Math.floor(n));
  const marks = new Map<number, string>();
  const place = (frac: number, marker: string) => {
    let i = Math.min(count - 1, Math.floor(count * frac));
    while (marks.has(i) && i < count - 1) i++;
    while (marks.has(i) && i > 0) i--;
    if (!marks.has(i)) marks.set(i, marker);
  };
  place(0.12, RACE_MARKER);
  place(0.3, COLLIDE_MARKER);
  place(0.4, COLLIDE_MARKER);
  place(0.7, BATCH_FAIL_MARKER);
  const bullets = Array.from({ length: count }, (_, i) => {
    const w = i < SWARM_WORDS.length ? SWARM_WORDS[i]! : `${SWARM_WORDS[i % SWARM_WORDS.length]!}${Math.floor(i / SWARM_WORDS.length)}`;
    const marker = marks.get(i);
    return `- Add a /features/${w} endpoint returning ${w} facts${marker ? ` ${marker}` : ""}`;
  });
  return [`Ship a swarm of ${count} feature endpoints`, ...bullets].join("\n");
}

// ── sim main log ─────────────────────────────────────────────────────────

/** One member's change set in the sim's per-hive history. */
export interface SimMainEntry {
  seq: number;
  trainId: string;
  promptId: string;
  /** The car that merged it (absent for entries seeded directly). */
  carId?: string;
  paths: string[];
  /** True once the car's LANDER push happened. */
  landed: boolean;
}
export interface SimMain {
  next: number;
  entries: SimMainEntry[];
}

/** The slice of SimStore the log needs. */
export interface LogStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

const MAIN_KEY = (hive: string) => `sim:main:${hive}`;
export const FORK_KEY = (trainId: string) => `sim:fork:${trainId}`;
export const PATHS_KEY = (trainId: string) => `sim:paths:${trainId}`;
export const CAR_KEY = (carId: string) => `sim:car:${carId}`;
export const BATCH_FAIL_KEY = (promptId: string) => `sim:bf:${promptId}`;
const MAIN_LIMIT = 4000;

export async function loadMain(store: LogStore, hive: string): Promise<SimMain> {
  return (await store.get<SimMain>(MAIN_KEY(hive))) ?? { next: 0, entries: [] };
}
export const saveMain = (store: LogStore, hive: string, main: SimMain) => store.put(MAIN_KEY(hive), { ...main, entries: main.entries.slice(-MAIN_LIMIT) });

/** What the MERGE fake recorded about a car, for its integration gate. */
export interface SimCarRecord {
  members: { trainId: string; promptId: string; title: string; onTop: boolean }[];
}

export interface SimMergeInput {
  carId: string;
  members: { trainId: string; promptId: string; title: string }[];
  /** forkSeq / paths per member trainId (from the FORK and BUILD fakes). */
  forkSeq: (trainId: string) => number | undefined;
  paths: (trainId: string) => string[] | undefined;
  /** Cars the Queen ejected: their unlanded entries are dropped from the log. */
  ejectedCars: Set<string>;
}

export interface SimMergeOutcome {
  merged: string[];
  conflicts: MergeConflict[];
  fastForward: boolean;
  car: SimCarRecord;
}

/**
 * The MERGE fake over the sim main (§6). For each member in order: it
 * conflicts if any non-generated path was changed by an entry after its fork
 * point (same item excluded: a rework follows its own earlier attempt);
 * otherwise it merges and is appended. Re-running a car replaces its entries.
 */
export function simMerge(main: SimMain, input: SimMergeInput): SimMergeOutcome {
  main.entries = main.entries.filter((e) => e.landed || (e.carId !== input.carId && !(e.carId && input.ejectedCars.has(e.carId))));
  const merged: string[] = [];
  const conflicts: MergeConflict[] = [];
  const car: SimCarRecord = { members: [] };
  for (const m of input.members) {
    const forkSeq = input.forkSeq(m.trainId) ?? main.next;
    const paths = input.paths(m.trainId) ?? simChangedPaths(m.title);
    const earlier = main.entries.filter((e) => e.seq >= forkSeq && e.promptId !== m.promptId);
    const touched = new Set(earlier.flatMap((e) => e.paths.filter((p) => !isGeneratedPath(p))));
    const clash = paths.filter((p) => !isGeneratedPath(p) && touched.has(p));
    if (clash.length) {
      conflicts.push({
        trainId: m.trainId,
        kind: "content",
        paths: clash.slice(0, 50),
        summary: `Merge conflict in ${clash.join(", ")}: changed by an earlier merge since ${m.trainId} forked.`.slice(0, 500),
      });
      continue;
    }
    main.entries.push({ seq: main.next++, trainId: m.trainId, promptId: m.promptId, carId: input.carId, paths, landed: false });
    merged.push(m.trainId);
    car.members.push({ trainId: m.trainId, promptId: m.promptId, title: m.title, onTop: earlier.length > 0 });
  }
  const fastForward = input.members.length === 1 && merged.length === 1 && !car.members[0]!.onTop;
  return { merged, conflicts, fastForward, car };
}

/** Mark the car's members landed in the sim main. */
export function simLand(main: SimMain, trainIds: string[]): void {
  const ids = new Set(trainIds);
  for (const e of main.entries) if (ids.has(e.trainId)) e.landed = true;
}

/** `[gate-spot]`: the gate files one out-of-diff security finding. */
export const gateSpotFollowUp = (): FollowUp => ({
  kind: "bug",
  title: "Spotted: unescaped query string in legacy search",
  body: "The security scan found an unescaped query parameter in src/legacy/search.js, outside the diff.",
  paths: ["src/legacy/search.js"],
  priority: 2,
});
/** `[spot-bug]`: the builder reports one follow-up (first BUILD only). */
export const spotBugFollowUp = (): FollowUp => ({
  kind: "bug",
  title: "Spotted: README badge link 404s",
  body: "While building, the builder noticed the build badge link in README.md returns 404.",
  paths: ["README.md"],
  priority: 2,
});
