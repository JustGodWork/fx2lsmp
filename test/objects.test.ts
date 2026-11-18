import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concatShim, renderConfig } from "../tools/fx2lsmp/cli.ts";
import { World, type JsResource, type LuaResource } from "./harness.ts";

const SHIM_DIR = resolve(import.meta.dirname, "../shim");

const LUA_FRAMEWORK = `
  local bank = { [1] = 100, [2] = 200 }
  local function makePlayer(src)
    local self = { source = src, identifier = 'id' .. src, money = bank[src] }
    self.getMoney = function() return bank[src] end
    self.addMoney = function(n) bank[src] = bank[src] + n end
    self.getInventory = function() return { weight = 3, label = function() return 'inv' .. src end } end
    self.Functions = { AddMoney = function(n) bank[src] = bank[src] + n return true end }
    return self
  end
  local ESX = { version = 'lua-1', Game = { Double = function(n) return n * 2 end } }
  ESX.GetPlayerFromId = function(src) return makePlayer(src) end
  local Point = { kind = 'point' }
  Point.__index = Point
  function Point.describe() return 'a point' end
  ESX.Point = setmetatable(Point, { __call = function(_, x) return setmetatable({ x = x }, Point) end })
  exports('getSharedObject', function() return ESX end)
  exports('many', function(n)
    local list = {}
    for i = 1, n do list[i] = { ping = function() return i end } end
    return table.unpack(list, 1, n)
  end)
  exports('useObject', function(obj) return obj.twice(21) + obj.inner.add(1, 2) end)
`;

const JS_FRAMEWORK = `
  const bank = new Map([[1, 100], [2, 200]]);
  function makePlayer(src) {
    const self = { source: src, identifier: 'id' + src, money: bank.get(src) };
    self.getMoney = () => bank.get(src);
    self.addMoney = (n) => { bank.set(src, bank.get(src) + n); };
    self.getInventory = () => ({ weight: 3, label: () => 'inv' + src });
    self.Functions = { AddMoney: (n) => { bank.set(src, bank.get(src) + n); return true; } };
    return self;
  }
  const ESX = { version: 'js-1', Game: { Double: (n) => n * 2 } };
  ESX.GetPlayerFromId = (src) => makePlayer(src);
  exports('getSharedObject', () => ESX);
  exports('fresh', () => ({ ping: () => 1 }));
  exports('useObject', async (obj) => (await obj.twice(21)) + (await obj.inner.add(1, 2)));
`;

let world: World;
let luaApp: LuaResource;
let jsApp: JsResource;

async function bootLua(resource: string, script?: string): Promise<LuaResource> {
  const res = await world.addLua(resource);
  const config = `${renderConfig(undefined, {})}\nFXCOMPAT_CONFIG.expose = true\n`;
  const shim = concatShim(SHIM_DIR);
  for (const vm of [res.server, ...res.clients]) {
    vm.load("config.lua", config);
    vm.load("init.lua", shim);
  }
  if (script !== undefined) res.server.load("server.lua", script);
  await world.advance(30);
  return res;
}

beforeAll(async () => {
  world = await World.create({ resource: "objects", clients: 1, peers: true, luaMain: false });
  await bootLua("luafw", LUA_FRAMEWORK);
  luaApp = await bootLua("luaapp");
  const jsFw = world.addJs("jsfw");
  jsApp = world.addJs("jsapp");
  await world.loadJsShim(jsFw);
  await world.loadJsShim(jsApp);
  jsFw.server.load("server.js", JS_FRAMEWORK);
  await world.advance(50);
});
afterAll(() => world.close());

const luaUse = (resource: string, first: number): string => `
  local ESX = exports.${resource}:getSharedObject()
  local p = ESX.GetPlayerFromId(${first})
  local before = p.money
  p.addMoney(50)
  local colon = p:getMoney()
  local ok = p.Functions:AddMoney(5)
  local dot = p.Functions.AddMoney(5)
  local fresh = ESX.GetPlayerFromId(${first})
  return {
    version = ESX.version, id = p.identifier, before = before, snapshot = p.money, colon = colon, ok = ok, dot = dot,
    now = p.getMoney(), fresh = fresh.money, double = ESX.Game.Double(4), label = p.getInventory().label(),
    weight = p.getInventory().weight,
  }
`;

