import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRecord } from "../shim/js/protocol.ts";
import { World, nth, type JsResource } from "./harness.ts";
import type { JsVm } from "./js-vm.ts";
import { makeWebui } from "./webui.ts";

const NAME = "jsunit";
function readRecord(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(resolve(import.meta.dirname, "../shim/js", name), "utf8"));
  if (!isRecord(parsed)) throw new Error(`${name} is not an object`);
  return parsed;
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(value)) for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}

const names: unknown = readRecord("natives_data.json")["names"];
const DATA = {
  alias: { ...stringMap(readRecord("natives_data.json")["alias"]), ...stringMap(readRecord("natives_hashes.json")) },
  names: Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [],
};

let world: World;
let res: JsResource;
let server: JsVm;
let first: JsVm;
let second: JsVm;
const storage = new Map<string, string>();

beforeAll(async () => {
  world = await World.create({ luaMain: false, clients: 2, resource: NAME, webuiDir: makeWebui(""), storage });
  res = world.addJs(NAME);
  await world.loadJsShim(res, {
    uiPage: "index.html",
    kvpPage: "_fxcompat/kvp.html",
    convars: { sv_name: "Test", max: "32", flag: "true" },
    metadata: { author: ["me"] },
  });
  server = res.server;
  first = nth(res.clients, 0);
  second = nth(res.clients, 1);
  await world.advance(100);
});
afterAll(() => world.close());

const filtered = (errors: string[]): string[] =>
  errors.filter((e) => !e.includes("kaboom") && !e.includes("expected-failure") && !e.includes("disabled after"));

const nuiBrowser = (vm: JsVm): number => [...vm.browsers.values()].find((b) => b.url.endsWith("index.html"))?.id ?? 0;

