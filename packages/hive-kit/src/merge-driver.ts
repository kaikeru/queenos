/**
 * The merge queue's merge driver (v2 design §2.3.4). For paths in
 * GENERATED_PATHS (the feature registry) it merges by module set:
 * `renderRegistry(ours ∪ theirs − removedInEither)` computed from the base,
 * ours and theirs module lists, so two features that both register never
 * conflict. Every other path falls back to a diff3 line merge equivalent to
 * isomorphic-git's built-in driver. The agent equivalent of
 * `.gitattributes merge=union`.
 *
 * isomorphic-git 1.42.6 limitations this works around:
 * - it does not export its default driver (`mergeFile`), and a custom driver
 *   replaces it for every path, so the diff3 fallback is ported here
 *   (`diff3MergeText`, after the `diff3` package isomorphic-git bundles);
 * - it passes the driver the entry's *basename* (`index.js`), not the repo
 *   path, so the registry is recognised by basename AND by its generated shape
 *   (only imports of `./<name>.js`, comments and the `features` export). A
 *   hand-written `index.js` anywhere else falls through to diff3.
 */
import type { MergeDriverCallback } from "isomorphic-git";
import { GENERATED_PATHS } from "@queenos/queen-types";
import { registryModules, renderRegistry } from "./registry.js";

/**
 * Three-way merge of registry contents by module set (pure). Modules removed
 * on either side stay removed; additions from both sides are kept.
 */
export function mergeRegistryContents(base: string, ours: string, theirs: string): string {
  const b = new Set(registryModules(base));
  const o = new Set(registryModules(ours));
  const t = new Set(registryModules(theirs));
  const removed = (m: string) => b.has(m) && (!o.has(m) || !t.has(m));
  return renderRegistry([...o, ...t].filter((m) => !removed(m)));
}

const REGISTRY_LINE = [
  /^\s*$/,
  /^\s*\/\/.*$/,
  /^\s*import\s+[^;]*?\s+from\s*["']\.\/[A-Za-z0-9._-]+\.js["']\s*;?\s*$/,
  /^\s*export\s+const\s+features\s*=\s*\[[\sA-Za-z0-9_$,]*\]\s*;?\s*$/,
];

/** True when `text` is a generated registry (or empty): nothing a module-set merge could drop. */
export function isRegistrySource(text: string): boolean {
  return text.split(/\r?\n/).every((line) => REGISTRY_LINE.some((re) => re.test(line)));
}

const GENERATED_NAMES = new Set<string>([...GENERATED_PATHS, ...GENERATED_PATHS.map((p) => p.slice(p.lastIndexOf("/") + 1))]);

/** isomorphic-git `mergeDriver`: the registry merge for GENERATED_PATHS, diff3 for everything else. */
export const registryMergeDriver: MergeDriverCallback = ({ branches, contents, path }) => {
  const [base = "", ours = "", theirs = ""] = contents;
  if (GENERATED_NAMES.has(path) && isRegistrySource(base) && isRegistrySource(ours) && isRegistrySource(theirs)) {
    return { cleanMerge: true, mergedText: mergeRegistryContents(base, ours, theirs) };
  }
  return diff3MergeText({ branches, contents });
};

// ── diff3 (the isomorphic-git default driver, ported) ──────────────────────

const LINEBREAKS = /^.*(\r?\n|$)/gm;
const MARKER = 7;

/**
 * isomorphic-git's default `mergeFile`: a line-level diff3 merge with
 * `<<<<<<< ours` / `=======` / `>>>>>>> theirs` markers around conflicts.
 * `branches` = [baseName, ourName, theirName]; `contents` = [base, ours, theirs].
 */
export function diff3MergeText({ branches, contents }: { branches: readonly string[]; contents: readonly string[] }): {
  cleanMerge: boolean;
  mergedText: string;
} {
  const lines = (s: string | undefined) => (s ?? "").match(LINEBREAKS) ?? [];
  const base = lines(contents[0]);
  const ours = lines(contents[1]);
  const theirs = lines(contents[2]);
  let mergedText = "";
  let cleanMerge = true;
  for (const block of diff3Merge(ours, base, theirs)) {
    if ("ok" in block) {
      mergedText += block.ok.join("");
    } else {
      cleanMerge = false;
      mergedText += `${"<".repeat(MARKER)} ${branches[1] ?? "ours"}\n`;
      mergedText += block.conflict.a.join("");
      mergedText += `${"=".repeat(MARKER)}\n`;
      mergedText += block.conflict.b.join("");
      mergedText += `${">".repeat(MARKER)} ${branches[2] ?? "theirs"}\n`;
    }
  }
  return { cleanMerge, mergedText };
}

/** A changed region: `[oStart, oLen]` of the base replaced by `[xStart, xLen]` of a side. */
interface Hunk {
  o: number;
  oLen: number;
  side: 0 | 2;
  x: number;
  xLen: number;
}

/** Longest common subsequence as matched index pairs (DP after trimming the common prefix/suffix). */
function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  const pairs: [number, number][] = [];
  for (let i = 0; i < pre; i++) pairs.push([i, i]);
  if (n > 0 && m > 0) {
    // dp[i][j] = LCS length of a[pre+i..] and b[pre+j..] (row-major, (n+1)×(m+1)).
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a[pre + i] === b[pre + j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[pre + i] === b[pre + j]) {
        pairs.push([pre + i, pre + j]);
        i++;
        j++;
      } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
      else j++;
    }
  }
  for (let k = suf; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}

