/**
 * POLICY role: static policy scan over a train's tree.
 *
 * Rules (all `error` unless noted):
 * - disallowed-dependency / remote-dependency: package.json dependencies and
 *   devDependencies (and optionalDependencies) must be on the allowlist
 *   (POLICY_ALLOWED_DEPS) and must not be git/URL specs.
 * - node-builtin: imports/require of Node built-ins (`fs`, `crypto`, `node:*`, ...).
 * - unapproved-module: bare module specifiers not on the allowlist.
 * - global-mutation: assignments (or defineProperty/assign/Reflect.set) on
 *   `globalThis`/`self`/`global`/`window`.
 * - prototype-mutation: same on `Array.prototype`, `Object.prototype`, ...
 * - top-level-mutable-state (warning): module-level `let`/`var`.
 *
 * Engines: acorn (a real AST) for .js/.mjs/.cjs. acorn cannot parse TypeScript
 * or JSX, so .ts/.tsx/.mts/.cts/.jsx (and any JS acorn rejects) go through the
 * token scanner in lex.ts, which is deliberately simple. See README limits.
 */
import { parse, type Node } from "acorn";
import { matchesAllowlist } from "./config";
import { isCodePath, isSkippedPath, toReport, type Finding, type ScanReport } from "./findings";
import { ASSIGN_OPS, matchingClose, tokenize, type Token } from "./lex";

export interface PolicyOptions {
  allowedDeps: readonly string[];
}

export const NODE_BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
  "events", "fs", "http", "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring",
  "readline", "repl", "stream", "string_decoder", "sys", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

const GLOBAL_ROOTS = new Set(["globalThis", "self", "global", "window"]);
const BUILTIN_PROTOS = new Set([
  "Object", "Array", "String", "Number", "Boolean", "Function", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Date", "RegExp", "Error", "Symbol", "BigInt",
  "Uint8Array", "ArrayBuffer", "URL", "URLSearchParams", "Request", "Response", "Headers", "Event", "EventTarget", "ReadableStream", "WritableStream",
]);
const MUTATING_CALLS = new Set(["Object.defineProperty", "Object.defineProperties", "Object.assign", "Object.setPrototypeOf", "Reflect.set", "Reflect.defineProperty", "Reflect.setPrototypeOf"]);

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
const REMOTE_SPEC_RE = /^(?:git(?:\+[a-z]+)?:|https?:|github:|gitlab:|bitbucket:|file:|link:)|^[\w.-]+\/[\w.-]+(?:#.*)?$/;

// ── module specifiers ────────────────────────────────────────────────────────

export function packageNameOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
}

/** Classify an import specifier. Null = fine. */
export function checkSpecifier(spec: string, allowed: readonly string[]): { rule: string; message: string } | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#") || spec.startsWith("@/") || spec.startsWith("~/")) return null;
  if (spec.startsWith("node:")) return { rule: "node-builtin", message: `import of Node built-in "${spec}" (Workers V8 isolates have no Node built-ins)` };
  if (spec.startsWith("cloudflare:")) return null;
  const pkg = packageNameOf(spec);
  if (NODE_BUILTINS.has(pkg)) return { rule: "node-builtin", message: `import of Node built-in "${spec}" (Workers V8 isolates have no Node built-ins)` };
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return { rule: "unapproved-module", message: `import of "${spec}" uses an unapproved URL/scheme` };
  if (!matchesAllowlist(pkg, allowed)) return { rule: "unapproved-module", message: `import of "${spec}": package "${pkg}" is not on the allowlist` };
  return null;
}

// ── package.json ────────────────────────────────────────────────────────────

export function scanPackageJson(path: string, text: string, allowed: readonly string[]): Finding[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [{ rule: "package-json-invalid", severity: "warning", file: path, message: "package.json is not valid JSON; dependencies were not checked" }];
  }
  const out: Finding[] = [];
  if (typeof json !== "object" || json === null) return out;
  for (const field of DEP_FIELDS) {
    const deps = (json as Record<string, unknown>)[field];
    if (typeof deps !== "object" || deps === null) continue;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (!matchesAllowlist(name, allowed)) {
        out.push({ rule: "disallowed-dependency", severity: "error", file: path, message: `${field}: "${name}" is not on the dependency allowlist` });
      } else if (typeof spec === "string" && REMOTE_SPEC_RE.test(spec)) {
        out.push({ rule: "remote-dependency", severity: "error", file: path, message: `${field}: "${name}" uses a git/URL/file spec "${spec}"` });
      }
    }
  }
  return out;
}

