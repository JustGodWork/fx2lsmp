import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LuaFactory, type LuaEngine } from "wasmoon";
import { concatShim, renderConfig, renderConfigJs, type JsConfig } from "../tools/fx2lsmp/cli.ts";
import { buildJsShim } from "../tools/fx2lsmp/jsShim.ts";
import { FakePage } from "./fake-page.ts";
import { JsVm } from "./js-vm.ts";
import type { PlayerSpec, SimVm } from "./sim.ts";

export type { PlayerSpec } from "./sim.ts";

const MOCK_SOURCE = readFileSync(resolve(import.meta.dirname, "lua/mock_lsmp.lua"), "utf8");
const SERVER_CONVARS = "_fxcompat/server_convars.json";
const SHIM_DIR = resolve(import.meta.dirname, "../shim");
export const TICK_MS = 10;

export interface BusMessage {
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

interface Queued {
  origin: SimVm;
  text: string;
  msg: BusMessage;
}

interface EvalResult<T> {
  ok: boolean;
  value: T;
  error?: string;
}

export class Vm implements SimVm {
  readonly language = "lua";

  private constructor(
    readonly world: World,
    readonly side: "server" | "client",
    readonly id: number | null,
    readonly key: number,
    readonly resource: string,
    private readonly lua: LuaEngine,
  ) {}

  static async create(
    world: World,
    side: "server" | "client",
    resource: string,
    id: number | null,
    key = 0,
    peers = false,
  ): Promise<Vm> {
    const factory = new LuaFactory();
    const lua = await factory.createEngine({ injectObjects: false });
    const vm = new Vm(world, side, id, key, resource, lua);
    lua.global.set("__SIDE", side);
    lua.global.set("__RESOURCE", resource);
    lua.global.set("__KEY", key);
    lua.global.set("__PEERS", peers);
    lua.global.set("__LOCAL_PLAYER", id ?? 0);
    lua.global.set("__send", (text: string): void => world.enqueue(vm, text));
    await lua.doString(MOCK_SOURCE);
    return vm;
  }

  tick(ms: number): void {
    const fn: (dt: number) => void = this.lua.global.get("__tick");
    fn(ms);
  }

  deliver(text: string): void {
    const fn: (text: string) => void = this.lua.global.get("__deliver");
    fn(text);
  }

  hasCall(name: string): boolean {
    const fn: (name: string) => boolean = this.lua.global.get("__hasCall");
    return fn(name);
  }

  setFile(path: string, content: string): void {
    this.lua.global.set("__FILE_PATH", path);
    this.lua.global.set("__FILE_CONTENT", content);
    this.lua.doStringSync("lsmp.__test.files[__FILE_PATH] = __FILE_CONTENT");
  }

  load(name: string, source: string): void {
    const fn: (name: string, source: string) => void = this.lua.global.get("__load");
    fn(name, source);
  }

  addPlayer(spec: PlayerSpec): void {
    const fn: (id: number, name: string, lsmpId: number | null, ip: string, hwid?: string) => void = this.lua.global.get("__addPlayer");
    fn(spec.id, spec.name, spec.lsmpId, spec.ip, spec.hwid);
  }

  pageResult(id: number, json: string, err: string): void {
    const fn: (id: number, json: string, err: string) => void = this.lua.global.get("__pageResult");
    fn(id, json, err);
  }

  runAutoSpawn(): void {
    const fn: () => void = this.lua.global.get("__runAutoSpawn");
    fn();
  }

  pageEmit(browser: number, event: string, args: unknown[]): void {
    const fn: (browser: number, event: string, json: string) => void = this.lua.global.get("__pageEmit");
    fn(browser, event, JSON.stringify(args));
  }

  pageCall(callId: number, browser: number, event: string, args: unknown[]): void {
    const fn: (callId: number, browser: number, event: string, json: string) => void = this.lua.global.get("__pageCall");
    fn(callId, browser, event, JSON.stringify(args));
  }

  fire(name: string, ...args: unknown[]): void {
    const fn: (name: string, json: string) => void = this.lua.global.get("__fire");
    fn(name, JSON.stringify(args));
  }

