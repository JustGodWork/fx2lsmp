import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, nth, type JsResource, type LuaResource } from "./harness.ts";
import type { JsVm } from "./js-vm.ts";

const HELD = ["setVehicleNumberPlateText", "setVehicleDoorsLocked", "freezeEntityPosition", "setEntityCoords", "setEntityHeading",
  "setEntityVelocity", "setPedArmour", "setEntityHealth", "giveWeaponToPed", "requestModel", "setPlayerModel", "setModelAsNoLongerNeeded"];

let world: World;
let jsj: JsResource;
let jsl: JsResource;
let jslLua: LuaResource;
let luj: JsResource;
let lujLua: LuaResource;
let joff: JsResource;
let dual: JsResource;
let dualLua: LuaResource;

beforeAll(async () => {
  world = await World.create({ luaMain: false, clients: 2 });
  jsj = world.addJs("jsj");
  await world.loadJsShim(jsj);
  jsl = world.addJs("jsl");
  await world.loadJsShim(jsl, {}, "server");
  jslLua = await world.addLua("jsl");
  await world.loadLuaShim(jslLua, "client");
  luj = world.addJs("luj");
  await world.loadJsShim(luj, {}, "client");
  lujLua = await world.addLua("luj");
  await world.loadLuaShim(lujLua);
  joff = world.addJs("joff");
  await world.loadJsShim(joff, { b1Workarounds: false });
  dual = world.addJs("dual");
  await world.loadJsShim(dual, { applyEntities: false }, "client");
  dualLua = await world.addLua("dual");
  await world.loadLuaShim(dualLua);
  await world.advance(50);
});
afterAll(() => world.close());

const calls = (vm: JsVm): unknown[][] =>
  vm.natives.filter((n) => HELD.includes(n.name)).map((n) => [n.name, ...n.args.slice(0, n.name === "setEntityCoords" || n.name === "setEntityVelocity" ? 4 : 3)]);

async function adoptJs(res: JsResource, netId: number, player: number): Promise<void> {
  nth(res.clients, player - 1).owners.set(netId, player - 1);
  res.server.setOwner(netId, player - 1);
  await world.advance(300);
}

describe("server creation", () => {
  it("creates persistent entities from hashes (signed or not) and names", async () => {
    const ids = await jsj.server.eval<number[]>(`
      return [
        CreateVehicle(-1216765807, 1, 2, 3, 90, true, true), CreateVehicle(3078201489, 1, 2, 3, 0),
        CreatePed(4, 'a_m_y_skater_01', 0, 0, 70, 10, true, false), CreateObject(12345, 5, 6, 7, true, true, false),
        CreateObjectNoOffset(777, 1, 1, 1), CreateVehicleServerSetter('adder', 'automobile', 0, 0, 0, 45), CreateVehicle(0, 0, 0, 0, 0),
        CreateVehicle('0', 0, 0, 0, 0),
      ];
    `);
    const [a, b, c, d, e, f, g, h] = ids;
    const entities = jsj.server.entities;
    expect([entities.get(a ?? 0)?.model, entities.get(b ?? 0)?.model]).toEqual([3078201489, 3078201489]);
    expect(entities.get(a ?? 0)?.opts).toEqual({ lifePolicy: "keep", heading: 90 });
    expect(entities.get(c ?? 0)?.type).toBe("ped");
    expect(entities.get(d ?? 0)?.opts["heading"]).toBeUndefined();
    expect(entities.get(e ?? 0)?.type).toBe("object");
    expect(entities.get(f ?? 0)?.type).toBe("vehicle");
    expect([g, h]).toEqual([0, 0]);
  });

  it("answers model, type, owner and routing bucket reads", async () => {
    const result = await jsj.server.eval<number[]>(`
      const v = CreateVehicle(500, 0, 0, 0, 0), p = CreatePed(4, 501, 0, 0, 0, 0), o = CreateObject(502, 0, 0, 0);
      SetEntityRoutingBucket(v, 9);
      return [GetEntityModel(v), GetEntityType(v), GetEntityType(p), GetEntityType(o), GetEntityType(999999999),
        NetworkGetEntityOwner(v), GetEntityRoutingBucket(v), GetEntityRoutingBucket(p)];
    `);
    expect(result).toEqual([500, 2, 1, 3, 0, -1, 9, 0]);
  });
});

