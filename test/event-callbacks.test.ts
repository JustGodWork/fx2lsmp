import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, type JsResource, type LuaResource } from "./harness.ts";

const SKIN = `
  AddEventHandler('skin:load', function(skin, cb) cb(skin.n + 1) end)
`;

let world: World;
let esx: LuaResource;
let js: JsResource;

beforeAll(async () => {
  world = await World.withShim({ clients: 0, peers: true, resource: "skinres", server: SKIN });
  esx = await world.addLua("esxres");
  await world.loadLuaShim(esx, "server");
  js = world.addJs("jsres");
  await world.loadJsShim(js);
  js.server.load("server.js", "on('js:load', (n, cb) => cb(n * 3));");
  await world.advance(50);
});
afterAll(() => world.close());

describe("functions passed through local events", () => {
  it("reach a handler in another Lua resource as a callable callback", async () => {
    esx.server.load("spawn.lua", `
      CreateThread(function()
        local p = promise.new()
        TriggerEvent('skin:load', { n = 1 }, function(v) p:resolve(v) end)
        SPAWNED = Citizen.Await(p)
      end)
    `);
    await world.advance(100);
    expect(await esx.server.eval("return SPAWNED")).toBe(2);
  });

  it("cross between Lua and JS and stay the same function inside one resource", async () => {
    esx.server.load("mixed.lua", "TriggerEvent('js:load', 7, function(v) FROM_JS = v end)");
    js.server.load("mixed.js", "TriggerEvent('skin:load', { n: 4 }, (v) => { globalThis.FROM_LUA = v; });");
    world.server.load("self.lua", `
      local fn = function() end
      AddEventHandler('self:check', function(got) SAME = got == fn end)
      TriggerEvent('self:check', fn)
    `);
    await world.advance(100);
    expect(await esx.server.eval("return FROM_JS")).toBe(21);
    expect(await js.server.eval("return globalThis.FROM_LUA")).toBe(5);
    expect(await world.server.eval("return SAME")).toBe(true);
  });
});