  press(control: number): void {
    const fn: (control: number) => void = this.lua.global.get("__press");
    fn(control);
  }

  release(control: number): void {
    const fn: (control: number) => void = this.lua.global.get("__release");
    fn(control);
  }

  storageDump(): string {
    const fn: () => string = this.lua.global.get("__storageDump");
    return fn();
  }

  storageLoad(wire: string): void {
    const fn: (wire: string) => void = this.lua.global.get("__storageLoad");
    fn(wire);
  }

  logs(): string[] {
    const fn: () => string = this.lua.global.get("__logs");
    const parsed: string[] = JSON.parse(fn());
    return parsed;
  }

  errors(): string[] {
    const fn: () => string = this.lua.global.get("__errors");
    const parsed: string[] = JSON.parse(fn());
    return parsed;
  }

  /** Runs Lua code in a host coroutine (like a script body) and returns its first result. */
  async eval<T = unknown>(code: string): Promise<T> {
    const start: (code: string) => number = this.lua.global.get("__eval");
    const result: (id: number) => string | null = this.lua.global.get("__evalResult");
    const id = start(code);
    for (let i = 0; i < 400; i++) {
      const text = result(id);
      if (text !== null && text !== undefined) {
        const parsed: EvalResult<T> = JSON.parse(text);
        if (!parsed.ok) throw new Error(`${this.side} eval failed: ${parsed.error ?? "unknown"}`);
        return parsed.value;
      }
      await this.world.advance(TICK_MS);
    }
    throw new Error(`${this.side} eval did not finish: ${code}`);
  }

  close(): void {
    this.lua.global.close();
  }
}

export interface WorldOptions {
  resource?: string;
  clients?: number;
  /** Folder served by the browsers (the converted resource root when the page is in a sub folder). */
  webuiDir?: string;
  /** localStorage of the pages, shared between worlds to simulate a restart. */
  storage?: Map<string, string>;
  /** Several resources live in the world: local events and calls cross between their environments. */
  peers?: boolean;
  /** `false` creates no Lua VMs for the main resource (a world of added resources only). */
  luaMain?: boolean;
}

export function nth<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
}

export interface JsResource {
  resource: string;
  server: JsVm;
  clients: JsVm[];
}

export interface LuaResource {
  resource: string;
  server: Vm;
  clients: Vm[];
}

export class World {
  server!: Vm;
  clients: Vm[] = [];
  readonly extras: SimVm[] = [];
  readonly players: PlayerSpec[] = [];
  private nextKey = 1;
  private jsBundle: Promise<string> | undefined;
  readonly pages = new Map<string, FakePage>();
  storage: Map<string, string> = new Map();
  readonly pageCalls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly queue: Queued[] = [];
  private nextPageCall = 0;
  private constructor(
    readonly resource: string,
    private readonly webuiDir: string | undefined,
    private readonly peers: boolean,
  ) {}

  static async create(opts: WorldOptions = {}): Promise<World> {
    const world = new World(opts.resource ?? "unit", opts.webuiDir, opts.peers === true);
    if (opts.storage !== undefined) world.storage = opts.storage;
    const count = opts.clients ?? 1;
    for (let i = 1; i <= count; i++) {
      world.players.push({ id: i - 1, name: `Player${i}`, lsmpId: 100 + i, ip: `10.0.0.${i}` });
    }
    if (opts.luaMain === false) return world;
    const main = await world.addLua(world.resource, true);
    world.server = main.server;
    world.clients = main.clients;
    return world;
  }

  /** Adds a Lua resource: a server VM and one client VM per player. */
  async addLua(resource: string, main = false): Promise<LuaResource> {
    const server = await Vm.create(this, "server", resource, null, this.nextKey++, this.peers);
    const clients: Vm[] = [];
    for (const p of this.players) {
      const vm = await Vm.create(this, "client", resource, p.id, this.nextKey++, this.peers);
      for (const other of this.players) vm.addPlayer(other);
      clients.push(vm);
      server.addPlayer(p);
    }
    if (!main) this.extras.push(server, ...clients);
    return { resource, server, clients };
  }

