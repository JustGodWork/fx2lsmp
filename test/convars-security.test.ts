import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { convertResource } from "../tools/fx2lsmp/cli.ts";
import { World } from "./harness.ts";

interface Manifest {
  shared_scripts: string[];
  client_scripts?: string[];
  server_scripts?: string[];
  files?: string[];
  webui?: string[];
}

const CFG = 'set mysql_connection_string "mysql://u:SECRET@h/db"\nsets sv_projectName SECRETNAME\nsetr ui_color red\n';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Every file LS:MP may put in the client package: shared and client scripts, files and the webui folders. */
function clientPackage(out: string): string[] {
  const manifest: Manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  const listed = [...manifest.shared_scripts, ...(manifest.client_scripts ?? []), ...(manifest.files ?? [])];
  return [...listed.map((p) => join(out, p)), ...(manifest.webui ?? []).flatMap((d) => walk(join(out, d)))];
}

async function convert(scripts: Record<string, string>, manifestBody: string): Promise<{ out: string; warnings: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "fxconvars-"));
  const src = join(root, "secrets");
  mkdirSync(src);
  writeFileSync(join(src, "fxmanifest.lua"), `fx_version 'cerulean'\ngame 'gta5'\n${manifestBody}\n`);
  for (const [name, code] of Object.entries(scripts)) writeFileSync(join(src, name), code);
  writeFileSync(join(root, "server.cfg"), CFG);
  const out = join(root, "out");
  const { warnings } = await convertResource({ resourceDir: src, outDir: out, cfg: join(root, "server.cfg") });
  return { out, warnings };
}

function expectJsonOnlyOnServer(out: string, manifest: Manifest): void {
  const json = "_fxcompat/server_convars.json";
  const everything = [...manifest.shared_scripts, ...(manifest.client_scripts ?? []), ...(manifest.server_scripts ?? [])];
  expect(everything).not.toContain(json);
  expect(manifest.files ?? []).not.toContain(json);
  expect(clientPackage(out).map((p) => p.replaceAll("\\", "/"))).not.toContain(join(out, json).replaceAll("\\", "/"));
  expect(readFileSync(join(out, json), "utf8")).toContain("SECRET");
}

let world: World | undefined;
afterAll(() => world?.close());

describe("server-only convars", () => {
  it("never reach the client package of a Lua resource and stay readable on the server", async () => {
    const { out } = await convert(
      {
        "client.lua": "CLIENT_COLOR = GetConvar('ui_color', 'none')\n",
        "server.lua": "SERVER_DB = GetConvar('mysql_connection_string', '')\n",
      },
      "client_script 'client.lua'\nserver_script 'server.lua'",
    );
    for (const file of clientPackage(out)) expect(readFileSync(file, "utf8"), file).not.toContain("SECRET");
    const manifest: Manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expectJsonOnlyOnServer(out, manifest);
    world = await World.fromConverted(out, 1, "secrets");
    const client = world.clients[0]!;
    expect(await client.eval("return CLIENT_COLOR")).toBe("red");
    expect(await client.eval("return GetConvar('mysql_connection_string', 'default')")).toBe("default");
    expect(await client.eval("return GetConvar('sv_projectName', 'default')")).toBe("default");
    expect(await world.server.eval("return SERVER_DB")).toBe("mysql://u:SECRET@h/db");
    expect(await world.server.eval("return GetConvar('ui_color', '')")).toBe("red");
  });

  it("never reach the client package of a JS resource", async () => {
    const { out } = await convert(
      { "client.js": "globalThis.c = GetConvar('ui_color', 'none');\n", "server.js": "globalThis.s = 1;\n" },
      "client_script 'client.js'\nserver_script 'server.js'",
    );
    for (const file of clientPackage(out)) expect(readFileSync(file, "utf8"), file).not.toContain("SECRET");
    const manifest: Manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expectJsonOnlyOnServer(out, manifest);
    expect(readFileSync(join(out, "_fxcompat", "server_convars.json"), "utf8")).toContain("SECRET");
    expect(readFileSync(join(out, "_fxcompat", "config.js"), "utf8")).toContain("ui_color");
  });

  it("lets a shared script read a set convar at load time on the server, in Lua and JS", async () => {
    const lua = await convert(
      { "shared.lua": "SHARED_DB = GetConvar('mysql_connection_string', 'missing')\nSHARED_INT = GetConvarInt('nope', 7)\n" },
      "shared_script 'shared.lua'",
    );
    const luaWorld = await World.fromConverted(lua.out, 1, "secrets");
    expect(await luaWorld.server.eval("return SHARED_DB")).toBe("mysql://u:SECRET@h/db");
    expect(await luaWorld.server.eval("return SHARED_INT")).toBe(7);
    luaWorld.close();

    const js = await convert(
      { "shared.js": "globalThis.sharedDb = GetConvar('mysql_connection_string', 'missing');\n", "client.js": "globalThis.c = 1;\n" },
      "shared_script 'shared.js'\nclient_script 'client.js'",
    );
    const mixed = await World.fromConvertedMixed(js.out, 1);
    expect(await mixed.js?.server.eval("return globalThis.sharedDb")).toBe("mysql://u:SECRET@h/db");
    mixed.world.close();
  });

  it("makes the Lua shim the only entity applier when a resource loads both client shims", async () => {
    const both = await convert({ "c.js": "1;\n", "s.lua": "x = 1\n" }, "client_script 'c.js'\nserver_script 's.lua'");
    expect(readFileSync(join(both.out, "_fxcompat", "config.js"), "utf8")).toContain('"applyEntities":false');
    const jsOnly = await convert({ "c.js": "1;\n", "s.js": "1;\n" }, "client_script 'c.js'\nserver_script 's.js'");
    expect(readFileSync(join(jsOnly.out, "_fxcompat", "config.js"), "utf8")).not.toContain("applyEntities");
  });


  it("warns when a replicated convar looks secret", async () => {
    const root = mkdtempSync(join(tmpdir(), "fxconvars-"));
    const src = join(root, "res");
    mkdirSync(src);
    writeFileSync(join(src, "fxmanifest.lua"), "fx_version 'cerulean'\ngame 'gta5'\nserver_script 'server.lua'\n");
    writeFileSync(join(src, "server.lua"), "print(1)\n");
    writeFileSync(join(root, "server.cfg"), 'setr discord_webhook "https://x"\n');
    const { warnings } = await convertResource({ resourceDir: src, outDir: join(root, "out"), cfg: join(root, "server.cfg") });
    expect(warnings.some((w) => w.includes("discord_webhook"))).toBe(true);
  });
});
