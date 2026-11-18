import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { convertResource } from "../tools/fx2lsmp/cli.ts";
import { moduleHash } from "../tools/fx2lsmp/modules.ts";
import { TICK_MS, World } from "./harness.ts";

interface Manifest {
  shared_scripts: string[];
  client_scripts?: string[];
  server_scripts?: string[];
  files?: string[];
}

const RES = "modres";
const SERVER_SECRET = "SERVER_ONLY_SECRET_MARK";
const FILES: Record<string, string> = {
  "imports/x/shared.lua": "local lib = {}\nfunction lib.shared() return 'shared' end\n",
  "imports/x/client.lua": "MARK_GLOBAL = 'set'\nlib.side = 'client'\nreturn lib, select('#', ...), ...\n",
  "imports/x/server.lua": `lib.side = 'server'\nlocal ${SERVER_SECRET} = 1\nreturn lib\n`,
  "imports/x/note.txt": "note",
  "lib/s.lua": `#!/usr/bin/env lua\nlocal ${SERVER_SECRET}_LIB = 1\nreturn { name = 'slib' }\n`,
  "boot.lua": [
    "if IsDuplicityVersion() then",
    "  local text = LoadResourceFile(GetCurrentResourceName(), 'lib/s.lua')",
    "  BOOT = load(text, '@@modres/lib/s.lua', 't', _ENV)().name",
    "end",
    "",
  ].join("\n"),
};

function convertFixture(keepModuleText = false, files = "'imports/**/client.lua', 'imports/**/shared.lua'"): Promise<{ out: string; warnings: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "fxmodules-"));
  const src = join(root, RES);
  mkdirSync(src);
  writeFileSync(
    join(src, "fxmanifest.lua"),
    `fx_version 'cerulean'
game 'gta5'
shared_script 'boot.lua'
files { ${files} }
`,
  );
  for (const [name, code] of Object.entries(FILES)) {
    mkdirSync(dirname(join(src, name)), { recursive: true });
    writeFileSync(join(src, name), code);
  }
  const out = join(root, "out");
  return convertResource({ resourceDir: src, outDir: out, keepModuleText }).then(({ warnings }) => ({ out, warnings }));
}

let world: World | undefined;
afterAll(() => world?.close());

describe("module hash", () => {
  it("is the same in TypeScript and Lua", async () => {
    world = await World.withShim({ resource: "unit", clients: 1 });
    const server = world.server;
    const samples = ["", "plain ascii", "caf\u00e9 \u4e2d\u6587 \ud83d\ude00", "a\r\nb\r\n", "x".repeat(1000)];
    for (const [i, text] of samples.entries()) {
      server.setFile(`f${i}`, text);
      const lua = await server.eval(`return __fxc.moduleHash(LoadResourceFile(GetCurrentResourceName(), 'f${i}'))`);
      expect(lua, JSON.stringify(text)).toBe(moduleHash(text));
    }
    expect(moduleHash("")).toBe("0:811c9dc5");
    world.close();
    world = undefined;
  });
});

describe("module text", () => {
  it("drops registered Lua files from the manifest files and keeps the rest", async () => {
    const { out } = await convertFixture(false, "'imports/x/*', 'data/*.json'");
    const manifest: Manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.files).toEqual(["imports/x/note.txt", "data/*.json"]);
  });

  it("keeps the text with --keep-module-text and the client reads the real file", async () => {
    const { out } = await convertFixture(true);
    const manifest: Manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.files).toEqual(["imports/**/client.lua", "imports/**/shared.lua"]);
    world = await World.withShim({ resource: RES, clients: 1 });
    const client = world.clients[0]!;
    client.setFile("imports/x/shared.lua", "real text");
    expect(await client.eval("return LoadResourceFile(GetCurrentResourceName(), 'imports/x/shared.lua')")).toBe("real text");
    world.close();
    world = undefined;
  });
});

