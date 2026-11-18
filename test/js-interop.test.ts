import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, nth, type JsResource } from "./harness.ts";

const LUA_SERVER = `
  exports('luaAdd', function(a, b) return a + b, 'lua' end)
  exports('luaSparse', function(t) return { [5] = t[7], list = { 1, 2 } } end)
  exports('luaCall', function(cb) return cb(5) + 1 end)
  exports('luaBoom', function() error('kaboom') end)
  exports('luaVec2', function() return vector2(1.5, 2.5) end)
  RegisterNetEvent('lua:net', function(p) LUA_NET = { source, p } end)
  AddEventHandler('lua:local', function(p) LUA_LOCAL = p end)
`;

const LUA_CLIENT = `
  RegisterNetEvent('lua:down', function(p) LUA_DOWN = { source, p } end)
`;

const JS_SERVER = `
  exports('jsMul', (a, b) => a * b);
  exports('jsRestore', (t) => new Map([[5, t[7]], ['name', t.name]]));
  exports('jsVec', () => ({ x: 1, y: 2, z: 3 }));
  exports('jsEcho', (v) => v);
  exports('withCb', async (cb) => (await cb(21)) + 1);
  onNet('js:net', (p) => { globalThis.JS_NET = [source, p]; });
  on('js:local', (p) => { globalThis.JS_LOCAL = p; });
`;

const JS_CLIENT = `
  onNet('js:down', (p) => { globalThis.JS_DOWN = [source, p]; });
`;

let world: World;
let js: JsResource;

beforeAll(async () => {
  world = await World.withShim({ clients: 1, peers: true, resource: "luares", server: LUA_SERVER, client: LUA_CLIENT });
  js = world.addJs("jsres");
  await world.loadJsShim(js);
  js.server.load("server.js", JS_SERVER);
  js.clients[0]?.load("client.js", JS_CLIENT);
  await world.advance(50);
});
afterAll(() => world.close());

const luaServer = (): World["server"] => world.server;
const luaClient = (): World["server"] => nth(world.clients, 0);
const jsClient = (): JsResource["server"] => nth(js.clients, 0);

describe("exports, Lua and JS in both directions", () => {
  it("JS calls a Lua export and gets the first result", async () => {
    expect(await js.server.eval("return await exports.luares.luaAdd(1, 2)")).toBe(3);
  });

  it("Lua calls a JS export and gets its result", async () => {
    expect(await luaServer().eval("local a = exports.jsres:jsMul(6, 7) return a")).toBe(42);
    expect(await luaServer().eval("return exports.jsres.jsMul(3, 3)")).toBe(9);
  });

  it("an integer keyed table survives JS to Lua and back", async () => {
    expect(await js.server.eval("return await exports.luares.luaSparse(new Map([[7, 'seven']]))")).toEqual({ "5": "seven", list: [1, 2] });
    expect(await luaServer().eval("local r = exports.jsres:jsRestore({ [7] = 'seven', name = 'n' }) return { r[5], r.name }")).toEqual(["seven", "n"]);
  });

  it("vectors travel as the shared wire shapes", async () => {
    expect(await luaServer().eval("local v = exports.jsres:jsVec() return { v.x, v.y, v.z }")).toEqual([1, 2, 3]);
    expect(await js.server.eval("return await exports.luares.luaVec2()")).toEqual({ x: 1.5, y: 2.5 });
    expect(await luaServer().eval("local v = exports.jsres:jsEcho(vector2(3, 4)) return { v.x, v.y }")).toEqual([3, 4]);
  });

  it("function references call back across languages", async () => {
    expect(await luaServer().eval("return exports.jsres:withCb(function(n) return n * 2 end)")).toBe(43);
    expect(await js.server.eval("return await exports.luares.luaCall((n) => n * 3)")).toBe(16);
  });

  it("failures and missing exports raise in the caller", async () => {
    expect(await js.server.eval("try { await exports.luares.luaBoom() } catch (e) { return e.message }")).toContain("failed: error");
    expect(await luaServer().eval("local ok, err = pcall(function() return exports.jsres:nope() end) return err")).toContain("not available");
  });

  it("uses the shared event names", () => {
    expect(js.server.hasCall("export:jsres:jsMul")).toBe(true);
    expect(luaServer().hasCall("export:luares:luaAdd")).toBe(true);
  });
});

describe("events, Lua and JS in both directions", () => {
  it("a Lua client reaches a JS server event and a JS client reaches a Lua server event", async () => {
    await luaClient().eval("TriggerServerEvent('js:net', { [101] = 'a', list = { 1, 2 }, v = vector3(1, 2, 3) })");
    await jsClient().eval("TriggerServerEvent('lua:net', new Map([[5, 'five']]), { x: 1, y: 2, z: 3 })");
    await world.advance(50);
    expect(await js.server.eval("return globalThis.JS_NET")).toEqual([1, { "101": "a", list: [1, 2], v: { x: 1, y: 2, z: 3 } }]);
    expect(await luaServer().eval("return { LUA_NET[1], LUA_NET[2][5] }")).toEqual([1, "five"]);
  });

  it("a Lua server reaches a JS client and a JS server reaches a Lua client, source is the server", async () => {
    await luaServer().eval("TriggerClientEvent('js:down', 1, { [3] = 'x', ok = true })");
    await js.server.eval("TriggerClientEvent('lua:down', 1, new Map([[9, 'nine']]))");
    await world.advance(50);
    expect(await jsClient().eval("return globalThis.JS_DOWN")).toEqual([65535, { "3": "x", ok: true }]);
    expect(await luaClient().eval("return { LUA_DOWN[1], LUA_DOWN[2][9] }")).toEqual([65535, "nine"]);
  });

  it("local events cross the resources with the marker payload", async () => {
    await luaServer().eval("TriggerEvent('js:local', { [5] = 'x', n = 1 })");
    await js.server.eval("emit('lua:local', new Map([[5, 'five']]), 2)");
    await world.advance(50);
    expect(await js.server.eval("return globalThis.JS_LOCAL")).toEqual({ "5": "x", n: 1 });
    expect(await luaServer().eval("return LUA_LOCAL[5]")).toBe("five");
  });

  it("no mock rule was broken in any VM", () => {
    expect(world.allErrors().filter((e) => !e.includes("kaboom"))).toEqual([]);
  });
});
