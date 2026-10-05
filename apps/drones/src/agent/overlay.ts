/**
 * The agent's result as a file overlay: what changed between the seeded base tree and the final
 * workspace. Only the overlay leaves the Workflow step (the caps keep it far under 1 MiB).
 */
import { MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, isProtectedPath } from "../change-set";

export interface Overlay {
  files: { path: string; content: string }[];
  deletes: string[];
}

const byteLength = (s: string) => new TextEncoder().encode(s).byteLength;

/** Changed/added files (sorted) and deletions. Paths are repo-relative, no leading slash. */
export function diffTrees(base: Record<string, string>, final: Record<string, string>): Overlay {
  const files = Object.keys(final)
    .filter((p) => base[p] !== final[p])
    .sort()
    .map((path) => ({ path, content: final[path]! }));
  const deletes = Object.keys(base)
    .filter((p) => !(p in final))
    .sort();
  return { files, deletes };
}

/** Why this overlay cannot be committed (empty = fine). Messages are written for the model. */
export function overlayProblems(o: Overlay): string[] {
  const problems: string[] = [];
  if (o.files.length + o.deletes.length === 0) problems.push("no files were changed");
  const touched = [...o.files.map((f) => f.path), ...o.deletes];
  const prot = touched.filter(isProtectedPath);
  if (prot.length) problems.push(`these paths are platform-owned and must not change: ${prot.join(", ")} (restore them)`);
  if (o.files.length + o.deletes.length > MAX_FILES) problems.push(`too many files changed (${o.files.length + o.deletes.length} > ${MAX_FILES})`);
  for (const f of o.files) {
    if (byteLength(f.content) > MAX_FILE_BYTES) problems.push(`${f.path} exceeds ${MAX_FILE_BYTES} bytes`);
  }
  const total = o.files.reduce((n, f) => n + byteLength(f.content), 0);
  if (total > MAX_TOTAL_BYTES) problems.push(`change exceeds ${MAX_TOTAL_BYTES} bytes in total`);
  return problems;
}

/** FNV-1a over the sorted snapshot: "has the workspace changed since the last passing verify?" */
export function snapshotHash(files: Record<string, string>): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  for (const p of Object.keys(files).sort()) {
    feed(p);
    feed("\u0000");
    feed(files[p]!);
    feed("\u0001");
  }
  return `${(h >>> 0).toString(16).padStart(8, "0")}:${Object.keys(files).length}`;
}
