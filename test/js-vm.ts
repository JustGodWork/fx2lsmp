import { createContext, runInContext, type Context } from "node:vm";
import { isRecord } from "../shim/js/protocol.ts";
import type { Bus, PlayerSpec, SimVm } from "./sim.ts";
import { WireError, fromWire, toWire, toWireValue } from "./wire.ts";

type Fn = (...args: unknown[]) => unknown;

interface BusMessage {
  to: string;
  from?: number;
  ret?: number;
  kind: string;
  id?: number;
  name?: string;
  wire?: string;
  browser?: number;
  url?: string;
  event?: string;
  args?: unknown[];
  value?: unknown;
  err?: string;
  scope?: string;
  target?: number;
  key?: string;
}

interface Timer {
  id: number;
  at: number;
  seq: number;
  fn: Fn;
  args: unknown[];
  every: number | null;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface CommandEntry {
  fn: Fn;
  permission: string | false | undefined;
}

export interface NativeCall {
  name: string;
  args: unknown[];
}

const ENGINE_NAMES: ReadonlySet<string> = new Set([
  "playerJoin", "playerLeave", "playerDeath", "playerSpawn", "resourceStart", "resourceStop", "metaChange",
  "serverStart", "serverStop", "playerPreConnection", "playerDimensionChange", "entityOwnerChange",
  "entityStreamIn", "entityStreamOut",
]);

const RECORDED_NATIVES: readonly string[] = [
  "addPedAmmoByType", "setEntityCoords", "setTextChatEnabled", "deleteEntity", "deleteVehicle", "deletePed", "deleteObject",
  "removeBlip", "setBlipDisplay", "setBlipAlpha", "setEntityHeading", "freezeEntityPosition", "setEntityVelocity",
  "setVehicleNumberPlateText", "setVehicleDoorsLocked", "setPedIntoVehicle", "giveWeaponToPed", "removeAllPedWeapons",
  "setPlayerModel", "setPedArmour", "setEntityHealth", "requestModel", "setModelAsNoLongerNeeded",
  "removeWeaponFromPed", "giveWeaponComponentToPed", "setPedAmmo",
];

const READ_NATIVES: readonly string[] = ["getEntityHeading", "getEntityHealth", "getVehicleNumberPlateText", "getEntityVelocity", "getPedArmour"];

interface MockEntity {
  type: string;
  model: number;
  dimension: number;
  opts: Record<string, unknown>;
}

function lsmpError(code: string, message: string): Error {
  return Object.assign(new Error(`lsmp: ${code}: ${message}`), { code });
}

function joaat(text: string): number {
  let h = 0;
  for (const byte of Buffer.from(text.toLowerCase(), "utf8")) {
    h = (h + byte) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  return (h + (h << 15)) >>> 0;
}

function checkName(fn: string, name: unknown): string {
  if (typeof name !== "string" || name.length < 1 || name.length > 128) throw new Error(`${fn}: event name must be 1..128 bytes`);
  if (name.startsWith("lsmp:")) throw new Error(`${fn}: the 'lsmp:' prefix is reserved`);
  return name;
}

function checkNet(fn: string, name: unknown): string {
  const checked = checkName(fn, name);
  if (ENGINE_NAMES.has(checked)) throw new Error(`${fn}: event name '${checked}' is reserved by LS:MP`);
  return checked;
}

export class JsBrowser {
  valid = true;
  focus = false;
  focusOpts: unknown = undefined;
  readonly handlers = new Map<string, Fn[]>();
  constructor(
    readonly id: number,
    readonly url: string,
    private readonly vm: JsVm,
  ) {}

  destroy(): boolean {
    this.valid = false;
    return true;
  }

  isValid(): boolean {
    return this.valid;
  }

  setVisible(): boolean {
    return true;
  }

  setFocus(focused: boolean, opts?: unknown): boolean {
    if (isRecord(opts) && focused && opts["cursor"] === false && opts["keepInput"] === true) {
      throw new Error("lsmp: cursor=false cannot combine with keepInput");
    }
    this.focus = focused;
    this.focusOpts = opts;
    return true;
  }

  emit(event: string, ...args: unknown[]): boolean {
    if (!this.valid) return false;
    checkName("browser:emit", event);
    toWire("browser:emit", args);
    this.vm.send({ to: "page", browser: this.id, kind: "pageEmit", event, args: JSON.parse(JSON.stringify(args)) });
    return true;
  }

  on(event: string, fn: Fn): () => boolean {
    const list = this.handlers.get(event) ?? [];
    if (!list.includes(fn)) list.push(fn);
    this.handlers.set(event, list);
    return () => true;
  }

  off(): boolean {
    return true;
  }

  call(nameOrOpts: string | { name: string }, ...args: unknown[]): Promise<unknown> {
    const name = typeof nameOrOpts === "string" ? nameOrOpts : nameOrOpts.name;
    checkName("browser:call", name);
    toWire("browser:call", args);
    return this.vm.pendingCall((id) =>
      this.vm.send({ to: "page", browser: this.id, kind: "pageCallIn", id, event: name, args: JSON.parse(JSON.stringify(args)) }),
    );
  }
}

export class JsVm implements SimVm {
  readonly language = "js";
  readonly context: Context;
  readonly natives: NativeCall[] = [];
  readonly kicks: { id: number; reason: string | undefined }[] = [];
  readonly files = new Map<string, string>();
  readonly httpRequests: unknown[] = [];
  readonly grants = new Map<number, Set<string>>();
  readonly browsers = new Map<number, JsBrowser>();
  readonly commandsRun: string[] = [];
  private now = 0;
  private seq = 0;
  private timers: Timer[] = [];
  private later: (() => void)[] = [];
  private tickHandlers: Fn[] = [];
  private readonly logLines: string[] = [];
  private readonly errorLines: string[] = [];
  private readonly listeners = new Map<string, Fn[]>();
  private readonly netListeners = new Map<string, Fn[]>();
  private readonly calls = new Map<string, Fn>();
  private readonly pending = new Map<number, Pending>();
  private readonly players = new Map<number, PlayerSpec>();
  private readonly store = new Map<string, unknown>();
  private readonly commands = new Map<string, CommandEntry[]>();
  private readonly pressed = new Set<number>();
  private readonly released = new Set<number>();
  private lastPending = 0;
  private lastBrowser = 0;
  private readonly peers: boolean;

  constructor(
    private readonly bus: Bus,
    readonly side: "server" | "client",
    readonly resource: string,
    readonly id: number | null,
    readonly key: number,
    peers: boolean,
  ) {
    this.peers = peers;
    this.context = createContext({
      lsmp: this.buildLsmp(),
      console: this.buildConsole(),
      setTimeout: (fn: Fn, ms?: number, ...args: unknown[]) => this.addTimer(fn, ms ?? 0, args, null),
      setInterval: (fn: Fn, ms?: number, ...args: unknown[]) => this.addTimer(fn, Math.max(ms ?? 1, 1), args, Math.max(ms ?? 1, 1)),
      clearTimeout: (timer: number) => this.clearTimer(timer),
      clearInterval: (timer: number) => this.clearTimer(timer),
    });
    if (side === "client") this.defineClientNatives();
  }

  get tickCount(): number {
    return this.now;
  }

  send(msg: BusMessage): void {
    this.bus.enqueue(this, JSON.stringify(msg));
  }

  private record(error: unknown): void {
    this.errorLines.push(error instanceof Error ? error.message : String(error));
  }

  private buildConsole(): Record<string, Fn> {
    const line = (...args: unknown[]): void => void this.logLines.push(args.map(String).join("\t"));
    return { log: line, info: line, debug: line, warn: line, error: (...args: unknown[]) => this.record(args.map(String).join(" ")) };
  }

  private invoke(fn: Fn, args: unknown[]): unknown {
    try {
      const result = fn(...args);
      if (result instanceof Promise) result.catch((error: unknown) => this.record(error));
      return result;
    } catch (error) {
      this.record(error);
      return undefined;
    }
  }

  private realm(value: unknown): unknown {
    if (value === undefined) return undefined;
    const parse: (text: string) => unknown = runInContext("JSON.parse", this.context);
    return parse(JSON.stringify(value));
  }

  private addTimer(fn: Fn, ms: number, args: unknown[], every: number | null): number {
    const id = ++this.seq;
    this.timers.push({ id, at: this.now + ms, seq: id, fn, args, every });
    return id;
  }

  private clearTimer(id: number): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  private addTo(map: Map<string, Fn[]>, name: string, fn: Fn): () => boolean {
    const list = map.get(name) ?? [];
    if (list.includes(fn)) return () => false;
    list.push(fn);
    map.set(name, list);
    return () => {
      const index = list.indexOf(fn);
      if (index < 0) return false;
      list.splice(index, 1);
      return true;
    };
  }

  private defer(fn: () => void): void {
    this.later.push(fn);
  }

  pendingCall(start: (id: number) => void): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.lastPending;
      this.pending.set(id, { resolve, reject });
      start(id);
    });
  }

  private settle(id: number, value: unknown, err?: string): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
    this.pending.delete(id);
    if (err !== undefined) p.reject(lsmpError(err, "call failed"));
    else p.resolve(this.realm(value));
  }

  private runHandler(handler: Fn, source: number | null, args: unknown[], reply: (wire?: string, err?: string) => void): void {
    let result: unknown;
    try {
      result = this.side === "server" ? handler(source, ...args) : handler(...args);
    } catch (error) {
      this.record(error);
      return reply(undefined, "error");
    }
    Promise.resolve(result).then(
      (value) => {
        try {
          reply(toWireValue("result", value));
        } catch (error) {
          this.record(error);
          reply(undefined, "error");
        }
      },
      (error: unknown) => {
        this.record(error);
        reply(undefined, "error");
      },
    );
  }

  private buildLsmp(): Record<string, unknown> {
    const lsmp: Record<string, unknown> = {
      getResourceName: () => this.resource,
      getResourceState: (name: string) => (name === this.resource ? "started" : null),
      readResourceFile: (path: string) => this.files.get(path) ?? null,
      hash: joaat,
      getTickCount: () => this.now,
      nowMs: () => this.now,
      log: (...args: unknown[]) => void this.logLines.push(args.map(String).join("\t")),
      warn: (...args: unknown[]) => void this.logLines.push(["WARN", ...args.map(String)].join("\t")),
      error: (...args: unknown[]) => this.record(args.map(String).join(" ")),
      on: (name: string, fn: Fn) => this.addTo(this.listeners, name, fn),
      emit: (name: string, ...args: unknown[]) => {
        checkNet("lsmp.emit", name);
        if (this.peers) this.send({ to: "peers", from: this.key, kind: "localEvent", name, wire: toWire("lsmp.emit", args) });
        for (const fn of [...(this.listeners.get(name) ?? [])]) this.invoke(fn, args);
      },
      onCall: (name: string, fn: Fn) => {
        checkNet("lsmp.onCall", name);
        if (this.calls.has(name)) throw new Error(`lsmp.onCall: '${name}' is already handled by resource '${this.resource}'`);
        this.calls.set(name, fn);
        return () => this.calls.delete(name);
      },
      call: (nameOrOpts: string | { name: string }, ...args: unknown[]) => {
        const name = checkNet("lsmp.call", typeof nameOrOpts === "string" ? nameOrOpts : nameOrOpts.name);
        const wire = toWire("lsmp.call", args);
        return this.pendingCall((id) =>
          this.defer(() => {
            const handler = this.calls.get(name);
            if (handler === undefined && this.peers) {
              return this.send({ to: "peers", ret: this.key, kind: "localCall", id, name, wire });
            }
            if (handler === undefined) return this.settle(id, null, "no-handler");
            const list = fromWire(wire);
            this.runHandler(handler, null, Array.isArray(list) ? this.realmList(list) : [], (reply, err) =>
              err === undefined ? this.settle(id, reply === undefined ? null : fromWire(reply)) : this.settle(id, null, err),
            );
          }),
        );
      },
      wait: (ms?: number) =>
        new Promise<void>((resolve) => {
          this.addTimer(() => resolve(), Math.max(ms ?? 0, 0), [], null);
        }),
      getPlayers: () => [...this.players.keys()].sort((a, b) => a - b),
      getGlobalMeta: (key: string) => this.metaGet("global", null, key),
      getPlayerMeta: (id: number, key: string) => this.metaGet("player", id, key),
      getEntityMeta: (netId: number, key: string) => this.metaGet("entity", netId, key),
      setGlobalMeta: (key: string, value: unknown) => this.metaSet("global", null, key, value),
      setPlayerMeta: (id: number, key: string, value: unknown) => this.metaSet("player", id, key, value),
      setEntityMeta: (netId: number, key: string, value: unknown) => this.metaSet("entity", netId, key, value),
      getPlayerPed: (id: number) => (this.players.has(id) ? (this.side === "server" ? 1000 : 500) + id : null),
      registerCommand: (name: string, a: unknown, b?: unknown) => {
        const fn = typeof a === "function" ? a : b;
        const opts = typeof a === "function" ? undefined : a;
        if (!/^[\w.:-]+$/.test(name) || name.length > 64) throw new Error("lsmp.registerCommand: invalid command name");
        if (typeof fn !== "function") throw new Error("lsmp.registerCommand: handler expected");
        const key = name.toLowerCase();
        const list = this.commands.get(key) ?? [];
        list.push({ fn: (...args: unknown[]) => Reflect.apply(fn, undefined, args), permission: isRecord(opts) ? permissionOf(opts) : undefined });
        this.commands.set(key, list);
        return () => true;
      },
      executeCommand: (source: number | null, line: string) => {
        this.defer(() => this.command(source, line));
        return "ok";
      },
      http: {
        request: (opts: unknown) => {
          this.httpRequests.push(opts);
          return Promise.resolve({ ok: true, status: 200, headers: {}, body: '{"ok":true}' });
        },
      },
    };
    if (this.side === "client") this.addClientApi(lsmp);
    else this.addServerApi(lsmp);
    return lsmp;
  }

  /** Every meta write attempted by this context, accepted or not. */
  readonly metaWrites: { scope: string; target: number | null; key: string }[] = [];
  private readonly metaStore = new Map<string, unknown>();

  private metaSlot(scope: string, target: number | null, key: string): string {
    if (key.length < 1 || key.length > 128) throw new Error("lsmp.meta: key must be 1..128 bytes");
    if (key.startsWith("lsmp:")) throw new Error("lsmp.meta: the 'lsmp:' prefix is reserved");
    return `${scope}|${String(target)}|${key}`;
  }

  private metaGet(scope: string, target: number | null, key: string): unknown {
    return this.realm(this.metaStore.get(this.metaSlot(scope, target, key)) ?? null) ?? null;
  }

  private metaApply(scope: string, target: number | null, key: string, wire: string, source: number | null): void {
    const list = fromWire(wire);
    const value: unknown = Array.isArray(list) ? (list[0] ?? null) : null;
    const slot = this.metaSlot(scope, target, key);
    const same = JSON.stringify(this.metaStore.get(slot) ?? null) === JSON.stringify(value);
    if (value === null) this.metaStore.delete(slot);
    else this.metaStore.set(slot, value);
    if (same) return;
    for (const fn of [...(this.listeners.get("metaChange") ?? [])]) this.invoke(fn, [scope, target, key, this.realm(value) ?? null, source]);
  }

  private metaSet(scope: string, target: number | null, key: string, value: unknown): boolean {
    this.metaSlot(scope, target, key);
    const wire = toWire("lsmp.setMeta", [value]);
    this.metaWrites.push({ scope, target, key });
    if (wire.length > 8192) return this.fail("too-large");
    const base = { kind: "metaWrite", scope, ...(target === null ? {} : { target }), key, wire };
    if (this.side === "client") {
      const allowed = (scope === "player" && target === this.id) || (scope === "entity" && target !== null && this.owners.get(target) === this.id);
      if (!allowed) return this.fail("permission");
      this.send({ to: "s", from: this.id ?? 0, ...base });
      return true;
    }
    if (scope === "player" && (target === null || !this.players.has(target))) return this.fail("not-found");
    this.metaApply(scope, target, key, wire, null);
    for (const id of this.players.keys()) this.send({ to: `c${id}`, ...base, kind: "meta" });
    if (this.peers) this.send({ to: "peers", ...base, kind: "metaPeer" });
    return true;
  }

  private fail(reason: string): false {
    this.lastError = reason;
    return false;
  }

  private realmList(list: unknown[]): unknown[] {
    const converted = this.realm(list);
    return Array.isArray(converted) ? converted : [];
  }

  private addClientApi(lsmp: Record<string, unknown>): void {
    Object.assign(lsmp, {
      emitServer: (name: string, ...args: unknown[]) => {
        checkNet("lsmp.emitServer", name);
        this.send({ to: "s", from: this.id ?? 0, kind: "event", name, wire: toWire("lsmp.emitServer", args) });
        return true;
      },
      onServer: (name: string, fn: Fn) => {
        checkNet("lsmp.onServer", name);
        return this.addTo(this.netListeners, name, fn);
      },
      callServer: (name: string, ...args: unknown[]) =>
        this.pendingCall((id) =>
          this.send({ to: "s", from: this.id ?? 0, ret: this.key, kind: "call", id, name: checkNet("lsmp.callServer", name), wire: toWire("lsmp.callServer", args) }),
        ),
      getLocalPlayer: () => this.id,
      getEntityOwner: (netId: number) => this.owners.get(netId) ?? null,
      getEntityFromNetId: (netId: number) => netId + 10000,
      getNetIdFromEntity: (handle: number) => (handle > 10000 ? handle - 10000 : null),
      onTick: (fn: Fn) => {
        this.tickHandlers.push(fn);
        return () => true;
      },
      createBrowser: (url: string) => {
        const browser = new JsBrowser(++this.lastBrowser, url, this);
        this.browsers.set(browser.id, browser);
        this.send({ to: "page", browser: browser.id, kind: "pageCreate", url });
        return browser;
      },
    });
  }

  private addServerApi(lsmp: Record<string, unknown>): void {
    const ids = (target: number | number[]): number[] => (Array.isArray(target) ? target : [target]);
    Object.assign(lsmp, {
      emitClient: (target: number | number[], name: string, ...args: unknown[]) => {
        checkNet("lsmp.emitClient", name);
        const wire = toWire("lsmp.emitClient", args);
        let sent = false;
        for (const id of ids(target)) {
          if (!this.players.has(id)) continue;
          this.send({ to: `c${id}`, kind: "event", name, wire });
          sent = true;
        }
        return sent;
      },
      emitAllClients: (name: string, ...args: unknown[]) => {
        checkNet("lsmp.emitAllClients", name);
        const wire = toWire("lsmp.emitAllClients", args);
        for (const id of this.players.keys()) this.send({ to: `c${id}`, kind: "event", name, wire });
        return this.players.size;
      },
      onClient: (name: string, fn: Fn) => {
        checkNet("lsmp.onClient", name);
        return this.addTo(this.netListeners, name, fn);
      },
      callClient: (target: number, name: string, ...args: unknown[]) =>
        this.pendingCall((id) =>
          this.send({ to: `c${target}`, ret: this.key, kind: "call", id, name: checkNet("lsmp.callClient", name), wire: toWire("lsmp.callClient", args) }),
        ),
      getPlayerName: (id: number) => this.players.get(id)?.name ?? null,
      getPlayerLsmpId: (id: number) => this.players.get(id)?.lsmpId ?? null,
      getPlayerIdentifier: (id: number, kind: string) => {
        const p = this.players.get(id);
        if (p === undefined) return null;
        if (kind === "ip") return p.ip;
        if (kind === "name") return p.name;
        if (kind === "hwid") return p.hwid ?? null;
        return kind === "lsmp" && p.lsmpId !== null ? String(p.lsmpId) : null;
      },
      kickPlayer: (id: number, reason?: string) => {
        this.kicks.push({ id, reason });
        return true;
      },
      getPlayerDimension: (id: number) => this.dimensions.get(id) ?? 0,
      setPlayerDimension: (id: number, dimension: number) => {
        this.dimensions.set(id, dimension);
        return true;
      },
      getEntityCoords: () => ({ x: 1, y: 2, z: 3 }),
      entityExists: (netId: number) => netId > 0 && !this.deleted.has(netId),
      deleteEntity: (netId: number) => {
        if (netId <= 0 || this.deleted.has(netId)) return false;
        this.deleted.add(netId);
        return true;
      },
      getLastError: () => this.lastError,
      createEntity: (type: string, model: number | string, position: unknown, opts?: Record<string, unknown>) => {
        if (!["vehicle", "ped", "object"].includes(type)) throw new Error(`lsmp.createEntity: unknown type '${type}'`);
        if (model === 0 || model === "") throw new Error("lsmp.createEntity: model must not be 0");
        if (!isRecord(position) || typeof position["x"] !== "number") throw new Error("lsmp.createEntity: position expected");
        const netId = ++this.lastNetId;
        const dimension = typeof opts?.["dimension"] === "number" ? opts["dimension"] : 0;
        this.entities.set(netId, { type, model: typeof model === "string" ? joaat(model) : model, dimension, opts: { ...opts } });
        this.owners.set(netId, typeof opts?.["owner"] === "number" ? opts["owner"] : null);
        return netId;
      },
      getEntityOwner: (netId: number) => this.owners.get(netId) ?? null,
      getEntityModel: (netId: number) => this.entities.get(netId)?.model ?? null,
      getEntityType: (netId: number) => this.entities.get(netId)?.type ?? null,
      getPedInVehicleSeat: (vehicle: number, seat: number) => (vehicle === 900 && seat === 0 ? 901 : null),
      getVehiclePedIsIn: (ped: number) => (ped === 901 ? 900 : null),
      getEntities: (opts?: { types?: string[] }) =>
        [...this.entities.entries()]
          .filter(([netId, e]) => !this.deleted.has(netId) && (opts?.types === undefined || opts.types.includes(e.type)))
          .map(([netId]) => netId),
      setEntityDimension: (netId: number, dimension: number) => {
        const entity = this.entities.get(netId);
        if (entity === undefined) return false;
        entity.dimension = dimension;
        return true;
      },
      getEntityDimension: (netId: number) => this.entities.get(netId)?.dimension ?? null,
      perms: { has: (id: number, perm: string) => this.grants.get(id)?.has(perm) === true },
      storage: {
        get: (key: string) => this.store.get(key) ?? null,
        set: (key: string, value: unknown) => {
          this.store.set(key, fromWire(toWireValue("storage.set: value", value)));
          return true;
        },
        delete: (key: string) => this.store.delete(key),
        keys: (prefix?: string) => [...this.store.keys()].filter((k) => k.startsWith(prefix ?? "")).sort(),
      },
    });
  }

  readonly dimensions = new Map<number, number>();
  readonly entities = new Map<number, MockEntity>();
  readonly owners = new Map<number, number | null>();
  readonly deleted = new Set<number>();
  /** Values the read natives of a client answer with, by native name. */
  readonly nativeResults = new Map<string, unknown>();
  private lastNetId = 100;
  private lastError: string | null = null;

  /** Changes the owner of an entity and fires `entityOwnerChange` on a server. */
  setOwner(netId: number, owner: number | null): void {
    const old = this.owners.get(netId) ?? null;
    this.owners.set(netId, owner);
    for (const fn of [...(this.listeners.get("entityOwnerChange") ?? [])]) {
      this.invoke(fn, [netId, old, owner, owner === null ? "release" : "adopt"]);
    }
  }

  private defineClientNatives(): void {
    const define = <A extends unknown[]>(name: string, fn: (...args: A) => unknown): void => void Reflect.set(this.context, name, fn);
    define("playerId", () => 0);
    define("playerPedId", () => 500 + (this.id ?? 0));
    define("getPlayerPed", (slot: number) => {
      const ids = [...this.players.keys()];
      const id = ids[slot];
      return id === undefined ? 0 : 500 + id;
    });
    define("getEntityCoords", () => ({ x: 100, y: 200, z: 30 }));
    define("getGameTimer", () => this.now);
    define("isControlJustPressed", (_pad: number, control: number) => this.pressed.has(control));
    define("isControlJustReleased", (_pad: number, control: number) => this.released.has(control));
    for (const name of RECORDED_NATIVES) define(name, (...args: unknown[]) => void this.natives.push({ name, args }));
    for (const name of READ_NATIVES) define(name, () => this.nativeResults.get(name) ?? 0);
    define("hasModelLoaded", () => true);
    define("doesBlipExist", () => true);
    let lastBlip = 100;
    for (const name of ["addBlipForCoord", "addBlipForEntity", "addBlipForArea", "addBlipForRadius", "addBlipForPickup"]) {
      define(name, () => ++lastBlip);
    }
  }

  press(control: number): void {
    this.pressed.add(control);
  }

  release(control: number): void {
    this.released.add(control);
  }

  /** Mirrors the command dispatch of the Lua mock. */
  command(source: number | null, line: string): string {
    const match = /^\s*\/?(\S+)\s*(.*)$/.exec(line);
    const list = this.commands.get((match?.[1] ?? "").toLowerCase());
    if (match === null || list === undefined) return "unknown";
    const rest = match[2] ?? "";
    const args = rest.split(/\s+/).filter((w) => w !== "");
    this.commandsRun.push(line);
    let result = "denied";
    for (const entry of list) {
      const permission = entry.permission;
      const allowed =
        this.side === "client" || source === null || permission === false ||
        this.grants.get(source)?.has(typeof permission === "string" ? permission : `command.${match[1]?.toLowerCase()}`) === true;
      if (!allowed) continue;
      result = "ok";
      this.invoke(entry.fn, this.side === "server" ? [args, rest, source, "test"] : [args, rest]);
    }
    return result;
  }

  grant(playerId: number, permission: string): void {
    const set = this.grants.get(playerId) ?? new Set<string>();
    set.add(permission);
    this.grants.set(playerId, set);
  }

  tick(ms: number): void {
    this.now += ms;
    const queue = this.later;
    this.later = [];
    for (const fn of queue) this.invoke(fn, []);
    const due = this.timers.filter((t) => t.at <= this.now).sort((a, b) => a.at - b.at || a.seq - b.seq);
    this.timers = this.timers.filter((t) => t.at > this.now);
    for (const t of due) {
      if (t.every !== null) this.timers.push({ ...t, at: this.now + t.every });
      this.invoke(t.fn, t.args);
    }
    for (const fn of this.tickHandlers) this.invoke(fn, [ms]);
    this.pressed.clear();
    this.released.clear();
  }

  hasCall(name: string): boolean {
    return this.calls.has(name);
  }

  deliver(text: string): void {
    const m: BusMessage = JSON.parse(text);
    const name = m.name ?? "";
    const args = (): unknown[] => {
      const list = fromWire(m.wire ?? "{}");
      return Array.isArray(list) ? this.realmList(list) : [];
    };
    switch (m.kind) {
      case "event":
        for (const fn of [...(this.netListeners.get(name) ?? [])]) {
          this.invoke(fn, this.side === "server" ? [m.from, ...args()] : args());
        }
        return;
      case "localEvent":
        for (const fn of [...(this.listeners.get(name) ?? [])]) this.invoke(fn, args());
        return;
      case "call":
      case "localCall": {
        const handler = this.calls.get(name);
        const back = m.ret === undefined ? (this.side === "client" ? "s" : `c${m.from}`) : `vm:${m.ret}`;
        if (handler === undefined) return this.send({ to: back, kind: "result", id: m.id, err: "no-handler" });
        const source = m.kind === "localCall" ? null : (m.from ?? null);
        return this.runHandler(handler, source, args(), (wire, err) =>
          this.send({ to: back, kind: "result", id: m.id, ...(wire === undefined ? {} : { wire }), ...(err === undefined ? {} : { err }) }),
        );
      }
      case "meta":
      case "metaPeer":
        return this.metaApply(m.scope ?? "", m.target ?? null, m.key ?? "", m.wire ?? "{N}", null);
      case "metaWrite":
        this.metaApply(m.scope ?? "", m.target ?? null, m.key ?? "", m.wire ?? "{N}", m.from ?? null);
        for (const id of this.players.keys()) this.send({ to: `c${id}`, kind: "meta", scope: m.scope ?? "", ...(m.target === undefined ? {} : { target: m.target }), key: m.key ?? "", wire: m.wire ?? "{N}" });
        return;
      case "result":
        if (m.err !== undefined) return this.settle(m.id ?? 0, null, m.err);
        return this.settle(m.id ?? 0, m.wire === undefined ? null : fromWire(m.wire));
      default:
        throw new WireError(`unknown message kind ${m.kind}`);
    }
  }

  addPlayer(spec: PlayerSpec): void {
    this.players.set(spec.id, spec);
  }

  removePlayer(id: number): void {
    this.players.delete(id);
  }

  setFile(path: string, content: string): void {
    this.files.set(path, content);
  }

  load(name: string, source: string): void {
    try {
      runInContext(source, this.context, { filename: name });
    } catch (error) {
      this.record(error);
    }
  }

  pageEmit(browser: number, event: string, args: unknown[]): void {
    for (const fn of this.browsers.get(browser)?.handlers.get(event) ?? []) this.invoke(fn, this.realmList(args));
  }

  pageCall(callId: number, browser: number, event: string, args: unknown[]): void {
    const handlers = this.browsers.get(browser)?.handlers.get(event) ?? [];
    const reply = (extra: Record<string, unknown>): void => this.send({ to: "page", kind: "pageResult", browser, id: callId, ...extra });
    if (handlers.length === 0) return reply({ err: "no-handler" });
    void (async () => {
      for (const fn of handlers) {
        try {
          const result: unknown = await fn(...this.realmList(args));
          if (result !== undefined && result !== null) {
            toWireValue("result", result);
            return reply({ value: JSON.parse(JSON.stringify(result)) });
          }
        } catch (error) {
          this.record(error);
          return reply({ err: "error" });
        }
      }
      reply({ value: null });
    })();
  }

  pageResult(id: number, json: string, err: string): void {
    if (err !== "") return this.settle(id, null, err);
    this.settle(id, JSON.parse(json));
  }

  /** Fires an engine event as the host would. */
  fire(name: string, ...args: unknown[]): void {
    for (const fn of [...(this.listeners.get(name) ?? [])]) this.invoke(fn, args);
  }

  /** Runs `code` as the body of an async function and resolves with its JSON-safe result. */
  async eval<T = unknown>(code: string): Promise<T> {
    const promise: Promise<unknown> = runInContext(`(async () => {\n${code}\n})()`, this.context);
    let outcome: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
    promise.then(
      (value) => void (outcome = { ok: true, value }),
      (error: unknown) => void (outcome = { ok: false, error }),
    );
    for (let i = 0; i < 400 && outcome === undefined; i++) await this.bus.advance(10);
    if (outcome === undefined) throw new Error(`${this.side} js eval did not finish: ${code}`);
    if (!outcome.ok) throw new Error(`${this.side} js eval failed: ${String(outcome.error)}`);
    const value: T = JSON.parse(JSON.stringify(outcome.value ?? null));
    return value;
  }

  logs(): string[] {
    return [...this.logLines];
  }

  errors(): string[] {
    return [...this.errorLines];
  }

  close(): void {
    this.timers = [];
  }
}

function permissionOf(opts: Record<string, unknown>): string | false | undefined {
  const permission = opts["permission"];
  return typeof permission === "string" || permission === false ? permission : undefined;
}