describe("orphans and owner changes between JS shims", () => {
  let car = 0;

  it("queues setters until an owner adopts the entity", async () => {
    car = await jsj.server.eval<number>(`
      const v = CreateVehicle(600, 0, 0, 0, 0);
      SetEntityCoords(v, 1, 2, 3); SetEntityCoords(v, 10, 20, 30); SetEntityHeading(v, 180);
      SetVehicleNumberPlateText(v, 'FXC 001'); SetVehicleDoorsLocked(v, 2); FreezeEntityPosition(v, true);
      SetEntityVelocity(v, 0, 0, 5); SetPedArmour(v, 50);
      return v;
    `);
    await world.advance(300);
    expect(calls(nth(jsj.clients, 0))).toEqual([]);
    await adoptJs(jsj, car, 1);
    const handle = car + 10000;
    expect(calls(nth(jsj.clients, 0))).toEqual([
      ["setVehicleNumberPlateText", handle, "FXC 001"],
      ["setVehicleDoorsLocked", handle, 2],
      ["freezeEntityPosition", handle, true],
      ["setEntityCoords", handle, 10, 20, 30],
      ["setEntityHeading", handle, 180],
      ["setEntityVelocity", handle, 0, 0, 5],
      ["setPedArmour", handle, 50],
    ]);
    expect(calls(nth(jsj.clients, 1))).toEqual([]);
  });

  it("sends later setters straight to the owner and re-applies persistent state to a new owner", async () => {
    await jsj.server.eval(`SetEntityCoords(${car}, 7, 8, 9)`);
    await world.advance(100);
    expect(calls(nth(jsj.clients, 0)).at(-1)).toEqual(["setEntityCoords", car + 10000, 7, 8, 9]);
    await adoptJs(jsj, car, 2);
    expect(calls(nth(jsj.clients, 1))).toEqual([
      ["setVehicleNumberPlateText", car + 10000, "FXC 001"],
      ["setVehicleDoorsLocked", car + 10000, 2],
      ["freezeEntityPosition", car + 10000, true],
    ]);
  });

  it("ignores a message when the receiving client does not own the entity", async () => {
    const first = nth(jsj.clients, 0);
    const before = calls(first).length;
    first.owners.set(car, 1);
    jsj.server.owners.set(car, 0);
    await jsj.server.eval(`SetEntityHeading(${car}, 5)`);
    await world.advance(3500);
    expect(calls(first).length).toBe(before);
    jsj.server.owners.set(car, 1);
  });

  it("keeps the last 32 one-shot actions of an orphan", async () => {
    const ped = await jsj.server.eval<number>(`
      const p = CreatePed(4, 'a_m_y_skater_01', 0, 0, 0, 0);
      for (let i = 1; i <= 40; i++) GiveWeaponToPed(p, 1000 + i, i);
      return p;
    `);
    const second = nth(jsj.clients, 1);
    second.natives.length = 0;
    await adoptJs(jsj, ped, 2);
    const weapons = second.natives.filter((n) => n.name === "giveWeaponToPed");
    expect(weapons).toHaveLength(32);
    expect(weapons[0]?.args.slice(1, 3)).toEqual([1009, 9]);
    expect(weapons.at(-1)?.args.slice(1, 3)).toEqual([1040, 40]);
  });

  it("forgets queued actions on delete, on a model change and on resource stop", async () => {
    const [stopped = 0, removed = 0, reused = 0] = await jsj.server.eval<number[]>(`
      const a = CreateVehicle(601, 0, 0, 0, 0), b = CreateVehicle(602, 0, 0, 0, 0), c = CreateVehicle(603, 0, 0, 0, 0);
      SetEntityCoords(a, 1, 1, 1);
      SetVehicleNumberPlateText(b, 'GONE'); SetEntityCoords(b, 2, 2, 2); DeleteEntity(b);
      SetEntityCoords(c, 3, 3, 3);
      return [a, b, c];
    `);
    const entity = jsj.server.entities.get(reused);
    if (entity !== undefined) entity.model = 999;
    await jsj.server.eval(`SetEntityHeading(${reused}, 1)`);
    jsj.server.fire("resourceStop", "jsj");
    const first = nth(jsj.clients, 0);
    first.natives.length = 0;
    for (const id of [stopped, removed]) await adoptJs(jsj, id, 1);
    expect(calls(first)).toEqual([]);
  });
});

