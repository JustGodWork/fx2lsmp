import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World } from "./harness.ts";
import { makeWebui } from "./webui.ts";

const PAGE = `
  window.addEventListener('message', function (e) { window.LAST = e.data; });
  window.postTo = function (name, body) {
    return fetch('https://' + GetParentResourceName() + '/' + name, { method: 'POST', body: JSON.stringify(body) }).then(function (r) { return r.json(); });
  };
`;

const CLIENT = `
  KEYS = {}
  RegisterKeyMapping('+menu', 'Menu', 'keyboard', 'F5')
  RegisterCommand('+menu', function() KEYS.down = (KEYS.down or 0) + 1 end)
  RegisterCommand('-menu', function() KEYS.up = (KEYS.up or 0) + 1 end)
  RegisterKeyMapping('action', 'Action', 'keyboard', 'E')
  RegisterCommand('action', function(src, args, raw) KEYS.action = { src, raw } end)
  RegisterKeyMapping('nokey', 'x', 'keyboard', 'NOSUCHKEY')
  RegisterKeyMapping('pad', 'x', 'pad', 'A')
  RegisterCommand('cc', function(src, args, raw) KEYS.cc = { src, args, raw } end)

  NUI = {}
  RegisterNUICallback('close', function(data, cb)
    NUI.close = data
    SetNuiFocus(false, false)
    cb({ ok = true, reason = data.reason })
  end)
  RegisterNUICallback('slow', function(data, cb) SetTimeout(100, function() cb('later') end) end)
  RegisterNuiCallback('sparse', function(data, cb) cb({ [3] = 'x', names = { 'a' } }) end)
`;

let world: World;
beforeAll(async () => {
  world = await World.withShim({
    clients: 2,
    client: CLIENT,
    uiPage: "index.html",
    webuiDir: makeWebui(PAGE),
  });
});
afterAll(() => world.close());

const client = () => world.clients[0]!;

describe("natives fallback", () => {
  it("resolves PascalCase through lowercasing, the alias table and N_ names, caching the result", async () => {
    expect(await client().eval("local c = GetEntityCoords(PlayerPedId()) return { c.x, c.z }")).toEqual([100, 30]);
    expect(await client().eval("return rawget(_G, 'GetEntityCoords') == getEntityCoords")).toBe(true);
    expect(await client().eval("function addPedAmmoByType() return 'aliased' end return AddAmmoToPedByType()")).toBe("aliased");
    expect(await client().eval("return N_0x3FEF770D40960D5A(1).x")).toBe(100);
  });

  it("leaves other missing globals nil", async () => {
    expect(await client().eval("return { NoSuchNative == nil, lowercaseMissing == nil, rawget(_G, 'NoSuchNative') == nil }")).toEqual([true, true, true]);
  });
});

describe("player ids", () => {
  it("maps local slots and server ids both ways", async () => {
    expect(await client().eval("return GetPlayerServerId(PlayerId())")).toBe(1);
    expect(await client().eval("return GetPlayerFromServerId(2)")).toBe(1);
    expect(await client().eval("return GetPlayerServerId(1)")).toBe(2);
    expect(await client().eval("return GetPlayerFromServerId(99)")).toBe(-1);
    expect(await client().eval("return GetActivePlayers()")).toEqual([0, 1]);
    expect(await client().eval("return { NetworkIsPlayerActive(PlayerId()), NetworkIsPlayerActive(1), NetworkIsPlayerConnected(9) }")).toEqual([true, true, false]);
  });

  it("maps network ids", async () => {
    expect(await client().eval("return { NetworkGetNetworkIdFromEntity(10005), NetworkGetEntityFromNetworkId(5), NetToVeh(7) }")).toEqual([5, 10005, 10007]);
  });
});

describe("client commands and key mappings", () => {
  it("runs a typed client command with FiveM arguments", async () => {
    await client().eval("__runCommand(nil, 'cc 1 2')");
    await world.advance(30);
    expect(await client().eval("return KEYS.cc")).toEqual([0, ["1", "2"], "cc 1 2"]);
  });

  it("runs +cmd on press and -cmd on release", async () => {
    client().press(166);
    await world.advance(20);
    client().release(166);
    await world.advance(20);
    expect(await client().eval("return { KEYS.down, KEYS.up }")).toEqual([1, 1]);
  });

  it("runs a plain command on press only", async () => {
    client().press(38);
    await world.advance(20);
    expect(await client().eval("return KEYS.action")).toEqual([0, "action"]);
  });

  it("warns about unknown keys and devices once", async () => {
    const logs = client().logs().join("\n");
    expect(logs).toContain("NOSUCHKEY");
    expect(logs).toContain("'pad' is not supported");
  });
});

describe("NUI", () => {
  it("creates the browser lazily on rsc://<resource>/<ui_page>", async () => {
    expect(await client().eval("return lsmp.__test.browsers[1].url")).toBe("rsc://unit/index.html");
    expect(await client().eval("return lsmp.__test.browsers[2] == nil")).toBe(true);
  });

  it("delivers SendNUIMessage as a message event with JSON semantics", async () => {
    await client().eval("SendNUIMessage({ type = 'show', items = { [3] = 'a', n = 1 }, fn = print })");
    await world.advance(20);
    expect(world.page().messages.at(-1)).toEqual({ type: "show", items: { "3": "a", n: 1 } });
    expect(world.page().run("window.LAST.type")).toBe("show");
  });

  it("answers fetch('https://<resource>/<name>') with the callback value", async () => {
    await client().eval("SetNuiFocus(true, true)");
    expect(await client().eval("return IsNuiFocused()")).toBe(true);
    const answer = world.page().run("window.postTo('close', { reason: 'button' })");
    await world.advance(50);
    expect(await answer).toEqual({ ok: true, reason: "button" });
    expect(await client().eval("return NUI.close.reason")).toBe("button");
    expect(await client().eval("return IsNuiFocused()")).toBe(false);
  });

  it("waits for a callback that is answered later", async () => {
    const answer = world.page().run("window.postTo('slow', {})");
    await world.advance(200);
    expect(await answer).toBe("later");
  });

  it("serializes a callback answer with integer keys", async () => {
    const answer = world.page().run("window.postTo('sparse', {})");
    await world.advance(50);
    expect(await answer).toEqual({ "3": "x", names: ["a"] });
  });

  it("maps SetNuiFocus options to browser focus", async () => {
    await client().eval("SetNuiFocus(true, false)");
    expect(await client().eval("local b = lsmp.__test.browsers[1] return { b.focus, b.focusOpts.cursor, b.focusOpts.keepInput }")).toEqual([true, false, false]);
    await client().eval("SetNuiFocusKeepInput(true)");
    expect(await client().eval("local b = lsmp.__test.browsers[1] return { b.focus, b.focusOpts.cursor, b.focusOpts.keepInput }")).toEqual([true, true, true]);
    await client().eval("SetNuiFocusKeepInput(false) SetNuiFocus(false, false)");
    expect(await client().eval("return lsmp.__test.browsers[1].focus")).toBe(false);
  });

  it("answers 404 for a callback nobody registered and passes other urls to fetch", async () => {
    const status = world.page().run("fetch('https://unit/nothing', { method: 'POST', body: '{}' }).then(function (r) { return r.status })");
    await world.advance(50);
    expect(await status).toBe(404);
    world.page().run("fetch('https://example.test/data.json')");
    expect(world.page().passedThroughFetches.map((f) => f.url)).toEqual(["https://example.test/data.json"]);
  });

  it("no mock rule was broken", () => {
    expect(world.allErrors()).toEqual([]);
  });
});