describe("events", () => {
  it("a client net event reaches the server with the sender as source", async () => {
    await server.eval("onNet('t:up', (n, o) => { globalThis.seen = [source, n, o]; })");
    await first.eval("TriggerServerEvent('t:up', 1, { a: [1, 2] })");
    await second.eval("emitNet('t:up', 2, { b: null })");
    await world.advance(30);
    expect(await server.eval("return globalThis.seen")).toEqual([2, 2, { b: null }]);
    await first.eval("TriggerLatentServerEvent('t:up', 100, 'latent')");
    await world.advance(30);
    expect(await server.eval("return globalThis.seen")).toEqual([1, "latent", null]);
  });

  it("a server net event reaches the target clients with the server source", async () => {
    for (const vm of [first, second]) await vm.eval("onNet('t:down', (x) => { globalThis.got = [source, x]; })");
    await server.eval("TriggerClientEvent('t:down', -1, 'all')");
    await world.advance(30);
    expect(await first.eval("return globalThis.got")).toEqual([65535, "all"]);
    expect(await second.eval("return globalThis.got")).toEqual([65535, "all"]);
    await server.eval("TriggerClientEvent('t:down', '2', 'only second')");
    await server.eval("emitNet('t:down', 1, 'first via emitNet')");
    await server.eval("TriggerLatentClientEvent('t:down', 2, 500, 'latent')");
    await world.advance(30);
    expect(await first.eval("return globalThis.got")).toEqual([65535, "first via emitNet"]);
    expect(await second.eval("return globalThis.got")).toEqual([65535, "latent"]);
    expect(await server.eval("try { TriggerClientEvent('t:down', 'abc') } catch (e) { return e.message }")).toContain("invalid target");
  });

  it("local events run every handler, in order, and can be removed", async () => {
    const result = await server.eval(`
      const log = [];
      const a = () => log.push('a');
      const handle = AddEventHandler('t:local', (x) => log.push('b' + x));
      on('t:local', a);
      onNet('t:local', () => log.push('net'));
      emit('t:local', 1);
      TriggerEvent('t:local', 2);
      RemoveEventHandler(handle);
      removeEventListener('t:local', a);
      emit('t:local', 3);
      return log;
    `);
    expect(result).toEqual(["b1", "a", "net", "b2", "a", "net", "net"]);
  });

  it("an async handler of a local event keeps the source of its net event, a failing handler does not stop the others", async () => {
    await server.eval("on('t:fail', () => { throw new Error('kaboom'); }); on('t:fail', () => { globalThis.after = true; })");
    await server.eval("emit('t:fail')");
    expect(await server.eval("return globalThis.after")).toBe(true);
    expect(server.errors().some((e) => e.includes("kaboom"))).toBe(true);
  });

  it("decodes integer keyed maps and vectors sent by the Lua shim, as one wire format", async () => {
    await first.eval("onNet('t:marker', (items, v, list) => { globalThis.marker = [items, v, list]; })");
    const wire =
      '{{["__fx"]="m",["k"]={101,205},["v"]={"trowel","bucket"}},{["__fx"]="v2",["x"]=1.5,["y"]=2.5},{N,1,{["__fx"]="m",["k"]={true,"a"},["v"]={1,2}}}}';
    first.deliver(JSON.stringify({ to: "c1", kind: "event", name: "t:marker", wire }));
    await world.advance(20);
    expect(await first.eval("return globalThis.marker")).toEqual([
      { "101": "trowel", "205": "bucket" },
      { x: 1.5, y: 2.5 },
      [null, 1, { true: 1, a: 2 }],
    ]);
  });

  it("sends a Map with integer keys as the marker form", async () => {
    await server.eval("globalThis.wireSeen = null");
    await first.eval("onNet('t:map', (m) => { globalThis.map = m; })");
    await server.eval("TriggerClientEvent('t:map', 1, new Map([[5, 'five'], [7, 'seven']]), { f() {}, ok: 1 })");
    await world.advance(30);
    expect(await first.eval("return globalThis.map")).toEqual({ "5": "five", "7": "seven" });
    expect(server.logs().some((l) => l.includes("cannot be transported"))).toBe(true);
  });

  it("routes the FiveM lifecycle names to engine events", async () => {
    await server.eval(`
      globalThis.life = [];
      on('onResourceStart', (r) => life.push(['start', r]));
      on('onServerResourceStart', (r) => life.push(['sstart', r]));
      on('onResourceStop', (r) => life.push(['stop', r]));
      on('playerJoining', (old) => life.push(['joining', source, old]));
      on('playerDropped', (reason) => life.push(['dropped', source, reason]));
      on('playerSpawned', (data) => life.push(['spawned', source, data]));
      on('playerConnecting', (name, setKickReason, deferrals) => {
        life.push(['connecting', name]);
        deferrals.defer();
        deferrals.update('x');
        setKickReason('bad name');
      });
    `);
    server.fire("resourceStart", NAME);
    server.fire("resourceStop", NAME);
    server.fire("playerJoin", 7);
    server.fire("playerLeave", 7, "Bob", "Timed out", "net");
    server.fire("playerSpawn", 7, { x: 1, y: 2, z: 3 }, 90, 123);
    let denied = "";
    server.fire("playerPreConnection", { name: "Bob", deny: (reason: string) => (denied = reason) });
    await world.advance(20);
    expect(denied).toBe("bad name");
    expect(await server.eval("return globalThis.life")).toEqual([
      ["start", NAME],
      ["sstart", NAME],
      ["stop", NAME],
      ["joining", 8, "8"],
      ["dropped", 8, "Timed out: net"],
      ["spawned", 8, { x: 1, y: 2, z: 3, heading: 90, model: 123 }],
      ["connecting", "Bob"],
    ]);
    await first.eval("on('playerSpawned', (d) => { globalThis.spawned = d; }); on('onClientResourceStart', (r) => { globalThis.cstart = r; })");
    first.fire("playerSpawn", 1, { x: 0, y: 0, z: 0 }, 0, 1);
    first.fire("playerSpawn", 0, { x: 5, y: 6, z: 7 }, 10, 2);
    first.fire("resourceStart", NAME);
    expect(await first.eval("return [globalThis.spawned, globalThis.cstart]")).toEqual([{ x: 5, y: 6, z: 7, heading: 10, model: 2 }, NAME]);
  });

  it("bridges FiveM chat events to the bundled chat line", async () => {
    await first.eval("globalThis.chat = []; lsmp.onServer('chat:message', (line) => chat.push(line))");
    await server.eval("TriggerClientEvent('chat:addMessage', 1, { args: ['^1Ann', 'hi there'] }); TriggerClientEvent('chatMessage', 1, '', [0, 0, 0], 'welcome')");
    await world.advance(30);
    expect(await first.eval("return globalThis.chat")).toEqual([
      { name: "Ann", text: "hi there", system: false },
      { name: "", text: "welcome", system: true },
    ]);
  });
});