describe("getters", () => {
  it("returns the last value set when there is no owner, and the Async twin does the same", async () => {
    const result = await jsj.server.eval<unknown[]>(`
      const v = CreateVehicle(701, 0, 0, 0, 33);
      const before = [GetEntityHeading(v), GetEntityHealth(v), GetVehicleNumberPlateText(v)];
      SetEntityHeading(v, 90); SetEntityHealth(v, 640); SetVehicleNumberPlateText(v, 'SET 1'); SetEntityVelocity(v, 1, 2, 3);
      return [...before, GetEntityHeading(v), GetEntityHealth(v), GetVehicleNumberPlateText(v), GetEntityVelocity(v),
        await GetEntityHeadingAsync(v), GetEntityHeading(424242)];
    `);
    expect(result).toEqual([33, 0, "", 90, 640, "SET 1", [1, 2, 3], 90, 0]);
  });

  it("asks the owner: the Async getters resolve fresh values and the sync ones catch up", async () => {
    const owner = nth(jsj.clients, 0);
    owner.nativeResults.set("getEntityHeading", 123.5);
    owner.nativeResults.set("getEntityHealth", 187);
    owner.nativeResults.set("getVehicleNumberPlateText", "LIVE 01");
    owner.nativeResults.set("getEntityVelocity", { x: 1, y: 2, z: 3 });
    const car = await jsj.server.eval<number>("return CreateVehicle(700, 0, 0, 0, 0)");
    await adoptJs(jsj, car, 1);
    const fresh = await jsj.server.eval<unknown[]>(`
      return [await GetEntityHeadingAsync(${car}), await GetEntityHealthAsync(${car}), await GetVehicleNumberPlateTextAsync(${car}),
        await GetEntityVelocityAsync(${car})];
    `);
    expect(fresh).toEqual([123.5, 187, "LIVE 01", [1, 2, 3]]);
    owner.nativeResults.set("getEntityHealth", 50);
    await world.advance(300);
    expect(await jsj.server.eval(`return GetEntityHealth(${car})`)).toBe(187);
    await world.advance(100);
    expect(await jsj.server.eval(`return GetEntityHealth(${car})`)).toBe(50);
  });

  it("applies a player model on the target client", async () => {
    const second = nth(jsj.clients, 1);
    second.natives.length = 0;
    await jsj.server.eval("SetPlayerModel(2, -1692214353)");
    await world.advance(300);
    expect(calls(second).map((c) => c[0])).toEqual(["requestModel", "setPlayerModel", "setModelAsNoLongerNeeded"]);
    expect(calls(second)[0]?.[1]).toBe(2602752943);
  });
});

describe("JS server with a Lua client", () => {
  const luaClient = (): LuaResource["server"] => nth(jslLua.clients, 0);

  it("drives the Lua client with the same event and op shapes, and reads through the same query", async () => {
    const car = await jsl.server.eval<number>(`
      const v = CreateVehicle(800, 0, 0, 0, 0);
      SetVehicleNumberPlateText(v, 'JS 001'); SetEntityCoords(v, 4, 5, 6); GiveWeaponToPed(v, 'weapon_pistol', 30);
      return v;
    `);
    await luaClient().eval(`lsmp.__test.owners[${car}] = 0`);
    jsl.server.setOwner(car, 0);
    await world.advance(300);
    const names = await luaClient().eval<string[]>(
      "local o = {} for _, c in ipairs(lsmp.__test.natives) do o[#o + 1] = c.name end return o",
    );
    expect(names).toEqual(["setVehicleNumberPlateText", "setEntityCoords", "giveWeaponToPed"]);
    const fresh = await jsl.server.eval<unknown[]>(`
      return [await GetEntityHeadingAsync(${car}), await GetEntityHealthAsync(${car}), await GetVehicleNumberPlateTextAsync(${car}),
        await GetEntityVelocityAsync(${car})];
    `);
    expect(fresh).toEqual([123.5, 187, "LIVE 01", [1, 2, 3]]);
  });
});

