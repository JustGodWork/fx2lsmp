import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World } from "./harness.ts";

let world: World;
const serverCode = `
  CMD = {}
  RegisterCommand('hello', function(src, args, raw) CMD.hello = { src = src, args = args, raw = raw, source = source } end, false)
  RegisterCommand('secret', function(src, args, raw) CMD.secret = { src = src, raw = raw } end, true)
  RegisterCommand('Mixed.Case', function(src) CMD.mixed = src end)
`;

beforeAll(async () => {
  world = await World.withShim({
    clients: 2,
    server: serverCode,
    convars: { sv_hostname: "My Server", max_things: "32", flag: "true" },
  });
});
afterAll(() => world.close());

const server = (code: string) => world.server.eval(code);

describe("players", () => {
  it("lists ids as strings and resolves names", async () => {
    expect(await server("return GetPlayers()")).toEqual(["1", "2"]);
    expect(await server("return { GetPlayerName(2), GetPlayerName('1') }")).toEqual(["Player2", "Player1"]);
  });

  it("builds FiveM style identifiers", async () => {
    expect(await server("return GetPlayerIdentifiers(1)")).toEqual(["license:101", "ip:10.0.0.1", "name:Player1"]);
    expect(await server("return GetPlayerIdentifierByType(2, 'license')")).toBe("license:102");
    expect(await server("return GetPlayerIdentifierByType(2, 'steam') == nil")).toBe(true);
    expect(await server("return { GetNumPlayerIdentifiers(1), GetPlayerIdentifier(1, 1) }")).toEqual([3, "ip:10.0.0.1"]);
  });

  it("covers entities, routing buckets, ACE and DropPlayer", async () => {
    expect(await server("local c = GetEntityCoords(GetPlayerPed(1)) return { GetPlayerPed(2), c.x, c.z }")).toEqual([1001, 1, 3]);
    expect(await server("return { NetworkGetNetworkIdFromEntity(55), NetworkGetEntityFromNetworkId(55) }")).toEqual([55, 55]);
    expect(await server("SetPlayerRoutingBucket('2', 7) return GetPlayerRoutingBucket(2)")).toBe(7);
    await server("lsmp.__test.grants[0] = { ['command.secret'] = true }");
    expect(await server("return { IsPlayerAceAllowed(1, 'command.secret'), IsPlayerAceAllowed('2', 'command.secret') }")).toEqual([true, false]);
    await server("DropPlayer('2', 'bye')");
    expect(await server("return lsmp.__test.kicks[1]")).toEqual({ id: 1, reason: "bye" });
  });
});

describe("KVP", () => {
  it("stores strings, ints and floats with their types", async () => {
    expect(
      await server(`
        SetResourceKvp('s', 'text')
        SetResourceKvpInt('i', 41.0)
        SetResourceKvpFloat('f', 3)
        return { GetResourceKvpString('s'), GetResourceKvpInt('i'), math.type(GetResourceKvpInt('i')), GetResourceKvpFloat('f'), math.type(GetResourceKvpFloat('f')) }
      `),
    ).toEqual(["text", 41, "integer", 3, "float"]);
  });

  it("returns nil, 0 and 0.0 for missing keys and deletes", async () => {
    expect(await server("return { GetResourceKvpString('none') == nil, GetResourceKvpInt('none'), GetResourceKvpFloat('none') }")).toEqual([true, 0, 0]);
    await server("SetResourceKvp('gone', 'x') DeleteResourceKvp('gone')");
    expect(await server("return GetResourceKvpString('gone') == nil")).toBe(true);
  });

  it("iterates a prefix with StartFindKvp", async () => {
    expect(
      await server(`
        SetResourceKvp('item:b', '2') SetResourceKvp('item:a', '1') SetResourceKvp('other', '3')
        local h = StartFindKvp('item:')
        local keys = {}
        while true do local k = FindKvp(h) if not k then break end keys[#keys + 1] = k end
        EndFindKvp(h)
        return keys
      `),
    ).toEqual(["item:a", "item:b"]);
  });

  it("persists in the storage across a restart of the server VM", async () => {
    await server("SetResourceKvpInt('boots', 5)");
    const dump = world.server.storageDump();
    const second = await World.withShim({ clients: 0 });
    second.server.storageLoad(dump);
    expect(await second.server.eval("return GetResourceKvpInt('boots')")).toBe(5);
    second.close();
  });
});

describe("commands", () => {
  it("runs a restricted false command for a player with FiveM arguments", async () => {
    await server("__runCommand(0, 'hello a b')");
    await world.advance(30);
    expect(await server("return CMD.hello")).toEqual({ src: 1, args: ["a", "b"], raw: "hello a b", source: 1 });
  });

  it("lets every player run a command registered without the restricted flag", async () => {
    expect(await server("return __runCommand(1, 'Mixed.Case')")).toBe("ok");
    await world.advance(30);
    expect(await server("return CMD.mixed")).toBe(2);
  });

  it("denies a restricted command until the player has the permission", async () => {
    expect(await server("return __runCommand(1, 'secret')")).toBe("denied");
    expect(await server("return __runCommand(0, 'secret now')")).toBe("ok");
    await world.advance(30);
    expect(await server("return CMD.secret")).toEqual({ src: 1, raw: "secret now" });
  });

  it("uses source 0 for the console and ignores command case", async () => {
    await server("__runCommand(nil, 'mixed.case')");
    await world.advance(30);
    expect(await server("return CMD.mixed")).toBe(0);
  });
});

describe("convars and http", () => {
  it("reads the config convars", async () => {
    expect(await server("return { GetConvar('sv_hostname', 'x'), GetConvar('missing', 'dflt'), GetConvarInt('max_things', 1), GetConvarInt('missing', 9), GetConvarBool('flag', false) }")).toEqual([
      "My Server",
      "dflt",
      32,
      9,
      true,
    ]);
  });

  it("PerformHttpRequest calls back with status and body", async () => {
    const result = await server(`
      local got
      PerformHttpRequest('https://example.test/a', function(status, body, headers) got = { status, body } end, 'POST', '{"x":1}', { ['X-Test'] = '1' })
      Wait(50)
      local req = lsmp.__test.httpRequests[1]
      return { got[1], got[2], req.method, req.body, req.headers['X-Test'] }
    `);
    expect(result).toEqual([200, '{"ok":true}', "POST", '{"x":1}', "1"]);
  });

  it("GetGameTimer, LoadResourceFile and GetResourceState", async () => {
    await server("lsmp.__test.files['data.json'] = '{}'");
    expect(await server("return { LoadResourceFile(GetCurrentResourceName(), 'data.json'), LoadResourceFile('other', 'data.json') == nil, GetResourceState('unit'), GetResourceState('x') }")).toEqual(["{}", true, "started", "missing"]);
    expect(await server("return type(GetGameTimer())")).toBe("number");
  });

  it("no mock rule was broken", () => {
    expect(world.allErrors()).toEqual([]);
  });
});
