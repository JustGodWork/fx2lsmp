import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World } from "./harness.ts";

let world: World;

beforeAll(async () => {
  world = await World.withShim({ clients: 2 });
});
afterAll(() => world.close());

const server = <T = unknown>(code: string): Promise<T> => world.server.eval<T>(code);
const client = <T = unknown>(index: number, code: string): Promise<T> => world.clients[index - 1]!.eval<T>(code);

type Call = unknown[];

async function natives(index: number): Promise<Call[]> {
  const raw = await client<Call[]>(
    index,
    "local r = {} for _, n in ipairs(lsmp.__test.natives) do r[#r + 1] = { n.name, n.args[1], n.args[2], n.args[3], n.args[4] } end return r",
  );
  return raw.map((call) => {
    const trimmed = [...call];
    while (trimmed.length > 1 && trimmed.at(-1) === null) trimmed.pop();
    return trimmed;
  });
}

async function adopt(netId: number, player: number): Promise<void> {
  await client(player, `lsmp.__test.owners[${netId}] = ${player}`);
  await server(`lsmp.__test.setOwner(${netId}, ${player})`);
  await world.advance(300);
}

describe("creation", () => {
  it("creates persistent entities from hashes (signed or not) and names", async () => {
    const result = await server<number[]>(`
      local a = CreateVehicle(-1216765807, 1.0, 2.0, 3.0, 90.0, true, true)
      local b = CreateVehicle(3078201489, 1, 2, 3, 0)
      local c = CreatePed(4, 'a_m_y_skater_01', 0.0, 0.0, 70.0, 10.0, true, false)
      local d = CreateObject(12345, 5.0, 6.0, 7.0, true, true, false)
      local e = CreateObjectNoOffset(777, 1.0, 1.0, 1.0)
      local f = CreateVehicleServerSetter('adder', 'automobile', 0.0, 0.0, 0.0, 45.0)
      local g = CreateVehicle(0, 0.0, 0.0, 0.0, 0.0)
      local en = lsmp.__test.entities
      return { en[a].model, en[b].model, en[a].opts.heading, en[a].opts.lifePolicy == 'keep' and 1 or 0, en[c].type == 'ped' and 1 or 0,
        en[d].type == 'object' and 1 or 0, en[d].opts.heading == nil and 1 or 0, en[e].type == 'object' and 1 or 0,
        en[f].type == 'vehicle' and 1 or 0, g }
    `);
    expect(result).toEqual([3078201489, 3078201489, 90, 1, 1, 1, 1, 1, 1, 0]);
  });

  it("answers model, type, owner and routing bucket reads", async () => {
    const result = await server<number[]>(`
      local v = CreateVehicle(500, 0.0, 0.0, 0.0, 0.0)
      local p = CreatePed(4, 501, 0.0, 0.0, 0.0, 0.0)
      local o = CreateObject(502, 0.0, 0.0, 0.0)
      SetEntityRoutingBucket(v, 9)
      return { GetEntityModel(v), GetEntityType(v), GetEntityType(p), GetEntityType(o), GetEntityType(999999999),
        NetworkGetEntityOwner(v), GetEntityRoutingBucket(v), GetEntityRoutingBucket(p) }
    `);
    expect(result).toEqual([500, 2, 1, 3, 0, -1, 9, 0]);
  });
});