  /** Adds a JS resource: a server context and one client context per player. */
  addJs(resource: string): JsResource {
    const server = new JsVm(this, "server", resource, null, this.nextKey++, this.peers);
    const clients: JsVm[] = [];
    for (const p of this.players) {
      const vm = new JsVm(this, "client", resource, p.id, this.nextKey++, this.peers);
      for (const other of this.players) vm.addPlayer(other);
      clients.push(vm);
      server.addPlayer(p);
    }
    this.extras.push(server, ...clients);
    return { resource, server, clients };
  }

  /** Loads the JS shim bundle (built from shim/js like fx2lsmp does) into every context of a JS resource. */
  async loadJsShim(res: JsResource, config: Partial<JsConfig> = {}, only?: "server" | "client"): Promise<void> {
    this.jsBundle ??= buildJsShim(SHIM_DIR);
    const bundle = await this.jsBundle;
    const text = renderConfigJs({ convars: {}, metadata: {}, ...config });
    for (const vm of [res.server, ...res.clients].filter((v) => only === undefined || v.side === only)) {
      vm.load("config.js", text);
      vm.load("init.js", bundle);
    }
    await this.advance(TICK_MS);
  }

  /** Loads the Lua shim into the contexts of a Lua resource added with addLua, on one side only when asked. */
  async loadLuaShim(res: LuaResource, only?: "server" | "client", extraConfig = ""): Promise<void> {
    const config = `${renderConfig(undefined, {}, undefined)}
FXCOMPAT_CONFIG.expose = true
${extraConfig}
`;
    const shim = concatShim(SHIM_DIR);
    for (const vm of [res.server, ...res.clients].filter((v) => only === undefined || v.side === only)) {
      vm.load("config.lua", config);
      vm.load("init.lua", shim);
    }
    await this.advance(TICK_MS);
  }

  /** Boots the shim straight from shim/ with a config, then optional user scripts per side. */
  static async withShim(
    opts: WorldOptions & {
      uiPage?: string;
      kvpPage?: string;
      extraConfig?: string;
      convars?: Record<string, string>;
      server?: string;
      client?: string;
    } = {},
  ): Promise<World> {
    const world = await World.create(opts);
    const config = `${renderConfig(opts.uiPage, opts.convars ?? {}, opts.kvpPage)}
FXCOMPAT_CONFIG.expose = true
${opts.extraConfig ?? ""}
`;
    const shim = concatShim(SHIM_DIR);
    for (const vm of [world.server, ...world.clients]) {
      vm.load("config.lua", config);
      vm.load("init.lua", shim);
    }
    await world.advance(TICK_MS);
    const serverScript = opts.server;
    if (serverScript !== undefined) world.server.load("server.lua", serverScript);
    const clientScript = opts.client;
    if (clientScript !== undefined) for (const vm of world.clients) vm.load("client.lua", clientScript);
    await world.advance(TICK_MS * 2);
    return world;
  }

  /** Loads a converted resource (output of fx2lsmp) the way LS:MP does: shared scripts, then side scripts. */
  static async fromConverted(
    dir: string,
    clients = 1,
    resource?: string,
    storage?: Map<string, string>,
    peers = false,
  ): Promise<World> {
    const manifest: {
      title: string;
      shared_scripts: string[];
      client_scripts?: string[];
      server_scripts?: string[];
      webui?: string[];
    } = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const world = await World.create({
      resource: resource ?? manifest.title,
      clients,
      peers,
      webuiDir: manifest.webui?.[0] === undefined ? undefined : join(dir, manifest.webui[0]),
      ...(storage === undefined ? {} : { storage }),
    });
    const source = (path: string): string => readFileSync(join(dir, path), "utf8");
    if (existsSync(join(dir, SERVER_CONVARS))) world.server.setFile(SERVER_CONVARS, source(SERVER_CONVARS));
    for (const vm of [world.server, ...world.clients]) {
      const own = (vm.side === "server" ? manifest.server_scripts : manifest.client_scripts) ?? [];
      for (const path of [...manifest.shared_scripts, ...own]) vm.load(path, source(path));
    }
    await world.advance(TICK_MS * 3);
    return world;
  }

