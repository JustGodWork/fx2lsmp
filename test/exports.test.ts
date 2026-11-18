import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World } from "./harness.ts";

let world: World;
const code = `
  exports('add', function(a, b) return a + b, 'extra' end)
  exports('nothing', function() end)
  exports('nilFirst', function() return nil, 5 end)
  exports('sparse', function(t) return { [5] = t[7] }, t end)
  exports('boom', function() error('kaboom') end)
  exports('whoCalls', function() return source end)
`;

beforeAll(async () => {
  world = await World.withShim({ clients: 1, server: code, client: code });
});
afterAll(() => world.close());

describe("exports", () => {
  it("returns every result of a registered export", async () => {
    expect(await world.server.eval("local a, b = exports.unit:add(1, 2) return { a, b }")).toEqual([3, "extra"]);
    expect(await world.server.eval("local a, b = exports['unit']:add(4, 5) return { a, b }")).toEqual([9, "extra"]);
  });

  it("accepts the call without the proxy self argument", async () => {
    expect(await world.server.eval("return exports['unit'].add(2, 3)")).toBe(5);
  });

  it("keeps nil results in place and empty results empty", async () => {
    expect(await world.server.eval("local a, b = exports.unit:nilFirst() return { a == nil, b }")).toEqual([true, 5]);
    expect(await world.server.eval("return select('#', exports.unit:nothing())")).toBe(0);
  });

  it("sends sparse tables through the codec both ways", async () => {
    expect(
      await world.server.eval("local r, echoed = exports.unit:sparse({ [7] = 'seven' }) return { r[5], echoed[7] }"),
    ).toEqual(["seven", "seven"]);
  });

  it("raises with the error code when the export fails or is missing", async () => {
    expect(await world.server.eval("local ok, err = pcall(function() return exports.unit:boom() end) return { ok, err }")).toEqual([
      false,
      expect.stringContaining("failed: error"),
    ]);
    expect(await world.server.eval("local ok, err = pcall(function() return exports.other:nope() end) return err")).toContain(
      "not available",
    );
  });

  it("works on the client too", async () => {
    expect(await world.clients[0]!.eval("return exports.unit:add(20, 22)")).toBe(42);
  });

  it("no mock rule was broken", () => {
    const errors = world.allErrors().filter((e) => !e.includes("kaboom"));
    expect(errors).toEqual([]);
  });
});
