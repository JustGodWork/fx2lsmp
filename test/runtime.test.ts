import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertResource } from "../tools/fx2lsmp/cli.ts";
import { World } from "./harness.ts";
import { makeWebui } from "./webui.ts";

const KVP_PAGE = "_fxcompat/kvp.html";

async function kvpWorld(storage: Map<string, string>): Promise<World> {
  return World.withShim({ clients: 1, storage, uiPage: "index.html", kvpPage: KVP_PAGE, webuiDir: makeWebui("") });
}

describe("client KVP", () => {
  const storage = new Map<string, string>();
  let first: World;
  beforeAll(async () => {
    first = await kvpWorld(storage);
  });
  afterAll(() => first.close());

  it("reads back what it writes, typed, without waiting for the page", async () => {
    const result = await first.clients[0]!.eval(`
      SetResourceKvp('name', 'Ann')
      SetResourceKvpInt('count', 7)
      SetResourceKvpFloat('ratio', 1.5)
      SetResourceKvp('player:1', 'a')
      SetResourceKvp('player:2', 'b')
      return {
        GetResourceKvpString('name'), GetResourceKvpInt('count'), GetResourceKvpFloat('ratio'),
        GetResourceKvpString('missing') == nil, GetResourceKvpInt('missing'), GetResourceKvpInt('name'),
        GetResourceKvpString('count'),
      }
    `);
    expect(result).toEqual(["Ann", 7, 1.5, true, 0, 0, "7"]);
  });

  it("persists through the page localStorage as typed entries", async () => {
    await first.advance(50);
    expect(JSON.parse(storage.get("fxkvp:count") ?? "null")).toEqual({ t: "i", v: 7 });
    expect(JSON.parse(storage.get("fxkvp:name") ?? "null")).toEqual({ t: "s", v: "Ann" });
  });

  it("deletes and finds by prefix", async () => {
    const result = await first.clients[0]!.eval(`
      DeleteResourceKvp('player:2')
      local h = StartFindKvp('player:')
      local keys = {}
      while true do
        local k = FindKvp(h)
        if k == nil then break end
        keys[#keys + 1] = k
      end
      EndFindKvp(h)
      return { keys, FindKvp(h) == nil }
    `);
    expect(result).toEqual([["player:1"], true]);
    await first.advance(50);
    expect(storage.has("fxkvp:player:2")).toBe(false);
  });

  it("a restarted resource loads the entries on the first read, and local writes win over them", async () => {
    const second = await kvpWorld(storage);
    try {
      const vm = second.clients[0]!;
      await vm.eval("SetResourceKvp('name', 'Bob')");
      expect(await vm.eval("return { GetResourceKvpString('name'), GetResourceKvpInt('count'), GetResourceKvpFloat('ratio') }")).toEqual([
        "Bob",
        7,
        1.5,
      ]);
      expect(await vm.eval("local h = StartFindKvp('') local n = 0 while FindKvp(h) do n = n + 1 end return n")).toBe(4);
      expect(second.allErrors()).toEqual([]);
    } finally {
      second.close();
    }
  });

  it("works in memory only, with one warning, when the build left no page", async () => {
    const bare = await World.withShim({ clients: 1 });
    try {
      expect(await bare.clients[0]!.eval("SetResourceKvp('a', 'b') return GetResourceKvpString('a')")).toBe("b");
      expect(bare.clients[0]!.logs().filter((l) => l.includes("KVP page"))).toHaveLength(1);
    } finally {
      bare.close();
    }
  });
});

