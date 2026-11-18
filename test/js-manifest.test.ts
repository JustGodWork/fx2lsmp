import { createContext, runInContext } from "node:vm";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adaptJsScript, convertResource } from "../tools/fx2lsmp/cli.ts";
import { isJsScript, parseFxManifest, toLsmpManifest } from "../tools/fx2lsmp/manifest.ts";
import { World } from "./harness.ts";

async function manifestOf(source: string): Promise<ReturnType<typeof toLsmpManifest>> {
  return toLsmpManifest(await parseFxManifest(source), "res");
}

describe("script languages in the manifest", () => {
  it("recognises JavaScript script names", () => {
    expect(["a.js", "a.mjs", "a.cjs", "client/*.JS"].every(isJsScript)).toBe(true);
    expect(["a.lua", "a.json", "a.jsx"].some(isJsScript)).toBe(false);
  });

  it("Lua only resources keep the Lua shim and no JS shim", async () => {
    const m = await manifestOf("client_script 'a.lua'\nserver_script 'b.lua'\nshared_script 'c.lua'");
    expect(m.shared_scripts).toEqual(["_fxcompat/config.lua", "_fxcompat/init.lua", "c.lua"]);
    expect(m.client_scripts).toEqual(["a.lua"]);
  });

  it("JS only resources get the JS shim and no Lua shim", async () => {
    const m = await manifestOf("client_scripts { 'a.js' }\nserver_scripts { 'b.js', 'c.mjs' }");
    expect(m.shared_scripts).toEqual(["_fxcompat/config.js", "_fxcompat/init.js"]);
    expect(m.client_scripts).toEqual(["a.js"]);
    expect(m.server_scripts).toEqual(["b.js", "c.mjs"]);
  });

  it("a shared JS script puts the JS shim in front of it", async () => {
    const m = await manifestOf("shared_script 'config.js'\nclient_script 'a.js'");
    expect(m.shared_scripts).toEqual(["_fxcompat/config.js", "_fxcompat/init.js", "config.js"]);
  });

  it("a JS script on one side only keeps the shim on that side", async () => {
    const server = await manifestOf("client_script 'a.lua'\nserver_script 'b.js'");
    expect(server.shared_scripts).toEqual(["_fxcompat/config.lua", "_fxcompat/init.lua"]);
    expect(server.server_scripts).toEqual([
      "_fxcompat/config.js",
      "_fxcompat/init.js",
      "b.js",
    ]);
    expect(server.client_scripts).toEqual(["a.lua"]);
  });

  it("JS on both sides goes in the shared list, mixed with Lua keeps both shims", async () => {
    const m = await manifestOf("client_script 'a.js'\nserver_script 'b.js'\nserver_script 'c.lua'");
    expect(m.shared_scripts).toEqual(["_fxcompat/config.lua", "_fxcompat/init.lua", "_fxcompat/config.js", "_fxcompat/init.js"]);
    expect(m.server_scripts).toEqual(["b.js", "c.lua"]);
  });
});