describe("exports", () => {
  beforeAll(async () => {
    const code = `
      exports('add', (a, b) => a + b);
      exports('later', async (x) => { await Wait(20); return x * 2; });
      exports('nothing', () => {});
      exports('boom', () => { throw new Error('kaboom'); });
      exports('sparse', (t) => new Map([[5, t[7]]]));
      exports('withCb', async (cb) => (await cb(21)) + 1);
      exports('retFn', () => (n) => n + 100);
      exports('vec', (v) => ({ x: v.x + 1, y: v.y + 1 }));
    `;
    await server.eval(code);
    await first.eval("exports('where', () => GetCurrentResourceName() + ':client')");
  });

  it("returns values, promises and nothing, like FiveM JS exports", async () => {
    expect(await server.eval("return await exports.jsunit.add(1, 2)")).toBe(3);
    expect(await server.eval("return await exports['jsunit'].later(4)")).toBe(8);
    expect(await server.eval("return await exports.jsunit.nothing()")).toBeNull();
  });

  it("raises with the error code when the export fails or is missing", async () => {
    expect(await server.eval("try { await exports.jsunit.boom() } catch (e) { return e.message }")).toContain("failed: error");
    expect(await server.eval("try { await exports.other.nope() } catch (e) { return e.message }")).toContain("not available");
  });

  it("carries integer keys and function references through the codec", async () => {
    expect(await server.eval("return await exports.jsunit.sparse(new Map([[7, 'seven']]))")).toEqual({ "5": "seven" });
    expect(await server.eval("return await exports.jsunit.withCb((n) => n * 2)")).toBe(43);
    expect(await server.eval("const f = await exports.jsunit.retFn(); return await f(5)")).toBe(105);
    expect(await server.eval("return await exports.jsunit.vec({ x: 1, y: 2 })")).toEqual({ x: 2, y: 3 });
  });

  it("works on the client too", async () => {
    expect(await first.eval("return await exports.jsunit.where()")).toBe("jsunit:client");
  });

  it("uses the same event names as the Lua shim", async () => {
    expect(server.hasCall("export:jsunit:add")).toBe(true);
    expect(server.hasCall("export:jsunit:__callback")).toBe(true);
  });
});

describe("threads", () => {
  it("setTick runs every frame, awaits async ticks and stops on clearTick", async () => {
    const result = await server.eval(`
      let n = 0;
      const id = setTick(() => { n++; });
      await Wait(55);
      clearTick(id);
      const after = n;
      await Wait(50);
      let slow = 0;
      const slowId = setTick(async () => { slow++; await Wait(30); });
      await Delay(100);
      clearTick(slowId);
      return [after >= 4, n === after, slow >= 2 && slow <= 5];
    `);
    expect(result).toEqual([true, true, true]);
  });

  it("provides setImmediate where the runtime has none, and Citizen.*", async () => {
    expect(await first.eval("return await new Promise((r) => setImmediate(r, 1)).then(() => typeof Citizen.setTick)")).toBe("function");
    expect(await first.eval("return await new Promise((r) => Citizen.setTimeout(10, r)).then(() => 'timeout')")).toBe("timeout");
  });

  it("disables a tick that fails 8 frames in a row", async () => {
    await server.eval("globalThis.fails = 0; setTick(() => { fails++; throw new Error('expected-failure'); })");
    await world.advance(200);
    expect(await server.eval("return globalThis.fails")).toBe(8);
  });
});