// ── JS via acorn ────────────────────────────────────────────────────────────

type AnyNode = Node & Record<string, unknown> & { loc?: { start: { line: number } } };

function parseJs(src: string): AnyNode {
  const base = { ecmaVersion: "latest", locations: true, allowHashBang: true } as const;
  try {
    return parse(src, { ...base, sourceType: "module", allowAwaitOutsideFunction: true }) as unknown as AnyNode;
  } catch (e) {
    // CommonJS (return outside function, `with`, ...)
    try {
      return parse(src, { ...base, sourceType: "script", allowReturnOutsideFunction: true }) as unknown as AnyNode;
    } catch {
      throw e;
    }
  }
}

/** `a.b.c` / `a["b"].c` as [root, ...props]; null if the root is not an identifier. */
function memberChain(n: unknown): string[] | null {
  const node = n as AnyNode | undefined;
  if (!node) return null;
  if (node.type === "Identifier") return [String(node["name"])];
  if (node.type === "MemberExpression") {
    const base = memberChain(node["object"]);
    if (!base) return null;
    const prop = node["property"] as AnyNode;
    const name = !node["computed"] && prop.type === "Identifier" ? String(prop["name"]) : prop.type === "Literal" ? String(prop["value"]) : "[]";
    return [...base, name];
  }
  return null;
}

function classifyTarget(chain: string[] | null, isAssignTarget: boolean): "global" | "prototype" | null {
  if (!chain) return null;
  const [root, ...props] = chain;
  if (root && GLOBAL_ROOTS.has(root) && (isAssignTarget ? props.length >= 1 : true)) return "global";
  if (root && BUILTIN_PROTOS.has(root) && props[0] === "prototype") return "prototype";
  return null;
}

function scanJsAst(path: string, src: string, allowed: readonly string[]): Finding[] {
  const ast = parseJs(src);
  const out: Finding[] = [];
  const add = (rule: string, severity: Finding["severity"], node: AnyNode, message: string) =>
    out.push({ rule, severity, file: path, ...(node.loc ? { line: node.loc.start.line } : {}), message });

  const checkSpec = (node: AnyNode, source: unknown) => {
    const s = source as AnyNode | null | undefined;
    if (s && s.type === "Literal" && typeof s["value"] === "string") {
      const bad = checkSpecifier(s["value"], allowed);
      if (bad) add(bad.rule, "error", node, bad.message);
    }
  };

  const reportTarget = (node: AnyNode, target: unknown, how: string) => {
    const kind = classifyTarget(memberChain(target), true);
    if (kind === "global") add("global-mutation", "error", node, `${how} global-scope object "${memberChain(target)?.join(".")}"`);
    else if (kind === "prototype") add("prototype-mutation", "error", node, `${how} built-in prototype "${memberChain(target)?.join(".")}"`);
  };

  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    const node = n as AnyNode;
    if (typeof node.type !== "string") return;
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration":
        checkSpec(node, node["source"]);
        break;
      case "ImportExpression":
        checkSpec(node, node["source"]);
        break;
      case "AssignmentExpression":
        reportTarget(node, node["left"], "assignment to");
        break;
      case "UpdateExpression":
        reportTarget(node, node["argument"], "update of");
        break;
      case "UnaryExpression":
        if (node["operator"] === "delete") reportTarget(node, node["argument"], "delete on");
        break;
      case "CallExpression": {
        const callee = memberChain(node["callee"]);
        const args = node["arguments"] as AnyNode[];
        if (callee?.length === 1 && callee[0] === "require" && args[0]?.type === "Literal") checkSpec(node, args[0]);
        if (callee && MUTATING_CALLS.has(callee.join(".")) && args[0]) {
          const target = memberChain(args[0]);
          const kind = classifyTarget(target, false);
          if (kind) add(kind === "global" ? "global-mutation" : "prototype-mutation", "error", node, `${callee.join(".")}() on ${kind === "global" ? "global-scope object" : "built-in prototype"} "${target?.join(".")}"`);
        }
        break;
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "loc" || k === "type") continue;
      if (v && typeof v === "object") visit(v);
    }
  };
  visit(ast);

  for (const stmt of ast["body"] as AnyNode[]) {
    const decl = stmt.type === "ExportNamedDeclaration" ? (stmt["declaration"] as AnyNode | null) : stmt;
    if (decl && decl.type === "VariableDeclaration" && (decl["kind"] === "let" || decl["kind"] === "var")) {
      add("top-level-mutable-state", "warning", decl, `module-level \`${String(decl["kind"])}\` is mutable state shared across requests in an isolate`);
    }
  }
  return out;
}

