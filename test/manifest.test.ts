import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertResource, parseConvars } from "../tools/fx2lsmp/cli.ts";
import { normalizeResourceName, parseFxManifest, toLsmpManifest } from "../tools/fx2lsmp/manifest.ts";
import { globToRegExp, injectPrelude } from "../tools/fx2lsmp/nui.ts";

describe("fxmanifest parsing", () => {
  it("accepts curried, call and table forms", async () => {
    const fx = await parseFxManifest(`
      fx_version 'cerulean'
      game 'gta5'
      lua54 'yes'
      client_script 'client.lua'
      client_scripts { 'a.lua', 'b/*.lua' }
      server_script("server.lua")
      shared_scripts { 'config.lua' }
      dependency 'ox_lib'
      dependencies { 'x', '/server:5848' }
      files { 'html/style.css', 'data/handling.meta' }
      data_file 'HANDLING_FILE' 'data/handling.meta'
      ui_page 'html/index.html'
      author 'me'
      description 'd'
      version '1.2'
    `);
    expect(fx.clientScripts).toEqual(["client.lua", "a.lua", "b/*.lua"]);
    expect(fx.serverScripts).toEqual(["server.lua"]);
    expect(fx.sharedScripts).toEqual(["config.lua"]);
    expect(fx.dependencies).toEqual(["ox_lib", "x"]);
    expect(fx.dataFiles).toEqual([{ type: "HANDLING_FILE", path: "data/handling.meta" }]);
    expect(fx.uiPage).toBe("html/index.html");
    expect(fx.author).toBe("me");
    expect(fx.warnings).toEqual([expect.stringContaining("/server:5848")]);
  });

  it("warns about @ paths and unknown directives", async () => {
    const fx = await parseFxManifest(`
      server_scripts { '@mysql-async/lib/MySQL.lua', 'server.lua' }
      shared_script '@ox_lib/init.lua'
      weird_directive 'x'
    `);
    expect(fx.serverScripts).toEqual(["server.lua"]);
    expect(fx.sharedScripts).toEqual([]);
    expect(fx.warnings).toHaveLength(3);
    expect(fx.warnings.join("\n")).toContain("@mysql-async/lib/MySQL.lua");
    expect(fx.warnings.join("\n")).toContain("unknown directive 'weird_directive'");
  });

  it("accepts a directive called with a name and then a table (chat_theme 'x' { ... })", async () => {
    const fx = await parseFxManifest(`
      file 'style.css'
      chat_theme 'esx' {
        styleSheet = 'style.css',
        msgTemplates = { default = '<b>{0}</b>' },
      }
    `);
    expect(fx.files).toEqual(["style.css"]);
    expect(fx.metadata.chat_theme).toEqual(["esx"]);
  });

  it("keeps custom directives as readable metadata and stays quiet about informational ones", async () => {
    const fx = await parseFxManifest(`
      repository 'https://example.test/r'
      author 'me'
      theme_name 'dark'
      theme_name 'light'
      theme_list { 'a', 'b' }
    `);
    expect(fx.warnings).toEqual(["unknown directive 'theme_name'", "unknown directive 'theme_list'"]);
    expect(fx.metadata).toEqual({
      repository: ["https://example.test/r"],
      author: ["me"],
      theme_name: ["dark", "light"],
      theme_list: ["a", "b"],
    });
  });

  it("supports Lua helpers inside the manifest", async () => {
    const fx = await parseFxManifest(`
      local list = {}
      for i = 1, 2 do list[#list + 1] = 'f' .. i .. '.lua' end
      client_scripts(list)
    `);
    expect(fx.clientScripts).toEqual(["f1.lua", "f2.lua"]);
  });
});

