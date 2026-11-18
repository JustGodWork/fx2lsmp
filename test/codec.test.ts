import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World } from "./harness.ts";

let world: World;
beforeAll(async () => {
  world = await World.withShim({ clients: 1 });
});
afterAll(() => world.close());

const server = (code: string) => world.server.eval(code);

describe("shim boot", () => {
  it("detects the side and exposes the FiveM globals", async () => {
    expect(await server("return IsDuplicityVersion()")).toBe(true);
    expect(await world.clients[0]!.eval("return IsDuplicityVersion()")).toBe(false);
    expect(await server("return GetCurrentResourceName()")).toBe("unit");
    expect(world.allErrors()).toEqual([]);
  });
});

describe("payload codec", () => {
  it("returns transportable tables untouched", async () => {
    expect(
      await server(`
        local t = { 1, 2, { a = 1, b = { 3, 4 } }, Vector3(1, 2, 3) }
        local m = { name = 'x', list = { 1, 2 }, empty = {} }
        return __fxc.encode(t) == t and __fxc.encode(m) == m and __fxc.encode({}) ~= nil
      `),
    ).toBe(true);
  });

  it("round trips sparse maps, mixed tables, float keys and the marker key", async () => {
    expect(
      await server(`
        local function same(a, b)
          if type(a) ~= 'table' or type(b) ~= 'table' then return a == b end
          for k, v in pairs(a) do if not same(v, b[k]) then return false end end
          for k in pairs(b) do if a[k] == nil then return false end end
          return true
        end
        local cases = {
          { [5] = 'a', [10] = 'b' },
          { 1, 2, name = 'x' },
          { [1.5] = 'f', [true] = 'b', s = { [3] = { [7] = 1 } } },
          { __fx = 'user value', other = 1 },
          { 1, nil, 3 },
        }
        for i, c in ipairs(cases) do
          local wire = __fxc.encode(c)
          if wire == c then return 'case ' .. i .. ' was not encoded' end
          if not same(__fxc.decode(wire), c) then return 'case ' .. i .. ' did not round trip' end
        end
        return 'ok'
      `),
    ).toBe("ok");
  });

  it("encoded payloads pass the strict transport rules", async () => {
    await server("lsmp.__strictLocal = true");
    expect(await server("return pcall(lsmp.emit, 'raw:x', { [5] = 1 })")).toBe(false);
    expect(
      await server(`
        TriggerEvent('codec:strict', { [5] = 1, 'a' }, { f = print, ok = true }, vector2(1, 2), vector4(1, 2, 3, 4))
        return 'sent'
      `),
    ).toBe("sent");
    await server("lsmp.__strictLocal = false");
    expect(world.allErrors()).toEqual([]);
  });

  it("drops functions with a single warning", async () => {
    const result = await server(`
      local a = __fxc.encode({ keep = 1, f = print })
      local b = __fxc.encode({ g = print, 1 })
      local c = __fxc.encode({ print, 2 })
      return { a.keep, a.f == nil, #c, c[1] == lsmp.null }
    `);
    expect(result).toEqual([1, true, 2, true]);
    const after = world.server.logs().filter((l) => l.includes("function inside a payload")).length;
    expect(after).toBe(1);
  });

  it("encodes vector2, vector4 and quat as marked maps and keeps Vector3", async () => {
    expect(
      await server(`
        local v2 = __fxc.encode(vector2(1, 2))
        local v4 = __fxc.encode(vector4(1, 2, 3, 4))
        local q = __fxc.encode(quat(1, 2, 3, 4))
        local v3 = Vector3(1, 2, 3)
        return { getmetatable(v2) == nil, v2.__fx, v2.y, v4.__fx, v4.w, q.__fx, q.w, __fxc.encode(v3) == v3 }
      `),
    ).toEqual([true, "v2", 2, "v4", 4, "q", 4, true]);
  });

  it("restores shim vectors after decode, nested and over the transport", async () => {
    expect(
      await server(`
        local back = __fxc.decode(__fxc.encode({ a = vector2(1, 2), list = { vector4(1, 2, 3, 4), quat(5, 6, 7, 8) } }))
        return {
          getmetatable(back.a) == getmetatable(vector2(0, 0)), back.a == vector2(1, 2), #back.a,
          back.list[1] == vector4(1, 2, 3, 4), back.list[2].w, tostring(back.list[2]),
        }
      `),
    ).toEqual([true, true, Math.sqrt(5), true, 8, "quat(5.0, 6.0, 7.0, 8.0)"]);
    await world.clients[0]!.eval("AddEventHandler('vec:in', function(a, b, c) VEC = { tostring(a), tostring(b), tostring(c) } end) RegisterNetEvent('vec:in')");
    await server("TriggerClientEvent('vec:in', 1, vector2(1, 2), vector4(1, 2, 3, 4), quat(0, 0, 0, 1))");
    await world.advance(100);
    expect(await world.clients[0]!.eval("return VEC")).toEqual(["vector2(1.0, 2.0)", "vector4(1.0, 2.0, 3.0, 4.0)", "quat(0.0, 0.0, 0.0, 1.0)"]);
  });

  it("keeps the NUI JSON form of flat vectors unmarked", async () => {
    expect(await server("local j = __fxc.toJson(vector2(1, 2)) return { j.__fx == nil, j.x, j.y }")).toEqual([true, 1, 2]);
  });

  it("encodeArgs and decodeArgs keep nil holes and counts", async () => {
    expect(
      await server(`
        local a, b, c, d = __fxc.decodeArgs(__fxc.encodeArgs(1, nil, { [4] = 'x' }, 'z'))
        return { a, b == nil, c[4], d }
      `),
    ).toEqual([1, true, "x", "z"]);
  });

  it("rejects nesting deeper than 32", async () => {
    expect(
      await server(`
        local t = {}
        local cur = t
        for i = 1, 40 do cur.n = {} cur = cur.n end
        local ok, err = pcall(__fxc.encode, t)
        return ok == false and err:find('deeper than 32') ~= nil
      `),
    ).toBe(true);
  });
});