// ── token scanner (TypeScript / JSX / acorn fallback) ───────────────────────────

const isWord = (t: Token | undefined, v?: string) => t?.t === "word" && (v === undefined || t.v === v);
const isPunct = (t: Token | undefined, v: string) => t?.t === "punct" && t.v === v;

/** Walk `.a.b` / `["a"]` after a root token; returns [index after the chain, chain length]. */
function walkChain(tokens: Token[], from: number): { end: number; props: string[] } {
  let j = from;
  const props: string[] = [];
  for (;;) {
    const t = tokens[j];
    if ((isPunct(t, ".") || isPunct(t, "?.")) && tokens[j + 1]?.t === "word") {
      props.push(tokens[j + 1]!.v);
      j += 2;
    } else if (isPunct(t, "[")) {
      const close = matchingClose(tokens, j);
      props.push("[]");
      j = close + 1;
    } else break;
  }
  return { end: j, props };
}

export function scanTokens(path: string, src: string, allowed: readonly string[]): Finding[] {
  const tokens = tokenize(src);
  const out: Finding[] = [];
  const add = (rule: string, severity: Finding["severity"], tok: Token, message: string) => out.push({ rule, severity, file: path, line: tok.line, message });
  const checkSpec = (tok: Token, spec: string) => {
    const bad = checkSpecifier(spec, allowed);
    if (bad) add(bad.rule, "error", tok, bad.message);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const prev = tokens[i - 1];
    const afterDot = isPunct(prev, ".") || isPunct(prev, "?.");
    if (t.t !== "word") continue;

    if (t.v === "import" && !afterDot) {
      const n1 = tokens[i + 1];
      if (n1?.t === "str") checkSpec(t, n1.v);
      else if (isPunct(n1, "(") && tokens[i + 2]?.t === "str") checkSpec(t, tokens[i + 2]!.v);
      else if (isWord(n1, "type") && !isWord(tokens[i + 2], "from")) {
        /* `import type ...` is erased at compile time: ignored */
      } else if (n1 && !isPunct(n1, "(") && !isPunct(n1, ".")) {
        for (let j = i + 1; j < Math.min(tokens.length, i + 400); j++) {
          if (isPunct(tokens[j], ";")) break;
          if (isWord(tokens[j], "from") && tokens[j + 1]?.t === "str") {
            checkSpec(t, tokens[j + 1]!.v);
            break;
          }
        }
      }
    } else if (t.v === "export" && !afterDot && t.depth === 0) {
      const n1 = tokens[i + 1];
      if (isPunct(n1, "*") || isPunct(n1, "{")) {
        for (let j = i + 1; j < Math.min(tokens.length, i + 400); j++) {
          if (isPunct(tokens[j], ";")) break;
          if (isWord(tokens[j], "from") && tokens[j + 1]?.t === "str") {
            checkSpec(t, tokens[j + 1]!.v);
            break;
          }
        }
      }
    } else if (t.v === "require" && !afterDot && isPunct(tokens[i + 1], "(") && tokens[i + 2]?.t === "str") {
      checkSpec(t, tokens[i + 2]!.v);
    }

    if (afterDot) continue;

    // global-scope / prototype mutation
    if (GLOBAL_ROOTS.has(t.v) || (BUILTIN_PROTOS.has(t.v) && isPunct(tokens[i + 1], ".") && isWord(tokens[i + 2], "prototype"))) {
      const isGlobal = GLOBAL_ROOTS.has(t.v);
      const { end, props } = walkChain(tokens, i + 1);
      const op = tokens[end];
      const assigned = op?.t === "punct" && (ASSIGN_OPS.has(op.v) || op.v === "++" || op.v === "--");
      const deleted = isWord(prev, "delete");
      if ((assigned || deleted) && (isGlobal ? props.length >= 1 : props.length >= 1)) {
        const name = [t.v, ...props].join(".");
        add(isGlobal ? "global-mutation" : "prototype-mutation", "error", t, `${deleted ? "delete on" : "assignment to"} ${isGlobal ? "global-scope object" : "built-in prototype"} "${name}"`);
      }
    }
    if ((t.v === "Object" || t.v === "Reflect") && isPunct(tokens[i + 1], ".") && tokens[i + 2]?.t === "word" && isPunct(tokens[i + 3], "(")) {
      const callee = `${t.v}.${tokens[i + 2]!.v}`;
      const a0 = tokens[i + 4];
      if (MUTATING_CALLS.has(callee) && a0?.t === "word") {
        const { props } = walkChain(tokens, i + 5);
        const isGlobal = GLOBAL_ROOTS.has(a0.v);
        const isProto = BUILTIN_PROTOS.has(a0.v) && props[0] === "prototype";
        if (isGlobal || isProto) {
          add(isGlobal ? "global-mutation" : "prototype-mutation", "error", t, `${callee}() on ${isGlobal ? "global-scope object" : "built-in prototype"} "${[a0.v, ...props].join(".")}"`);
        }
      }
    }

    // module-level mutable state
    if ((t.v === "let" || t.v === "var") && t.depth === 0 && !isWord(prev, "declare") && tokens[i + 1]?.t === "word") {
      add("top-level-mutable-state", "warning", t, `module-level \`${t.v}\` is mutable state shared across requests in an isolate`);
    }
  }
  return out;
}