describe("manifest.json conversion", () => {
  it("builds the LS:MP manifest", async () => {
    const fx = await parseFxManifest(`
      client_script 'client.lua'
      server_script 'server.lua'
      shared_script 'shared.lua'
      files { 'html/style.css', 'html/app.js', 'data/handling.meta', 'extra.txt' }
      data_file 'HANDLING_FILE' 'data/handling.meta'
      ui_page 'html/index.html'
      dependency 'ox_lib'
      export 'foo'
    `);
    const manifest = toLsmpManifest(fx, "hello");
    expect(manifest).toEqual({
      title: "hello",
      shared_scripts: ["_fxcompat/config.lua", "_fxcompat/init.lua", "shared.lua"],
      client_scripts: ["client.lua"],
      server_scripts: ["server.lua"],
      files: ["extra.txt"],
      webui: ["html"],
      data_files: [{ path: "data/handling.meta", type: "HANDLING_FILE" }],
      dependencies: ["ox_lib"],
    });
  });

  it("accepts nui:// ui_page and a root page", async () => {
    const nui = toLsmpManifest(await parseFxManifest("ui_page 'nui://res/web/index.html'"), "res");
    expect(nui.webui).toEqual(["web"]);
    const root = toLsmpManifest(await parseFxManifest("ui_page 'index.html'"), "res");
    expect(root.webui).toEqual(["webui"]);
  });

  it("reads the table form of ui_page", async () => {
    const fx = await parseFxManifest("ui_page { 'html/ui.html' }");
    expect(fx.uiPage).toBe("html/ui.html");
  });

  it("lowercases the resource name", () => {
    const warnings: string[] = [];
    expect(normalizeResourceName("My_Resource", warnings)).toBe("my_resource");
    expect(warnings).toHaveLength(1);
    expect(normalizeResourceName("ok-name", [])).toBe("ok-name");
  });
});

describe("nui helpers", () => {
  it("injects the prelude before the first script, once", () => {
    const html = "<html><head><title>x</title><script src=a.js></script></head></html>";
    const out = injectPrelude(html);
    expect(out.indexOf("nui-prelude.js")).toBeLessThan(out.indexOf("a.js"));
    expect(injectPrelude(out)).toBe(out);
    expect(injectPrelude("<body></body>")).toContain("nui-prelude.js");
  });
  it("matches globs", () => {
    expect(globToRegExp("html/*.css").test("html/a.css")).toBe(true);
    expect(globToRegExp("html/*.css").test("html/x/a.css")).toBe(false);
    expect(globToRegExp("html/**").test("html/x/a.css")).toBe(true);
  });
});

describe("server.cfg convars", () => {
  it("reads set, setr and sets", () => {
    expect(parseConvars('set a 1\nsetr b "two words"\nsets c x # note\n# set d 4\nendpoint_add_tcp "x"')).toEqual({
      a: { value: "1", kind: "set" },
      b: { value: "two words", kind: "setr" },
      c: { value: "x", kind: "sets" },
    });
  });
});

describe("convertResource", () => {
  it("builds a converted resource from a FiveM one", async () => {
    const root = mkdtempSync(join(tmpdir(), "fx2lsmp-"));
    const src = join(root, "Hello");
    mkdirSync(join(src, "html"), { recursive: true });
    const shim = join(root, "shim");
    mkdirSync(shim);
    writeFileSync(join(shim, "core.lua"), "-- core\n");
    writeFileSync(join(shim, "client.lua"), "-- client\n");
    writeFileSync(join(shim, "events.lua"), "-- events\n");
    writeFileSync(join(shim, "nui-prelude.js"), "// prelude\n");
    writeFileSync(join(src, "fxmanifest.lua"), "client_script 'c.lua'\nui_page 'html/index.html'\n");
    writeFileSync(join(src, "c.lua"), "local h = `adder`\nlocal n = 0\nn += 1\n");
    writeFileSync(join(src, "html", "index.html"), "<html><head><script src=\"a.js\"></script></head></html>");
    writeFileSync(join(root, "server.cfg"), "setr foo bar\nset hidden x\n");
    const out = join(root, "out");
    const result = await convertResource({ resourceDir: src, outDir: out, cfg: join(root, "server.cfg"), shimDir: shim });
    expect(result.name).toBe("hello");
    expect(readFileSync(join(out, "c.lua"), "utf8")).toBe("local h = 3078201489\nlocal n = 0\nn = n + (1)\n");
    expect(readFileSync(join(out, "_fxcompat", "init.lua"), "utf8")).toBe("-- core\n\n-- events\n\n-- client\n");
    expect(readFileSync(join(out, "_fxcompat", "config.lua"), "utf8")).toContain('["foo"] = "bar"');
    expect(readFileSync(join(out, "_fxcompat", "config.lua"), "utf8")).not.toContain("hidden");
    expect(readFileSync(join(out, "_fxcompat", "server_convars.json"), "utf8")).toContain("hidden");
    expect(readFileSync(join(out, "_fxcompat", "config.lua"), "utf8")).toContain('uiPage = "index.html"');
    expect(readFileSync(join(out, "html", "index.html"), "utf8")).toMatch(/nui-prelude\.js.*a\.js/);
    expect(existsSync(join(out, "html", "_fxcompat", "nui-prelude.js"))).toBe(true);
    expect(existsSync(join(out, "fxmanifest.lua"))).toBe(false);
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")).webui).toEqual(["html"]);
  });
});
