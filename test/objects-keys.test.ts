import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concatShim, renderConfig } from "../tools/fx2lsmp/cli.ts";
import { World, type JsResource, type LuaResource } from "./harness.ts";

const SHIM_DIR = resolve(import.meta.dirname, "../shim");

const LUA_OWNER = `
  local person = { name = 'bob' }
  function person:getName() return self.name end
  function person.greet(self, greeting) return greeting .. ' ' .. self.name end
  person.closure = function(n) return n + 1 end
  person.rename = function(self, name) self.name = name return self.name end
  exports('person', function() return person end)
  exports('list', function()
    return { function() return 'one' end, 'data', [4] = function(n) return n or 'four' end }
  end)
  exports('nested', function() return { items = { function() return 7 end, { function() return 8 end } } } end)
  exports('holes', function() return { [1] = 'x', [3] = 'z', go = function() return 'went' end } end)
`;

const JS_OWNER = `
  exports('list', () => [() => 'one', 'data', null, (n) => n ?? 'four']);
  exports('nested', () => ({ items: [() => 7, [() => 8]] }));
  exports('holes', () => ({ keep: 'k', arr: ['x', null, 'z', () => 'tail'] }));
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
  world = await World.create({ resource: "objkeys", clients: 1, peers: true, luaMain: false });
  await bootLua("luaown", LUA_OWNER);
  luaApp = await bootLua("luaapp");
  const jsOwn = world.addJs("jsown");
  jsApp = world.addJs("jsapp");
  await world.loadJsShim(jsOwn);
  await world.loadJsShim(jsApp);
  jsOwn.server.load("server.js", JS_OWNER);
  await world.advance(50);
});
afterAll(() => world.close());

describe("functions under integer keys, Lua consumer", () => {
  it("calls list slots of a Lua owner and of a JS owner", async () => {
    for (const owner of ["luaown", "jsown"]) {
      const code = `
        local l = exports.${owner}:list()
        return { l[1](), l[2], tostring(l[3]), l[4](), l[4](9), type(l[1]) }
      `;
      expect(await luaApp.server.eval(code)).toEqual(["one", "data", "nil", "four", 9, "function"]);
    }
  });

  it("reaches nested list slots", async () => {
    for (const owner of ["luaown", "jsown"]) {
      const code = `local n = exports.${owner}:nested() return { n.items[1](), n.items[2][1]() }`;
      expect(await luaApp.server.eval(code)).toEqual([7, 8]);
    }
  });

  it("keeps the data snapshot with holes", async () => {
    expect(
      await luaApp.server.eval(
        "local h = exports.luaown:holes() return { h[1], tostring(h[2]), h[3], h.go(), type(h.go) }",
      ),
    ).toEqual(["x", "nil", "z", "went", "function"]);
    expect(
      await luaApp.server.eval(
        "local h = exports.jsown:holes() return { h.keep, h.arr[1], tostring(h.arr[2]), h.arr[3], h.arr[4]() }",
      ),
    ).toEqual(["k", "x", "nil", "z", "tail"]);
  });
});

describe("functions under integer keys, JS consumer", () => {
  it("calls array slots of a Lua owner with 0-based indices", async () => {
    const code = `
      const l = await exports.luaown.list();
      return [await l[0](), l[1], l[2] ?? null, await l[3](), await l[3](9), Array.isArray(l), typeof l[0]];
    `;
    expect(await jsApp.server.eval(code)).toEqual(["one", "data", null, "four", 9, true, "function"]);
  });

  it("calls array slots of a JS owner", async () => {
    const code = `
      const l = await exports.jsown.list();
      const n = await exports.jsown.nested();
      return [await l[0](), l[1], l[2], await l[3](), await n.items[0](), await n.items[1][0]()];
    `;
    expect(await jsApp.server.eval(code)).toEqual(["one", "data", null, "four", 7, 8]);
  });

  it("reaches nested slots and holes of a Lua owner", async () => {
    const code = `
      const n = await exports.luaown.nested();
      const h = await exports.luaown.holes();
      return [await n.items[0](), await n.items[1][0](), h["1"], h["2"] ?? null, h["3"], await h.go()];
    `;
    expect(await jsApp.server.eval(code)).toEqual([7, 8, "x", null, "z", "went"]);
  });
});

describe("self style methods", () => {
  it("passes the live container to colon calls and to methods whose first parameter is self", async () => {
    const code = `
      local p = exports.luaown:person()
      local a = p:getName()
      local b = p:greet('hi')
      local c = p.greet('yo')
      local d = p.closure(4)
      local e = p:closure(5)
      local f = p:rename('alice')
      return { a, b, c, d, e, f, p:getName(), p.name }
    `;
    expect(await luaApp.server.eval(code)).toEqual(["bob", "hi bob", "yo bob", 5, 6, "alice", "alice", "bob"]);
  });

  it("passes the container to a self method called from JS", async () => {
    const code = `
      const p = await exports.luaown.person();
      return [await p.getName(), await p.greet('hey'), await p.closure(1)];
    `;
    expect(await jsApp.server.eval(code)).toEqual(["alice", "hey alice", 2]);
  });
});