describe("Citizen.InvokeNative and N_0x names", () => {
  let world: World;
  beforeAll(async () => {
    world = await World.withShim({ clients: 1 });
  });
  afterAll(() => world.close());
  const client = () => world.clients[0]!;

  it("resolves the 64 bit hash through the generated table", async () => {
    expect(await client().eval("return Citizen.InvokeNative(0x3FEF770D40960D5A, 1).x")).toBe(100);
    expect(await client().eval("return Citizen.InvokeNative('0x3FEF770D40960D5A', 1).z")).toBe(30);
  });

  it("strips the result and pointer markers from the arguments", async () => {
    expect(
      await client().eval(`
        function addPedAmmoByType(...) return select('#', ...) end
        return Citizen.InvokeNative(0x2472622CE1F2D45F, 1, nil, 3, Citizen.PointerValueInt(), Citizen.ReturnResultAnyway(), Citizen.ResultAsInteger())
      `),
    ).toBe(3);
  });

  it("accepts N_0x names in any hex case", async () => {
    expect(await client().eval("return N_0x3fef770d40960d5a(1).x")).toBe(100);
    expect(await client().eval("return N_0X3FEF770D40960D5A(1).x")).toBe(100);
  });

  it("raises a clear error for an unknown hash", async () => {
    await expect(client().eval("return Citizen.InvokeNative(0x1234567890ABCDEF, 1)")).rejects.toThrow(
      "native 0x1234567890ABCDEF is not in the LS:MP catalogue",
    );
    await expect(client().eval("return Citizen.InvokeNative('nope')")).rejects.toThrow("invalid native hash");
  });
});

describe("workarounds for B1", () => {
  let world: World;
  const server = () => world.server;
  const client = () => world.clients[0]!;
  const nativeNames = async (): Promise<string[]> =>
    client().eval("local out = {} for _, c in ipairs(lsmp.__test.natives) do out[#out + 1] = c.name end return out");

  beforeAll(async () => {
    world = await World.withShim({ clients: 2 });
    await server().eval("lsmp.__test.owners[5] = 1 lsmp.__test.owners[6] = 2");
  });
  afterAll(() => world.close());

  it("DeleteEntity of a networked entity the player owns is deleted by the server", async () => {
    await client().eval("DeleteEntity(10005)");
    await world.advance(50);
    expect(await server().eval("return lsmp.__test.deleted[5] == true")).toBe(true);
    expect(await nativeNames()).toEqual([]);
  });

  it("covers DeleteVehicle, DeletePed and DeleteObject the same way", async () => {
    await server().eval("lsmp.__test.owners[11] = 1 lsmp.__test.owners[12] = 1 lsmp.__test.owners[13] = 1");
    await client().eval("DeleteVehicle(10011) DeletePed(10012) DeleteObject(10013)");
    await world.advance(50);
    expect(await server().eval("local d = lsmp.__test.deleted return { d[11], d[12], d[13] }")).toEqual([true, true, true]);
  });

  it("refuses entities owned by someone else, orphans and unknown netIds", async () => {
    await client().eval("DeleteEntity(10006) DeleteEntity(10007) DeleteEntity(10999)");
    await world.advance(50);
    expect(await server().eval("local d = lsmp.__test.deleted return { d[6] == nil, d[7] == nil, d[999] == nil }")).toEqual([true, true, true]);
    expect(world.allErrors()).toEqual([]);
  });

  it("a non-networked entity falls back to the native with one warning", async () => {
    await client().eval("DeleteEntity(77) DeleteEntity(78)");
    expect((await nativeNames()).filter((n) => n === "deleteEntity")).toHaveLength(2);
    expect(client().logs().filter((l) => l.includes("non-networked"))).toHaveLength(1);
  });

  it("RemoveBlip hides the blip and forgets it until the handle is reused", async () => {
    const result = await client().eval(`
      local blip = AddBlipForCoord(1.0, 2.0, 3.0)
      local before = DoesBlipExist(blip)
      RemoveBlip(blip)
      local after = DoesBlipExist(blip)
      local calls = {}
      for _, c in ipairs(lsmp.__test.natives) do
        if c.name == 'setBlipDisplay' or c.name == 'setBlipAlpha' then calls[#calls + 1] = { c.name, c.args[1] == blip, c.args[2] } end
      end
      return { before, after, calls }
    `);
    expect(result).toEqual([true, false, [["setBlipDisplay", true, 0], ["setBlipAlpha", true, 0]]]);
    expect(await nativeNames()).not.toContain("removeBlip");
    expect(await client().eval("local b = AddBlipForEntity(1) return DoesBlipExist(b)")).toBe(true);
  });

  it("is switched off by the single b1Workarounds flag", async () => {
    const off = await World.withShim({ clients: 1, extraConfig: "FXCOMPAT_CONFIG.b1Workarounds = false" });
    try {
      await off.clients[0]!.eval("DeleteEntity(10005) RemoveBlip(5)");
      const names = await off.clients[0]!.eval<string[]>(
        "local o = {} for _, c in ipairs(lsmp.__test.natives) do o[#o + 1] = c.name end return o",
      );
      expect(names).toEqual(["deleteEntity", "removeBlip"]);
    } finally {
      off.close();
    }
  });
});

