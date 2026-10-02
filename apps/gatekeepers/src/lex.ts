/**
 * A small JS/TS tokenizer used where acorn cannot parse (TypeScript, JSX).
 *
 * It does NOT build a syntax tree and does not strip types: it only needs to
 * (1) skip comments, strings and regex literals so that code-looking text in
 * them never matches a rule, and (2) keep bracket depth so "top level" can be
 * recognised. Type annotations are harmless to a token scan, which is why this
 * works on TypeScript without a real type-stripping pass.
 *
 * Known imprecision: regex-vs-division is a heuristic (previous token), and
 * JSX text containing a lone quote can desynchronise a string (strings end at
 * a newline, which bounds the damage to one line).
 */
export type TokenType = "word" | "str" | "tmpl" | "num" | "punct";

export interface Token {
  t: TokenType;
  v: string;
  line: number;
  /** Nesting depth of ( [ { at this token (0 = module top level). */
  depth: number;
}

const OPS = [
  ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
];

const REGEX_PREV_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

const isIdStart = (c: string) => /[A-Za-z_$\u0080-￿]/.test(c);
const isIdPart = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  let depth = 0;
  const n = src.length;

  const push = (t: TokenType, v: string, ln: number, d = depth) => out.push({ t, v, line: ln, depth: d });

  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    // comments
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    // hashbang
    if (c === "#" && src[i + 1] === "!" && i === 0) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // strings (end at newline if unterminated: bounds JSX-text damage)
    if (c === '"' || c === "'") {
      const q = c;
      const startLine = line;
      let j = i + 1;
      let v = "";
      while (j < n && src[j] !== q && src[j] !== "\n") {
        if (src[j] === "\\" && j + 1 < n) {
          v += src[j + 1];
          j += 2;
        } else v += src[j++];
      }
      push("str", v, startLine);
      i = src[j] === q ? j + 1 : j;
      continue;
    }
    // template literals (static text kept; ${...} replaced with a marker)
    if (c === "`") {
      const startLine = line;
      let j = i + 1;
      let v = "";
      while (j < n && src[j] !== "`") {
        if (src[j] === "\\" && j + 1 < n) {
          v += src[j + 1];
          j += 2;
        } else if (src[j] === "$" && src[j + 1] === "{") {
          let d = 1;
          j += 2;
          while (j < n && d > 0) {
            if (src[j] === "{") d++;
            else if (src[j] === "}") d--;
            else if (src[j] === "\n") line++;
            j++;
          }
          v += "${}";
        } else {
          if (src[j] === "\n") line++;
          v += src[j++];
        }
      }
      push("tmpl", v, startLine);
      i = j + 1;
      continue;
    }
    // numbers
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j]!)) j++;
      push("num", src.slice(i, j), line);
      i = j;
      continue;
    }
    // identifiers / keywords (also `#private`)
    if (isIdStart(c) || (c === "#" && isIdStart(src[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && isIdPart(src[j]!)) j++;
      push("word", src.slice(i, j), line);
      i = j;
      continue;
    }
    // regex literal (heuristic)
    if (c === "/") {
      const prev = out[out.length - 1];
      const regexOk = !prev || (prev.t === "punct" && ![")", "]", "}"].includes(prev.v)) || (prev.t === "word" && REGEX_PREV_WORDS.has(prev.v));
      if (regexOk) {
        let j = i + 1;
        let inClass = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") j += 2;
          else if (src[j] === "[") {
            inClass = true;
            j++;
          } else if (src[j] === "]") {
            inClass = false;
            j++;
          } else if (src[j] === "/" && !inClass) break;
          else j++;
        }
        if (src[j] === "/") {
          j++;
          while (j < n && /[a-z]/.test(src[j]!)) j++;
          push("punct", "/regex/", line);
          i = j;
          continue;
        }
      }
    }
    // punctuation
    if (c === "(" || c === "[" || c === "{") {
      push("punct", c, line);
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth = Math.max(0, depth - 1);
      push("punct", c, line);
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      push("punct", op, line);
      i += op.length;
      continue;
    }
    push("punct", c, line);
    i++;
  }
  return out;
}

/** Index of the bracket closing the one at `i` (or tokens.length). */
export function matchingClose(tokens: Token[], i: number): number {
  const open = tokens[i]!.v;
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let d = 0;
  for (let j = i; j < tokens.length; j++) {
    const v = tokens[j]!;
    if (v.t !== "punct") continue;
    if (v.v === open) d++;
    else if (v.v === close && --d === 0) return j;
  }
  return tokens.length;
}

export const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="]);