describe("orphans and owner changes", () => {
  let car = 0;

  it("queues setters until an owner adopts the entity", async () => {
    car = await server<number>(`
      local v = CreateVehicle(600, 0.0, 0.0, 0.0, 0.0)
      SetEntityCoords(v, 1.0, 2.0, 3.0)
      SetEntityCoords(v, 10.0, 20.0, 30.0)
      SetEntityHeading(v, 180.0)
      SetVehicleNumberPlateText(v, 'FXC 001')
      SetVehicleDoorsLocked(v, 2)
      FreezeEntityPosition(v, true)
      SetEntityVelocity(v, 0.0, 0.0, 5.0)
      SetPedArmour(v, 50)
      return v
    `);
    await world.advance(300);
    expect(await natives(1)).toEqual([]);
    await adopt(car, 1);
    const handle = car + 10000;
    expect(await natives(1)).toEqual([
      ["setVehicleNumberPlateText", handle, "FXC 001"],
      ["setVehicleDoorsLocked", handle, 2],
      ["freezeEntityPosition", handle, true],
      ["setEntityCoords", handle, 10, 20, 30],
      ["setEntityHeading", handle, 180],
      ["setEntityVelocity", handle, 0, 0, 5],
      ["setPedArmour", handle, 50],
    ]);
    expect(await natives(2)).toEqual([]);
  });

  it("sends later setters straight to the owner and re-applies persistent state to a new owner", async () => {
    await server(`SetEntityCoords(${car}, 7.0, 8.0, 9.0)`);
    await world.advance(100);
    expect((await natives(1)).at(-1)).toEqual(["setEntityCoords", car + 10000, 7, 8, 9]);
    await adopt(car, 2);
    expect(await natives(2)).toEqual([
      ["setVehicleNumberPlateText", car + 10000, "FXC 001"],
      ["setVehicleDoorsLocked", car + 10000, 2],
      ["freezeEntityPosition", car + 10000, true],
    ]);
  });

  it("ignores a message when the receiving client does not own the entity", async () => {
    const before = (await natives(1)).length;
    await client(1, `lsmp.__test.owners[${car}] = 2`);
    await server(`lsmp.__test.owners[${car}] = 1 SetEntityHeading(${car}, 5.0)`);
    await world.advance(3500);
    expect((await natives(1)).length).toBe(before);
    await server(`lsmp.__test.owners[${car}] = 2`);
  });

  it("forgets queued actions on resource stop and on delete", async () => {
    const [stopped, removed] = await server<number[]>(`
      local a = CreateVehicle(601, 0.0, 0.0, 0.0, 0.0)
      local b = CreateVehicle(602, 0.0, 0.0, 0.0, 0.0)
      SetEntityCoords(a, 1.0, 1.0, 1.0)
      SetVehicleNumberPlateText(b, 'GONE')
      DeleteEntity(b)
      lsmp.__fire('resourceStop', 'unit')
      return { a, b }
    `);
    const before = (await natives(1)).length;
    await adopt(stopped!, 1);
    await adopt(removed!, 1);
    expect((await natives(1)).length).toBe(before);
  });
});

describe("getters", () => {
  it("asks the owner inside a coroutine", async () => {
    const car = await server<number>("return CreateVehicle(700, 0.0, 0.0, 0.0, 0.0)");
    await adopt(car, 1);
    const result = await server<unknown[]>(`
      local v = GetEntityVelocity(${car})
      return { GetEntityHeading(${car}), GetEntityHealth(${car}), GetVehicleNumberPlateText(${car}), v.x, v.y, v.z }
    `);
    expect(result).toEqual([123.5, 187, "LIVE 01", 1, 2, 3]);
  });

  it("falls back to the last value set when there is no owner", async () => {
    const result = await server<unknown[]>(`
      local v = CreateVehicle(701, 0.0, 0.0, 0.0, 33.0)
      local before = { GetEntityHeading(v), GetEntityHealth(v), GetVehicleNumberPlateText(v) }
      SetEntityHeading(v, 90.0)
      SetEntityHealth(v, 640)
      SetVehicleNumberPlateText(v, 'SET 1')
      SetEntityVelocity(v, 1.0, 2.0, 3.0)
      local vel = GetEntityVelocity(v)
      return { before[1], before[2], before[3], GetEntityHeading(v), GetEntityHealth(v), GetVehicleNumberPlateText(v), vel.z,
        GetEntityHeading(424242) }
    `);
    expect(result).toEqual([33, 0, "", 90, 640, "SET 1", 3, 0]);
  });

  it("falls back outside a host coroutine", async () => {
    const car = await server<number>("return CreateVehicle(702, 0.0, 0.0, 0.0, 12.0)");
    await adopt(car, 1);
    const value = await server<number>(`
      local co = coroutine.wrap(function() return GetEntityHeading(${car}) end)
      return co()
    `);
    expect(value).toBe(12);
  });
});

describe("player model", () => {
  it("is applied by the target client", async () => {
    await client(2, "lsmp.__test.natives = {}");
    await server("SetPlayerModel(2, -1692214353)");
    await world.advance(300);
    const calls = await natives(2);
    expect(calls.map((c) => c[0])).toEqual(["requestModel", "setPlayerModel", "setModelAsNoLongerNeeded"]);
    expect(calls[0]![1]).toBe(2602752943);
  });
});