describe("export callbacks", () => {
  let world: World;
  beforeAll(async () => {
    world = await World.withShim({ clients: 1 });
  });
  afterAll(() => world.close());

  it("a function passed to an export is called back, and a returned function too", async () => {
    const result = await world.clients[0]!.eval(`
      exports('apply', function(value, fn) return fn(value + 1), function(x) return x * 2 end end)
      local got, doubler = exports.unit:apply(1, function(v) return v * 10 end)
      return { got, doubler(21) }
    `);
    expect(result).toEqual([20, 42]);
    expect(world.allErrors()).toEqual([]);
  });
});

describe("spawnmanager compat resource", () => {
  let world: World;
  beforeAll(async () => {
    const out = join(mkdtempSync(join(tmpdir(), "fxspawn-")), "spawnmanager");
    const result = await convertResource({ resourceDir: resolve(import.meta.dirname, "../compat/spawnmanager"), outDir: out });
    expect(result.warnings).toEqual([]);
    world = await World.fromConverted(out, 1);
  });
  afterAll(() => world.close());
  const client = () => world.clients[0]!;
  const spawns = () => client().eval<{ pos: { x: number; y: number; z: number }; opts: { heading: number; model?: string } }[]>("return lsmp.__test.spawns");

  it("registers the auto spawn handler, which closes the loading screen when there is nothing to spawn at", async () => {
    client().runAutoSpawn();
    await world.advance(50);
    expect(await spawns()).toEqual([]);
    expect(await client().eval("return lsmp.__test.loadingClosed")).toBe(true);
  });

  it("spawnPlayer spawns at a table or a spawn point index and calls the callback", async () => {
    const result = await client().eval(`
      local seen
      local ok = exports.spawnmanager:spawnPlayer({ x = 1.0, y = 2.0, z = 3.0, heading = 90.0, model = 'a_m_y_skater_01' },
        function(spawn) seen = spawn.x end)
      local idx = exports.spawnmanager:addSpawnPoint({ x = 10.0, y = 20.0, z = 30.0, heading = 5.0 })
      local ok2 = exports.spawnmanager:spawnPlayer(idx)
      return { ok, seen, idx, ok2 }
    `);
    expect(result).toEqual([true, 1, 1, true]);
    const list = await spawns();
    expect(list[0]).toEqual({ pos: { x: 1, y: 2, z: 3 }, opts: { heading: 90, model: "a_m_y_skater_01" } });
    expect(list[1]?.pos).toEqual({ x: 10, y: 20, z: 30 });
  });

  it("fires the FiveM playerSpawned event with a spawn table", async () => {
    await client().eval("AddEventHandler('playerSpawned', function(spawn) SPAWNED = { spawn.x, spawn.heading } end)");
    await client().eval("exports.spawnmanager:spawnPlayer({ x = 4.0, y = 5.0, z = 6.0, heading = 7.0 })");
    await world.advance(30);
    expect(await client().eval("return SPAWNED")).toEqual([4, 7]);
  });

  it("raises on a bad spawn", async () => {
    await expect(client().eval("return exports.spawnmanager:spawnPlayer({ x = 1 })")).rejects.toThrow("export 'spawnmanager:spawnPlayer' failed");
    expect(client().errors().some((e) => e.includes("expected a spawn table"))).toBe(true);
  });

  it("setAutoSpawnCallback takes a function and forceRespawn runs it", async () => {
    await client().eval(`
      CALLED = 0
      exports.spawnmanager:setAutoSpawnCallback(function() CALLED = CALLED + 1 end)
      exports.spawnmanager:forceRespawn()
    `);
    await world.advance(50);
    expect(await client().eval("return CALLED")).toBe(1);
    client().runAutoSpawn();
    await world.advance(50);
    expect(await client().eval("return CALLED")).toBe(2);
  });

  it("setAutoSpawn(false) is forwarded to LS:MP", async () => {
    await client().eval("exports.spawnmanager:setAutoSpawn(false)");
    expect(await client().eval("return lsmp.__test.autoSpawn")).toBe(false);
  });

  it("revives a dead ped in place and respawns after a death when auto spawn is on", async () => {
    await client().eval("exports.spawnmanager:setAutoSpawn(true) lsmp.__test.dead = true lsmp.__test.resurrects = {}");
    await client().eval("exports.spawnmanager:spawnPlayer({ x = 8.0, y = 8.0, z = 8.0 })");
    expect(await client().eval("return #lsmp.__test.resurrects")).toBe(1);
    await client().eval("CALLED = 0 lsmp.__test.dead = true");
    client().fire("playerDeath", 1, 0, 0, { x: 0, y: 0, z: 0 }, 0, 0);
    await world.advance(2200);
    expect(await client().eval("return CALLED")).toBe(1);
    expect(world.allErrors().filter((e) => !e.includes("expected a spawn table"))).toEqual([]);
  });
});

