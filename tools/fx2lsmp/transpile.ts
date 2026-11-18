export type IssueKind = "safe-navigation" | "in-unpacking" | "set-constructor" | "c-comment";

export interface TranspileIssue {
  line: number;
  kind: IssueKind;
  message: string;
}

export interface TranspileResult {
  code: string;
  issues: TranspileIssue[];
}

const COMPOUND_OPS: readonly string[] = ["<<", ">>", "//", "..", "+", "-", "*", "/", "%", "^", "&", "|"];
const STMT_START_WORDS: ReadonlySet<string> = new Set(["then", "do", "else", "repeat", "end"]);
const RHS_STOP_WORDS: ReadonlySet<string> = new Set(["end", "else", "elseif", "until"]);
const IN_UNPACK = /^local\s+[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s+in\s/;

export function joaat(text: string): number {
  let h = 0;
  for (const b of Buffer.from(text.toLowerCase(), "utf8")) {
    h = (h + b) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  h = (h + (h << 15)) >>> 0;
  return h;
}

const isIdStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

function longBracketLevel(src: string, i: number): number {
  if (src[i] !== "[") return -1;
  let j = i + 1;
  while (src[j] === "=") j++;
  return src[j] === "[" ? j - i - 1 : -1;
}

function skipLongBracket(src: string, i: number, level: number): number {
  const close = "]" + "=".repeat(level) + "]";
  const end = src.indexOf(close, i + level + 2);
  return end < 0 ? src.length : end + close.length;
}

const NAV_EMPTY = "__fxc_nil";

/** Start index of the primary expression (name, `.field`, `:method`, call, index) that ends `out`, or -1. */
function navOperandStart(out: string): number {
  let p = out.length;
  for (;;) {
    const ch = out[p - 1] ?? "";
    if (ch === ")" || ch === "]") {
      const open = ch === ")" ? "(" : "[";
      let depth = 0;
      let q = p - 1;
      for (; q >= 0; q--) {
        const x = out[q];
        if (x === ch) depth++;
        else if (x === open && --depth === 0) break;
      }
      if (q < 0) return -1;
      p = q;
      const before = out[p - 1] ?? " ";
      if (!isIdChar(before) && before !== "]" && before !== ")") return p;
      continue;
    }
    if (!isIdChar(ch)) return -1;
    while (isIdChar(out[p - 1] ?? " ")) p--;
    const sep = out[p - 1];
    if ((sep === "." && out[p - 2] !== ".") || sep === ":") {
      p--;
      continue;
    }
    return p;
  }
}

class Lexer {
  readonly issues: TranspileIssue[] = [];
  private readonly lineStarts: number[] = [0];

  constructor(private readonly src: string) {
    for (let i = 0; i < src.length; i++) if (src[i] === "\n") this.lineStarts.push(i + 1);
  }

  private lineAt(pos: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  private report(pos: number, kind: IssueKind, message: string): void {
    const line = this.lineAt(pos);
    if (!this.issues.some((x) => x.line === line && x.kind === kind)) this.issues.push({ line, kind, message });
  }

  private compoundAt(i: number): string | undefined {
    const s = this.src;
    for (const op of COMPOUND_OPS) {
      if (s.startsWith(op + "=", i) && s[i + op.length + 1] !== "=") return op;
    }
    return undefined;
  }

  /** Transpiles from `start`. With `stopAtStatementEnd`, ends at the end of the statement (right side of a compound op). */
  run(start: number, stopAtStatementEnd: boolean): { text: string; end: number } {
    const s = this.src;
    let out = "";
    let i = start;
    let depth = 0;
    let atStmtStart = !stopAtStatementEnd;
    let stmtStart = 0;
    let lastSignificant = "";

    const copyUntil = (end: number): void => {
      out += s.slice(i, end);
      i = end;
    };

    while (i < s.length) {
      const c = s[i] as string;

      if (c === "\n") {
        if (stopAtStatementEnd) break;
        out += c;
        i++;
        atStmtStart = true;
        continue;
      }
      if (c === " " || c === "\t" || c === "\r") {
        out += c;
        i++;
        continue;
      }

      if (c === "-" && s[i + 1] === "-") {
        if (stopAtStatementEnd) break;
        const level = longBracketLevel(s, i + 2);
        copyUntil(level >= 0 ? skipLongBracket(s, i + 2, level) : this.lineEnd(i));
        continue;
      }
      if (c === "/" && s[i + 1] === "*") {
        this.report(i, "c-comment", "C style comment `/* */` is not Lua");
        const end = s.indexOf("*/", i + 2);
        copyUntil(end < 0 ? s.length : end + 2);
        continue;
      }

      if (atStmtStart) {
        stmtStart = out.length;
        atStmtStart = false;
        if (c === "l" && IN_UNPACK.test(s.slice(i, this.lineEnd(i)))) {
          this.report(i, "in-unpacking", "`local a, b in t` unpacking is not Lua");
        }
      }

      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < s.length && s[j] !== c && s[j] !== "\n") j += s[j] === "\\" ? 2 : 1;
        copyUntil(Math.min(j + 1, s.length));
        lastSignificant = c;
        continue;
      }
      if (c === "[") {
        const level = longBracketLevel(s, i);
        if (level >= 0) {
          copyUntil(skipLongBracket(s, i, level));
          lastSignificant = "]";
          continue;
        }
      }
      if (c === "`") {
        const end = s.indexOf("`", i + 1);
        const nl = s.indexOf("\n", i + 1);
        if (end > 0 && (nl < 0 || end < nl)) {
          out += String(joaat(s.slice(i + 1, end)));
          i = end + 1;
          lastSignificant = "0";
          continue;
        }
      }

      if (c === "?" && (s[i + 1] === "." || s[i + 1] === "[") && s[i + 2] !== ".") {
        const start = navOperandStart(out);
        if (start >= 0) {
          out = `${out.slice(0, start)}(${out.slice(start)} or ${NAV_EMPTY})`;
          i += s[i + 1] === "." && s[i + 2] === "[" ? 2 : 1;
          lastSignificant = ")";
          continue;
        }
        this.report(i, "safe-navigation", "safe navigation `?.` is not Lua");
      }
      if (c === "." && s[i + 1] !== "." && isIdStart(s[i + 1] ?? "") && (lastSignificant === "{" || lastSignificant === ",")) {
        this.report(i, "set-constructor", "set constructor `{ .a }` is not Lua");
      }

      if (stopAtStatementEnd) {
        if (c === ";" && depth === 0) break;
        if (c === "(" || c === "[" || c === "{") depth++;
        else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--;
        else if (isIdStart(c) && depth === 0 && !isIdChar(s[i - 1] ?? " ")) {
          let j = i + 1;
          while (j < s.length && isIdChar(s[j] as string)) j++;
          if (RHS_STOP_WORDS.has(s.slice(i, j))) break;
        }
      } else {
        const op = this.compoundAt(i);
        if (op !== undefined && !(c === "." && lastSignificant === ".")) {
          const lhs = out.slice(stmtStart).trim();
          const indent = out.slice(stmtStart).match(/^\s*/)?.[0] ?? "";
          const rhs = this.run(i + op.length + 1, true);
          out = out.slice(0, stmtStart) + `${indent}${lhs} = ${lhs} ${op} (${rhs.text.trim()})` + (rhs.text.match(/\s*$/)?.[0] ?? "");
          i = rhs.end;
          lastSignificant = ")";
          continue;
        }
      }

      if (isIdStart(c)) {
        let j = i + 1;
        while (j < s.length && isIdChar(s[j] as string)) j++;
        const word = s.slice(i, j);
        copyUntil(j);
        lastSignificant = "a";
        if (!stopAtStatementEnd && STMT_START_WORDS.has(word)) atStmtStart = true;
        continue;
      }

      if (c === ";" && !stopAtStatementEnd) atStmtStart = true;
      lastSignificant = c;
      copyUntil(i + 1);
    }
    return { text: out, end: i };
  }

  private lineEnd(i: number): number {
    const nl = this.src.indexOf("\n", i);
    return nl < 0 ? this.src.length : nl;
  }
}

export function transpile(src: string): TranspileResult {
  const lexer = new Lexer(src);
  const { text } = lexer.run(0, false);
  return { code: copyAssignedLoopVars(text), issues: lexer.issues };
}

interface Tok {
  text: string;
  start: number;
  end: number;
  kind: "name" | "punct" | "other";
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && src[i + 1] === "-") {
      const level = longBracketLevel(src, i + 2);
      if (level >= 0) i = skipLongBracket(src, i + 2, level);
      else {
        const nl = src.indexOf("\n", i);
        i = nl < 0 ? src.length : nl;
      }
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      i = Math.min(j + 1, src.length);
    } else if (c === "[" && longBracketLevel(src, i) >= 0) {
      i = skipLongBracket(src, i, longBracketLevel(src, i));
    } else if (isIdStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdChar(src[j] as string)) j++;
      toks.push({ text: src.slice(i, j), start: i, end: j, kind: "name" });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9A-Za-z_.]/.test(src[j] as string)) j++;
      i = j;
    } else {
      const two = src.slice(i, i + 2);
      const text = two === "==" || two === "~=" || two === "<=" || two === ">=" || two === ".." || two === "::" ? two : c;
      toks.push({ text, start: i, end: i + text.length, kind: "punct" });
      i += text.length;
    }
  }
  return toks;
}