/** Mismatched regions between base `o` and side `x`. */
function diffHunks(o: readonly string[], x: readonly string[], side: 0 | 2): Hunk[] {
  const hunks: Hunk[] = [];
  let oi = 0;
  let xi = 0;
  for (const [po, px] of [...lcsPairs(o, x), [o.length, x.length] as [number, number]]) {
    if (po > oi || px > xi) hunks.push({ o: oi, oLen: po - oi, side, x: xi, xLen: px - xi });
    oi = po + 1;
    xi = px + 1;
  }
  return hunks;
}

type Diff3Block = { ok: string[] } | { conflict: { a: string[]; o: string[]; b: string[] } };

/** Khanna/Kunal/Pierce diff3 over line arrays (a = ours, o = base, b = theirs). */
function diff3Merge(a: readonly string[], o: readonly string[], b: readonly string[]): Diff3Block[] {
  const hunks = [...diffHunks(o, a, 0), ...diffHunks(o, b, 2)].sort((x, y) => x.o - y.o);
  const files = { 0: a, 2: b } as const;
  const out: Diff3Block[] = [];
  let ok: string[] = [];
  const flush = () => {
    if (ok.length) out.push({ ok });
    ok = [];
  };
  let common = 0;
  const copyCommon = (to: number) => {
    if (to > common) ok.push(...o.slice(common, to));
    common = Math.max(common, to);
  };

  for (let h = 0; h < hunks.length; h++) {
    const first = h;
    const lhs = hunks[h]!.o;
    let rhs = lhs + hunks[h]!.oLen;
    while (h < hunks.length - 1 && hunks[h + 1]!.o <= rhs) {
      rhs = Math.max(rhs, hunks[h + 1]!.o + hunks[h + 1]!.oLen);
      h++;
    }
    copyCommon(lhs);
    if (first === h) {
      const one = hunks[h]!;
      ok.push(...files[one.side].slice(one.x, one.x + one.xLen));
    } else {
      // Overlapping edits (one diff's hunks never touch each other, so the
      // group spans both sides): widen each side's region to cover [lhs, rhs).
      const region = { 0: [a.length, -1, o.length, -1], 2: [b.length, -1, o.length, -1] };
      for (let k = first; k <= h; k++) {
        const hk = hunks[k]!;
        const r = region[hk.side];
        r[0] = Math.min(hk.x, r[0]!);
        r[1] = Math.max(hk.x + hk.xLen, r[1]!);
        r[2] = Math.min(hk.o, r[2]!);
        r[3] = Math.max(hk.o + hk.oLen, r[3]!);
      }
      const slice = (side: 0 | 2) => {
        const r = region[side];
        return files[side].slice(r[0]! + (lhs - r[2]!), r[1]! + (rhs - r[3]!));
      };
      const sideA = slice(0);
      const sideB = slice(2);
      if (sideA.length === sideB.length && sideA.every((line, i) => line === sideB[i])) {
        ok.push(...sideA);
      } else {
        flush();
        out.push({ conflict: { a: sideA, o: o.slice(lhs, rhs), b: sideB } });
      }
    }
    common = rhs;
  }
  copyCommon(o.length);
  flush();
  return out;
}
