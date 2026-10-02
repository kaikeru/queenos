export type Severity = "error" | "warning";

export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line?: number;
  message: string;
}

export interface ScanReport {
  /** True when there are no `error` findings (warnings never fail the gate). */
  passed: boolean;
  findings: Finding[];
  filesScanned: number;
}

export const MAX_FINDINGS = 100;

export function toReport(findings: Finding[], filesScanned: number): ScanReport {
  return { passed: !findings.some((f) => f.severity === "error"), findings: findings.slice(0, MAX_FINDINGS), filesScanned };
}

export const CODE_EXT_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
export const isCodePath = (p: string) => CODE_EXT_RE.test(p) && !/\.d\.[cm]?ts$/i.test(p);

const SKIP_DIR_RE = /(?:^|\/)(?:node_modules|\.git|dist|\.wrangler|\.turbo|coverage)\//;
export const isSkippedPath = (p: string) => SKIP_DIR_RE.test(p);

export function formatFinding(f: Finding): string {
  return `[${f.severity}] ${f.rule} ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`;
}