describe("exported objects with methods, Lua consumer", () => {
  it("calls nested methods on a Lua framework with dot and colon forms", async () => {
    expect(await luaApp.server.eval(luaUse("luafw", 1))).toEqual({
      version: "lua-1", id: "id1", before: 100, snapshot: 100, colon: 150, ok: true, dot: true,
      now: 160, fresh: 160, double: 8, label: "inv1", weight: 3,
    });
  });

  it("calls nested methods on a JS framework", async () => {
    expect(await luaApp.server.eval(luaUse("jsfw", 2))).toEqual({
      version: "js-1", id: "id2", before: 200, snapshot: 200, colon: 250, ok: true, dot: true,
      now: 260, fresh: 260, double: 8, label: "inv2", weight: 3,
    });
  });

  it("carries a self referencing class table with its functions", async () => {
    const code = "local Point = exports.luafw:getSharedObject().Point return { Point.kind, Point.describe() }";
    expect(await luaApp.server.eval(code)).toEqual(["point", "a point"]);
  });

  it("reports a missing method", async () => {
    const code =
      "local p = exports.luafw:getSharedObject().GetPlayerFromId(1) local ok, err = pcall(function() return p.nope() end) return { ok, err ~= nil }";
    expect(await luaApp.server.eval(code)).toEqual([false, true]);
  });

  it("passes an object with methods as an argument, to Lua and to JS", async () => {
    const arg = "{ twice = function(n) return n * 2 end, inner = { add = function(a, b) return a + b end } }";
    expect(await luaApp.server.eval(`return exports.luafw:useObject(${arg})`)).toBe(45);
    expect(await luaApp.server.eval(`return exports.jsfw:useObject(${arg})`)).toBe(45);
  });

  it("keeps the registry bounded: an old object expires, a recent one stays callable", async () => {
    const code = `
      local r = table.pack(exports.luafw:many(1100))
      local okLast, last = pcall(function() return r[1100].ping() end)
      local okFirst, err = pcall(function() return r[1].ping() end)
      return { okLast, last, okFirst, string.find(tostring(err), '__objcall', 1, true) ~= nil }
    `;
    expect(await luaApp.server.eval(code)).toEqual([true, 1100, false, true]);
  });
});

const jsUse = (resource: string, first: number): string => `
  const ESX = await exports.${resource}.getSharedObject();
  const p = await ESX.GetPlayerFromId(${first});
  const before = p.money;
  await p.addMoney(50);
  const ok = await p.Functions.AddMoney(5);
  const fresh = await ESX.GetPlayerFromId(${first});
  return {
    version: ESX.version, id: p.identifier, before, snapshot: p.money, ok, now: await p.getMoney(), fresh: fresh.money,
    double: await ESX.Game.Double(4), label: await (await p.getInventory()).label(), weight: (await p.getInventory()).weight,
  };
`;

describe("exported objects with methods, JS consumer", () => {
  it("calls nested methods on a JS framework", async () => {
    expect(await jsApp.server.eval(jsUse("jsfw", 1))).toEqual({
      version: "js-1", id: "id1", before: 100, snapshot: 100, ok: true, now: 155, fresh: 155, double: 8, label: "inv1", weight: 3,
    });
  });

  it("calls nested methods on a Lua framework", async () => {
    expect(await jsApp.server.eval(jsUse("luafw", 2))).toEqual({
      version: "lua-1", id: "id2", before: 200, snapshot: 200, ok: true, now: 255, fresh: 255, double: 8, label: "inv2", weight: 3,
    });
  });

  it("passes an object with methods as an argument, to JS and to Lua", async () => {
    const arg = "{ twice: (n) => n * 2, inner: { add: (a, b) => a + b } }";
    expect(await jsApp.server.eval(`return await exports.jsfw.useObject(${arg})`)).toBe(45);
    expect(await jsApp.server.eval(`return await exports.luafw.useObject(${arg})`)).toBe(45);
  });

  it("keeps the registry bounded", async () => {
    const code = `
      const all = await Promise.all(Array.from({ length: 1100 }, () => exports.jsfw.fresh()));
      const last = await all[1099].ping();
      let expired = false;
      try { await all[0].ping(); } catch (e) { expired = String(e.message).includes("__objcall"); }
      return { last, expired };
    `;
    expect(await jsApp.server.eval(code)).toEqual({ last: 1, expired: true });
  });
});

describe("errors", () => {
  it("raised nothing unexpected in any VM", () => {
    const errors = world.allErrors().filter((e) => !e.includes("expired") && !e.includes("no such method"));
    expect(errors).toEqual([]);
  });
});
