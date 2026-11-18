import { config, expose, exposeUnlessDefined, host, logError, resource, side, warnOnce } from "./runtime.ts";
import { invokingResource } from "./invoker.ts";
import { isRecord } from "./protocol.ts";

type Tick = () => unknown;
type Callback = (...args: unknown[]) => unknown;

const MAX_TICK_ERRORS = 8;

interface TickState {
  active: boolean;
}

/** `Citizen.*` of FiveM JS: other modules add their members before the global is published. */
export const citizen: Record<string, unknown> = {};

const ticks = new Map<number, TickState>();
let lastTick = 0;

async function runTick(state: TickState, fn: Tick): Promise<void> {
  let failures = 0;
  while (state.active) {
    try {
      await fn();
      failures = 0;
    } catch (error) {
      failures++;
      logError("tick", error);
      if (failures >= MAX_TICK_ERRORS) {
        state.active = false;
        logError("tick", new Error(`disabled after ${MAX_TICK_ERRORS} errors in a row`));
      }
    }
    if (state.active) await host.wait(0);
  }
}

/** A tick that returns a promise is awaited before the next frame, so `await Wait(n)` inside it paces the loop. */
export function setTick(fn: Tick): number {
  const id = ++lastTick;
  const state: TickState = { active: true };
  ticks.set(id, state);
  void runTick(state, fn);
  return id;
}

export function clearTick(id: number): void {
  const state = ticks.get(id);
  if (state === undefined) return;
  state.active = false;
  ticks.delete(id);
}

export function Wait(ms?: number): Promise<void> {
  return host.wait(ms ?? 0);
}

function setImmediateShim(fn: Callback, ...args: unknown[]): number {
  return Number(setTimeout(() => void fn(...args), 0));
}

function setTimeoutFiveM(ms: number, fn: Callback): number {
  return Number(setTimeout(fn, ms));
}

function metadataOf(name: string, key: string): string[] {
  return name === resource ? (config.metadata[key] ?? []) : [];
}

let serverConvars: Map<string, string> | undefined;

/** Server-only convars (`set`, `sets`) live in a data file the client package never lists. */
function loadServerConvars(): Map<string, string> {
  if (serverConvars !== undefined) return serverConvars;
  serverConvars = new Map();
  const text = host.readResourceFile("_fxcompat/server_convars.json");
  if (text === null) return serverConvars;
  try {
    const data: unknown = JSON.parse(text);
    if (isRecord(data)) {
      for (const [k, v] of Object.entries(data)) if (typeof v === "string") serverConvars.set(k, v);
    }
  } catch {
    warnOnce("server-convars", "_fxcompat/server_convars.json is not valid JSON");
  }
  return serverConvars;
}

function convar(name: string): string | undefined {
  if (side === "server") {
    const value = loadServerConvars().get(name);
    if (value !== undefined) return value;
  }
  return config.convars[name];
}

export function installCore(): void {
  expose("setTick", setTick);
  expose("clearTick", clearTick);
  expose("Wait", Wait);
  expose("Delay", Wait);
  exposeUnlessDefined("setImmediate", setImmediateShim);
  expose("GetHashKey", host.hash);
  expose("joaat", host.hash);
  expose("GetCurrentResourceName", () => resource);
  expose("GetParentResourceName", () => resource);
  expose("IsDuplicityVersion", () => side === "server");
  expose("GetInvokingResource", invokingResource);
  expose("GetResourceState", (name: string) => host.getResourceState(name) ?? "missing");
  expose("LoadResourceFile", (name: string, path: string) => (name === resource ? host.readResourceFile(path) : null));
  expose("GetConvar", (name: string, fallback?: string) => convar(name) ?? fallback ?? "");
  expose("GetConvarInt", (name: string, fallback?: number) => {
    const n = Number(convar(name));
    return convar(name) === undefined || Number.isNaN(n) ? (fallback ?? 0) : Math.trunc(n);
  });
  expose("GetConvarBool", (name: string, fallback?: boolean) => {
    const value = convar(name);
    return value === undefined ? (fallback ?? false) : value === "true" || value === "1";
  });
  expose("GetNumResourceMetadata", (name: string, key: string) => metadataOf(name, key).length);
  expose("GetResourceMetadata", (name: string, key: string, index?: number) => metadataOf(name, key)[index ?? 0] ?? null);
  expose("GetNumResources", () => 1);
  expose("GetResourceByFindIndex", (index: number) => (index === 0 ? resource : null));
  citizen["Wait"] = Wait;
  citizen["setTick"] = setTick;
  citizen["clearTick"] = clearTick;
  citizen["setImmediate"] = Reflect.get(globalThis, "setImmediate");
  citizen["setTimeout"] = setTimeoutFiveM;
  citizen["trace"] = (text: string) => host.log(text);
  expose("Citizen", citizen);
}
