import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, nth, type JsResource } from "./harness.ts";

const JS_SERVER = `
  globalThis.SEEN = [];
  AddStateBagChangeHandler('job', null, (bag, key, value, reserved, replicated) => {
    SEEN.push([bag, key, value?.name ?? value, reserved, replicated]);
  });
  globalThis.PRIV = [];
  AddStateBagChangeHandler('secret', 'player:1', (bag, key, value, _, replicated) => { PRIV.push([bag, key, value, replicated]); });
`;

const JS_CLIENT = `
  globalThis.SEEN = [];
  AddStateBagChangeHandler(null, 'global', (bag, key, value, reserved, replicated) => { SEEN.push([bag, key, value, reserved, replicated]); });
  globalThis.KEYED = [];
  globalThis.COOKIE = AddStateBagChangeHandler('fuel', null, (bag, key, value) => { KEYED.push([bag, key, value]); });
`;

const LUA_SERVER = `
  LUA_SEEN = {}
  AddStateBagChangeHandler('shared', nil, function(bag, key, value) LUA_SEEN[#LUA_SEEN + 1] = { bag, key, value } end)
`;

let world: World;
let js: JsResource;

beforeAll(async () => {
  world = await World.withShim({ clients: 2, peers: true, resource: "luares", server: LUA_SERVER });
  js = world.addJs("jsres");
  await world.loadJsShim(js);
  js.server.load("server.js", JS_SERVER);
  for (const vm of js.clients) vm.load("client.js", JS_CLIENT);
  await world.advance(50);
});
afterAll(() => world.close());

const server = <T = unknown>(code: string): Promise<T> => js.server.eval<T>(code);
const client = <T = unknown>(index: number, code: string): Promise<T> => nth(js.clients, index - 1).eval<T>(code);
const luaServer = <T = unknown>(code: string): Promise<T> => world.server.eval<T>(code);
const luaClient = <T = unknown>(index: number, code: string): Promise<T> => nth(world.clients, index - 1).eval<T>(code);

describe("JS global state", () => {
  it("a server write is readable on the server and every client and fires the handlers", async () => {
    await server("GlobalState.playerCount = 3; GlobalState.set('cfg', { a: 1, b: ['x', 'y'] }, true); return 0");
    await world.advance(300);
    expect(await server("return GlobalState.playerCount")).toBe(3);
    expect(await client(1, "return GlobalState.playerCount")).toBe(3);
    expect(await client(2, "return GlobalState.cfg.b[0]")).toBe("x");
    expect(await client(1, "return SEEN[0]")).toEqual(["global", "playerCount", 3, 0, true]);
  });

  it("undefined deletes the key and a client write is refused with a warning", async () => {
    await server("GlobalState.playerCount = undefined; return 0");
    await world.advance(300);
    expect(await client(1, "return GlobalState.playerCount === undefined")).toBe(true);
    expect(await client(1, "GlobalState.cheat = 1; return GlobalState.cheat === undefined")).toBe(true);
    expect(nth(js.clients, 0).errors()).toEqual([]);
  });

  it("warns instead of raising when a value exceeds 8 KiB", async () => {
    const before = js.server.metaWrites.length;
    await server("GlobalState.big = 'x'.repeat(9000); return 0");
    expect(await server("return GlobalState.big === undefined")).toBe(true);
    expect(js.server.logs().join(" ")).toContain('state bag write of "big"');
    expect(js.server.metaWrites.length).toBe(before + 1);
  });
});

describe("JS player state", () => {
  it("replicates a server write and exposes LocalPlayer.state", async () => {
    await server("Player(1).state.job = { name: 'cop' }; Player('2').state.set('job', { name: 'medic' }, true); return 0");
    await world.advance(300);
    expect(await client(2, "return Player(1).state.job.name")).toBe("cop");
    expect(await client(1, "return LocalPlayer.state.job.name")).toBe("cop");
    expect(await client(2, "return LocalPlayer.state.job.name")).toBe("medic");
    expect(await server("return SEEN.map((e) => e[0] + ':' + e[2]).join(',')")).toBe("player:1:cop,player:2:medic");
  });

  it("a client may write its own player state, which the server sees", async () => {
    await client(1, "LocalPlayer.state.mood = 'happy'; return 0");
    await world.advance(300);
    expect(await server("return Player(1).state.mood")).toBe("happy");
    expect(await client(2, "return Player(1).state.mood")).toBe("happy");
  });

  it("set(key, value, false) stays on the server and never reaches the meta layer", async () => {
    const before = js.server.metaWrites.length;
    await server("Player(1).state.set('secret', 'hunter2', false); return 0");
    await world.advance(300);
    expect(await server("return Player(1).state.secret")).toBe("hunter2");
    expect(await server("return lsmp.getPlayerMeta(1, 'secret')")).toBeNull();
    expect(js.server.metaWrites.length).toBe(before);
    expect(await client(1, "return Player(1).state.secret === undefined")).toBe(true);
    expect(await client(2, "return lsmp.getPlayerMeta(1, 'secret')")).toBeNull();
    expect(await server("return PRIV[0].join(':')")).toBe("player:1:secret:hunter2:false");
  });

  it("a replicated write replaces a server-only value", async () => {
    await server("Player(1).state.secret = 'public'; return 0");
    await world.advance(300);
    expect(await server("return Player(1).state.secret")).toBe("public");
    expect(await client(2, "return Player(1).state.secret")).toBe("public");
  });
});