describe("Lua server with a JS client", () => {
  const luaServer = (): LuaResource["server"] => lujLua.server;
  const jsClient = (): JsVm => nth(luj.clients, 0);

  it("drives the JS client and answers its queries from the Lua server", async () => {
    const car = await luaServer().eval<number>(`
      local v = CreateVehicle(900, 0.0, 0.0, 0.0, 0.0)
      SetVehicleNumberPlateText(v, 'LUA 001') SetEntityCoords(v, 4.0, 5.0, 6.0) SetPedArmour(v, 25)
      return v
    `);
    jsClient().owners.set(car, 0);
    await luaServer().eval(`lsmp.__test.setOwner(${car}, 0)`);
    await world.advance(300);
    const handle = car + 10000;
    expect(calls(jsClient())).toEqual([
      ["setVehicleNumberPlateText", handle, "LUA 001"],
      ["setEntityCoords", handle, 4, 5, 6],
      ["setPedArmour", handle, 25],
    ]);
    jsClient().nativeResults.set("getEntityHeading", 12.5);
    jsClient().nativeResults.set("getEntityVelocity", { x: 1, y: 2, z: 3 });
    const read = await luaServer().eval<number[]>(`
      local v = GetEntityVelocity(${car})
      return { GetEntityHeading(${car}), v.x, v.y, v.z }
    `);
    expect(read).toEqual([12.5, 1, 2, 3]);
  });

  it("a JS client B1 delete reaches the Lua server, which checks ownership", async () => {
    const [mine = 0, theirs = 0] = await luaServer().eval<number[]>(`
      local a = CreateVehicle(901, 0.0, 0.0, 0.0, 0.0)
      local b = CreateVehicle(902, 0.0, 0.0, 0.0, 0.0)
      lsmp.__test.owners[a] = 0
      lsmp.__test.owners[b] = 1
      return { a, b }
    `);
    await jsClient().eval(`DeleteEntity(${mine + 10000}); DeleteVehicle(${theirs + 10000})`);
    await world.advance(50);
    expect(await luaServer().eval(`local d = lsmp.__test.deleted return { d[${mine}] == true, d[${theirs}] == nil }`)).toEqual([true, true]);
  });
});

describe("B1 workarounds in JS", () => {
  const client = (): JsVm => nth(jsj.clients, 0);

  it("a JS client delete reaches the JS server, which checks existence and ownership", async () => {
    const [mine = 0, theirs = 0] = await jsj.server.eval<number[]>(`
      return [CreateVehicle(950, 0, 0, 0, 0), CreateVehicle(951, 0, 0, 0, 0)];
    `);
    jsj.server.owners.set(mine, 0);
    jsj.server.owners.set(theirs, 1);
    client().natives.length = 0;
    await client().eval(`DeleteEntity(${mine + 10000}); DeletePed(${theirs + 10000}); DeleteObject(10999999)`);
    await world.advance(50);
    expect([jsj.server.deleted.has(mine), jsj.server.deleted.has(theirs)]).toEqual([true, false]);
    expect(client().natives.filter((n) => n.name.startsWith("delete"))).toEqual([]);
  });

  it("a non-networked entity falls back to the native with one warning", async () => {
    client().natives.length = 0;
    await client().eval("DeleteEntity(77); DeleteEntity(78)");
    expect(client().natives.filter((n) => n.name === "deleteEntity")).toHaveLength(2);
    expect(client().logs().filter((l) => l.includes("non-networked"))).toHaveLength(1);
  });

  it("RemoveBlip hides the blip and forgets it until the handle is reused", async () => {
    client().natives.length = 0;
    const result = await client().eval<boolean[]>(
      "const b = AddBlipForCoord(1, 2, 3); const before = DoesBlipExist(b); RemoveBlip(b); return [before, DoesBlipExist(b)]",
    );
    expect(result).toEqual([true, false]);
    expect(client().natives.map((n) => n.name)).toEqual(["setBlipDisplay", "setBlipAlpha"]);
  });

  it("is switched off by the single b1Workarounds flag", async () => {
    const off = nth(joff.clients, 0);
    off.natives.length = 0;
    await off.eval("DeleteEntity(10005); RemoveBlip(5)");
    expect(off.natives.map((n) => n.name)).toEqual(["deleteEntity", "removeBlip"]);
  });
});

describe("clean run", () => {
  it("no mock rule was broken in any VM", () => {
    expect(world.allErrors()).toEqual([]);
  });
});

