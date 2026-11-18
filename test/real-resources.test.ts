import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertResource, findRuntimeLoads } from "../tools/fx2lsmp/cli.ts";
import { World } from "./harness.ts";
import { makeWebui } from "./webui.ts";

const PAGE = `
  window.postTo = function (name, body) {
    return fetch('https://' + GetParentResourceName() + '/' + name, { method: 'POST', body: JSON.stringify(body) }).then(function (r) { return r.json(); });
  };
`;

const CLIENT = `
  RegisterCommand('alpha', function() end)
  RegisterCommand('beta', function() end)
  RegisterCommand('alpha', function() end)
  RAW = {}
  RegisterRawNuiCallback('chatResult', function(request, cb)
    RAW.request = request
    RAW.data = json.decode(request.body)
    cb({ body = 'ok' })
  end)
  RegisterRawNuiCallback('echo', function(request, cb) cb({ body = request.body }) end)
  SetTextChatEnabled(false)
`;

const SERVER = `
  TriggerClientEvent('chat:addMessage', 1, { args = { 'Ann', '^2hello^7' }, color = { 255, 0, 0 } })
  TriggerClientEvent('chat:addMessage', -1, 'plain notice')
  TriggerClientEvent('chatMessage', 2, '', { 255, 255, 255 }, '^1* left')
  TriggerClientEvent('chat:addMessage', 1, { args = {} })
`;

let world: World;
beforeAll(async () => {
  world = await World.withShim({
    clients: 2,
    client: CLIENT,
    uiPage: "index.html",
    webuiDir: makeWebui(PAGE),
    extraConfig: `FXCOMPAT_CONFIG.metadata = { chat_theme = { 'dark', 'light' }, author = { 'me' } }`,
  });
  world.server.load("chat.lua", SERVER);
  await world.advance(60);
});
afterAll(() => world.close());

const client = () => world.clients[0]!;

describe("resource metadata", () => {
  it("answers for the calling resource only", async () => {
    expect(
      await client().eval(
        "return { GetNumResourceMetadata(GetCurrentResourceName(), 'chat_theme'), GetResourceMetadata(GetCurrentResourceName(), 'chat_theme', 1), GetResourceMetadata('unit', 'author') }",
      ),
    ).toEqual([2, "light", "me"]);
    expect(await client().eval("return { GetNumResourceMetadata('other', 'chat_theme'), GetResourceMetadata('unit', 'nothing') == nil }")).toEqual([0, true]);
  });

  it("finds the calling resource as the only one", async () => {
    expect(await client().eval("return { GetNumResources(), GetResourceByFindIndex(0), GetResourceByFindIndex(1) == nil }")).toEqual([1, "unit", true]);
  });
});

describe("registered commands and client permissions", () => {
  it("lists each registered command once", async () => {
    expect(await client().eval("local t = {} for _, c in ipairs(GetRegisteredCommands()) do t[#t + 1] = c.name end return t")).toEqual(["alpha", "beta"]);
  });

  it("denies client side ACE checks", async () => {
    expect(await client().eval("return IsAceAllowed('command.alpha')")).toBe(false);
  });
});

describe("raw NUI callbacks", () => {
  it("hands the page data over as a JSON body and decodes the answer body", async () => {
    const answer = world.page().run("window.postTo('chatResult', { message: 'hi', mode: null })");
    await world.advance(50);
    expect(await answer).toBe("ok");
    expect(await client().eval("return { RAW.request.resource, RAW.request.path, RAW.request.method, RAW.data.message }")).toEqual(["unit", "/chatResult", "POST", "hi"]);
  });

  it("returns a JSON body as a value", async () => {
    const answer = world.page().run("window.postTo('echo', { a: 1 })");
    await world.advance(50);
    expect(await answer).toEqual({ a: 1 });
  });
});

describe("chat bridge", () => {
  const lines = async (id: number) => world.clients[id - 1]!.eval<unknown[]>("return CHATLOG");

  it("turns FiveM chat events into LS:MP chat:message lines and keeps the original event", async () => {
    for (const vm of world.clients) await vm.eval("CHATLOG = {} lsmp.onServer('chat:message', function(line) CHATLOG[#CHATLOG + 1] = line end) return true");
    world.server.load("chat2.lua", SERVER);
    await world.advance(60);
    expect(await lines(1)).toEqual([
      { name: "Ann", text: "hello", system: false },
      { name: "", text: "plain notice", system: true },
    ]);
    expect(await lines(2)).toEqual([
      { name: "", text: "plain notice", system: true },
      { name: "", text: "* left", system: true },
    ]);
  });
});

describe("conversion warnings", () => {
  it("warns about a ui_page and a files pattern missing from the source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fxmiss-"));
    const src = join(dir, "res");
    mkdirSync(src);
    writeFileSync(join(src, "fxmanifest.lua"), "ui_page 'dist/ui.html'\nclient_script 'c.lua'\nfiles { 'dist/*.css' }\nrepository 'x'\n");
    writeFileSync(join(src, "c.lua"), "print('x')\n");
    const result = await convertResource({ resourceDir: src, outDir: join(dir, "out") });
    expect(result.warnings).toEqual([
      "ui_page 'dist/ui.html' is not in the source folder (a build step may not have run)",
      "files pattern 'dist/*.css' matches no file",
    ]);
  });

  it("warns when the resource name is one LS:MP bundles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fxbundled-"));
    const src = join(dir, "chat");
    mkdirSync(src);
    writeFileSync(join(src, "fxmanifest.lua"), "server_script 's.lua'\n");
    writeFileSync(join(src, "s.lua"), "print('x')\n");
    const result = await convertResource({ resourceDir: src, outDir: join(dir, "out") });
    expect(result.warnings).toEqual([expect.stringContaining("also a resource bundled with LS:MP")]);
  });
});

describe("convars on the client", () => {
  it("reads the build time convars like the server", async () => {
    const w = await World.withShim({ clients: 1, convars: { chat_flag: "false", chat_n: "3" } });
    try {
      expect(await w.clients[0]!.eval("return { GetConvar('chat_flag', 'x'), GetConvarInt('chat_n', 0), GetConvarBool('chat_flag', true), GetConvar('nope', 'd') }")).toEqual(["false", 3, false, "d"]);
    } finally {
      w.close();
    }
  });
});

describe("runtime code loading", () => {
  it("finds load calls and skips look-alikes", () => {
    const code = ["local f = load(src)", "t.load(a)", "LoadResourceFile('r', 'f')", "-- load(z)", "x = loadstring ('y')"].join(String.fromCharCode(10));
    expect(findRuntimeLoads(code)).toEqual([{ line: 1, name: "load" }, { line: 5, name: "loadstring" }]);
  });
});
