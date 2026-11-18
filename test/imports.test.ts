import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { convertResource } from "../tools/fx2lsmp/cli.ts";
import { TICK_MS, World } from "./harness.ts";

interface Manifest {
  shared_scripts: string[];
  client_scripts?: string[];
  server_scripts?: string[];
  files?: string[];
}

const SERVER_MARK = "XLIB_SERVER_ONLY_MARK";
const DATA_MARK = "XLIB_DATA_JSON_MARK";
const IMPORTS = "_fxcompat/imports/xlib";

const XLIB: Record<string, string> = {
  "fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nshared_script 'imports.lua'\nfiles { 'imports.lua', 'imports/**/client.lua', 'imports/**/shared.lua' }\n",
  "imports.lua": [
    "local side = IsDuplicityVersion() and 'server' or 'client'",
    "local shared = LoadResourceFile('xlib', 'imports/m/shared.lua')",
    "local part = LoadResourceFile('xlib', 'imports/m/' .. side .. '.lua')",
    "XLIB = load(shared .. string.char(10) .. part, '@@xlib/imports/m/' .. side .. '.lua', 't', _ENV)()",
    "XLIB_DATA = LoadResourceFile('xlib', 'data.json')",
    "",
  ].join("\n"),
  "imports/m/shared.lua": "local lib = {}\nfunction lib.shared() return 'shared' end\n",
  "imports/m/client.lua": "lib.side = 'client'\nreturn lib\n",
  "imports/m/server.lua": `lib.side = 'server'\nlocal ${SERVER_MARK} = 1\nreturn lib\n`,
  "imports/s/server.lua": `S_LOADED = 'yes'\nlocal ${SERVER_MARK}_S = 1\n`,
  "data.json": `{"secret":"${DATA_MARK}"}`,
};

function put(root: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
}

async function convertApp(withResources: boolean): Promise<{ out: string; warnings: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "fximports-"));
  put(join(root, "res", "[core]", "xlib"), XLIB);
  put(join(root, "res", "[core]", "node_modules", "xlib"), { "fxmanifest.lua": "-- decoy" });
  put(join(root, "app"), {
    "fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nshared_scripts { '@xlib/imports.lua' }\nserver_scripts { '@xlib/imports/s/server.lua' }\n",
  });
  const out = join(root, "out");
  const { warnings } = await convertResource({
    resourceDir: join(root, "app"),
    outDir: out,
    ...(withResources ? { resourcesDir: join(root, "res") } : {}),
  });
  return { out, warnings };
}

let world: World | undefined;
afterAll(() => world?.close());

describe("cross-resource imports", () => {
  it("vendors the other resource, keeping server-only content off the client", async () => {
    const { out, warnings } = await convertApp(true);
    const read = (path: string): string => readFileSync(join(out, path), "utf8");
    const manifest: Manifest = JSON.parse(read("manifest.json"));

    expect(warnings.some((w) => w.includes("cross-resource"))).toBe(false);
    expect(warnings.some((w) => w.includes("vendored resource 'xlib'") && w.includes("server-only file(s)"))).toBe(true);
    expect(manifest.shared_scripts).toEqual(["_fxcompat/config.lua", "_fxcompat/init.lua", "_fxcompat/modules.lua"]);
    expect(manifest.client_scripts).toEqual([`${IMPORTS}/imports.lua`]);
    expect(manifest.server_scripts).toEqual(["_fxcompat/modules_server.lua", `${IMPORTS}/imports.lua`, `${IMPORTS}/imports/s/server.lua`]);
    expect(manifest.files).toBeUndefined();

    const clientListed = [...manifest.shared_scripts, ...(manifest.client_scripts ?? [])];
    const registered = [`${IMPORTS}/imports/m/client.lua`, `${IMPORTS}/imports/m/shared.lua`];
    for (const path of clientListed) {
      const text = read(path);
      expect(text, path).not.toContain(SERVER_MARK);
      expect(text, path).not.toContain(DATA_MARK);
    }
    expect(clientListed).not.toContain(`${IMPORTS}/data.json`);
    expect(read("_fxcompat/modules.lua")).not.toContain(SERVER_MARK);
    expect(read("_fxcompat/modules.lua")).toContain("imports/m/client.lua");
    expect(read("_fxcompat/modules_server.lua")).toContain(SERVER_MARK);
    expect(read(`${IMPORTS}/data.json`)).toContain(DATA_MARK);

    world = await World.create({ resource: "app", clients: 1 });
    const client = world.clients[0]!;
    const server = world.server;
    for (const path of clientListed) client.setFile(path, read(path));
    for (const path of [...clientListed, ...registered, `${IMPORTS}/imports/m/server.lua`, `${IMPORTS}/imports/s/server.lua`, `${IMPORTS}/data.json`]) {
      server.setFile(path, read(path));
    }
    for (const vm of [server, client]) {
      const own = (vm.side === "server" ? manifest.server_scripts : manifest.client_scripts) ?? [];
      for (const path of [...manifest.shared_scripts, ...own]) vm.load(path, read(path));
    }
    await world.advance(TICK_MS * 3);

    expect(await server.eval("return { side = XLIB.side, shared = XLIB.shared(), s = S_LOADED }")).toEqual({ side: "server", shared: "shared", s: "yes" });
    expect(await client.eval("return { side = XLIB.side, shared = XLIB.shared(), s = S_LOADED }")).toEqual({ side: "client", shared: "shared" });
    expect(await server.eval("return XLIB_DATA")).toContain(DATA_MARK);
    expect(await client.eval("return XLIB_DATA")).toBe(null);
    expect(await client.eval("return LoadResourceFile('xlib', 'imports/m/client.lua')")).toMatch(/^--fxc:module:\d+:[0-9a-f]{8}$/);
    expect(await client.eval("return LoadResourceFile('xlib', 'data.json')")).toBe(null);
  });

  it("keeps the warning, with a hint, when no resources folder is given", async () => {
    const { out, warnings } = await convertApp(false);
    expect(warnings.some((w) => w.includes("'@xlib/imports.lua' ignored") && w.includes("--resources"))).toBe(true);
    const manifest: Manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.server_scripts ?? []).toEqual([]);
    expect(JSON.stringify(manifest)).not.toContain("xlib");
  });
});