function makeResource(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "fxmix-")), "mixed");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe("conversion of JS and mixed resources", () => {
  it("bundles the JS shim into one script that declares nothing but its effects", async () => {
    const dir = makeResource({
      "fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nserver_script 'server.js'\nclient_script 'client.lua'",
      "server.js": "console.log('x')",
      "client.lua": "print('c')",
    });
    const out = join(dir, "..", "out");
    const result = await convertResource({ resourceDir: dir, outDir: out });
    expect(result.warnings).toEqual([]);
    const init = readFileSync(join(out, "_fxcompat", "init.js"), "utf8");
    expect(init.length).toBeGreaterThan(100000);
    expect(init.length).toBeLessThan(300000);
    expect(init).not.toContain("import ");
    expect(existsSync(join(out, "_fxcompat", "config.js"))).toBe(true);
    expect(existsSync(join(out, "_fxcompat", "init.lua"))).toBe(true);
    expect(readFileSync(join(out, "server.js"), "utf8")).toBe("var exports=globalThis.exports;console.log('x')");
  });

  it("bundles the native hash table only for resources that use invokeNative", async () => {
    const dir = makeResource({
      "fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nclient_script 'client.js'",
      "client.js": "Citizen.invokeNative('0x1', 1)",
    });
    const out = join(dir, "..", "out");
    await convertResource({ resourceDir: dir, outDir: out });
    expect(readFileSync(join(out, "_fxcompat", "init.js"), "utf8").length).toBeGreaterThan(400000);
  });

  it("a resource with Lua and JS halves talks between them through the shared formats", async () => {
    const dir = makeResource({
      "fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nserver_script 'server.js'\nserver_script 'server.lua'",
      "server.js": "exports('fromJs', (t) => new Map([[5, t[7]]])); on('mixed:js', (p) => { globalThis.GOT = p; });",
      "server.lua": "exports('fromLua', function() return 'lua' end)\nAddEventHandler('mixed:lua', function(p) GOT = p end)",
    });
    const out = join(dir, "..", "out");
    await convertResource({ resourceDir: dir, outDir: out });
    const { world, js, lua } = await World.fromConvertedMixed(out, 1);
    try {
      if (js === undefined || lua === undefined) throw new Error("both halves expected");
      // the halves share one resource name: the JS half calls the Lua export and the other way round
      expect(await js.server.eval("return await exports.mixed.fromLua()")).toBe("lua");
      expect(await lua.server.eval("local r = exports.mixed:fromJs({ [7] = 'seven' }) return r[5]")).toBe("seven");
      await lua.server.eval("TriggerEvent('mixed:js', { [2] = 'two' })");
      await js.server.eval("emit('mixed:lua', new Map([[3, 'three']]))");
      await world.advance(50);
      expect(await js.server.eval("return globalThis.GOT")).toEqual({ "2": "two" });
      expect(await lua.server.eval("return GOT[3]")).toBe("three");
      expect(world.allErrors()).toEqual([]);
    } finally {
      world.close();
    }
  });
});

describe("script scope of LS:MP server JS", () => {
  it("publishes top-level declarations on globalThis and the FiveM exports global", () => {
    const code = "'use strict';\nconst Config = {\n  a: 1,\n};\nlet n = 0\nvar x == 1\nfunction helper() {}\nasync function later() {}\nconst inner = () => { const local = 1; };";
    const out = adaptJsScript(code);
    expect(out.startsWith("'use strict';var exports=globalThis.exports;globalThis.helper=helper;globalThis.later=later;")).toBe(true);
    expect(out).toContain("const Config = globalThis.Config = {");
    expect(out).toContain("let n = 0");
    expect(out).toContain('Object.defineProperty(globalThis,"n"');
    expect(out).toContain("const inner = globalThis.inner = () =>");
    expect(out).toContain("var x == 1");
    expect(out).toContain("{ const local = 1; }");
  });

  it("keeps a reassigned top-level let in sync across scripts, in both directions", () => {
    const context = createContext({});
    const run = (code: string): void => {
      const wrapper: (exports: unknown) => void = runInContext(`(function (exports) {${adaptJsScript(code)}
})`, context);
      wrapper({});
    };
    run(`let counter = 0;
let pending;
function bump() { counter++; pending = 'set'; }`);
    run("globalThis.seen = [counter, pending]; bump(); globalThis.afterBump = [counter, pending]; counter = 10;");
    run("globalThis.later = counter; bump(); globalThis.last = counter;");
    expect(runInContext("[seen, afterBump, later, last]", context)).toEqual([[0, undefined], [1, "set"], 10, 11]);
  });

  it("leaves module style scripts alone", () => {
    const code = "const fs = require('fs');\nmodule.exports = { fs };";
    expect(adaptJsScript(code)).toBe(`var exports=globalThis.exports;${code}`);
  });
});
