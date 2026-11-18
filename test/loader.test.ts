import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { convertResource } from "../tools/fx2lsmp/cli.ts";
import { TICK_MS, World, type Vm } from "./harness.ts";

interface Manifest {
  shared_scripts: string[];
  client_scripts?: string[];
  server_scripts?: string[];
}

const SERVER_MARK = "LOADER_SERVER_ONLY_MARK";

function put(root: string, files: Record<string, string>): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

async function convert(files: Record<string, string>): Promise<{ out: string; manifest: Manifest }> {
  const root = mkdtempSync(join(tmpdir(), "fxloader-"));
  const src = put(join(root, "src", "app"), files);
  const out = join(root, "out");
  await convertResource({ resourceDir: src, outDir: out });
  return { out, manifest: JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) };
}

/** LS:MP order: shared scripts, then the side's own; the mock starts the next file when a body suspends. */
function loadAll(vm: Vm, out: string, manifest: Manifest): void {
  const own = (vm.side === "server" ? manifest.server_scripts : manifest.client_scripts) ?? [];
  for (const path of [...manifest.shared_scripts, ...own]) vm.load(path, readFileSync(join(out, path), "utf8"));
}

let world: World | undefined;
afterEach(() => {
  world?.close();
  world = undefined;
});

const MANIFEST = "fx_version 'cerulean'\ngame 'gta5'\nshared_script 'shared.lua'\nserver_script 'server/*.lua'\nclient_script 'client.lua'\n";

describe("sequential script loader", () => {
  it("runs a script after the previous one finished, even when that one waits", async () => {
    const { out, manifest } = await convert({
      "fxmanifest.lua": MANIFEST,
      "shared.lua": "local n = 0\nSEEN = {}\nSEEN[#SEEN + 1] = 'shared start'\nWait(200)\nSHARED_DONE = true\nSEEN[#SEEN + 1] = 'shared end'\n",
      "server/a.lua": "A_SAW_SHARED = SHARED_DONE\nlocal n = 1\nSEEN[#SEEN + 1] = 'a'\n",
      "server/b.lua": "B_LOCAL = n\nSEEN[#SEEN + 1] = 'b'\n",
      "client.lua": "CLIENT_SAW_SHARED = SHARED_DONE\n",
    });
    expect(manifest.shared_scripts).toEqual(["_fxcompat/config.lua", "_fxcompat/init.lua"]);
    expect(manifest.server_scripts).toEqual(["_fxcompat/run_server.lua"]);
    expect(manifest.client_scripts).toEqual(["_fxcompat/run_client.lua"]);

    world = await World.create({ resource: "app", clients: 1 });
    for (const vm of [world.server, ...world.clients]) loadAll(vm, out, manifest);
    await world.advance(TICK_MS * 3);
    expect(await world.server.eval("return SEEN")).toEqual(["shared start"]);
    await world.advance(400);
    expect(await world.server.eval("return SEEN")).toEqual(["shared start", "shared end", "a", "b"]);
    expect(await world.server.eval("return A_SAW_SHARED")).toBe(true);
    expect(await world.server.eval("return B_LOCAL")).toBe(null);
    expect(await world.clients[0]!.eval("return CLIENT_SAW_SHARED")).toBe(true);
    expect(world.allErrors()).toEqual([]);
  });

  it("lets a script use the result of an export called by the previous one", async () => {
    const provider = await convert({
      "fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nserver_script 'server.lua'\n",
      "server.lua": "exports('getShared', function() return { name = 'ESX' } end)\n",
    });
    const consumer = await convert({
      "fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nserver_scripts { 'imports.lua', 'config.lua' }\n",
      "imports.lua": "ESX = exports.provider:getShared()\n",
      "config.lua": "CONFIG_NAME = ESX.name\n",
    });
    world = await World.fromConverted(provider.out, 1, "provider", undefined, true);
    const app = await world.addLua("app");
    loadAll(app.server, consumer.out, consumer.manifest);
    await world.advance(400);
    expect(await app.server.eval("return CONFIG_NAME")).toBe("ESX");
    expect(world.allErrors()).toEqual([]);
  });

  it("names the original file and line of an error and stops the resource there", async () => {
    const { out, manifest } = await convert({
      "fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nserver_scripts { 'one.lua', 'two.lua', 'three.lua' }\n",
      "one.lua": "ONE = true\n",
      "two.lua": "local ok = 1\n\nlocal x = nothing.field\n",
      "three.lua": "THREE = true\n",
    });
    world = await World.create({ resource: "app", clients: 0 });
    loadAll(world.server, out, manifest);
    await world.advance(TICK_MS * 3);
    expect(await world.server.eval("return ONE")).toBe(true);
    expect(await world.server.eval("return THREE")).toBe(null);
    const errors = world.allErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("two.lua:3:");
    expect(errors[0]).not.toContain("run_server");
  });

  it("keeps server-only scripts out of the client package and expands globs alphabetically", async () => {
    const { out, manifest } = await convert({
      "fxmanifest.lua": MANIFEST,
      "shared.lua": "SHARED_LOADED = true\n",
      "client.lua": "CLIENT_LOADED = true\n",
      "server/b.lua": `local ${SERVER_MARK} = 1\nORDER = (ORDER or '') .. 'b'\n`,
      "server/a.lua": "ORDER = (ORDER or '') .. 'a'\n",
    });
    expect(readFileSync(join(out, "_fxcompat/run_client.lua"), "utf8")).not.toContain(SERVER_MARK);
    const server = readFileSync(join(out, "_fxcompat/run_server.lua"), "utf8");
    expect(server.indexOf("server/a.lua")).toBeLessThan(server.indexOf("server/b.lua"));
    expect(server).not.toContain("CLIENT_LOADED");
    world = await World.create({ resource: "app", clients: 1 });
    for (const vm of [world.server, ...world.clients]) loadAll(vm, out, manifest);
    await world.advance(TICK_MS * 3);
    expect(await world.server.eval("return ORDER")).toBe("ab");
  });
});

describe("scripts as modules and CfxLua library helpers", () => {
  it("lets a script load the text of a listed script, as ESX locales do", async () => {
    const { out, manifest } = await convert({
      "fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nserver_scripts { 'main.lua', 'locales/*.lua' }\n",
      "main.lua": "",
      "locales/en.lua": "return { hello = 'Hello' }\n",
    });
    world = await World.create({ resource: "app", clients: 0 });
    world.server.setFile("locales/en.lua", readFileSync(join(out, "locales/en.lua"), "utf8"));
    loadAll(world.server, out, manifest);
    await world.advance(TICK_MS * 3);
    expect(await world.server.eval("return load(LoadResourceFile('app', 'locales/en.lua'))().hello")).toBe("Hello");
  });

  it("provides table.wipe and string.strsplit", async () => {
    world = await World.withShim({ resource: "unit", clients: 0 });
    expect(await world.server.eval("local t = { 1, 2, a = 3 } table.wipe(t) return next(t) == nil")).toBe(true);
    expect(await world.server.eval("return { string.strsplit(';', 'a;b;;c') }")).toEqual(["a", "b", "", "c"]);
    expect(await world.server.eval("return { string.strsplit(',;', 'a,b;c', 2) }")).toEqual(["a", "b;c"]);
  });
});