describe("build output for the KVP page", () => {
  it("adds the hidden page and a webui folder to a client resource without ui_page", async () => {
    const root = mkdtempSync(join(tmpdir(), "fxkvpbuild-"));
    const src = join(root, "plain");
    mkdirSync(src);
    writeFileSync(join(src, "fxmanifest.lua"), "client_script 'c.lua'\nserver_script 's.lua'\n");
    writeFileSync(join(src, "c.lua"), "print('c')\n");
    writeFileSync(join(src, "s.lua"), "print('s')\n");
    const out = join(root, "out");
    await convertResource({ resourceDir: src, outDir: out });
    const manifest: { webui?: string[] } = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.webui).toEqual(["webui"]);
    expect(existsSync(join(out, "webui", "_fxcompat", "kvp.html"))).toBe(true);
    expect(readFileSync(join(out, "_fxcompat", "config.lua"), "utf8")).toContain('kvpPage = "_fxcompat/kvp.html"');
  });

  it("puts the page in the existing webui folder and leaves server only resources alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "fxkvpbuild-"));
    const ui = join(root, "ui");
    mkdirSync(join(ui, "html"), { recursive: true });
    writeFileSync(join(ui, "fxmanifest.lua"), "client_script 'c.lua'\nui_page 'html/index.html'\n");
    writeFileSync(join(ui, "c.lua"), "print('c')\n");
    writeFileSync(join(ui, "html", "index.html"), "<html></html>");
    await convertResource({ resourceDir: ui, outDir: join(root, "ui-out") });
    expect(existsSync(join(root, "ui-out", "html", "_fxcompat", "kvp.html"))).toBe(true);

    const only = join(root, "only");
    mkdirSync(only);
    writeFileSync(join(only, "fxmanifest.lua"), "server_script 's.lua'\n");
    writeFileSync(join(only, "s.lua"), "print('s')\n");
    await convertResource({ resourceDir: only, outDir: join(root, "only-out") });
    expect(existsSync(join(root, "only-out", "webui"))).toBe(false);
    expect(readFileSync(join(root, "only-out", "_fxcompat", "config.lua"), "utf8")).not.toContain("kvpPage =");
  });
});

describe("playerSpawned on the server", () => {
  it("is routed from the playerSpawn engine event with the player as source", async () => {
    const world = await World.withShim({ clients: 1 });
    try {
      await world.server.eval("AddEventHandler('playerSpawned', function(spawn) GOT = { source, spawn.x, spawn.heading } end)");
      world.server.fire("playerSpawn", 1, { x: 1, y: 2, z: 3 }, 90, 123, true);
      await world.advance(30);
      expect(await world.server.eval("return GOT")).toEqual([1, 1, 90]);
    } finally {
      world.close();
    }
  });
});
