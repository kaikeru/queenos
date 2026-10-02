/**
 * SECURITY role: cheap, deterministic static checks.
 * - secret-pattern: API keys / private keys in any text file.
 * - eval / new-function: dynamic code execution in JS/TS (token scan, so
 *   comments and strings never match).
 * - disallowed-fetch-host: `fetch("https://host/...")` with a literal URL whose
 *   host is not allowlisted. Non-literal URLs cannot be checked statically
 *   (reported as a warning).
 */
import { isCodePath, isSkippedPath, toReport, type Finding, type ScanReport } from "./findings";
import { tokenize, type Token } from "./lex";

export interface SecurityOptions {
  allowedHosts: readonly string[];
}

interface SecretRule {
  id: string;
  re: RegExp;
}

const SECRET_RULES: SecretRule[] = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { id: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: "artifacts-token", re: /\bart_v1_[0-9a-f]{40}/ },
  { id: "cloudflare-token", re: /\b(?:CLOUDFLARE|CF)_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/ },
  { id: "generic-secret", re: /\b(?:api[_-]?key|secret|passw(?:or)?d|auth[_-]?token|access[_-]?token)\b["']?\s*[:=]\s*["'][A-Za-z0-9/+_=.-]{20,}["']/i },
];

const PLACEHOLDER_RE = /(?:EXAMPLE|PLACEHOLDER|CHANGEME|CHANGE_ME|YOUR_|<[^>]+>|x{6,}|\*{4,})/i;
const BINARY_EXT_RE = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|wasm|woff2?|ttf|otf|mp[34]|lock|lockb)$/i;
export const MAX_SCAN_BYTES = 256 * 1024;

function mask(s: string): string {
  return s.length <= 8 ? "****" : `${s.slice(0, 4)}…(${s.length} chars)`;
}

export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const p = a.toLowerCase();
    return p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
  });
}

function hostOf(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@?#]*@)?([^/:?#]+)/i.exec(url);
  return m ? m[1]! : null;
}

function scanSecrets(path: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 4000) continue;
    for (const rule of SECRET_RULES) {
      const m = rule.re.exec(line);
      if (m && !PLACEHOLDER_RE.test(m[0])) {
        out.push({ rule: "secret-pattern", severity: "error", file: path, line: i + 1, message: `possible ${rule.id}: ${mask(m[0])}` });
        break;
      }
    }
  }
  return out;
}

function scanCode(path: string, text: string, allowedHosts: readonly string[]): Finding[] {
  const tokens: Token[] = tokenize(text);
  const out: Finding[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.t !== "word") continue;
    const prev = tokens[i - 1];
    const afterDot = prev?.t === "punct" && (prev.v === "." || prev.v === "?.");
    const next = tokens[i + 1];
    const callish = next?.t === "punct" && next.v === "(";

    if (t.v === "eval" && callish && !afterDot) {
      out.push({ rule: "eval", severity: "error", file: path, line: t.line, message: "eval() executes arbitrary code" });
    } else if (t.v === "Function" && !afterDot && (callish || (prev?.t === "word" && prev.v === "new"))) {
      if (callish || next?.t === "punct") {
        out.push({ rule: "new-function", severity: "error", file: path, line: t.line, message: "Function constructor executes arbitrary code" });
      }
    } else if (t.v === "fetch" && callish && !afterDot) {
      const arg = tokens[i + 2];
      if (arg && (arg.t === "str" || arg.t === "tmpl")) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg.v)) {
          const host = hostOf(arg.v);
          if (!host || host.includes("${")) {
            out.push({ rule: "dynamic-fetch-host", severity: "warning", file: path, line: t.line, message: `fetch() host is built dynamically ("${arg.v.slice(0, 60)}")` });
          } else if (!hostAllowed(host, allowedHosts)) {
            out.push({ rule: "disallowed-fetch-host", severity: "error", file: path, line: t.line, message: `fetch() to non-allowlisted host "${host}"` });
          }
        }
      } else if (arg && arg.t === "word") {
        out.push({ rule: "dynamic-fetch-url", severity: "warning", file: path, line: t.line, message: "fetch() URL is not a literal; host cannot be checked statically" });
      }
    }
  }
  return out;
}

export function scanSecurity(files: Record<string, string>, opts: SecurityOptions): ScanReport {
  const findings: Finding[] = [];
  let scanned = 0;
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (isSkippedPath(path) || BINARY_EXT_RE.test(path) || text.length > MAX_SCAN_BYTES) continue;
    scanned++;
    findings.push(...scanSecrets(path, text));
    if (isCodePath(path)) findings.push(...scanCode(path, text, opts.allowedHosts));
  }
  return toReport(findings, scanned);
}