describe("json helpers", () => {
  it("json.encode accepts what FiveM accepts", async () => {
    expect(await server("return json.encode({ [5] = 'a', [1] = 'b', f = print })")).toBe('{"1":"b","5":"a"}');
    expect(await server("return json.encode({ 1, 2, 3 })")).toBe("[1,2,3]");
    expect(await server("return json.encode({ a = 1 }, { indent = true })")).toContain("\n");
  });

  it("json.decode maps null to nil and reports errors", async () => {
    expect(await server("local v = json.decode('[1,null,3]') return { v[1], v[2] == nil, v[3] }")).toEqual([1, true, 3]);
    expect(await server("local v, err = json.decode('{oops') return { v == nil, err ~= nil }")).toEqual([true, true]);
  });

  it("toJson makes integer keys strings and fromJson removes nulls", async () => {
    expect(await server("local j = __fxc.toJson({ [7] = 'x', n = 1 }) return { j['7'], j.n }")).toEqual(["x", 1]);
    expect(await server("return __fxc.fromJson({ a = lsmp.null, b = 2 }).a == nil")).toBe(true);
  });
});

describe("hashes and vectors", () => {
  it("GetHashKey matches joaat", async () => {
    expect(await server("return GetHashKey('adder')")).toBe(3078201489);
    expect(await server("return joaat('ADDER') == GetHashKey('adder')")).toBe(true);
  });

  it("vector2 and vector4 support arithmetic", async () => {
    expect(await server("local v = vector2(1, 2) + vector2(3, 4) return { v.x, v.y, #vector2(3, 4) }")).toEqual([4, 6, 5]);
    expect(await server("return vector4(1, 2, 3, 4) == vector4(1, 2, 3, 4)")).toBe(true);
    expect(await server("return tostring(vector2(1, 2))")).toBe("vector2(1.0, 2.0)");
    expect(await server("return vector3 == Vector3 and vec3 == vector3")).toBe(true);
  });
});
