import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, nth, type JsResource, type LuaResource } from "./harness.ts";

const LUA_B = `
  exports('who', function() return GetInvokingResource() end)
  exports('whoArgs', function(...) return select('#', ...), GetInvokingResource() end)
  exports('slow', function(tag)
    local before = GetInvokingResource()
    Wait(200)
    SLOW = SLOW or {}
    SLOW[tag] = { before, GetInvokingResource() }
    return before
  end)
  AddEventHandler('inv:local', function(a) LOCAL_SEEN = { GetInvokingResource(), a } end)
  RegisterNetEvent('inv:net', function() NET_SEEN = { GetInvokingResource() } end)
`;

const JS_B = `
  exports('who', () => GetInvokingResource());
  exports('whoArgs', (...a) => [a.length, GetInvokingResource()]);
  on('inv:local', (a) => { globalThis.LOCAL_SEEN = [GetInvokingResource(), a]; });
  onNet('inv:net', () => { globalThis.NET_SEEN = [GetInvokingResource()]; });
`;

let world: World;
let luaA: LuaResource;
let luaB: LuaResource;
let jsA: JsResource;
let jsB: JsResource;

beforeAll(async () => {
  world = await World.create({ luaMain: false, clients: 1, peers: true });
  luaA = await world.addLua("luaA");
  await world.loadLuaShim(luaA);
  luaB = await world.addLua("luaB");
  await world.loadLuaShim(luaB);
  luaB.server.load("b.lua", LUA_B);
  jsA = world.addJs("jsA");
  await world.loadJsShim(jsA);
  jsB = world.addJs("jsB");
  await world.loadJsShim(jsB);
  jsB.server.load("b.js", JS_B);
  await world.advance(50);
});
afterAll(() => world.close());

describe("GetInvokingResource", () => {
  it("is nil outside handlers", async () => {
    expect(await luaA.server.eval("return GetInvokingResource()")).toBeNull();
    expect(await jsA.server.eval("return GetInvokingResource()")).toBeNull();
  });

  it("export, Lua to Lua", async () => {
    expect(await luaA.server.eval("return exports.luaB:who()")).toBe("luaA");
  });

  it("export, JS to JS", async () => {
    expect(await jsA.server.eval("return await exports.jsB.who()")).toBe("jsA");
  });

  it("export, Lua to JS and JS to Lua", async () => {
    expect(await luaA.server.eval("return exports.jsB:who()")).toBe("luaA");
    expect(await jsA.server.eval("return await exports.luaB.who()")).toBe("jsA");
  });

  it("the marker never reaches the handler arguments", async () => {
    expect(await luaA.server.eval("local n, r = exports.luaB:whoArgs(1, 2) return { n, r }")).toEqual([2, "luaA"]);
    expect(await luaA.server.eval("return exports.jsB:whoArgs(1, 2)")).toEqual([2, "luaA"]);
    expect(await jsA.server.eval("return await exports.jsB.whoArgs()")).toEqual([0, "jsA"]);
  });

  it("an export called without the marker still runs and sees no invoker", async () => {
    const reply = await luaB.server.eval("local list = lsmp.call('export:luaB:whoArgs', 1, 2) return { list[1], list[2] }");
    expect(reply).toEqual([2, null]);
  });

  it("local events carry the triggering resource", async () => {
    await luaA.server.eval("TriggerEvent('inv:local', 7)");
    await jsA.server.eval("emit('inv:local', 8)");
    await world.advance(50);
    expect(await luaB.server.eval("return LOCAL_SEEN")).toEqual(["jsA", 8]);
    expect(await jsB.server.eval("return globalThis.LOCAL_SEEN")).toEqual(["jsA", 8]);
    await luaA.server.eval("TriggerEvent('inv:local', 9)");
    await world.advance(50);
    expect(await luaB.server.eval("return LOCAL_SEEN")).toEqual(["luaA", 9]);
    expect(await jsB.server.eval("return globalThis.LOCAL_SEEN")).toEqual(["luaA", 9]);
  });

  it("net events see nil", async () => {
    await nth(luaA.clients, 0).eval("TriggerServerEvent('inv:net')");
    await nth(jsA.clients, 0).eval("TriggerServerEvent('inv:net')");
    await world.advance(50);
    expect(await luaB.server.eval("return NET_SEEN")).toEqual([]);
    expect(await jsB.server.eval("return globalThis.NET_SEEN")).toEqual([null]);
  });

  it("a handler that yields keeps its own invoker next to a concurrent one", async () => {
    await luaA.server.eval("CreateThread(function() exports.luaB:slow('a') end)");
    await jsA.server.eval("void exports.luaB.slow('b')");
    await world.advance(400);
    expect(await luaB.server.eval("return { SLOW.a[1], SLOW.a[2], SLOW.b[1], SLOW.b[2] }")).toEqual([
      "luaA", "luaA", "jsA", "jsA",
    ]);
    expect(await luaB.server.eval("return GetInvokingResource()")).toBeNull();
  });

  it("no mock rule was broken", () => {
    expect(world.allErrors()).toEqual([]);
  });
});
