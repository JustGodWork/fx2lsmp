import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertResource } from "../tools/fx2lsmp/cli.ts";
import { World, nth, type JsResource } from "./harness.ts";

let world: World;
let js: JsResource;

beforeAll(async () => {
  const out = join(mkdtempSync(join(tmpdir(), "fxspawnjs-")), "spawnmanager");
  const result = await convertResource({ resourceDir: resolve(import.meta.dirname, "../compat/spawnmanager"), outDir: out });
  expect(result.warnings).toEqual([]);
  world = await World.fromConverted(out, 1, undefined, undefined, true);
  js = world.addJs("jsapp");
  await world.loadJsShim(js, {}, "client");
  await world.advance(50);
});
afterAll(() => world.close());

const jsClient = () => nth(js.clients, 0);
const luaClient = () => nth(world.clients, 0);
const spawns = () => luaClient().eval<{ pos: { x: number; y: number; z: number }; opts: { heading: number; model?: string } }[]>("return lsmp.__test.spawns");

describe("a JS resource calling the Lua spawnmanager", () => {
  it("spawnPlayer takes a spawn table and a callback function", async () => {
    const result = await jsClient().eval(`
      globalThis.seen = null;
      const ok = await exports.spawnmanager.spawnPlayer({ x: 1, y: 2, z: 3, heading: 90, model: 'a_m_y_skater_01' }, (spawn) => { globalThis.seen = spawn.x; });
      return ok;
    `);
    await world.advance(50);
    expect(result).toBe(true);
    expect(await jsClient().eval("return globalThis.seen")).toBe(1);
    expect((await spawns())[0]).toEqual({ pos: { x: 1, y: 2, z: 3 }, opts: { heading: 90, model: "a_m_y_skater_01" } });
  });

  it("addSpawnPoint then spawnPlayer by index", async () => {
    const [idx, ok] = await jsClient().eval<[number, boolean]>(`
      const idx = await exports.spawnmanager.addSpawnPoint({ x: 10, y: 20, z: 30, heading: 5 });
      return [idx, await exports.spawnmanager.spawnPlayer(idx)];
    `);
    expect([idx, ok]).toEqual([1, true]);
    expect((await spawns()).at(-1)?.pos).toEqual({ x: 10, y: 20, z: 30 });
  });

  it("a bad spawn rejects in the JS caller", async () => {
    const message = await jsClient().eval<string>("try { await exports.spawnmanager.spawnPlayer({ x: 1 }); return 'no error'; } catch (e) { return e.message; }");
    expect(message).toContain("export 'spawnmanager:spawnPlayer' failed");
    expect(luaClient().errors().some((e) => e.includes("expected a spawn table"))).toBe(true);
  });

  it("setAutoSpawnCallback takes a function and forceRespawn runs it", async () => {
    await jsClient().eval(`
      globalThis.called = 0;
      await exports.spawnmanager.setAutoSpawnCallback(() => { globalThis.called++; });
      await exports.spawnmanager.forceRespawn();
    `);
    await world.advance(50);
    expect(await jsClient().eval("return globalThis.called")).toBe(1);
    luaClient().runAutoSpawn();
    await world.advance(50);
    expect(await jsClient().eval("return globalThis.called")).toBe(2);
  });

  it("setAutoSpawn(false) is forwarded to LS:MP", async () => {
    await jsClient().eval("await exports.spawnmanager.setAutoSpawn(false)");
    expect(await luaClient().eval("return lsmp.__test.autoSpawn")).toBe(false);
  });

  it("no mock rule was broken in any VM", () => {
    expect(world.allErrors().filter((e) => !e.includes("expected a spawn table"))).toEqual([]);
  });
});
