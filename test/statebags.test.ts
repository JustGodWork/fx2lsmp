import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World } from "./harness.ts";

let world: World;

const serverCode = `
  SEEN = {}
  AddStateBagChangeHandler('job', nil, function(bag, key, value, reserved, replicated)
    SEEN[#SEEN + 1] = { bag, key, value and value.name or value, reserved, replicated }
  end)
  PRIV = {}
  AddStateBagChangeHandler('secret', 'player:1', function(bag, key, value, _, replicated)
    PRIV[#PRIV + 1] = { bag, key, value, replicated }
  end)
`;

const clientCode = `
  SEEN = {}
  AddStateBagChangeHandler(nil, 'global', function(bag, key, value, reserved, replicated)
    SEEN[#SEEN + 1] = { bag, key, value, reserved, replicated }
  end)
  KEYED = {}
  COOKIE = AddStateBagChangeHandler('fuel', nil, function(bag, key, value) KEYED[#KEYED + 1] = { bag, key, value } end)
`;

beforeAll(async () => {
  world = await World.withShim({ clients: 2, server: serverCode, client: clientCode });
});
afterAll(() => world.close());

const server = <T = unknown>(code: string): Promise<T> => world.server.eval<T>(code);
const client = <T = unknown>(index: number, code: string): Promise<T> => world.clients[index - 1]!.eval<T>(code);

describe("global state", () => {
  it("a server write is readable on the server and on every client, and fires the handlers", async () => {
    await server("GlobalState.playerCount = 3 GlobalState:set('cfg', { a = 1, b = { 'x', 'y' } }, true)");
    await world.advance(300);
    expect(await server("return GlobalState.playerCount")).toBe(3);
    expect(await client(1, "return GlobalState.playerCount")).toBe(3);
    expect(await client(2, "return GlobalState.cfg.b[2]")).toBe("y");
    expect(await client(1, "return { SEEN[1][1], SEEN[1][2], SEEN[1][3], SEEN[1][4], SEEN[1][5] }")).toEqual([
      "global", "playerCount", 3, 0, true,
    ]);
  });

  it("nil deletes the key", async () => {
    await server("GlobalState.playerCount = nil");
    await world.advance(300);
    expect(await client(1, "return GlobalState.playerCount")).toBeNull();
    expect(await server("return GlobalState.playerCount")).toBeNull();
  });

  it("refuses a client write with a warning instead of raising", async () => {
    const ok = await client(1, "GlobalState.cheat = 1 return GlobalState.cheat == nil");
    expect(ok).toBe(true);
  });

  it("warns instead of raising when a value exceeds 8 KiB", async () => {
    const before = await server<number>("return #lsmp.__test.metaWrites");
    await server("GlobalState.big = string.rep('x', 9000)");
    expect(await server("return GlobalState.big")).toBeNull();
    expect(world.server.logs().join(" ")).toContain('state bag write of "big"');
    expect(await server<number>("return #lsmp.__test.metaWrites")).toBe(before + 1);
  });
});

describe("player state", () => {
  it("replicates a server write to the clients and fires the keyed handler", async () => {
    await server("Player(1).state.job = { name = 'cop' } Player('2').state:set('job', { name = 'medic' }, true)");
    await world.advance(300);
    expect(await client(2, "return Player(1).state.job.name")).toBe("cop");
    expect(await client(1, "return Player(2).state.job.name")).toBe("medic");
    expect(await client(1, "return LocalPlayer.state.job.name")).toBe("cop");
    expect(await client(2, "return LocalPlayer.state.job.name")).toBe("medic");
    expect(await server("return SEEN[1][1] .. ':' .. SEEN[1][3] .. ':' .. SEEN[2][1]")).toBe("player:1:cop:player:2");
  });

  it("a client may write its own player state, which the server sees", async () => {
    await client(1, "LocalPlayer.state.mood = 'happy'");
    await world.advance(300);
    expect(await server("return Player(1).state.mood")).toBe("happy");
    expect(await client(2, "return Player(1).state.mood")).toBe("happy");
  });

  it("set(key, value, false) stays on the server and never reaches a client or the meta layer", async () => {
    const before = await server<number>("return #lsmp.__test.metaWrites");
    await server("Player(1).state:set('secret', 'hunter2', false)");
    await world.advance(300);
    expect(await server("return Player(1).state.secret")).toBe("hunter2");
    expect(await server("return lsmp.getPlayerMeta(1, 'secret')")).toBeNull();
    expect(await server<number>("return #lsmp.__test.metaWrites")).toBe(before);
    expect(await client(1, "return Player(1).state.secret")).toBeNull();
    expect(await client(2, "return Player(1).state.secret")).toBeNull();
    expect(await client(2, "return lsmp.getPlayerMeta(1, 'secret')")).toBeNull();
    expect(await server("return PRIV[1][1] .. ':' .. PRIV[1][3] .. ':' .. tostring(PRIV[1][4])")).toBe("player:1:hunter2:false");
  });

  it("a replicated write replaces a server-only value", async () => {
    await server("Player(1).state.secret = 'public'");
    await world.advance(300);
    expect(await server("return Player(1).state.secret")).toBe("public");
    expect(await client(2, "return Player(1).state.secret")).toBe("public");
  });
});

describe("entity state", () => {
  it("maps a client handle to the net id and replicates the server bag", async () => {
    await server("Entity(77).state.fuel = 0.5 Entity(77).state:set('owner', 'x', false)");
    await world.advance(300);
    expect(await server("return Entity(77).state.fuel")).toBe(0.5);
    expect(await client(1, "return Entity(NetworkGetEntityFromNetworkId(77)).state.fuel")).toBe(0.5);
    expect(await client(1, "return Entity(NetworkGetEntityFromNetworkId(77)).state.owner")).toBeNull();
    expect(await client(1, "return KEYED[1][1] .. ':' .. KEYED[1][2] .. ':' .. KEYED[1][3]")).toBe("entity:77:fuel:0.5");
  });

  it("resolves bag names", async () => {
    expect(await server("return GetEntityFromStateBagName('entity:77')")).toBe(77);
    expect(await server("return GetPlayerFromStateBagName('player:2')")).toBe(2);
    expect(await server("return GetPlayerFromStateBagName('global')")).toBe(0);
    expect(await client(1, "return GetEntityFromStateBagName('entity:77')")).toBe(10077);
  });
});

describe("handler removal", () => {
  it("RemoveStateBagChangeHandler stops the callbacks", async () => {
    await client(1, "RemoveStateBagChangeHandler(COOKIE)");
    await server("Entity(77).state.fuel = 0.25");
    await world.advance(300);
    expect(await client(1, "return #KEYED")).toBe(1);
    expect(await client(1, "return Entity(NetworkGetEntityFromNetworkId(77)).state.fuel")).toBe(0.25);
  });
});