  /** Loads a converted resource the way LS:MP does, one environment per language: JS files first, then Lua. */
  static async fromConvertedMixed(dir: string, clients = 1): Promise<{ world: World; js?: JsResource; lua?: LuaResource }> {
    const manifest: {
      title: string;
      shared_scripts: string[];
      client_scripts?: string[];
      server_scripts?: string[];
      webui?: string[];
    } = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const all = [...manifest.shared_scripts, ...(manifest.client_scripts ?? []), ...(manifest.server_scripts ?? [])];
    const hasJs = all.some((p) => /\.(c|m)?js$/.test(p));
    const hasLua = all.some((p) => p.endsWith(".lua"));
    const world = await World.create({
      resource: manifest.title,
      clients,
      luaMain: false,
      peers: hasJs && hasLua,
      webuiDir: manifest.webui?.[0] === undefined ? undefined : join(dir, manifest.webui[0]),
    });
    const source = (path: string): string => readFileSync(join(dir, path), "utf8");
    const serverFile = existsSync(join(dir, SERVER_CONVARS));
    const scripts = (side: "server" | "client", pick: (path: string) => boolean): string[] =>
      [...manifest.shared_scripts, ...((side === "server" ? manifest.server_scripts : manifest.client_scripts) ?? [])].filter(pick);
    const result: { world: World; js?: JsResource; lua?: LuaResource } = { world };
    if (hasJs) {
      const js = world.addJs(manifest.title);
      if (serverFile) js.server.setFile(SERVER_CONVARS, source(SERVER_CONVARS));
      for (const vm of [js.server, ...js.clients]) {
        for (const path of scripts(vm.side, (p) => /\.(c|m)?js$/.test(p))) vm.load(path, source(path));
      }
      result.js = js;
    }
    if (hasLua) {
      const lua = await world.addLua(manifest.title);
      if (serverFile) lua.server.setFile(SERVER_CONVARS, source(SERVER_CONVARS));
      for (const vm of [lua.server, ...lua.clients]) {
        for (const path of scripts(vm.side, (p) => p.endsWith(".lua"))) vm.load(path, source(path));
      }
      result.lua = lua;
    }
    await world.advance(TICK_MS * 3);
    return result;
  }

  vms(): SimVm[] {
    return [...(this.server === undefined ? [] : [this.server]), ...this.clients, ...this.extras];
  }

  enqueue(origin: SimVm, text: string): void {
    const msg: BusMessage = JSON.parse(text);
    this.queue.push({ origin, text, msg });
  }

  /** A network event reaches every resource of the target; a call goes to the one that handles the name. */
  private routeNet(group: SimVm[], msg: BusMessage, text: string): void {
    if (group.length === 0) throw new Error(`no target for ${msg.to}`);
    if (msg.kind === "call") {
      const handler = group.find((vm) => vm.hasCall(msg.name ?? "")) ?? group[0];
      return handler?.deliver(text);
    }
    for (const vm of group) vm.deliver(text);
  }

  private routePeers(origin: SimVm, msg: BusMessage, text: string): void {
    const peers = this.vms().filter((vm) => vm.side === origin.side && vm.id === origin.id && vm.key !== origin.key);
    if (msg.kind === "localEvent" || msg.kind === "metaPeer") {
      for (const vm of peers) vm.deliver(text);
      return;
    }
    const handler = peers.find((vm) => vm.hasCall(msg.name ?? ""));
    if (handler !== undefined) return handler.deliver(text);
    origin.deliver(JSON.stringify({ to: `vm:${origin.key}`, kind: "result", id: msg.id, err: "no-handler" }));
  }