describe("a client running both shims", () => {
  it("applies an owner proxied change once, from the Lua shim, when the JS shim is not the applier", async () => {
    const car = await dualLua.server.eval<number>(`
      local v = CreateVehicle(901, 0.0, 0.0, 0.0, 0.0)
      SetVehicleNumberPlateText(v, 'ONCE 01')
      return v
    `);
    const luaClient = nth(dualLua.clients, 0);
    const jsClient = nth(dual.clients, 0);
    jsClient.owners.set(car, 0);
    await luaClient.eval(`lsmp.__test.owners[${car}] = 0`);
    await dualLua.server.eval(`lsmp.__test.setOwner(${car}, 0)`);
    await world.advance(300);
    expect(calls(jsClient)).toEqual([]);
    const applied = await luaClient.eval<number>(
      "local n = 0 for _, c in ipairs(lsmp.__test.natives) do if c.name == 'setVehicleNumberPlateText' then n = n + 1 end end return n",
    );
    expect(applied).toBe(1);
  });
});

describe("server natives used by ESX in JS", () => {
  const warnings = (needle: string): number => jsj.server.logs().filter((line) => line.includes(needle)).length;

  it("sends warp, component, removal and ammo ops, creates a ped inside a vehicle, reads armour", async () => {
    const [ped, car, inside] = await jsj.server.eval<number[]>(`
      const p = CreatePed(4, 800, 0, 0, 0, 0), v = CreateVehicle(801, 0, 0, 0, 0);
      return [p, v, CreatePedInsideVehicle(v, 1, 803, 0, true, true)];
    `) as [number, number, number];
    const first = nth(jsj.clients, 0);
    await adoptJs(jsj, ped, 1);
    await adoptJs(jsj, inside, 1);
    first.natives.length = 0;
    await jsj.server.eval(`
      TaskWarpPedIntoVehicle(${ped}, ${car}, -1); GiveWeaponComponentToPed(${ped}, 1111, 2222);
      RemoveWeaponFromPed(${ped}, 1111); SetPedAmmo(${ped}, 1111, 90);
    `);
    await world.advance(300);
    const names = ["setPedIntoVehicle", "giveWeaponComponentToPed", "removeWeaponFromPed", "setPedAmmo"];
    expect(first.natives.filter((n) => names.includes(n.name)).map((n) => [n.name, ...n.args])).toEqual([
      ["setPedIntoVehicle", ped + 10000, car + 10000, -1],
      ["giveWeaponComponentToPed", ped + 10000, 1111, 2222],
      ["removeWeaponFromPed", ped + 10000, 1111],
      ["setPedAmmo", ped + 10000, 1111, 90],
    ]);
    expect(inside).toBeGreaterThan(0);
    expect(await jsj.server.eval<number>("return CreatePedInsideVehicle(0, 1, 803, 0)")).toBe(0);
    first.nativeResults.set("getPedArmour", 42);
    expect(await jsj.server.eval<number>(`return await GetPedArmourAsync(${ped})`)).toBe(42);
    expect(await jsj.server.eval<number>("const p = CreatePed(4, 804, 0, 0, 0, 0); SetPedArmour(p, 30); return GetPedArmour(p)")).toBe(30);
  });

  it("lists vehicles only, answers ping and time online, refuses StopResource", async () => {
    const [vehicle, ped, all] = await jsj.server.eval<[number, number, number[]]>(`
      const v = CreateVehicle(805, 0, 0, 0, 0), p = CreatePed(4, 806, 0, 0, 0, 0);
      return [v, p, GetAllVehicles()];
    `);
    expect(all).toContain(vehicle);
    expect(all).not.toContain(ped);
    expect(await jsj.server.eval<number[]>("return [GetPedInVehicleSeat(900, -1), GetPedInVehicleSeat(900, 0), GetVehiclePedIsIn(901), GetVehiclePedIsIn(5)]")).toEqual([901, 0, 900, 0]);
    expect(await jsj.server.eval<number[]>("return [GetPlayerPing(1), GetPlayerPing('2'), GetPlayerPing(99)]")).toEqual([1, 1, 0]);
    expect(await jsj.server.eval<number[]>("return [GetPlayerTimeOnline(1), GetPlayerTimeOnline(99)]")).toEqual([0, 0]);
    await world.advance(5200);
    expect(await jsj.server.eval<number>("return GetPlayerTimeOnline(1)")).toBe(5);
    expect(await jsj.server.eval<boolean[]>("return [StopResource('a'), StopResource('b')]")).toEqual([false, false]);
    expect(warnings("StopResource")).toBe(1);
    expect(warnings("GetPlayerPing")).toBe(1);
  });
});
