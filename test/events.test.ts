import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World } from "./harness.ts";

let world: World;
const [serverCode, clientCode] = [
  `
  GOT = {}
  RegisterNetEvent('t:echo')
  AddEventHandler('t:echo', function(payload, extra)
    GOT[#GOT + 1] = { source = source, payload = payload, extra = extra }
    TriggerClientEvent('t:back', source, payload)
    TriggerClientEvent('t:all', -1, 'hi', { [9] = 'nine' })
  end)
  RegisterNetEvent('t:inline', function(a) GOT.inline = { source = source, a = a } end)

  LOCAL = {}
  AddEventHandler('t:local', function(a, b) LOCAL[#LOCAL + 1] = { a, b } end)
  local removable = AddEventHandler('t:removable', function() LOCAL.removed = (LOCAL.removed or 0) + 1 end)
  TriggerEvent('t:removable')
  RemoveEventHandler(removable)
  TriggerEvent('t:removable')

  ORDER = {}
  AddEventHandler('t:slow', function() Wait(100) ORDER[#ORDER + 1] = 'slow' end)
  AddEventHandler('t:slow', function() ORDER[#ORDER + 1] = 'fast' end)

  ENGINE = {}
  AddEventHandler('onResourceStart', function(name) ENGINE.start = name end)
  AddEventHandler('onServerResourceStart', function(name) ENGINE.serverStart = name end)
  AddEventHandler('onResourceStop', function(name) ENGINE.stop = name end)
  AddEventHandler('playerDropped', function(reason) ENGINE.dropped = { source = source, reason = reason } end)
  AddEventHandler('playerJoining', function(oldId) ENGINE.joining = { source = source, oldId = oldId } end)
  AddEventHandler('playerConnecting', function(name, setKickReason, deferrals)
    deferrals.defer()
    Wait(20)
    deferrals.update('checking')
    if name == 'Banned' then setKickReason('no') end
    if name == 'Late' then deferrals.done('late reason') else deferrals.done() end
  end)
  `,
  `
  GOT = {}
  RegisterNetEvent('t:back', function(payload) GOT.back = { source = source, payload = payload } end)
  RegisterNetEvent('t:all', function(a, map) GOT.all = { a = a, nine = map[9], source = source } end)
  `,
];

beforeAll(async () => {
  world = await World.withShim({ clients: 2, server: serverCode, client: clientCode });
});
afterAll(() => world.close());

describe("local events", () => {
  it("TriggerEvent runs handlers synchronously and RemoveEventHandler stops them", async () => {
    expect(await world.server.eval("return LOCAL.removed")).toBe(1);
    await world.server.eval("TriggerEvent('t:local', 1, { [4] = 'x' })");
    expect(await world.server.eval("return { LOCAL[1][1], LOCAL[1][2][4] }")).toEqual([1, "x"]);
  });

  it("a waiting handler does not delay the others", async () => {
    await world.server.eval("TriggerEvent('t:slow')");
    expect(await world.server.eval("return ORDER[1]")).toBe("fast");
    await world.advance(150);
    expect(await world.server.eval("return ORDER[2]")).toBe("slow");
  });

  it("engine reserved names raise when emitted for real", async () => {
    expect(await world.server.eval("return pcall(TriggerEvent, 'playerJoin')")).toBe(false);
  });
});

