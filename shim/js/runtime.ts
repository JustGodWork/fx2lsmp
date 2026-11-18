import { isRecord } from "./protocol.ts";

export interface FxConfig {
  uiPage?: string;
  kvpPage?: string;
  chatBridge?: boolean;
  b1Workarounds?: boolean;
  applyEntities?: boolean;
  convars: Record<string, string>;
  metadata: Record<string, string[]>;
}

function isClient(candidate: LsmpShared): candidate is LsmpClient {
  return "emitServer" in candidate;
}

function isServer(candidate: LsmpShared): candidate is LsmpServer {
  return "emitClient" in candidate;
}

function readConfig(): FxConfig {
  const raw: unknown = Reflect.get(globalThis, "FXCOMPAT_CONFIG");
  const config: FxConfig = { convars: {}, metadata: {} };
  if (!isRecord(raw)) return config;
  if (typeof raw["uiPage"] === "string") config.uiPage = raw["uiPage"];
  if (typeof raw["kvpPage"] === "string") config.kvpPage = raw["kvpPage"];
  if (typeof raw["chatBridge"] === "boolean") config.chatBridge = raw["chatBridge"];
  if (typeof raw["b1Workarounds"] === "boolean") config.b1Workarounds = raw["b1Workarounds"];
  if (typeof raw["applyEntities"] === "boolean") config.applyEntities = raw["applyEntities"];
  if (isRecord(raw["convars"])) {
    for (const [k, v] of Object.entries(raw["convars"])) if (typeof v === "string") config.convars[k] = v;
  }
  if (isRecord(raw["metadata"])) {
    for (const [k, v] of Object.entries(raw["metadata"])) {
      if (Array.isArray(v)) config.metadata[k] = v.filter((e): e is string => typeof e === "string");
    }
  }
  return config;
}

export const host: LsmpShared = lsmp;
export const clientHost: LsmpClient | null = isClient(host) ? host : null;
export const serverHost: LsmpServer | null = isServer(host) ? host : null;
export const side: "client" | "server" = clientHost !== null ? "client" : "server";
export const resource: string = host.getResourceName();
export const config: FxConfig = readConfig();

const warned = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  host.warn(`[fxcompat] ${message}`);
}

export function dropped(what: string): void {
  warnOnce(`drop:${what}`, `a ${what} inside a payload cannot be transported and was dropped`);
}

/** Published as globals: user scripts of the same context read the FiveM names. */
export function expose(name: string, value: unknown): void {
  Reflect.set(globalThis, name, value);
}

export function exposeUnlessDefined(name: string, value: unknown): void {
  if (!(name in globalThis)) Reflect.set(globalThis, name, value);
}

export function logError(context: string, error: unknown): void {
  const stack = typeof error === "object" && error !== null ? Reflect.get(error, "stack") : undefined;
  const text = typeof stack === "string" ? stack : String(error);
  host.error(`[fxcompat] ${context}: ${text}`);
}

/** First temporary id of a connecting player (playerConnecting); LS:MP ids are below it. */
export const TEMP_ID_FIRST = 65536;

/** FiveM accepts numbers and numeric strings; LS:MP accepts integers only. */
export function parseInteger(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

/**
 * FiveM-visible player id to LS:MP id. FiveM ids are LS:MP ids + 1: 0 is the console and never a player.
 * -1 (everyone) and temporary connecting ids pass through unchanged.
 */
export function toLsmp(value: unknown): number | null {
  const n = parseInteger(value);
  if (n === null) return null;
  if (n === -1 || n >= TEMP_ID_FIRST) return n;
  return n < 1 ? null : n - 1;
}

export function toFiveM(id: number): number {
  return id >= TEMP_ID_FIRST ? id : id + 1;
}

/** Accounts get their `license:` from LS:MP; a guest gets a stable one derived from the hardware id. */
export function guestLicense(hwid: string | null | undefined): string | null {
  if (hwid === null || hwid === undefined || hwid === "") return null;
  return `license:hwid-${(host.hash(hwid) >>> 0).toString(16)}`;
}

export function native(name: string): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => {
    const fn: unknown = Reflect.get(globalThis, name);
    if (typeof fn !== "function") throw new Error(`fxcompat: LS:MP has no native ${name}`);
    return Reflect.apply(fn, globalThis, args);
  };
}
