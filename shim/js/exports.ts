import {
  CALLBACK_EXPORT, MARK, OBJECT_EXPORT, OBJECT_METHOD_EXPORT, decode, decodeArgs, encode, encodeArgs, errorCode, exportEvent, invokerMarker, isFnRef, isFunction, isObjRef, isPlain, isRecord, isThenable, splitInvoker, type FnRef, type ObjRef,
} from "./protocol.ts";
import { runAs } from "./invoker.ts";
import { dropped, expose, host, resource, serverHost } from "./runtime.ts";

type ExportFn = (...args: unknown[]) => unknown;


const CALLBACK_WINDOW = 512;
// FiveM exports have no deadline and ESX callbacks wait on fades and spawns: LS:MP's 10 s default cuts them
const EXPORT_TIMEOUT_MS = 300000;
const marker = invokerMarker(resource);

const callbacks = new Map<number, ExportFn>();
let lastCallback = 0;
let callbackRegistered = false;

/** A function passed to or returned by an export at the top level travels as a function reference and is called back through the "__callback" export of its owner. Only the last CALLBACK_WINDOW stay callable. */
function lift(fn: ExportFn): FnRef {
  if (!callbackRegistered) {
    callbackRegistered = true;
    register(resource, CALLBACK_EXPORT, (id, ...args) => {
      const target = typeof id === "number" ? callbacks.get(id) : undefined;
      if (target === undefined) throw new Error(`callback ${String(id)} expired`);
      return target(...args);
    });
  }
  lastCallback++;
  callbacks.set(lastCallback, fn);
  callbacks.delete(lastCallback - CALLBACK_WINDOW);
  return { [MARK]: "fn", r: resource, id: lastCallback };
}

// A plain object or array holding functions (at any depth) travels as { __fx: "obj", r, id, d, f }: d is a snapshot
// of the data fields, f lists the key path of every function (array slots as Lua 1-based indices). The caller rebuilds the object with one proxy per path,
// each calling the "__objcall" export of the owner, which finds the live function by id and path. Registered objects
// live in two generations: when OBJECT_WINDOW more objects get registered, the current generation becomes the old one
// and the old one is dropped. An object sent or called again moves back to the current generation.
const OBJECT_WINDOW = 512;
const MAX_PATH = 32;
const objectIds = new WeakMap<object, number>();
let currentObjects = new Map<number, object>();
let previousObjects = new Map<number, object>();
let lastObject = 0;
let objectCallRegistered = false;

type Bag = Record<string, unknown>;
type Node = Bag | unknown[];
type PathKey = string | number;

function isBag(value: unknown): value is Bag {
  return isRecord(value) && isPlain(value);
}

function putObject(id: number, target: object): void {
  if (currentObjects.size >= OBJECT_WINDOW) {
    previousObjects = currentObjects;
    currentObjects = new Map();
  }
  currentObjects.set(id, target);
}

function findObject(id: unknown): object | undefined {
  if (typeof id !== "number") return undefined;
  const current = currentObjects.get(id);
  if (current !== undefined) return current;
  const old = previousObjects.get(id);
  if (old === undefined) return undefined;
  previousObjects.delete(id);
  putObject(id, old);
  return old;
}

function isNode(value: unknown): value is Node {
  return Array.isArray(value) || isBag(value);
}

function entriesOf(value: Node): [PathKey, unknown][] {
  return Array.isArray(value) ? value.map((e, i): [PathKey, unknown] => [i + 1, e]) : Object.entries(value);
}

function hasFunction(value: Node, depth: number): boolean {
  if (depth > MAX_PATH) return false;
  for (const [, entry] of entriesOf(value)) {
    if (isFunction(entry) || (isNode(entry) && hasFunction(entry, depth + 1))) return true;
  }
  return false;
}

