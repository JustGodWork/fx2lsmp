import { NUI_CALLBACK_PREFIX, SERVER_SOURCE, decodeArgs, encodeArgs, invokerMarker, isRecord, isThenable, splitInvoker } from "./protocol.ts";
import { runAs } from "./invoker.ts";
import { clientHost, config, dropped, expose, host, logError, resource, serverHost, side, toFiveM, toLsmp, warnOnce } from "./runtime.ts";

type Handler = (...args: unknown[]) => unknown;

interface EventHandle {
  fn: Handler;
  event: string;
}

interface Adapted {
  source: number | null;
  args: unknown[];
}

interface EngineRoute {
  event: string;
  adapt(args: unknown[]): Adapted;
  accept?(args: unknown[]): boolean;
}

const marker = invokerMarker(resource);
const registry = new Map<string, EventHandle[]>();
const localSubscribed = new Set<string>();
const netSubscribed = new Set<string>();

function passthrough(args: unknown[]): Adapted {
  return { source: null, args };
}

function spawnData(position: unknown, heading: unknown, model: unknown): Record<string, unknown> {
  const p = isRecord(position) ? position : {};
  return { x: p["x"], y: p["y"], z: p["z"], heading, model };
}

function fiveMOrNull(playerId: unknown): number | null {
  return typeof playerId === "number" ? toFiveM(playerId) : null;
}

function connectingArgs(args: unknown[]): Adapted {
  const p = args[0];
  const deny = isRecord(p) && typeof p["deny"] === "function" ? p["deny"] : null;
  const refuse = (reason: unknown): void => {
    if (deny !== null) Reflect.apply(deny, p, [String(reason)]);
  };
  const deferrals = {
    defer: () => {},
    update: () => {},
    presentCard: () => {},
    done: (reason?: unknown) => {
      if (reason !== undefined && reason !== null) refuse(reason);
    },
  };
  return { source: null, args: [isRecord(p) ? p["name"] : undefined, refuse, deferrals] };
}

const ENGINE = new Map<string, EngineRoute>([
  ["onResourceStart", { event: "resourceStart", adapt: passthrough }],
  ["onClientResourceStart", { event: "resourceStart", adapt: passthrough }],
  ["onServerResourceStart", { event: "resourceStart", adapt: passthrough }],
  ["onResourceStop", { event: "resourceStop", adapt: passthrough }],
  ["onClientResourceStop", { event: "resourceStop", adapt: passthrough }],
]);

if (side === "server") {
  ENGINE.set("playerDropped", {
    event: "playerLeave",
    adapt: ([playerId, , reason, detail]) => {
      const text = detail === undefined || detail === null || detail === "" ? String(reason) : `${String(reason)}: ${String(detail)}`;
      return { source: fiveMOrNull(playerId), args: [text] };
    },
  });
  ENGINE.set("playerSpawned", {
    event: "playerSpawn",
    adapt: ([playerId, position, heading, model]) => ({
      source: fiveMOrNull(playerId),
      args: [spawnData(position, heading, model)],
    }),
  });
  ENGINE.set("playerJoining", {
    event: "playerJoin",
    adapt: ([playerId]) => ({ source: fiveMOrNull(playerId), args: [String(fiveMOrNull(playerId))] }),
  });
  ENGINE.set("playerConnecting", { event: "playerPreConnection", adapt: connectingArgs });
} else {
  ENGINE.set("playerSpawned", {
    event: "playerSpawn",
    accept: ([playerId]) => playerId === clientHost?.getLocalPlayer(),
    adapt: ([, position, heading, model]) => ({ source: null, args: [spawnData(position, heading, model)] }),
  });
}

function runHandler(handle: EventHandle, invoker: string | null, args: unknown[]): void {
  try {
    const result = runAs(invoker, () => handle.fn(...args));
    if (isThenable(result)) Promise.resolve(result).catch((error: unknown) => logError(`handler of '${handle.event}'`, error));
  } catch (error) {
    logError(`handler of '${handle.event}'`, error);
  }
}

function dispatch(name: string, invoker: string | null, src: number | null, args: unknown[]): void {
  const list = registry.get(name);
  if (list === undefined || list.length === 0) return;
  for (const handle of [...list]) {
    if (src !== null) expose("source", src);
    runHandler(handle, invoker, args);
  }
}

/** Page callbacks (`__cfx_nui:<name>`) are dispatched by the NUI module only. */
function subscribeLocal(name: string): void {
  if (localSubscribed.has(name) || name.startsWith(NUI_CALLBACK_PREFIX)) return;
  localSubscribed.add(name);
  const route = ENGINE.get(name);
  if (route === undefined) {
    host.on(name, (...wire) => {
      const { invoker, args } = splitInvoker(wire);
      dispatch(name, invoker, null, decodeArgs(args));
    });
    return;
  }
  host.on(route.event, (...args) => {
    if (route.accept !== undefined && !route.accept(args)) return;
    const adapted = route.adapt(args);
    dispatch(name, null, adapted.source, adapted.args);
  });
}

function subscribeNet(name: string): void {
  if (netSubscribed.has(name)) return;
  netSubscribed.add(name);
  if (serverHost !== null) {
    serverHost.onClient(name, (src, ...args) => dispatch(name, null, toFiveM(src), decodeArgs(args)));
  } else if (clientHost !== null) {
    clientHost.onServer(name, (...args) => dispatch(name, null, SERVER_SOURCE, decodeArgs(args)));
  }
}

