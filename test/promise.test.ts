import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embedPromise } from "../tools/fx2lsmp/cli.ts";
import { World } from "./harness.ts";

const VENDORED = resolve(import.meta.dirname, "../shim/vendor/promise.lua");
const UPSTREAM = "E:/GITHUB/fx-oop/runtime/shared/promise.lua";

describe("vendored promise library", () => {
  it.skipIf(!existsSync(UPSTREAM))("is byte identical to the fx-oop file", () => {
    expect(readFileSync(VENDORED).equals(readFileSync(UPSTREAM))).toBe(true);
  });

  it("is embedded as a function called with its dependencies", () => {
    const out = embedPromise("return 1");
    expect(out.startsWith("FXC.promiseLib = (function(...)")).toBe(true);
    expect(out.trimEnd().endsWith("end)(FXC.promiseDeps)")).toBe(true);
  });
});

describe("promise globals", () => {
  let world: World;
  beforeAll(async () => {
    world = await World.withShim({ clients: 0 });
  });
  afterAll(() => world.close());

  it("Citizen.Await waits for a promise resolved by a timer", async () => {
    expect(
      await world.server.eval(`
        local p = promise.new()
        SetTimeout(50, function() p:resolve(7, 'b') end)
        local a, b = Citizen.Await(p)
        return { a, b }
      `),
    ).toEqual([7, "b"]);
  });

  it("raises the rejection reason", async () => {
    expect(
      await world.server.eval(`
        local p = promise.new()
        SetTimeout(10, function() p:reject('nope') end)
        local ok, err = pcall(Citizen.Await, p)
        return { ok, err }
      `),
    ).toEqual([false, expect.stringContaining("nope")]);
  });

  it("next chains and promise.all collects", async () => {
    expect(
      await world.server.eval(`
        local a = promise.new()
        local b = promise.new()
        SetTimeout(10, function() a:resolve(1) end)
        SetTimeout(20, function() b:resolve(2) end)
        local doubled = a:next(function(v) return v * 2 end)
        local all = Citizen.Await(promise.all({ doubled, b }))
        return { all[1], all[2] }
      `),
    ).toEqual([2, 2]);
  });

  it("Await outside a host coroutine reports a clear error", async () => {
    const message = await world.server.eval<string>(`
      local p = promise.new()
      local co = coroutine.create(function() return Citizen.Await(p) end)
      local ok, err = coroutine.resume(co)
      return tostring(err)
    `);
    expect(message).toContain("host coroutine");
  });
});