describe("network events", () => {
  it("delivers the sender as source and the payload intact", async () => {
    const client = world.clients[1]!;
    await client.eval("TriggerServerEvent('t:echo', { [5] = 'a', [9] = 'b', cb = print }, 'x')");
    await world.advance(50);
    const got = await world.server.eval<{ source: number; payload: Record<string, string>; extra: string }>("return GOT[1]");
    expect(got.source).toBe(2);
    expect(got.extra).toBe("x");
    expect(got.payload).toEqual({ "5": "a", "9": "b" });
  });

  it("answers the sender and broadcasts with -1, string ids coerced", async () => {
    const [first, second] = world.clients;
    expect(await second!.eval("return GOT.back.source")).toBe(65535);
    expect(await second!.eval("return GOT.back.payload[5]")).toBe("a");
    expect(await first!.eval("return GOT.back")).toBeNull();
    expect(await first!.eval("return { GOT.all.a, GOT.all.nine, GOT.all.source }")).toEqual(["hi", "nine", 65535]);
    expect(await second!.eval("return GOT.all.a")).toBe("hi");
    await world.server.eval("TriggerClientEvent('t:back', '1', 'only first')");
    await world.advance(30);
    expect(await first!.eval("return GOT.back.payload")).toBe("only first");
  });

  it("RegisterNetEvent with a handler registers it", async () => {
    await world.clients[0]!.eval("TriggerServerEvent('t:inline', 7)");
    await world.advance(30);
    expect(await world.server.eval("return { GOT.inline.source, GOT.inline.a }")).toEqual([1, 7]);
  });

  it("latent variants behave like the plain ones", async () => {
    await world.clients[0]!.eval("TriggerLatentServerEvent('t:inline', 128, 8)");
    await world.advance(30);
    expect(await world.server.eval("return GOT.inline.a")).toBe(8);
    await world.server.eval("TriggerLatentClientEvent('t:back', 1, 128, 'latent')");
    await world.advance(30);
    expect(await world.clients[0]!.eval("return GOT.back.payload")).toBe("latent");
  });

  it("no mock rule was broken", () => {
    expect(world.allErrors()).toEqual([]);
  });
});

describe("FiveM lifecycle events", () => {
  it("routes resource events to the engine events", async () => {
    world.server.fire("resourceStart", "other");
    world.server.fire("resourceStop", "other");
    await world.advance(20);
    expect(await world.server.eval("return { ENGINE.start, ENGINE.serverStart, ENGINE.stop }")).toEqual(["other", "other", "other"]);
  });

  it("builds playerDropped reason and source", async () => {
    world.server.fire("playerLeave", 2, "Bob", "kick", "bye");
    await world.advance(20);
    expect(await world.server.eval("return { ENGINE.dropped.source, ENGINE.dropped.reason }")).toEqual([2, "kick: bye"]);
  });

  it("playerJoining receives the id as a string", async () => {
    world.server.fire("playerJoin", 3, "Cy");
    await world.advance(20);
    expect(await world.server.eval("return { ENGINE.joining.source, ENGINE.joining.oldId }")).toEqual([3, "3"]);
  });

  it("playerConnecting denies through setKickReason and deferrals.done", async () => {
    const result = await world.server.eval<string[]>(`
      local denied = {}
      local function connect(name)
        local p = { name = name, deny = function(reason) denied[#denied + 1] = name .. ':' .. reason end }
        lsmp.__fire('playerPreConnection', p)
      end
      connect('Fine') connect('Banned') connect('Late')
      Wait(100)
      return denied
    `);
    expect(result).toEqual(["Banned:no", "Late:late reason"]);
  });

  it("playerConnecting gets a temporary source that answers identifier natives", async () => {
    const result = await world.server.eval<(string | number | boolean)[]>(`
      local seen = {}
      AddEventHandler('playerConnecting', function(name)
        local src = source
        seen = { src, GetPlayerName(src), GetPlayerIdentifierByType(src, 'license'), GetPlayerIdentifierByType(src, 'ip') }
      end)
      lsmp.__fire('playerPreConnection', { name = 'Esx', lsmpId = 42, ip = '127.0.0.1', deny = function() end })
      Wait(50)
      return { seen[1] >= 65536, seen[2], seen[3], seen[4] }
    `);
    expect(result).toEqual([true, "Esx", "license:42", "ip:127.0.0.1"]);
  });

  it("TriggerEvent with a lifecycle name dispatches without emitting", async () => {
    await world.server.eval("TriggerEvent('onResourceStart', 'manual')");
    expect(await world.server.eval("return ENGINE.start")).toBe("manual");
  });
});