describe("JS entity state and handlers", () => {
  it("maps a client handle to the net id and keeps server-only values off the clients", async () => {
    await server("Entity(77).state.fuel = 0.5; Entity(77).state.set('owner', 'x', false); return 0");
    await world.advance(300);
    expect(await server("return Entity(77).state.fuel")).toBe(0.5);
    expect(await client(1, "return Entity(NetworkGetEntityFromNetworkId(77)).state.fuel")).toBe(0.5);
    expect(await client(1, "return Entity(NetworkGetEntityFromNetworkId(77)).state.owner === undefined")).toBe(true);
    expect(await client(1, "return KEYED[0].join(':')")).toBe("entity:77:fuel:0.5");
  });

  it("resolves bag names", async () => {
    expect(await server("return [GetEntityFromStateBagName('entity:77'), GetPlayerFromStateBagName('player:2'), GetPlayerFromStateBagName('global')]")).toEqual([77, 2, 0]);
    expect(await client(1, "return GetEntityFromStateBagName('entity:77')")).toBe(10077);
  });

  it("RemoveStateBagChangeHandler stops the callbacks", async () => {
    await client(1, "RemoveStateBagChangeHandler(COOKIE); return 0");
    await server("Entity(77).state.fuel = 0.25; return 0");
    await world.advance(300);
    expect(await client(1, "return KEYED.length")).toBe(1);
    expect(await client(1, "return Entity(NetworkGetEntityFromNetworkId(77)).state.fuel")).toBe(0.25);
  });
});

describe("Lua and JS see each other's state bags", () => {
  it("a Lua server write reaches the JS server, the JS clients and the handlers", async () => {
    await luaServer("GlobalState.shared = { n = 1, list = { 'a', 'b' } } Player(2).state.lang = 'fr' Entity(88).state.hp = 12.5");
    await world.advance(300);
    expect(await server("return GlobalState.shared")).toEqual({ n: 1, list: ["a", "b"] });
    expect(await server("return [Player(2).state.lang, Entity(88).state.hp]")).toEqual(["fr", 12.5]);
    expect(await client(2, "return GlobalState.shared.list[0]")).toBe("a");
    expect(await client(2, "return LocalPlayer.state.lang")).toBe("fr");
  });

  it("a JS server write reaches the Lua server, the Lua clients and the Lua handlers", async () => {
    await server("GlobalState.shared = { n: 2, list: ['c'] }; Player(1).state.lang = 'en'; return 0");
    await world.advance(300);
    expect(await luaServer("return GlobalState.shared.n")).toBe(2);
    expect(await luaServer("return Player(1).state.lang")).toBe("en");
    expect(await luaClient(2, "return GlobalState.shared.list[1]")).toBe("c");
    expect(await luaClient(1, "return LocalPlayer.state.lang")).toBe("en");
    expect(await luaServer("return LUA_SEEN[#LUA_SEEN][3].n")).toBe(2);
  });

  it("a JS client write to its own player reaches the Lua server and client", async () => {
    await client(2, "LocalPlayer.state.pose = { x: 1, y: 2, z: 3 }; return 0");
    await world.advance(300);
    expect(await luaServer("local p = Player(2).state.pose return { p.x, p.y, p.z }")).toEqual([1, 2, 3]);
    expect(await luaClient(1, "return Player(2).state.pose.z")).toBe(3);
  });

  it("a server-only value stays private to its language", async () => {
    await luaServer("Player(1).state:set('luaSecret', 's', false)");
    await server("Player(1).state.set('jsSecret', 'j', false); return 0");
    await world.advance(300);
    expect(await server("return Player(1).state.luaSecret === undefined")).toBe(true);
    expect(await luaServer("return Player(1).state.jsSecret")).toBeNull();
    expect(await client(1, "return Player(1).state.jsSecret === undefined")).toBe(true);
  });
});
