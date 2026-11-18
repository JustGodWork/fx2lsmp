import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concatShim, renderConfig } from "../tools/fx2lsmp/cli.ts";
import { resolve } from "node:path";
import { World } from "./harness.ts";

let world: World;
beforeAll(async () => {
  world = await World.create({ clients: 0 });
  await world.server.eval("Vector3 = nil");
  world.server.load("config.lua", `${renderConfig(undefined, {})}\nFXCOMPAT_CONFIG.expose = true\n`);
  world.server.load("init.lua", concatShim(resolve(import.meta.dirname, "../shim")));
  await world.advance(30);
});
afterAll(() => world.close());

describe("vector3 fallback when the engine has no Vector3", () => {
  it("provides a table based vector3 with arithmetic that the codec lets through", async () => {
    expect(
      await world.server.eval(`
        local v = vector3(1, 2, 3) + vector3(1, 1, 1)
        return { v.x, v.z, #vector3(0, 3, 4), __fxc.encode(v) == v, vec3 == vector3 }
      `),
    ).toEqual([2, 4, 5, true, true]);
  });
});

describe("table.unpack on vectors", () => {
  it("unpacks the table based vectors and leaves plain tables alone", async () => {
    expect(
      await world.server.eval(`
        local a = { table.unpack(vector3(1, 2, 3)) }
        local b = { table.unpack(vector4(1, 2, 3, 4)) }
        local c = { table.unpack(vector2(5, 6)) }
        local d = { table.unpack({ 7, 8, 9 }, 2) }
        return { #a, a[3], #b, b[4], #c, c[2], #d, d[1] }
      `),
    ).toEqual([3, 3, 4, 4, 2, 6, 2, 8]);
  });
});

describe("transpiled safe navigation", () => {
  it("evaluates to nil on a nil operand and reads the field otherwise", async () => {
    expect(
      await world.server.eval(`
        local t = { a = { b = 5 } }
        local none = nil
        return { (t or __fxc_nil).a.b, (none or __fxc_nil).a == nil, (t.zz or __fxc_nil).b == nil }
      `),
    ).toEqual([5, true, true]);
  });
});