describe("shared functions", () => {
  it("answers the identity questions of the resource", async () => {
    expect(await server.eval("return [GetCurrentResourceName(), IsDuplicityVersion(), GetResourceState('jsunit'), GetResourceState('x')]")).toEqual([
      NAME,
      true,
      "started",
      "missing",
    ]);
    expect(await first.eval("return [IsDuplicityVersion(), GetParentResourceName()]")).toEqual([false, NAME]);
    expect(await server.eval("return [GetHashKey('prop_cs_trowel'), joaat('PROP_CS_TROWEL')]")).toEqual([2360793148, 2360793148]);
  });

  it("reads the convars and metadata of the build", async () => {
    expect(await server.eval("return [GetConvar('sv_name', 'x'), GetConvar('nope', 'dflt'), GetConvarInt('max', 1), GetConvarInt('nope', 5), GetConvarBool('flag'), GetConvarBool('nope', true)]")).toEqual([
      "Test",
      "dflt",
      32,
      5,
      true,
      true,
    ]);
    expect(await server.eval("return [GetResourceMetadata('jsunit', 'author', 0), GetNumResourceMetadata('jsunit', 'author'), GetResourceMetadata('other', 'author', 0)]")).toEqual([
      "me",
      1,
      null,
    ]);
  });
});

