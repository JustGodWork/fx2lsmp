import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World } from "./harness.ts";

const code = `
  exports('count', function(...) return select('#', ...), ... end)
`;

describe("exports proxy arguments", () => {
  let world: World;
  beforeAll(async () => {
    world = await World.withShim({ clients: 1, server: code });
  });
  afterAll(() => world.close());

  it("drops a nil first argument of a dot call", async () => {
    expect(await world.server.eval("local n, a = exports.unit.count(nil, 'a') return { n, a }")).toEqual([1, "a"]);
  });

  it("sends the arguments of a colon call without the proxy", async () => {
    expect(await world.server.eval("local n, a = exports.unit:count('a') return { n, a }")).toEqual([1, "a"]);
  });

  it("keeps a non nil first argument of a dot call", async () => {
    expect(await world.server.eval("local n, a, b = exports.unit.count('a', 'b') return { n, a, b }")).toEqual([2, "a", "b"]);
  });
});

describe("exports takesSelf", () => {
  let world: World;
  beforeAll(async () => {
    const extraConfig = `
      GETLOCAL_CALLS = 0
      debug = debug or {}
      debug.getlocal = function() GETLOCAL_CALLS = GETLOCAL_CALLS + 1 error('refused') end
    `;
    world = await World.withShim({
      clients: 1,
      extraConfig,
      server: `
        exports('make', function() return { go = function(a) return a end } end)
      `,
    });
  });
  afterAll(() => world.close());

  it("asks a host that raises only once", async () => {
    const calls = `
      local obj = exports.unit:make()
      for i = 1, 3 do obj.go(i) end
      return GETLOCAL_CALLS
    `;
    expect(await world.server.eval(calls)).toBeLessThanOrEqual(1);
  });
});