// ── entry point ───────────────────────────────────────────────────────────

const ACORN_EXT_RE = /\.(?:js|mjs|cjs)$/i;

export function scanPolicy(files: Record<string, string>, opts: PolicyOptions): ScanReport {
  const findings: Finding[] = [];
  let scanned = 0;
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (isSkippedPath(path)) continue;
    if (/(?:^|\/)package\.json$/.test(path)) {
      scanned++;
      findings.push(...scanPackageJson(path, text, opts.allowedDeps));
      continue;
    }
    if (!isCodePath(path)) continue;
    scanned++;
    if (ACORN_EXT_RE.test(path)) {
      try {
        findings.push(...scanJsAst(path, text, opts.allowedDeps));
        continue;
      } catch (e) {
        findings.push({ rule: "parse-fallback", severity: "warning", file: path, message: `acorn could not parse (${String((e as Error).message).slice(0, 80)}); used the token scanner` });
      }
    }
    findings.push(...scanTokens(path, text, opts.allowedDeps));
  }
  return toReport(findings, scanned);
}

// ── protected paths (human-push design §8) ─────────────────────────────────────

/** `.queen/**`, `wrangler.*` and `package.json` (at any depth): configuration a non-drone origin must not change. */
export const PROTECTED_PATH_RE = /^\.queen\/|(?:^|\/)(?:wrangler\.[^/]+|package\.json)$/i;

/** One policy error per changed (added, modified or deleted) protected path. Callers apply it to non-drone origins only. */
export function scanProtectedPaths(changed: Iterable<string>): Finding[] {
  const out: Finding[] = [];
  for (const file of [...changed].sort()) {
    if (!PROTECTED_PATH_RE.test(file)) continue;
    out.push({ rule: "protected-path", severity: "error", file, message: "changes to .queen/**, wrangler.* and package.json are not allowed from pushed (human or agent) code; ask the Queen to make this change" });
  }
  return out;
}