interface LoopFrame {
  type: "loop" | "block";
  vars: Tok[];
  assigned: Set<string>;
  bodyStart: number;
}

/** Lua 5.5 makes `for` control variables constant: copy the ones the body assigns into a local of the same name. */
function copyAssignedLoopVars(code: string): string {
  const toks = tokenize(code);
  const stack: LoopFrame[] = [];
  const edits: { at: number; remove: number; insert: string }[] = [];
  let pending: Tok[] | undefined;
  let pendingIsLoop = false;
  const renamed = (name: string): string => `${name}__fxc`;

  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t] as Tok;
    if (tok.kind === "name") {
      const prev = toks[t - 1]?.text;
      const isField = prev === "." || prev === ":";
      switch (tok.text) {
        case "for": {
          const vars: Tok[] = [];
          let u = t + 1;
          while (toks[u] !== undefined && toks[u]?.text !== "in" && toks[u]?.text !== "=") {
            if (toks[u]?.kind === "name") vars.push(toks[u] as Tok);
            u++;
          }
          pending = vars;
          pendingIsLoop = true;
          break;
        }
        case "while":
          pending = [];
          pendingIsLoop = true;
          break;
        case "do":
          if (pendingIsLoop && pending !== undefined) {
            stack.push({ type: "loop", vars: pending, assigned: new Set(), bodyStart: tok.end });
            pending = undefined;
            pendingIsLoop = false;
          } else stack.push({ type: "block", vars: [], assigned: new Set(), bodyStart: tok.end });
          break;
        case "function":
        case "if":
        case "repeat":
          if (!isField) stack.push({ type: "block", vars: [], assigned: new Set(), bodyStart: tok.end });
          break;
        case "until":
          stack.pop();
          break;
        case "end": {
          const frame = stack.pop();
          if (frame?.type === "loop" && frame.assigned.size > 0) {
            let insert = " ";
            for (const v of frame.vars) {
              if (!frame.assigned.has(v.text)) continue;
              edits.push({ at: v.start, remove: v.end - v.start, insert: renamed(v.text) });
              insert += `local ${v.text} = ${renamed(v.text)}; `;
            }
            edits.push({ at: frame.bodyStart, remove: 0, insert: insert.trimEnd() });
          }
          break;
        }
        default: {
          if (isField || prev === "local") break;
          let u = t + 1;
          while (toks[u]?.text === "," && toks[u + 1]?.kind === "name") u += 2;
          if (toks[u]?.text !== "=") break;
          for (const frame of stack) {
            if (frame.type === "loop" && frame.vars.some((v) => v.text === tok.text)) frame.assigned.add(tok.text);
          }
        }
      }
    }
  }
  if (edits.length === 0) return code;
  edits.sort((a, b) => b.at - a.at);
  let out = code;
  for (const e of edits) out = out.slice(0, e.at) + e.insert + out.slice(e.at + e.remove);
  return out;
}