function split(value: Node, path: PathKey[], paths: PathKey[][], ancestors: Set<object>): Node {
  if (path.length > MAX_PATH) throw new Error(`fxcompat: payload nested deeper than ${MAX_PATH}`);
  ancestors.add(value);
  const data: Node = Array.isArray(value) ? [] : {};
  for (const [key, entry] of entriesOf(value)) {
    let kept: unknown = entry;
    if (isFunction(entry)) {
      paths.push([...path, key]);
      kept = Array.isArray(value) ? null : undefined;
    } else if (isNode(entry)) {
      kept = ancestors.has(entry) ? undefined : split(entry, [...path, key], paths, ancestors);
    }
    if (Array.isArray(data)) data.push(kept ?? null);
    else if (kept !== undefined && typeof key === "string") data[key] = kept;
  }
  ancestors.delete(value);
  return data;
}

/** Path keys are string keys, or Lua 1-based indices for the slots of an array. */
function ownEntry(parent: unknown, key: unknown): unknown {
  if (Array.isArray(parent)) {
    return typeof key === "number" && Number.isInteger(key) && key >= 1 ? parent[key - 1] : undefined;
  }
  if (!isBag(parent)) return undefined;
  const name = typeof key === "number" ? String(key) : key;
  return typeof name === "string" && Object.hasOwn(parent, name) ? parent[name] : undefined;
}

function runMethod(id: unknown, path: unknown, args: unknown[]): unknown {
  const target = findObject(id);
  if (target === undefined) throw new Error(`object ${String(id)} expired`);
  if (!Array.isArray(path) || path.length === 0) throw new Error("bad method path");
  const keys: unknown[] = path;
  let parent: unknown = target;
  for (const key of keys.slice(0, -1)) parent = ownEntry(parent, key);
  const method = ownEntry(parent, keys[keys.length - 1]);
  if (!isFunction(method)) throw new Error("no such method");
  return Reflect.apply(method, parent, args);
}

function liftObject(value: Node): ObjRef {
  if (!objectCallRegistered) {
    objectCallRegistered = true;
    register(resource, OBJECT_EXPORT, (id, path, ...args) => runMethod(id, path, args));
    register(resource, OBJECT_METHOD_EXPORT, (id, path, ...args) => runMethod(id, path, args));
  }
  let id = objectIds.get(value);
  if (id === undefined || findObject(id) !== value) {
    lastObject++;
    id = lastObject;
    objectIds.set(value, id);
    putObject(id, value);
  }
  const paths: PathKey[][] = [];
  const d = split(value, [], paths, new Set());
  return { [MARK]: "obj", r: resource, id, d, f: paths };
}

function liftValue(value: unknown): unknown {
  if (isFunction(value)) return lift(value);
  if (isNode(value) && hasFunction(value, 1)) return liftObject(value);
  return value;
}

export function liftArgs(args: unknown[]): unknown[] {
  return args.map(liftValue);
}

function isPathKey(key: unknown): key is PathKey {
  return typeof key === "string" || (typeof key === "number" && Number.isInteger(key) && key >= 1);
}

function slot(container: Node, key: PathKey): unknown {
  if (Array.isArray(container)) return typeof key === "number" ? container[key - 1] : undefined;
  return container[String(key)];
}

function assign(container: Node, key: PathKey, value: unknown): void {
  if (Array.isArray(container)) {
    if (typeof key === "number") container[key - 1] = value;
  } else container[String(key)] = value;
}

/** An empty object travels as an empty list, so a container of the wrong kind for the next key is replaced. */
function fitting(value: unknown, next: unknown): Node {
  if (Array.isArray(value)) return typeof next === "number" ? value : {};
  if (isBag(value)) return value;
  return typeof next === "number" ? [] : {};
}