describe("server natives used by ESX", () => {
  const warnings = async (needle: string): Promise<number> =>
    (await world.server.logs()).filter((line) => line.includes("WARN") && line.includes(needle)).length;

  it("sends warp, component, removal and ammo ops to the owner of a ped", async () => {
    const [ped, car] = await server<number[]>(`
      local p = CreatePed(4, 800, 0.0, 0.0, 0.0, 0.0)
      local v = CreateVehicle(801, 0.0, 0.0, 0.0, 0.0)
      return { p, v }
    `) as [number, number];
    await adopt(ped, 1);
    await client(1, "lsmp.__test.natives = {}");
    await server(`
      TaskWarpPedIntoVehicle(${ped}, ${car}, -1)
      GiveWeaponComponentToPed(${ped}, 1111, 2222)
      RemoveWeaponFromPed(${ped}, 1111)
      SetPedAmmo(${ped}, 1111, 90)
    `);
    await world.advance(300);
    const handle = ped + 10000;
    expect(await natives(1)).toEqual([
      ["setPedIntoVehicle", handle, car + 10000, -1],
      ["giveWeaponComponentToPed", handle, 1111, 2222],
      ["removeWeaponFromPed", handle, 1111],
      ["setPedAmmo", handle, 1111, 90],
    ]);
  });

  it("creates a ped inside a vehicle and seats it through its owner", async () => {
    const [ped, car] = await server<number[]>(`
      local v = CreateVehicle(802, 0.0, 0.0, 0.0, 0.0)
      return { CreatePedInsideVehicle(v, 1, 803, 0, true, true), v }
    `) as [number, number];
    expect(ped).toBeGreaterThan(0);
    expect(await server<number[]>(`local e = lsmp.__test.entities[${ped}] return { e.position.x, e.position.y, e.position.z }`)).toEqual([1, 2, 3]);
    await client(1, "lsmp.__test.natives = {}");
    await adopt(ped, 1);
    expect(await natives(1)).toEqual([["setPedIntoVehicle", ped + 10000, car + 10000, 0]]);
    expect(await server<number>("return CreatePedInsideVehicle(0, 1, 803, 0)")).toBe(0);
  });

  it("reads armour from the owner, then the last value set", async () => {
    const ped = await server<number>("return CreatePed(4, 804, 0.0, 0.0, 0.0, 0.0)");
    expect(await server<number>(`SetPedArmour(${ped}, 30) return GetPedArmour(${ped})`)).toBe(30);
    expect(await server<number>("return GetPedArmour(424242)")).toBe(0);
    await adopt(ped, 1);
    expect(await server<number>(`return GetPedArmour(${ped})`)).toBe(42);
  });

  it("maps the FiveM driver seat to the LS:MP one", async () => {
    expect(await server<number[]>("return { GetPedInVehicleSeat(900, -1), GetPedInVehicleSeat(900, 0), GetVehiclePedIsIn(901), GetVehiclePedIsIn(5), GetPedInVehicleSeat(0, -1) }")).toEqual([901, 0, 900, 0, 0]);
  });

  it("lists vehicles only", async () => {
    const [vehicle, ped, all] = await server<[number, number, number[]]>(`
      local v = CreateVehicle(805, 0.0, 0.0, 0.0, 0.0)
      local p = CreatePed(4, 806, 0.0, 0.0, 0.0, 0.0)
      return { v, p, GetAllVehicles() }
    `);
    expect(all).toContain(vehicle);
    expect(all).not.toContain(ped);
  });

  it("reports a nominal ping for connected players and 0 for others, with one warning", async () => {
    expect(await server<number[]>("return { GetPlayerPing(1), GetPlayerPing('2'), GetPlayerPing(99), GetPlayerPing('x') }")).toEqual([1, 1, 0, 0]);
    expect(await warnings("GetPlayerPing")).toBe(1);
  });

  it("counts seconds online from the first sighting", async () => {
    expect(await server<number[]>("return { GetPlayerTimeOnline(2), GetPlayerTimeOnline(99) }")).toEqual([0, 0]);
    await world.advance(5200);
    expect(await server<number>("return GetPlayerTimeOnline(2)")).toBe(5);
    world.server.fire("playerLeave", 2, "Player2", "quit", "bye");
    expect(await server<number>("return GetPlayerTimeOnline(2)")).toBe(0);
  });

  it("refuses StopResource with one warning", async () => {
    expect(await server<boolean[]>("return { StopResource('a'), StopResource('b') }")).toEqual([false, false]);
    expect(await warnings("StopResource")).toBe(1);
  });
});
