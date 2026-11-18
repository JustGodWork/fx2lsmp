import { isRecord } from "../shim/js/protocol.ts";

const MAX_DEPTH = 32;
const MAX_ARGS = 32;

export class WireError extends Error {}

function quote(text: string, path: string): string {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh && !(text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff)) {
      throw new WireError(`${path}: lone surrogate is not transportable`);
    }
    if (isHigh) i++;
    else if (isLow) throw new WireError(`${path}: lone surrogate is not transportable`);
  }
  let out = '"';
  for (const byte of Buffer.from(text, "utf8")) {
    if (byte === 0x22 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += `\\${String(byte).padStart(3, "0")}`;
  }
  return `${out}"`;
}

function number(value: number, path: string): string {
  if (!Number.isFinite(value)) throw new WireError(`${path}: non-finite number is not transportable`);
  return String(value);
}

function tagOf(value: unknown): string {
  return Object.prototype.toString.call(value).slice(8, -1);
}

/** Values built in another realm (the vm contexts of the tests) have another Object.prototype: compare shapes, not identities. */
function isPlainObject(value: object): boolean {
  if (tagOf(value) !== "Object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || (typeof proto === "object" && Object.getPrototypeOf(proto) === null);
}

function isVector(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === 3 && ["x", "y", "z"].every((k) => typeof value[k] === "number");
}

function describe(value: unknown): string {
  if (typeof value === "function") return "function";
  if (typeof value === "symbol") return "symbol";
  const tag = tagOf(value);
  return ["Map", "Set", "Date", "RegExp", "Promise", "Error"].includes(tag) ? tag : "class instance";
}

/** LS:MP transportable values (docs/notes/b.md 0.4) as the Lua literal form of test/lua/mock_lsmp.lua. */
function wire(value: unknown, path: string, depth: number): string {
  if (value === null || value === undefined) return "N";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return number(value, path);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return quote(value, path);
  if (typeof value !== "object") throw new WireError(`${path}: ${describe(value)} is not transportable`);
  if (depth > MAX_DEPTH) throw new WireError(`${path}: nesting deeper than ${MAX_DEPTH}`);
  if (Array.isArray(value)) {
    return `{${Array.from({ length: value.length }, (_, i) => wire(value[i], `${path}[${i + 1}]`, depth + 1)).join(",")}}`;
  }
  if (!isPlainObject(value)) throw new WireError(`${path}: ${describe(value)} is not transportable`);
  if (!isRecord(value)) throw new WireError(`${path}: ${describe(value)} is not transportable`);
  if (isVector(value)) return `V(${wire(value["x"], path, depth)},${wire(value["y"], path, depth)},${wire(value["z"], path, depth)})`;
  const parts: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    parts.push(`[${quote(key, path)}]=${wire(entry, `${path}.${key}`, depth + 1)}`);
  }
  return `{${parts.join(",")}}`;
}

export function toWireValue(path: string, value: unknown): string {
  return wire(value, path, 1);
}

export function toWire(fnName: string, args: readonly unknown[]): string {
  let count = args.length;
  while (count > 0 && args[count - 1] === undefined) count--;
  if (count > MAX_ARGS) throw new WireError(`${fnName}: too many arguments (max ${MAX_ARGS})`);
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(wire(args[i], `${fnName}: args[${i + 1}]`, 1));
  return `{${parts.join(",")}}`;
}

class Reader {
  private pos = 0;
  constructor(private readonly text: string) {}

  private skip(): void {
    while (/\s/.test(this.text.charAt(this.pos))) this.pos++;
  }

  private expect(token: string): void {
    this.skip();
    if (!this.text.startsWith(token, this.pos)) throw new WireError(`wire: expected ${token} at ${this.pos}`);
    this.pos += token.length;
  }

  private eat(token: string): boolean {
    this.skip();
    if (!this.text.startsWith(token, this.pos)) return false;
    this.pos += token.length;
    return true;
  }

  private string(): string {
    this.expect('"');
    const bytes: number[] = [];
    for (;;) {
      const ch = this.text.charAt(this.pos);
      if (ch === "") throw new WireError("wire: unterminated string");
      if (ch === '"') {
        this.pos++;
        return Buffer.from(bytes).toString("utf8");
      }
      if (ch === "\\") {
        const digits = /^\d{1,3}/.exec(this.text.slice(this.pos + 1));
        if (digits !== null) {
          bytes.push(Number(digits[0]));
          this.pos += 1 + digits[0].length;
        } else {
          bytes.push(...Buffer.from(this.text.charAt(this.pos + 1), "utf8"));
          this.pos += 2;
        }
        continue;
      }
      bytes.push(...Buffer.from(ch, "utf8"));
      this.pos++;
    }
  }

  private numberToken(): number {
    const rest = this.text.slice(this.pos);
    const hex = /^-?0x[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?p[+-]?\d+/.exec(rest);
    if (hex !== null) {
      this.pos += hex[0].length;
      const negative = hex[0].startsWith("-");
      const [mantissa = "", exponent = "0"] = hex[0].replace(/^-?0x/, "").split(/p/i);
      const [whole = "0", fraction = ""] = mantissa.split(".");
      const value = parseInt(whole + fraction, 16) / 16 ** fraction.length * 2 ** Number(exponent);
      return negative ? -value : value;
    }
    const plain = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (plain === null) throw new WireError(`wire: unexpected token at ${this.pos}`);
    this.pos += plain[0].length;
    return Number(plain[0]);
  }

  value(): unknown {
    this.skip();
    if (this.eat("N")) return null;
    if (this.eat("true")) return true;
    if (this.eat("false")) return false;
    if (this.eat("V(")) {
      const x = this.numberToken();
      this.expect(",");
      const y = this.numberToken();
      this.expect(",");
      const z = this.numberToken();
      this.expect(")");
      return { x, y, z };
    }
    if (this.text.charAt(this.pos) === '"') return this.string();
    if (this.text.charAt(this.pos) === "{") return this.table();
    return this.numberToken();
  }

  private table(): unknown {
    this.expect("{");
    const list: unknown[] = [];
    const map: Record<string, unknown> = {};
    let isMap = false;
    while (!this.eat("}")) {
      if (this.eat("[")) {
        const key = this.string();
        this.expect("]");
        this.expect("=");
        map[key] = this.value();
        isMap = true;
      } else {
        list.push(this.value());
      }
      this.eat(",");
    }
    return isMap ? map : list;
  }
}

export function fromWire(text: string): unknown {
  return new Reader(text).value();
}
