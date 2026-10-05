/** Tiny line diff (LCS) for the spike report; files here are small. */
export function unifiedDiff(path: string, a: string | undefined, b: string | undefined): string {
  const A = a == null ? [] : a.split("\n");
  const B = b == null ? [] : b.split("\n");
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out = [`--- ${a == null ? "/dev/null" : `a/${path}`}`, `+++ ${b == null ? "/dev/null" : `b/${path}`}`];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) (out.push(` ${A[i]}`), i++, j++);
    else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) out.push(`+${B[j++]}`);
    else out.push(`-${A[i++]}`);
  }
  return out.join("\n");
}

export function changedFiles(before: Record<string, string>, after: Record<string, string>) {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths.filter((p) => before[p] !== after[p]).map((p) => ({ path: p, status: before[p] == null ? "added" : after[p] == null ? "deleted" : "modified", diff: unifiedDiff(p, before[p], after[p]) }));
}