describe("server functions", () => {
  it("lists players and their identifiers", async () => {
    const result = await server.eval(`
      return [
        GetPlayers(), GetPlayerName(2), GetPlayerName('1'), GetPlayerName(99),
        GetPlayerIdentifiers(1), GetPlayerIdentifierByType(1, 'ip'), GetPlayerIdentifierByType(1, 'steam'),
        GetNumPlayerIdentifiers(1), GetPlayerIdentifier(1, 0), GetPlayerPed(1), GetPlayerPed(99),
      ];
    `);
    expect(result).toEqual([
      ["1", "2"],
      "Player2",
      "Player1",
      null,
      ["license:101", "ip:10.0.0.1", "name:Player1"],
      "ip:10.0.0.1",
      null,
      3,
      "license:101",
      1000,
      0,
    ]);
  });

  it("keeps typed KVP in the resource storage", async () => {
    const result = await server.eval(`
      SetResourceKvp('name', 'Ann');
      SetResourceKvpInt('count', 7.9);
      SetResourceKvpFloat('ratio', 2.5);
      SetResourceKvp('player:1', 'a');
      SetResourceKvp('player:2', 'b');
      DeleteResourceKvp('player:2');
      const h = StartFindKvp('player:');
      const keys = [];
      for (let k = FindKvp(h); k !== null; k = FindKvp(h)) keys.push(k);
      EndFindKvp(h);
      return [GetResourceKvpString('name'), GetResourceKvpInt('count'), GetResourceKvpFloat('ratio'), GetResourceKvpString('missing'), GetResourceKvpInt('missing'), GetResourceKvpInt('name'), keys];
    `);
    expect(result).toEqual(["Ann", 7, 2.5, null, 0, 0, ["player:1"]]);
  });

  it("registers commands: open to all unless restricted, source and raw command set", async () => {
    await server.eval(`
      RegisterCommand('open', (src, args, raw) => { globalThis.cmd = [src, args, raw, source]; }, false);
      RegisterCommand('closed', () => { globalThis.closed = true; }, true);
      RegisterCommand('implicit', () => { globalThis.implicit = true; });
    `);
    expect(server.command(0, "open a b")).toBe("ok");
    expect(server.command(0, "closed")).toBe("denied");
    expect(server.command(0, "implicit")).toBe("ok");
    server.grant(0, "command.closed");
    expect(server.command(0, "closed")).toBe("ok");
    expect(server.command(null, "open")).toBe("ok");
    await world.advance(20);
    expect(await server.eval("return [globalThis.closed, globalThis.implicit, GetRegisteredCommands().map((c) => c.name)]")).toEqual([
      true,
      true,
      ["open", "closed", "implicit"],
    ]);
    server.command(0, "open a b");
    await world.advance(10);
    expect(await server.eval("return globalThis.cmd")).toEqual([1, ["a", "b"], "open a b", 1]);
    await server.eval("ExecuteCommand('open run')");
    await world.advance(20);
    expect(server.commandsRun).toContain("open run");
  });

  it("gives a guest a license from the hardware id and ids shifted by one", async () => {
    server.addPlayer({ id: 40, name: "Guest", lsmpId: null, ip: "10.0.0.40", hwid: "HW-GUEST-1" });
    server.addPlayer({ id: 41, name: "NoHw", lsmpId: null, ip: "10.0.0.41" });
    const result = await server.eval("return [GetPlayerIdentifierByType(41, 'license'), GetPlayerIdentifierByType(42, 'license'), GetPlayers().includes('41')]");
    expect(result).toEqual([expect.stringMatching(/^license:hwid-[0-9a-f]+$/), null, true]);
  });

  it("keeps a guest's identifiers readable in playerDropped once LS:MP stops answering", async () => {
    server.addPlayer({ id: 50, name: "Leaver", lsmpId: null, ip: "10.0.0.50", hwid: "HW-GUEST-2" });
    await server.eval("on('playerDropped', () => { globalThis.droppedLicense = GetPlayerIdentifierByType(source, 'license'); }); return null");
    server.fire("playerJoin", 50, "Leaver");
    await world.advance(10);
    const license = await server.eval("return GetPlayerIdentifierByType(51, 'license')");
    expect(license).toMatch(/^license:hwid-[0-9a-f]+$/);
    server.removePlayer(50);
    server.fire("playerLeave", 50, "Leaver", "timeout", "");
    await world.advance(10);
    expect(await server.eval("return globalThis.droppedLicense")).toBe(license);
    expect(await server.eval("return GetPlayerIdentifierByType(51, 'license')")).toBe(null);
  });

  it("checks aces, drops players, routes buckets and performs http requests", async () => {
    server.grant(0, "admin.use");
    expect(await server.eval("return [IsPlayerAceAllowed(1, 'Admin.Use'), IsPlayerAceAllowed(2, 'admin.use')]")).toEqual([true, false]);
    await server.eval("DropPlayer(2, 'bye'); SetPlayerRoutingBucket(1, 3);");
    expect(server.kicks).toEqual([{ id: 1, reason: "bye" }]);
    expect(await server.eval("return [GetPlayerRoutingBucket(1), GetPlayerRoutingBucket(2)]")).toEqual([3, 0]);
    expect(await server.eval("return await new Promise((r) => PerformHttpRequest('https://example.test/x', (status, body) => r([status, body]), 'POST', '{}', { a: 'b' }))")).toEqual([
      200,
      '{"ok":true}',
    ]);
    expect(server.httpRequests).toEqual([{ url: "https://example.test/x", method: "POST", headers: { a: "b" }, body: "{}" }]);
    expect(await server.eval("return [GetEntityCoords(5), DoesEntityExist(5), NetworkGetNetworkIdFromEntity(5)]")).toEqual([[1, 2, 3], true, 5]);
  });
});