  private route(item: Queued): void {
    const { origin, msg, text } = item;
    const all = this.vms();
    if (msg.to === "s") return this.routeNet(all.filter((vm) => vm.side === "server"), msg, text);
    if (msg.to.startsWith("c")) {
      const id = Number(msg.to.slice(1));
      return this.routeNet(all.filter((vm) => vm.side === "client" && vm.id === id), msg, text);
    }
    if (msg.to.startsWith("vm:")) {
      const target = all.find((vm) => vm.key === Number(msg.to.slice(3)));
      if (target === undefined) throw new Error(`no vm ${msg.to}`);
      return target.deliver(text);
    }
    if (msg.to === "peers") return this.routePeers(origin, msg, text);
    if (msg.to === "page") return this.routePage(origin, msg);
    throw new Error(`unroutable message ${text}`);
  }

  private routePage(origin: SimVm, msg: BusMessage): void {
    const key = `${origin.id}:${msg.browser}`;
    if (msg.kind === "pageCreate") {
      if (this.webuiDir === undefined) return;
      const url = msg.url ?? "";
      const file = url.replace(/^rsc:\/\/[^/]+\//, "");
      const browser = msg.browser ?? 0;
      const page = new FakePage(
        this.resource,
        {
          emit: (event, args) => origin.pageEmit(browser, event, args),
          call: (event, args) =>
            new Promise((resolvePromise, rejectPromise) => {
              const id = ++this.nextPageCall;
              this.pageCalls.set(id, {
                resolve: resolvePromise,
                reject: (error) => rejectPromise(error),
              });
              origin.pageCall(id, browser, event, args);
            }),
        },
        this.webuiDir,
        file,
        this.storage,
      );
      this.pages.set(key, page);
      return;
    }
    const page = this.pages.get(key);
    if (msg.kind === "pageCallIn") {
      const id = msg.id ?? 0;
      if (page === undefined) return origin.pageResult(id, "", "unavailable");
      page.invoke(msg.event ?? "", msg.args ?? []).then(
        (value) => origin.pageResult(id, JSON.stringify(value ?? null), ""),
        (error: { code?: string }) => origin.pageResult(id, "null", error.code ?? "error"),
      );
      return;
    }
    if (msg.kind === "pageEmit") {
      page?.receive(msg.event ?? "", msg.args ?? []);
    } else if (msg.kind === "pageResult") {
      const pending = this.pageCalls.get(msg.id ?? -1);
      this.pageCalls.delete(msg.id ?? -1);
      if (msg.err !== undefined) {
        const error = Object.assign(new Error(`lsmp.call: ${msg.err}`), { code: msg.err });
        pending?.reject(error);
      } else {
        pending?.resolve(msg.value);
      }
    }
  }

  flush(): void {
    for (let guard = 0; this.queue.length > 0; guard++) {
      if (guard > 10000) throw new Error("message loop did not settle");
      const item = this.queue.shift();
      if (item !== undefined) this.route(item);
    }
  }

  async advance(ms: number): Promise<void> {
    for (let t = 0; t < ms; t += TICK_MS) {
      for (const vm of this.vms()) vm.tick(TICK_MS);
      this.flush();
      // let promise callbacks of the fake pages run between ticks
      await Promise.resolve();
      await Promise.resolve();
      this.flush();
      // JS contexts continue async functions after messages: drain until nothing new is sent
      if (this.extras.some((vm) => vm.language === "js")) {
        for (let i = 0; i < 3; i++) {
          await new Promise<void>((done) => setImmediate(done));
          this.flush();
        }
      }
    }
  }

  pageFor(vm: SimVm, browser = 1): FakePage {
    const page = this.pages.get(`${vm.id}:${browser}`);
    if (page === undefined) throw new Error("no page was created");
    return page;
  }

  page(client = 0): FakePage {
    const id = this.clients[client]?.id;
    const page = this.pages.get(`${id}:1`);
    if (page === undefined) throw new Error("no page was created");
    return page;
  }

  /** Every error recorded by a handler or thread in any VM. */
  allErrors(): string[] {
    return this.vms().flatMap((vm) => vm.errors().map((e) => `${vm.side}: ${e}`));
  }

  close(): void {
    for (const vm of this.vms()) vm.close();
  }
}
