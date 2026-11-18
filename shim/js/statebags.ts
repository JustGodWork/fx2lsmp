import { decode, encode } from "./protocol.ts";
import { clientHost, dropped, expose, host, logError, native, serverHost, side, toFiveM, toLsmp, parseInteger, warnOnce } from "./runtime.ts";

type Scope = "global" | "player" | "entity";
type BagHandler = (bagName: string, key: string, value: unknown, reserved: number, replicated: boolean) => unknown;

interface BagCore {
  scope: Scope;
  target: number | null;
  name: string;
}

interface HandlerEntry {
  cookie: number;
  key: string | null;
  bag: string | null;
  fn: BagHandler;
}

export interface StateBag {
  set(key: string, value: unknown, replicated?: boolean): void;
  [key: string]: unknown;
}

export interface BagOwner {
  state: StateBag;
}

const MAX_CACHED_ENTITIES = 512;
const LEAVE_GRACE_MS = 1000;

const localValues = new Map<string, Map<string, unknown>>();
const players = new Map<number, BagOwner>();
const entities = new Map<number, BagOwner>();
let handlers: (HandlerEntry | null)[] = [];
let nextCookie = 0;
let depth = 0;
let dirty = false;
let hooked = false;
let leaveHooked = false;

function bagName(scope: Scope, target: number | null): string {
  if (scope === "global") return "global";
  if (scope === "player") return `player:${target === null ? "null" : String(toFiveM(target))}`;
  return `${scope}:${String(target)}`;
}

function dispatch(bag: string, key: string, value: unknown, replicated: boolean): void {
  const count = handlers.length;
  depth++;
  for (let i = 0; i < count; i++) {
    const h = handlers[i];
    if (h === null || h === undefined) continue;
    if ((h.key !== null && h.key !== key) || (h.bag !== null && h.bag !== bag)) continue;
    try {
      const result = h.fn(bag, key, value, 0, replicated);
      if (result instanceof Promise) result.catch((error: unknown) => logError("state bag handler", error));
    } catch (error) {
      logError("state bag handler", error);
    }
  }
  depth--;
  if (depth === 0 && dirty) {
    dirty = false;
    handlers = handlers.filter((h) => h !== null);
  }
}

function hookMeta(): void {
  if (hooked) return;
  hooked = true;
  host.on("metaChange", (scope, target, key, value) => {
    if (scope !== "global" && scope !== "player" && scope !== "entity") return;
    if (typeof key !== "string") return;
    const id = typeof target === "number" ? target : null;
    dispatch(bagName(scope, id), key, absent(decode(value)), true);
  });
}

function hookLeave(): void {
  if (leaveHooked || side !== "server") return;
  leaveHooked = true;
  host.on("playerLeave", (id) => {
    setTimeout(() => localValues.delete(bagName("player", typeof id === "number" ? id : null)), LEAVE_GRACE_MS);
  });
}

function absent(value: unknown): unknown {
  return value === null ? undefined : value;
}

function readLocal(core: BagCore, key: string): unknown {
  const values = localValues.get(core.name);
  if (values === undefined) return undefined;
  if (core.scope === "entity" && serverHost !== null && core.target !== null && !serverHost.entityExists(core.target)) {
    localValues.delete(core.name);
    return undefined;
  }
  return values.get(key);
}

function readMeta(core: BagCore, key: string): unknown {
  if (core.scope === "global") return absent(decode(host.getGlobalMeta(key)));
  if (core.target === null) return undefined;
  if (core.scope === "player") return absent(decode(host.getPlayerMeta(core.target, key)));
  return absent(decode(host.getEntityMeta(core.target, key)));
}

function read(core: BagCore, key: string | symbol): unknown {
  if (typeof key !== "string") return undefined;
  return readLocal(core, key) ?? readMeta(core, key);
}

function setMeta(core: BagCore, key: string, value: unknown): boolean {
  if (core.scope === "global") return host.setGlobalMeta(key, value);
  if (core.target === null) return false;
  if (core.scope === "player") return host.setPlayerMeta(core.target, key, value);
  return host.setEntityMeta(core.target, key, value);
}

function writeLocal(core: BagCore, key: string, value: unknown): void {
  let values = localValues.get(core.name);
  if (values === undefined) {
    if (value === undefined || value === null) return;
    values = new Map();
    localValues.set(core.name, values);
  }
  const next = value === null ? undefined : value;
  if (values.get(key) === next) return;
  if (next === undefined) values.delete(key);
  else values.set(key, next);
  if (values.size === 0) localValues.delete(core.name);
  if (core.scope === "player") hookLeave();
  dispatch(core.name, key, next, false);
}

