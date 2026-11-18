import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World } from "./harness.ts";

const HEX = `
  local function hex(s) return (s:gsub('.', function(c) return string.format('%02x', c:byte()) end)) end
  local function same(a, b)
    if type(a) ~= 'table' or type(b) ~= 'table' then return a == b and math.type(a) == math.type(b) end
    for k, v in pairs(a) do if not same(v, b[k]) then return false end end
    for k in pairs(b) do if a[k] == nil then return false end end
    return true
  end
`;

const SERVER = `
  GOT = {}
`;
const CLIENT = `
  GOT = {}
  RegisterNetEvent('t:mp', function(...) GOT.args = table.pack(...) end)
`;

let world: World;
beforeAll(async () => {
  world = await World.withShim({ clients: 1, server: SERVER, client: CLIENT });
});
afterAll(() => world.close());

const run = <T>(code: string): Promise<T> => world.server.eval<T>(HEX + code);

describe("msgpack encoding", () => {
  it("matches the MessagePack specification byte for byte", async () => {
    const hexes = await run<string[]>(`return {
      hex(msgpack.pack(1)), hex(msgpack.pack(-1)), hex(msgpack.pack('a')), hex(msgpack.pack({ 1, 2 })),
      hex(msgpack.pack(nil)), hex(msgpack.pack(true)), hex(msgpack.pack(false)), hex(msgpack.pack(255)),
      hex(msgpack.pack(256)), hex(msgpack.pack(-33)), hex(msgpack.pack(1.5)), hex(msgpack.pack({ a = 1 })),
      hex(msgpack.pack_args(1, nil, 'a')), hex(msgpack.pack(math.mininteger)), hex(msgpack.pack(math.maxinteger)),
    }`);
    expect(hexes).toEqual([
      "01", "ff", "a161", "920102", "c0", "c3", "c2", "ccff", "cd0100", "d0df", "cb3ff8000000000000", "81a16101",
      "9301c0a161", "d38000000000000000", "cf7fffffffffffffff",
    ]);
  });
});

describe("msgpack round trip", () => {
  it("keeps scalars, integer boundaries and floats", async () => {
    expect(
      await run<boolean>(`
        local values = { true, false, 0, 127, 128, 255, 256, 65535, 65536, 4294967295, 4294967296, -1, -32, -33,
          -128, -129, -32768, -32769, -2147483648, -2147483649, math.maxinteger, math.mininteger, 1.5, -0.25, 1e300, 3.0 }
        for _, v in ipairs(values) do
          if not same(msgpack.unpack(msgpack.pack(v)), v) then return false end
        end
        return true
      `),
    ).toBe(true);
  });

  it("keeps strings across the str sizes", async () => {
    expect(
      await run<boolean>(`
        for _, n in ipairs({ 0, 1, 31, 32, 255, 256, 65535, 65536, 70000 }) do
          local s = string.rep('x', n)
          if msgpack.unpack(msgpack.pack(s)) ~= s then return false end
        end
        return hex(msgpack.pack(string.rep('x', 32))):sub(1, 4) == 'd920' and hex(msgpack.pack(string.rep('x', 256))):sub(1, 6) == 'da0100'
          and hex(msgpack.pack(string.rep('x', 65536))):sub(1, 10) == 'db00010000'
      `),
    ).toBe(true);
  });

  it("keeps nested tables and maps with integer and string keys", async () => {
    expect(
      await run<boolean>(`
        local big = {}
        for i = 1, 20 do big[i] = i end
        local v = { list = { 1, { 2, 3 }, { deep = { 'x' } } }, [10] = 'ten', [-1] = 'neg', [1.5] = 'f', name = 'n', big = big, empty = {} }
        return same(msgpack.unpack(msgpack.pack(v)), v)
      `),
    ).toBe(true);
  });

  it("keeps nil holes and the count in packed arguments", async () => {
    expect(
      await run<[number, boolean, boolean]>(`
        local r = table.pack(msgpack.unpack_args(msgpack.pack_args(nil, 1, nil, 'a', nil)))
        return { r.n, r[1] == nil and r[2] == 1 and r[3] == nil and r[4] == 'a', r[5] == nil }
      `),
    ).toEqual([5, true, true]);
    expect(await run<number>("return select('#', msgpack.unpack_args(msgpack.pack_args()))")).toBe(0);
  });

  it("keeps vectors through the ext types", async () => {
    expect(
      await run<string[]>(`
        local v3 = msgpack.unpack(msgpack.pack(vector3(1, 2.5, -3)))
        local v2 = msgpack.unpack(msgpack.pack(vector2(4, 5)))
        local v4 = msgpack.unpack(msgpack.pack(vector4(1, 2, 3, 4)))
        local q = msgpack.unpack(msgpack.pack(quat(1, 2, 3, 4)))
        return { tostring(v3), tostring(v2), tostring(v4), tostring(q),
          hex(msgpack.pack(vector2(1, 2))), hex(msgpack.pack(vector3(1, 2, 3))):sub(1, 6) }
      `),
    ).toEqual([
      "Vector3(1.0, 2.5, -3.0)", "vector2(4.0, 5.0)", "vector4(1.0, 2.0, 3.0, 4.0)", "quat(1.0, 2.0, 3.0, 4.0)",
      "d7140000803f00000040", "c7 0c 15".replace(/ /g, ""),
    ]);
  });
});

describe("msgpack errors", () => {
  it("raises on functions, cycles and truncated data", async () => {
    expect(await run<string>("return select(2, pcall(msgpack.pack, print))")).toContain("cannot pack a function");
    expect(await run<string>("return select(2, pcall(msgpack.pack_args, 1, function() end))")).toContain("cannot pack a function");
    expect(await run<string>("local t = {} t.t = t return select(2, pcall(msgpack.pack, t))")).toContain("depth limit");
    expect(await run<boolean>("return (pcall(msgpack.unpack, string.char(0x92, 1)))")).toBe(false);
  });
});

describe("TriggerClientEventInternal", () => {
  it("reaches the client handler with the original arguments", async () => {
    await world.server.eval(`
      local payload = msgpack.pack_args('hello', nil, { a = 1, list = { 1, 2 } }, 7)
      TriggerClientEventInternal('t:mp', 1, payload, #payload)
    `);
    await world.advance(50);
    const got = await world.clients[0]!.eval<{ n: number; "1": string; "3": { a: number; list: number[] }; "4": number }>("return GOT.args");
    expect(got.n).toBe(4);
    expect(got["1"]).toBe("hello");
    expect(got["3"]).toEqual({ a: 1, list: [1, 2] });
    expect(got["4"]).toBe(7);
  });
});
