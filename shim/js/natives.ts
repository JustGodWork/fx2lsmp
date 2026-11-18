import data from "./natives_data.json" with { type: "json" };
import hashes from "./natives_hashes.json" with { type: "json" };
import { isRecord, isVec3 } from "./protocol.ts";
import { citizen } from "./core.ts";

const RESULT_MARKERS: readonly string[] = [
  "resultAsInteger", "resultAsLong", "resultAsFloat", "resultAsString", "resultAsVector", "resultAsObject",
  "resultAsObject2", "returnResultAnyway", "pointerValueInt", "pointerValueFloat", "pointerValueVector",
  "pointerValueIntInitialized", "pointerValueFloatInitialized",
];

const markers = new WeakSet<object>();

/** FiveM JS returns vectors as arrays, LS:MP as `{x,y,z}`. */
function adaptResult(result: unknown): unknown {
  if (isVec3(result)) return [result.x, result.y, result.z];
  if (Array.isArray(result) && result.some(isVec3)) {
    return result.map((e) => (isVec3(e) ? [e.x, e.y, e.z] : e));
  }
  return result;
}

function callNative(name: string, args: unknown[]): unknown {
  const impl: unknown = Reflect.get(globalThis, name);
  if (typeof impl !== "function") throw new Error(`fxcompat: LS:MP has no native ${name}`);
  return adaptResult(Reflect.apply(impl, globalThis, args));
}

function define(name: string, target: string): void {
  if (name in globalThis) return;
  Object.defineProperty(globalThis, name, {
    value: (...args: unknown[]) => callNative(target, args),
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

function hashKey(hash: unknown): string | null {
  try {
    const text = typeof hash === "string" ? hash.replace(/^0x/i, "") : null;
    const value = text === null ? BigInt(Number(hash)) : BigInt(`0x${text}`);
    return `N_0x${value.toString(16).toUpperCase().padStart(16, "0")}`;
  } catch {
    return null;
  }
}

interface NativesData {
  alias: Record<string, string>;
  names: string[];
}

function parseCatalogue(raw: unknown): NativesData {
  const alias: Record<string, string> = {};
  const names: string[] = [];
  if (isRecord(raw)) {
    const rawAlias = raw["alias"];
    if (isRecord(rawAlias)) for (const [k, v] of Object.entries(rawAlias)) if (typeof v === "string") alias[k] = v;
    const rawNames = raw["names"];
    if (Array.isArray(rawNames)) for (const n of rawNames) if (typeof n === "string") names.push(n);
  }
  return { alias, names };
}

const catalogue: NativesData = parseCatalogue(data);
// the hash table is bundled only for resources that call Citizen.invokeNative (a build flag): it is half of the data
const hashTable: Record<string, string> = __FX_HASHES__ ? parseCatalogue({ alias: hashes, names: [] }).alias : {};

function invokeNative(hash: unknown, ...args: unknown[]): unknown {
  const key = hashKey(hash);
  const target = key === null ? undefined : hashTable[key];
  if (target === undefined) throw new Error(`Citizen.invokeNative: native ${String(hash)} is not in the LS:MP catalogue`);
  return callNative(target, args.filter((a) => !(typeof a === "object" && a !== null && markers.has(a))));
}

export function installNatives(): void {
  for (const name of catalogue.names) define(name.charAt(0).toUpperCase() + name.slice(1), name);
  for (const [pascal, target] of Object.entries(catalogue.alias)) if (!pascal.startsWith("N_0x")) define(pascal, target);
  for (const marker of RESULT_MARKERS) {
    citizen[marker] = () => {
      const m = {};
      markers.add(m);
      return m;
    };
  }
  citizen["invokeNative"] = invokeNative;
}