describe("client natives", () => {
  it("resolves PascalCase names, returns vectors as arrays and keeps the camelCase natives", async () => {
    expect(await first.eval("return [PlayerPedId(), GetEntityCoords(PlayerPedId()), getEntityCoords(1), GetGameTimer() > 0]")).toEqual([
      500,
      [100, 200, 30],
      { x: 100, y: 200, z: 30 },
      true,
    ]);
  });

  it("resolves FiveM names that differ from the LS:MP name through the generated alias data", async () => {
    expect(DATA.alias["AddAmmoToPedByType"]).toBe("addPedAmmoByType");
    await first.eval("AddAmmoToPedByType(7, 8, 9)");
    expect(first.natives.at(-1)).toEqual({ name: "addPedAmmoByType", args: [7, 8, 9] });
    const hash = Object.entries(DATA.alias).find(([k, v]) => k.startsWith("N_0x") && v === "setEntityCoords")?.[0];
    expect(hash).toBeDefined();
    await first.eval(`Citizen.invokeNative('0x${hash?.slice(4)}', 1, 2, 3, Citizen.resultAsInteger())`);
    expect(first.natives.at(-1)).toEqual({ name: "setEntityCoords", args: [1, 2, 3] });
    expect(await first.eval("try { Citizen.invokeNative('0x1', 1) } catch (e) { return e.message }")).toContain("not in the LS:MP catalogue");
    expect(await first.eval("try { SetPlayerInvincible(1, true) } catch (e) { return e.message }")).toContain("no native");
  });

  it("uses the same alias data as the Lua shim", () => {
    const lua = readFileSync(resolve(import.meta.dirname, "../shim/natives_alias.lua"), "utf8");
    const entries = [...lua.matchAll(/^ {2}(\w+) = "(\w+)",$/gm)].map((m) => [m[1], m[2]]);
    expect(entries.length).toBeGreaterThan(5000);
    expect(Object.fromEntries(entries)).toEqual(DATA.alias);
    expect(DATA.names).toContain("getEntityCoords");
    expect(DATA.names).not.toContain("wait");
  });

  it("maps server ids to player slots", async () => {
    expect(await first.eval("return [GetPlayerServerId(PlayerId()), GetPlayerFromServerId(1), GetPlayerFromServerId(2), GetPlayerFromServerId(9), GetActivePlayers(), GetPlayerServerId(1)]")).toEqual([
      1,
      0,
      1,
      -1,
      [0, 1],
      2,
    ]);
    expect(await first.eval("return [NetworkGetNetworkIdFromEntity(10005), NetworkGetEntityFromNetworkId(5), NetToVeh(5), VehToNet(10006)]")).toEqual([5, 10005, 10005, 6]);
  });
});

describe("client commands and key mappings", () => {
  it("runs commands locally and through ExecuteCommand, and keeps +/- commands off the LS:MP list", async () => {
    await first.eval(`
      globalThis.keys = [];
      RegisterCommand('cc', (src, args, raw) => { globalThis.cc = [src, args, raw]; }, false);
      RegisterCommand('+act', () => keys.push('down'));
      RegisterCommand('-act', () => keys.push('up'));
      RegisterKeyMapping('+act', 'Act', 'keyboard', 'E');
      RegisterKeyMapping('nokey', 'x', 'keyboard', 'NOSUCHKEY');
      RegisterKeyMapping('pad', 'x', 'pad', 'A');
    `);
    expect(first.command(null, "cc one two")).toBe("ok");
    expect(first.command(null, "+act")).toBe("unknown");
    await first.eval("ExecuteCommand('+act')");
    first.press(38);
    await world.advance(30);
    first.release(38);
    await world.advance(30);
    expect(await first.eval("return [globalThis.cc, globalThis.keys, GetRegisteredCommands().length]")).toEqual([
      [0, ["one", "two"], "cc one two"],
      ["down", "down", "up"],
      3,
    ]);
    expect(first.logs().some((l) => l.includes("NOSUCHKEY") || l.includes("nokey"))).toBe(true);
    expect(first.logs().some((l) => l.includes("'pad'") || l.includes("device"))).toBe(true);
  });
});