export function dispatchLocal(name: string, src: number | null, args: unknown[]): void {
  dispatch(name, null, src, args);
}

export function hasHandlers(name: string): boolean {
  return (registry.get(name)?.length ?? 0) > 0;
}

export function AddEventHandler(name: string, fn: Handler): EventHandle {
  const handle: EventHandle = { fn, event: name };
  const list = registry.get(name);
  if (list === undefined) registry.set(name, [handle]);
  else list.push(handle);
  subscribeLocal(name);
  return handle;
}

export function RemoveEventHandler(handle: EventHandle): void {
  const list = registry.get(handle.event);
  const index = list?.indexOf(handle) ?? -1;
  if (index >= 0) list?.splice(index, 1);
}

function removeEventListener(name: string, fn: Handler): void {
  const list = registry.get(name);
  const index = list?.findIndex((h) => h.fn === fn) ?? -1;
  if (index >= 0) list?.splice(index, 1);
}

export function RegisterNetEvent(name: string, fn?: Handler): EventHandle | undefined {
  subscribeNet(name);
  return fn === undefined ? undefined : AddEventHandler(name, fn);
}

export function TriggerEvent(name: string, ...args: unknown[]): void {
  if (ENGINE.has(name)) return dispatch(name, resource, null, args);
  host.emit(name, marker, ...encodeArgs(args, dropped));
}

interface ChatLine {
  name: string;
  text: string;
  system: boolean;
}

function plainChat(text: unknown): string {
  return String(text).replace(/\^\d/g, "");
}

/** FiveM chat events as the line shape of the LS:MP bundled chat (`chat:message`). */
function chatLine(event: string, args: unknown[]): ChatLine | null {
  if (event === "chatMessage") {
    const [author, , text] = args;
    if (text === undefined || text === null) return null;
    const name = author === undefined || author === null ? "" : plainChat(author);
    return { name, text: plainChat(text), system: name === "" };
  }
  const message = args[0];
  if (typeof message === "string") return { name: "", text: plainChat(message), system: true };
  if (!isRecord(message) || !Array.isArray(message["args"]) || message["args"].length === 0) return null;
  const lines: unknown[] = message["args"];
  const name = lines.length > 1 ? plainChat(lines[0]) : "";
  return { name, text: plainChat(lines[lines.length - 1]), system: name === "" };
}

export function TriggerClientEvent(name: string, target: unknown, ...args: unknown[]): void {
  if (serverHost === null) throw new Error("TriggerClientEvent is a server function");
  const id = toLsmp(target);
  if (id === null) throw new Error(`TriggerClientEvent: invalid target '${String(target)}'`);
  const line = (name === "chatMessage" || name === "chat:addMessage") && config.chatBridge !== false ? chatLine(name, args) : null;
  const wire = encodeArgs(args, dropped);
  if (id === -1) {
    if (line !== null) serverHost.emitAllClients("chat:message", line);
    serverHost.emitAllClients(name, ...wire);
    return;
  }
  if (line !== null) serverHost.emitClient(id, "chat:message", line);
  serverHost.emitClient(id, name, ...wire);
}

export function TriggerServerEvent(name: string, ...args: unknown[]): void {
  if (clientHost === null) throw new Error("TriggerServerEvent is a client function");
  clientHost.emitServer(name, ...encodeArgs(args, dropped));
}

export function installEvents(): void {
  expose("AddEventHandler", AddEventHandler);
  expose("RemoveEventHandler", RemoveEventHandler);
  expose("removeEventListener", removeEventListener);
  expose("RegisterNetEvent", RegisterNetEvent);
  expose("RegisterServerEvent", RegisterNetEvent);
  expose("TriggerEvent", TriggerEvent);
  expose("on", AddEventHandler);
  expose("addEventListener", AddEventHandler);
  expose("emit", TriggerEvent);
  expose("onNet", (name: string, fn: Handler) => RegisterNetEvent(name, fn));
  expose("addNetEventHandler", (name: string, fn: Handler) => RegisterNetEvent(name, fn));
  expose("CancelEvent", () => warnOnce("cancel", "CancelEvent has no LS:MP equivalent and does nothing"));
  expose("WasEventCanceled", () => false);
  if (side === "server") {
    expose("TriggerClientEvent", TriggerClientEvent);
    expose("TriggerLatentClientEvent", (name: string, target: unknown, _bps: number, ...args: unknown[]) =>
      TriggerClientEvent(name, target, ...args));
    expose("emitNet", TriggerClientEvent);
    expose("emitNetLatent", (name: string, target: unknown, _bps: number, ...args: unknown[]) =>
      TriggerClientEvent(name, target, ...args));
  } else {
    expose("TriggerServerEvent", TriggerServerEvent);
    expose("TriggerLatentServerEvent", (name: string, _bps: number, ...args: unknown[]) =>
      TriggerServerEvent(name, ...args));
    expose("emitNet", TriggerServerEvent);
    expose("emitNetLatent", (name: string, _bps: number, ...args: unknown[]) => TriggerServerEvent(name, ...args));
  }
}