describe("precompiled modules", () => {
  it("builds client and server registries and loads them through load", async () => {
    const { out, warnings } = await convertFixture();
    expect(warnings.some((w) => w.includes("boot.lua") && w.includes("load"))).toBe(true);
    const manifest: Manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    const read = (path: string): string => readFileSync(join(out, path), "utf8");

    expect(manifest.shared_scripts).toEqual(["_fxcompat/config.lua", "_fxcompat/init.lua", "_fxcompat/modules.lua"]);
    expect(manifest.client_scripts).toEqual(["boot.lua"]);
    expect(manifest.server_scripts).toEqual(["_fxcompat/modules_server.lua", "boot.lua"]);
    const clientListed = [...manifest.shared_scripts, ...(manifest.client_scripts ?? [])].map(read);
    for (const text of [...clientListed, read("imports/x/shared.lua"), read("imports/x/client.lua")]) {
      expect(text).not.toContain(SERVER_SECRET);
    }
    expect(read("_fxcompat/modules.lua")).toContain("imports/x/client.lua");
    expect(read("_fxcompat/modules_server.lua")).toContain(SERVER_SECRET);
    expect(read("_fxcompat/modules_server.lua")).not.toContain("#!/usr");

    world = await World.create({ resource: RES, clients: 1 });
    const client = world.clients[0]!;
    const server = world.server;
    const filesFor = (vm: typeof server, paths: string[]): void => {
      for (const p of paths) vm.setFile(p, read(p));
    };
    expect(manifest.files).toBeUndefined();
    filesFor(server, ["imports/x/shared.lua", "imports/x/client.lua", "imports/x/server.lua", "lib/s.lua"]);
    for (const vm of [server, client]) {
      const own = (vm.side === "server" ? manifest.server_scripts : manifest.client_scripts) ?? [];
      for (const path of [...manifest.shared_scripts, ...own]) vm.load(path, read(path));
    }
    await world.advance(TICK_MS * 3);

    expect(await server.eval("return BOOT")).toBe("slib");
    expect(await client.eval("return BOOT")).toBe(null);

    const combo = `local r = GetCurrentResourceName()
      local text = LoadResourceFile(r, 'imports/x/shared.lua') .. string.char(10) .. LoadResourceFile(r, 'imports/x/client.lua')
      local env = setmetatable({}, { __index = _G })
      local fn, err = load(text, '@@modres/imports/x/client.lua', 't', env)
      if not fn then return { err = err } end
      local lib, count, a, b = fn('p', 'q')
      return { shared = lib.shared(), side = lib.side, count = count, a = a, b = b, own = env.MARK_GLOBAL, leaked = rawget(_G, 'MARK_GLOBAL') }`;
    expect(await client.eval(combo)).toEqual({ shared: "shared", side: "client", count: 2, a: "p", b: "q", own: "set" });

    const marker = /^--fxc:module:\d+:[0-9a-f]{8}$/;
    expect(await client.eval("return LoadResourceFile(GetCurrentResourceName(), 'imports/x/client.lua')")).toMatch(marker);
    expect(await client.eval("return LoadResourceFile(GetCurrentResourceName(), 'imports/x/shared.lua')")).toMatch(marker);
    expect(await client.eval("return LoadResourceFile(GetCurrentResourceName(), 'lib/s.lua')")).toBe(null);
    const plain = `local r = GetCurrentResourceName()
      local env = setmetatable({ lib = {} }, { __index = _G })
      local fn = load(LoadResourceFile(r, 'imports/x/client.lua'), '@@x', 't', env)
      local lib, count, first = fn('only')
      return { side = lib.side, count = count, first = first, own = env.MARK_GLOBAL }`;
    expect(await client.eval(plain)).toEqual({ side: "client", count: 1, first: "only", own: "set" });
    expect(await server.eval("return LoadResourceFile(GetCurrentResourceName(), 'imports/x/client.lua')")).toContain("MARK_GLOBAL");

    expect(await server.eval(`local r = GetCurrentResourceName()
      local fn = load(LoadResourceFile(r, 'imports/x/shared.lua') .. string.char(10) .. LoadResourceFile(r, 'imports/x/server.lua'), '@@x', 't')
      return fn().side`)).toBe("server");

    const unknown = await client.eval(`local fn, err = load('return 1', '@@modres/other.lua', 't')
      return { missing = fn == nil, err = err, strict = select(2, load('return 1', 'x', 'b')) }`);
    expect(unknown).toMatchObject({ missing: true });
    const message = (unknown as { err: string }).err;
    expect(message).toContain("@@modres/other.lua");
    expect(message).toContain("8 bytes");
    expect(message).toContain("precompiles only");
    expect(await client.eval("return LoadResourceFile('someother', 'a.lua')")).toBe(null);
    expect(await client.eval("return load == loadstring")).toBe(true);
  });
});