function rebuild(ref: ObjRef, depth: number): Node {
  const data = unlift(ref.d, depth + 1);
  const paths: unknown = ref.f;
  const list: unknown[] = Array.isArray(paths) ? paths : [];
  const first: unknown = list.length > 0 && Array.isArray(list[0]) ? list[0][0] : undefined;
  const obj = fitting(data, first);
  for (const path of list) {
    const raw: unknown[] = Array.isArray(path) ? path : [];
    const keys: PathKey[] = raw.filter(isPathKey);
    const last = keys[keys.length - 1];
    if (last === undefined || keys.length !== raw.length) continue;
    let container = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (key === undefined) continue;
      const existing = slot(container, key);
      const child = fitting(existing, keys[i + 1]);
      if (existing !== child) assign(container, key, child);
      container = child;
    }
    assign(container, last, (...args: unknown[]) => callExport(ref.r, OBJECT_EXPORT, ref.id, keys, ...args));
  }
  return obj;
}

function unlift(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const converted = unlift(value[i], depth + 1);
      if (converted !== value[i]) {
        out ??= [...value];
        out[i] = converted;
      }
    }
    return out ?? value;
  }
  if (!isBag(value)) return value;
  if (isFnRef(value)) {
    const own = value.r === resource ? callbacks.get(value.id) : undefined;
    return own ?? ((...args: unknown[]) => callExport(value.r, CALLBACK_EXPORT, value.id, ...args));
  }
  if (isObjRef(value)) return rebuild(value, depth);
  if (depth > MAX_PATH) return value;
  let out: Bag | undefined;
  for (const key of Object.keys(value)) {
    const converted = unlift(value[key], depth + 1);
    if (converted !== value[key]) {
      out ??= { ...value };
      out[key] = converted;
    }
  }
  return out ?? value;
}

export function unliftArgs(args: unknown[]): unknown[] {
  return args.map((a) => unlift(a, 1));
}

function pack(value: unknown): unknown[] {
  return [encode(liftValue(value), dropped) ?? null];
}

export function register(owner: string, exportName: string, fn: ExportFn): void {
  const run = (wire: unknown[]): unknown => {
    const { invoker, args } = splitInvoker(wire);
    const result = runAs(invoker, () => fn(...decodeArgs(args).map((a) => unlift(a, 1))));
    return isThenable(result) ? Promise.resolve(result).then(pack) : pack(result);
  };
  const event = exportEvent(owner, exportName);
  if (serverHost !== null) host.onCall(event, (_source, ...args) => run(args));
  else host.onCall(event, (...args) => run(args));
}

function failure(error: unknown, name: string, target: string): Error {
  const code = errorCode(error);
  if (code === "no-handler") return new Error(`export '${name}' of resource '${target}' is not available`);
  return new Error(`export '${target}:${name}' failed: ${String(code ?? error)}`);
}

/** Resolves with the first value the export returned. */
export async function callExport(target: string, name: string, ...args: unknown[]): Promise<unknown> {
  let list: unknown;
  try {
    list = await host.call({ name: exportEvent(target, name), timeoutMs: EXPORT_TIMEOUT_MS }, marker, ...encodeArgs(liftArgs(args), dropped));
  } catch (error) {
    throw failure(error, name, target);
  }
  if (!Array.isArray(list)) return undefined;
  const values = decode(list);
  return Array.isArray(values) ? unlift(values[0], 1) : undefined;
}

function resourceProxy(target: string): object {
  return new Proxy(
    {},
    {
      get: (_, name) =>
        typeof name !== "string" || name === "then" ? undefined : (...args: unknown[]) => callExport(target, name, ...args),
    },
  );
}

export function installExports(): void {
  const proxies = new Map<string, object>();
  const registerOwn = (name: string, fn: ExportFn): void => register(resource, name, fn);
  expose(
    "exports",
    new Proxy(registerOwn, {
      get: (_, target) => {
        if (typeof target !== "string" || target === "then") return undefined;
        let proxy = proxies.get(target);
        if (proxy === undefined) {
          proxy = resourceProxy(target);
          proxies.set(target, proxy);
        }
        return proxy;
      },
    }),
  );
}
