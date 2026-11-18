export const MARK = "__fx";
export const MAX_DEPTH = 32;
export const SERVER_SOURCE = 65535;
export const NUI_EVENT = "__fxnui";
export const NUI_CALLBACK_PREFIX = "__cfx_nui:";
export const CALLBACK_EXPORT = "__callback";
export const OBJECT_EXPORT = "__objcall";
export const OBJECT_METHOD_EXPORT = "__objmethod";

export type MarkerTag = "v2" | "v4" | "q" | "m" | "fn" | "obj";

export interface FnRef {
  __fx: "fn";
  r: string;
  id: number;
}

/** A table or object holding functions: `d` is a data snapshot, `f` the key path of every function (string keys, or Lua 1-based integer indices for list slots). */
export interface ObjRef {
  __fx: "obj";
  r: string;
  id: number;
  d: unknown;
  f: unknown;
}

export type Dropped = (what: string) => void;

export function exportEvent(resource: string, name: string): string {
  return `export:${resource}:${name}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Values built by the host may come from another realm: no `instanceof`. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "then") === "function";
}

export function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
}

export function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

export function isFnRef(value: unknown): value is FnRef {
  return isRecord(value) && value[MARK] === "fn" && typeof value["r"] === "string" && Number.isInteger(value["id"]);
}

export function isObjRef(value: unknown): value is ObjRef {
  return isRecord(value) && value[MARK] === "obj" && typeof value["r"] === "string" && Number.isInteger(value["id"]);
}

export function isPlain(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isBytes(value: object): boolean {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function checkDepth(depth: number): void {
  if (depth > MAX_DEPTH) throw new Error(`fxcompat: payload nested deeper than ${MAX_DEPTH}`);
}

function isClean(value: unknown, depth: number, json: boolean): boolean {
  switch (typeof value) {
    case "undefined":
    case "function":
    case "symbol":
      return false;
    case "bigint":
      return !json;
    case "object":
      break;
    default:
      return true;
  }
  if (value === null) return true;
  checkDepth(depth);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!isClean(value[i], depth + 1, json)) return false;
    }
    return true;
  }
  if (!isPlain(value)) return !json && isBytes(value);
  for (const key in value) {
    if (!json && key === MARK) return false;
    if (!isClean(Reflect.get(value, key), depth + 1, json)) return false;
  }
  return true;
}

function buildEntries(entries: [unknown, unknown][], depth: number, dropped: Dropped): unknown {
  const keys: unknown[] = [];
  const vals: unknown[] = [];
  let allStrings = true;
  for (const [k, v] of entries) {
    const built = build(v, depth + 1, dropped);
    if (built === undefined) continue;
    keys.push(k);
    vals.push(built);
    if (typeof k !== "string" || k === MARK) allStrings = false;
  }
  if (allStrings) {
    const out: Record<string, unknown> = {};
    keys.forEach((k, i) => {
      if (typeof k === "string") out[k] = vals[i];
    });
    return out;
  }
  return { [MARK]: "m", k: keys, v: vals };
}

function build(value: unknown, depth: number, dropped: Dropped): unknown {
  switch (typeof value) {
    case "undefined":
      return undefined;
    case "function":
      dropped("function");
      return undefined;
    case "symbol":
      dropped("symbol");
      return undefined;
    case "object":
      break;
    default:
      return value;
  }
  if (value === null) return null;
  checkDepth(depth);
  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_, i) => build(value[i], depth + 1, dropped) ?? null);
  }
  if (isBytes(value)) return value;
  if (value instanceof Map) return buildEntries([...value.entries()], depth, dropped);
  if (value instanceof Set) return Array.from(value, (e) => build(e, depth + 1, dropped) ?? null);
  const toJson: unknown = Reflect.get(value, "toJSON");
  if (typeof toJson === "function" && !isPlain(value)) return build(Reflect.apply(toJson, value, []), depth + 1, dropped);
  return buildEntries(Object.entries(value), depth, dropped);
}

/** Returns the very same value when it can already travel. */
export function encode(value: unknown, dropped: Dropped = () => {}): unknown {
  if (value === undefined) return null;
  if (typeof value !== "object" && typeof value !== "function" && typeof value !== "symbol") return value;
  if (isClean(value, 1, false)) return value;
  return build(value, 1, dropped) ?? null;
}

export function encodeArgs(args: readonly unknown[], dropped?: Dropped): unknown[] {
  return args.map((a) => encode(a, dropped));
}

function needsDecode(value: unknown, depth: number): boolean {
  if (typeof value !== "object" || value === null) return false;
  checkDepth(depth);
  if (Array.isArray(value)) return value.some((e) => needsDecode(e, depth + 1));
  if (MARK in value) return true;
  for (const key in value) {
    if (needsDecode(Reflect.get(value, key), depth + 1)) return true;
  }
  return false;
}

function unbuild(value: unknown, depth: number): unknown {
  if (typeof value !== "object" || value === null) return value;
  checkDepth(depth);
  if (Array.isArray(value)) return value.map((e) => unbuild(e, depth + 1));
  if (!isRecord(value)) return value;
  const tag = value[MARK];
  if (tag === "v2") return { x: value["x"], y: value["y"] };
  if (tag === "v4" || tag === "q") return { x: value["x"], y: value["y"], z: value["z"], w: value["w"] };
  if (tag === "fn") return value;
  const out: Record<string, unknown> = {};
  if (tag === "m" && Array.isArray(value["k"]) && Array.isArray(value["v"])) {
    const vals: unknown[] = value["v"];
    value["k"].forEach((k, i) => {
      out[String(k)] = unbuild(vals[i], depth + 1);
    });
    return out;
  }
  for (const key in value) out[key] = unbuild(value[key], depth + 1);
  return out;
}

export function decode(value: unknown): unknown {
  if (!needsDecode(value, 1)) return value;
  return unbuild(value, 1);
}

export function decodeArgs(args: readonly unknown[]): unknown[] {
  return args.map(decode);
}

/** FiveM JSON semantics for NUI messages: functions and undefined vanish. */
export function toJson(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null) return typeof value === "function" ? null : value;
  if (isClean(value, 1, true)) return value;
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text);
}

export function isVec3(value: unknown): value is { x: number; y: number; z: number } {
  if (!isRecord(value) || Object.keys(value).length !== 3) return false;
  return typeof value["x"] === "number" && typeof value["y"] === "number" && typeof value["z"] === "number";
}

export interface InvokerMarker {
  __fx: "inv";
  r: string;
}

export function invokerMarker(resource: string): InvokerMarker {
  return { [MARK]: "inv", r: resource };
}

/** Splits the leading invoker marker off the arguments of an export call or local event; older payloads have none. */
export function splitInvoker(args: readonly unknown[]): { invoker: string | null; args: unknown[] } {
  const first = args[0];
  if (isRecord(first) && first[MARK] === "inv") {
    const from = first["r"];
    return { invoker: typeof from === "string" ? from : null, args: args.slice(1) };
  }
  return { invoker: null, args: [...args] };
}