function refusal(): string {
  const reason = serverHost?.getLastError();
  return reason === null || reason === undefined ? "refused" : reason;
}

function writeReplicated(core: BagCore, key: string, value: unknown): void {
  const values = localValues.get(core.name);
  if (values?.delete(key) === true && values.size === 0) localValues.delete(core.name);
  let failure: string | null = null;
  try {
    if (!setMeta(core, key, encode(value, dropped))) failure = refusal();
  } catch (error) {
    failure = String(error);
  }
  if (failure === null) return;
  warnOnce(
    `statebag:${core.scope}:${key}`,
    `state bag write of "${key}" on ${core.scope} refused (${failure}): values are limited to 8 KiB, clients may only write their own player and the entities they own, and only the server writes global`,
  );
}

function write(core: BagCore, key: string | symbol, value: unknown, replicated?: boolean): void {
  if (typeof key !== "string" || key === "") {
    warnOnce("statebag:key", "state bag keys must be non empty strings");
    return;
  }
  if (replicated === false) return writeLocal(core, key, value);
  writeReplicated(core, key, value);
}

function newBag(scope: Scope, target: number | null): StateBag {
  const core: BagCore = { scope, target, name: bagName(scope, target) };
  const set = (key: string, value: unknown, replicated?: boolean): void => write(core, key, value, replicated);
  const bag: StateBag = { set };
  return new Proxy(bag, {
    get: (_, key) => (key === "set" ? set : read(core, key)),
    set: (_, key, value) => {
      write(core, key, value, true);
      return true;
    },
    deleteProperty: (_, key) => {
      write(core, key, undefined, true);
      return true;
    },
    has: (_, key) => key === "set" || read(core, key) !== undefined,
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
  });
}

export function playerOwner(id: unknown): BagOwner {
  const playerId = toLsmp(id);
  if (playerId === null) return { state: newBag("player", null) };
  let owner = players.get(playerId);
  if (owner === undefined) {
    owner = { state: newBag("player", playerId) };
    players.set(playerId, owner);
  }
  return owner;
}

function entityOwner(handle: unknown): BagOwner {
  const netId = side === "server" ? parseInteger(handle) : typeof handle === "number" ? (clientHost?.getNetIdFromEntity(handle) ?? null) : null;
  if (netId === null) return { state: newBag("entity", null) };
  let owner = entities.get(netId);
  if (owner === undefined) {
    if (entities.size >= MAX_CACHED_ENTITIES) entities.clear();
    owner = { state: newBag("entity", netId) };
    entities.set(netId, owner);
  }
  return owner;
}

function addHandler(keyFilter: unknown, bagFilter: unknown, fn: BagHandler): number {
  hookMeta();
  const cookie = ++nextCookie;
  handlers.push({
    cookie,
    key: typeof keyFilter === "string" && keyFilter !== "" ? keyFilter : null,
    bag: typeof bagFilter === "string" && bagFilter !== "" ? bagFilter : null,
    fn,
  });
  return cookie;
}

function removeHandler(cookie: number): void {
  const index = handlers.findIndex((h) => h?.cookie === cookie);
  if (index < 0) return;
  if (depth > 0) {
    handlers[index] = null;
    dirty = true;
  } else handlers.splice(index, 1);
}

function idFromName(name: string, prefix: "player" | "entity"): number | null {
  const match = new RegExp(`^${prefix}:(\\d+)$`).exec(name);
  return match === null ? null : Number(match[1]);
}

export function installStateBags(): void {
  expose("GlobalState", newBag("global", null));
  expose("Player", playerOwner);
  expose("Entity", entityOwner);
  if (clientHost !== null) {
    const client = clientHost;
    expose("LocalPlayer", {
      get state(): StateBag | undefined {
        const id = client.getLocalPlayer();
        return id === null ? undefined : playerOwner(toFiveM(id)).state;
      },
    });
  }
  expose("AddStateBagChangeHandler", addHandler);
  expose("RemoveStateBagChangeHandler", removeHandler);
  expose("GetPlayerFromStateBagName", (name: string) => {
    const id = idFromName(name, "player");
    if (id === null) return 0;
    if (side === "server") return id;
    const slot = Number(native("GetPlayerFromServerId")(id));
    return slot >= 0 ? slot : 0;
  });
  expose("GetEntityFromStateBagName", (name: string) => {
    const netId = idFromName(name, "entity");
    if (netId === null) return 0;
    return side === "server" ? netId : (clientHost?.getEntityFromNetId(netId) ?? 0);
  });
}