describe("NUI", () => {
  it("sends JSON messages to the page and answers its callbacks", async () => {
    await first.eval(`
      globalThis.nui = {};
      RegisterNuiCallbackType('close');
      on('__cfx_nui:close', (data, cb) => { nui.close = data; SetNuiFocus(false, false); cb({ ok: true, reason: data.reason }); });
      RegisterNUICallback('direct', (data, cb) => cb('direct:' + data.n));
      RegisterNUICallback('slow', (data, cb) => { setTimeout(() => cb('later'), 100); });
      RegisterNUICallback('none', () => {});
      RegisterNUICallback('sparse', (data, cb) => cb({ 3: 'x', names: ['a'] }));
    `);
    expect(await first.eval("return SendNUIMessage({ type: 'hi', f() {}, u: undefined, d: [1, undefined] })")).toBe(true);
    await world.advance(20);
    const page = world.pageFor(first, nuiBrowser(first));
    expect(page.messages.at(-1)).toEqual({ type: "hi", d: [1, null] });

    const call = async (name: string, data: unknown, ms = 150): Promise<unknown> => {
      const pending = Promise.resolve(page.run(`lsmp.call(${JSON.stringify(name)}, ${JSON.stringify(data)})`));
      await world.advance(ms);
      return pending;
    };
    expect(await call("close", { reason: "button" })).toEqual({ ok: true, reason: "button" });
    expect(await call("direct", { n: 4 })).toBe("direct:4");
    expect(await call("slow", {})).toBe("later");
    expect(await call("none", {}, 15100)).toBeNull();
    expect(await call("sparse", {})).toEqual({ "3": "x", names: ["a"] });
    expect(await first.eval("return [IsNuiFocused(), nui.close]")).toEqual([false, { reason: "button" }]);
  });

  it("focuses the page with the cursor and keep input options", async () => {
    await first.eval("SetNuiFocus(true, true)");
    const browser = first.browsers.get(nuiBrowser(first));
    expect(browser?.focus).toBe(true);
    expect(browser?.focusOpts).toEqual({ cursor: true, keepInput: false });
    await first.eval("SetNuiFocus(true, false); SetNuiFocusKeepInput(true)");
    expect(browser?.focusOpts).toEqual({ cursor: true, keepInput: true });
    await first.eval("SetNuiFocusKeepInput(false); SetNuiFocus(false, false)");
    expect(browser?.focus).toBe(false);
    expect(await first.eval("return IsNuiFocused()")).toBe(false);
  });
});

describe("client KVP", () => {
  it("serves typed values from memory and persists them in the hidden page", async () => {
    await first.eval("await fxcompat.kvpReady");
    const result = await first.eval(`
      SetResourceKvp('name', 'Ann');
      SetResourceKvpInt('count', 7);
      SetResourceKvpFloat('ratio', 1.5);
      SetResourceKvp('player:1', 'a');
      SetResourceKvp('player:2', 'b');
      DeleteResourceKvp('player:2');
      const h = StartFindKvp('player:');
      const keys = [];
      for (let k = FindKvp(h); k !== null; k = FindKvp(h)) keys.push(k);
      return [GetResourceKvpString('name'), GetResourceKvpInt('count'), GetResourceKvpFloat('ratio'), GetResourceKvpString('missing'), GetResourceKvpInt('name'), keys];
    `);
    expect(result).toEqual(["Ann", 7, 1.5, null, 0, ["player:1"]]);
    await world.advance(30);
    expect(JSON.parse(storage.get("fxkvp:count") ?? "null")).toEqual({ t: "i", v: 7 });
    expect(JSON.parse(storage.get("fxkvp:name") ?? "null")).toEqual({ t: "s", v: "Ann" });
    expect(storage.has("fxkvp:player:2")).toBe(false);
  });

  it("reads what the Lua shim stored in the same page", async () => {
    storage.set("fxkvp:lua", JSON.stringify({ t: "s", v: "from lua" }));
    const again = World.create({ luaMain: false, clients: 1, resource: NAME, webuiDir: makeWebui(""), storage });
    const other = await again;
    const res2 = other.addJs(NAME);
    await other.loadJsShim(res2, { kvpPage: "_fxcompat/kvp.html", uiPage: "index.html" });
    const vm = nth(res2.clients, 0);
    await other.advance(50);
    expect(await vm.eval("await fxcompat.kvpReady; return [GetResourceKvpString('lua'), GetResourceKvpInt('count')]")).toEqual(["from lua", 7]);
    other.close();
  });
});

describe("clean run", () => {
  it("no mock rule was broken in any context", () => {
    expect(filtered(world.allErrors())).toEqual([]);
  });
});
