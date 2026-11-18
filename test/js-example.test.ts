import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertResource } from "../tools/fx2lsmp/cli.ts";
import { World, type JsResource } from "./harness.ts";

const EXAMPLE = resolve(import.meta.dirname, "../examples/fivem/hello_js");

let out: string;
let world: World;
let js: JsResource;
let warnings: string[];

beforeAll(async () => {
  out = join(mkdtempSync(join(tmpdir(), "fxjs-")), "hello_js");
  warnings = (await convertResource({ resourceDir: EXAMPLE, outDir: out })).warnings;
  const loaded = await World.fromConvertedMixed(out, 2);
  world = loaded.world;
  if (loaded.js === undefined) throw new Error("no JS resource was loaded");
  js = loaded.js;
  await world.advance(300);
});
afterAll(() => world.close());

describe("converted JS example", () => {
  it("is converted without warnings and declares the JS shim only", () => {
    expect(warnings).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(manifest.shared_scripts).toEqual(["_fxcompat/config.js", "_fxcompat/init.js", "config.js"]);
    expect(manifest.client_scripts).toEqual(["client.js"]);
    expect(existsSync(join(out, "_fxcompat", "init.lua"))).toBe(false);
    expect(readFileSync(join(out, "_fxcompat", "config.js"), "utf8")).toContain('"uiPage":"index.html"');
    expect(readFileSync(join(out, "_fxcompat", "config.js"), "utf8")).not.toContain("kvpPage");
    expect(readFileSync(join(out, "html", "index.html"), "utf8")).toContain("/_fxcompat/nui-prelude.js");
  });

  it("starts: boot counter in KVP, resource start event", async () => {
    expect(await js.server.eval("return GetResourceKvpInt('boots')")).toBe(1);
    js.server.fire("resourceStart", "hello_js");
    await world.advance(30);
    expect(js.server.logs()).toContain("hello_js started, boot number 1, model prop_cs_trowel");
  });

  it("client command, server event with the right source, answer and broadcast", async () => {
    const [first, second] = js.clients;
    first?.command(null, "hello Ann");
    await world.advance(300);

    const logs = js.server.logs();
    expect(logs).toContain("greeting from source 1: Ann, item 101 = trowel, attempt 1");
    expect(logs).toContain("client 1 ready, hash matches GetHashKey: true");
    expect(first?.logs()).toContain("welcome from Ann (source 65535): 1 greetings, license:101");
    expect(second?.logs()).not.toContain("welcome from Ann (source 65535): 1 greetings, license:101");
  });

  it("export result and KVP are persisted", async () => {
    expect(await js.server.eval("return await exports.hello_js.getGreetings()")).toEqual([1, "Ann"]);
    expect(await js.server.eval("return GetResourceKvpString('last_greeter')")).toBe("Ann");
  });

  it("NUI: the page gets the messages and its callback reaches the client script and the server", async () => {
    const first = js.clients[0];
    if (first === undefined) throw new Error("no client");
    const page = world.pageFor(first);
    expect(page.messages).toContainEqual({
      type: "welcome",
      from: "Ann",
      items: { "101": "trowel", "205": "bucket" },
      total: 1,
    });
    expect(page.messages.at(-1)).toEqual({ type: "broadcast", text: "Ann says hello" });
    expect(page.document.getElementById("title").textContent).toBe("Hello Ann (1)");
    expect(await first.eval("return IsNuiFocused()")).toBe(true);

    page.document.getElementById("close").dispatch("click");
    await world.advance(100);

    expect(page.document.getElementById("status").textContent).toBe("closed");
    expect(await first.eval("return IsNuiFocused()")).toBe(false);
    expect(await js.server.eval("return GetResourceKvpString('last_close')")).toBe("1:button");
  });

  it("the F5 key mapping drives the +/- commands", async () => {
    const first = js.clients[0];
    if (first === undefined) throw new Error("no client");
    first.press(166);
    await world.advance(30);
    expect(world.pageFor(first).messages.at(-1)).toEqual({ type: "toggle", visible: true });
    first.release(166);
    await world.advance(30);
    expect(world.pageFor(first).messages.at(-1)).toEqual({ type: "toggle", visible: false });
  });

  it("handles a leaving player and the restricted console command", async () => {
    js.server.fire("playerLeave", 1, "Player2", "quit", "bye");
    await world.advance(30);
    expect(js.server.logs()).toContain("player 2 left: quit: bye");
    expect(js.server.command(1, "greetings")).toBe("denied");
    expect(js.server.command(null, "greetings")).toBe("ok");
    await world.advance(30);
    expect(js.server.logs()).toContain("greetings so far: 1");
  });

  it("no mock rule was broken", () => {
    expect(world.allErrors()).toEqual([]);
  });
});
