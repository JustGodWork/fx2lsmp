import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertResource } from "../tools/fx2lsmp/cli.ts";
import { World } from "./harness.ts";

const EXAMPLE = resolve(import.meta.dirname, "../examples/fivem/hello");

let out: string;
let world: World;
let warnings: string[];

beforeAll(async () => {
  out = join(mkdtempSync(join(tmpdir(), "fxe2e-")), "hello");
  warnings = (await convertResource({ resourceDir: EXAMPLE, outDir: out })).warnings;
  world = await World.fromConverted(out, 2);
  await world.advance(300);
});
afterAll(() => world.close());

const [first, second] = [() => world.clients[0]!, () => world.clients[1]!];

describe("converted example", () => {
  it("is converted without warnings and without CfxLua syntax left", () => {
    expect(warnings).toEqual([]);
    const server = readFileSync(join(out, "server.lua"), "utf8");
    const client = readFileSync(join(out, "client.lua"), "utf8");
    expect(server).toContain("greetings = greetings + (1)");
    expect(client).toContain("local TROWEL = 2360793148");
    expect(client).not.toContain("`");
    expect(existsSync(join(out, "html", "_fxcompat", "nui-prelude.js"))).toBe(true);
    expect(readFileSync(join(out, "html", "index.html"), "utf8")).toContain("/_fxcompat/nui-prelude.js");
  });

  it("starts: boot counter in KVP, resource start event, promise await", async () => {
    expect(await world.server.eval("return GetResourceKvpInt('boots')")).toBe(1);
    expect(await world.server.eval("return READY")).toBe("ready");
    world.server.fire("resourceStart", "hello");
    await world.advance(30);
    expect(world.server.logs()).toContain("hello started, boot number 1");
  });

  it("client command -> server event with the right source -> answer and broadcast", async () => {
    await first().eval("__runCommand(nil, 'hello Ann')");
    await world.advance(200);

    const logs = world.server.logs();
    expect(logs).toContain("greeting from source 1: Ann, item 101 = trowel, attempt 1");
    expect(logs).toContain("client 1 ready, backtick hash matches GetHashKey: true");

    expect(first().logs()).toContain("welcome from Ann (source 65535): 1 greetings, license:101");
    expect(second().logs()).not.toContain("welcome from Ann (source 65535): 1 greetings, license:101");
  });

  it("export result and KVP are persisted", async () => {
    expect(await world.server.eval("local n, last = exports.hello:getGreetings() return { n, last }")).toEqual([1, "Ann"]);
    expect(await world.server.eval("return GetResourceKvpString('last_greeter')")).toBe("Ann");
  });

  it("NUI message is delivered and the callback answers the page", async () => {
    const page = world.page(0);
    expect(page.messages.at(-1)).toEqual({ type: "broadcast", text: "Ann says hello" });
    expect(page.messages).toContainEqual({
      type: "welcome",
      from: "Ann",
      items: { "101": "trowel", "205": "bucket" },
      total: 1,
    });
    expect(page.document.getElementById("title").textContent).toBe("Hello Ann (1)");
    expect(page.document.getElementById("items").innerHTML).toBe("<li>101: trowel</li><li>205: bucket</li>");
    expect(await first().eval("return IsNuiFocused()")).toBe(true);

    page.document.getElementById("close").dispatch("click");
    await world.advance(100);

    expect(page.document.getElementById("status").textContent).toBe("closed");
    expect(await first().eval("return IsNuiFocused()")).toBe(false);
    expect(await world.server.eval("return GetResourceKvpString('last_close')")).toBe("1:button");
  });

  it("the broadcast reached the other client's page as well", () => {
    expect(world.page(1).messages.at(-1)).toEqual({ type: "broadcast", text: "Ann says hello" });
    expect(world.page(1).document.getElementById("broadcast").textContent).toBe("Ann says hello");
  });

  it("the F5 key mapping drives the +/- commands", async () => {
    first().press(166);
    await world.advance(30);
    expect(world.page(0).messages.at(-1)).toEqual({ type: "toggle", visible: true });
    first().release(166);
    await world.advance(30);
    expect(world.page(0).messages.at(-1)).toEqual({ type: "toggle", visible: false });
  });

  it("handles a leaving player and the restricted console command", async () => {
    world.server.fire("playerLeave", 1, "Player2", "quit", "bye");
    await world.advance(30);
    expect(world.server.logs()).toContain("player 2 left: quit: bye");
    expect(await world.server.eval("return __runCommand(1, 'greetings')")).toBe("denied");
    expect(await world.server.eval("return __runCommand(nil, 'greetings')")).toBe("ok");
    await world.advance(30);
    expect(world.server.logs()).toContain("greetings so far: 1");
  });

  it("KVP survives a restart of the server", async () => {
    const dump = world.server.storageDump();
    const again = await World.fromConverted(out, 1);
    again.server.storageLoad(dump);
    expect(await again.server.eval("return GetResourceKvpInt('boots')")).toBe(1);
    again.close();
    const restarted = await World.fromConverted(out, 0);
    restarted.server.storageLoad(dump);
    await restarted.server.eval("local b = GetResourceKvpInt('boots') SetResourceKvpInt('boots', b + 1)");
    expect(await restarted.server.eval("return GetResourceKvpInt('boots')")).toBe(2);
    restarted.close();
  });

  it("no mock transport rule was broken in any VM", () => {
    expect(world.allErrors()).toEqual([]);
  });
});
