import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World, nth, type JsResource } from "./harness.ts";

const HEX_LUA = `
  local function hex(s) return (s:gsub('.', function(c) return string.format('%02x', c:byte()) end)) end
  local function bytes(h) return (h:gsub('%x%x', function(x) return string.char(tonumber(x, 16)) end)) end
`;

const JS_HELPERS = `
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const bytes = (h) => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
`;

const LUA_CLIENT = `
  RegisterNetEvent('t:down', function(...) GOT_DOWN = table.pack(...) end)
`;

let world: World;
let js: JsResource;

beforeAll(async () => {
  world = await World.withShim({ clients: 1, peers: true, resource: "luares", client: LUA_CLIENT });
  js = world.addJs("jsres");
  await world.loadJsShim(js);
  js.server.load("server.js", "onNet('t:up', (...a) => { globalThis.GOT_UP = [source, ...a]; }); on('t:local', (...a) => { globalThis.GOT_LOCAL = a; });");
  nth(js.clients, 0).load("client.js", "onNet('t:down', (...a) => { globalThis.GOT_DOWN = a; });");
  await world.advance(50);
});
afterAll(() => world.close());

const lua = <T>(code: string): Promise<T> => world.server.eval<T>(HEX_LUA + code);
const jsServer = <T>(code: string): Promise<T> => js.server.eval<T>(JS_HELPERS + code);
const jsClient = <T>(code: string): Promise<T> => nth(js.clients, 0).eval<T>(JS_HELPERS + code);

describe("msgpack_pack", () => {
  it("matches the MessagePack specification byte for byte, like the Lua codec", async () => {
    const hexes = await jsServer<string[]>(`return [
      1, -1, 'a', [1, 2], null, true, false, 255, 256, -33, 1.5, { a: 1 }, -129, 65536, 4294967296, -2147483649,
    ].map((v) => hex(msgpack_pack(v)))`);
    expect(hexes).toEqual([
      "01", "ff", "a161", "920102", "c0", "c3", "c2", "ccff", "cd0100", "d0df", "cb3ff8000000000000", "81a16101",
      "d1ff7f", "ce00010000", "cf0000000100000000", "d3ffffffff7fffffff",
    ]);
  });

  it("packs strings by their UTF-8 length and 64 bit integers exactly", async () => {
    const hexes = await jsServer<string[]>(`return [
      hex(msgpack_pack('é€😀')).slice(0, 2), hex(msgpack_pack('x'.repeat(32))).slice(0, 4), hex(msgpack_pack(2n ** 63n)),
      hex(msgpack_pack(-(2n ** 63n))), hex(msgpack_pack({ x: 1, y: 2, z: 3 })),
    ]`);
    expect(hexes).toEqual(["a9", "d920", "cf8000000000000000", "d38000000000000000", "c70c15" + "0000803f" + "00000040" + "00004040"]);
  });

  it("round trips values, unpacks the extension vectors and refuses truncated data", async () => {
    const out = await jsServer<unknown[]>(`
      const back = (v) => msgpack_unpack(msgpack_pack(v));
      const long = 'é'.repeat(200);
      let failure = '';
      try { msgpack_unpack(bytes('92')); } catch (e) { failure = String(e.message); }
      return [back({ n: [1, 2.5, null, 'é€😀'], s: long }).s === long, back(2 ** 40), back(-(2 ** 40)), String(back(2n ** 62n)),
        back({ x: 1, y: 2, z: 3 }), msgpack_unpack(bytes('d7140000c03f00002040')), failure, back(new Uint8Array([1, 2]))];
    `);
    expect(out).toEqual([true, 2 ** 40, -(2 ** 40), "4611686018427387904", { x: 1, y: 2, z: 3 }, { x: 1.5, y: 2.5 }, "msgpack: unexpected end of data", { "0": 1, "1": 2 }]);
  });
});

describe("cross language bytes", () => {
  it("JS unpacks what the Lua codec packs", async () => {
    const packed = await lua<string>(`return hex(msgpack.pack({ a = { 1, 2.5, 'é' }, b = true, c = -70000, v = vector3(1, 2, 3) }))`);
    const value = await jsServer(`return msgpack_unpack(bytes('${packed}'))`);
    expect(value).toEqual({ a: [1, 2.5, "é"], b: true, c: -70000, v: { x: 1, y: 2, z: 3 } });
  });

  it("Lua unpacks what JS packs", async () => {
    const packed = await jsServer<string>(`return hex(msgpack_pack({ a: [1, 2.5, 'é'], b: true, c: -70000, v: { x: 1, y: 2, z: 3 } }))`);
    const value = await lua(`local t = msgpack.unpack(bytes('${packed}')) return { t.a[1], t.a[2], t.a[3], t.b, t.c, t.v.x, t.v.y, t.v.z }`);
    expect(value).toEqual([1, 2.5, "é", true, -70000, 1, 2, 3]);
  });

  it("an argument list packed by Lua feeds TriggerEventInternal in JS", async () => {
    const packed = await lua<string>(`return hex(msgpack.pack_args(1, nil, 'two', { k = 3 }))`);
    await jsServer(`TriggerEventInternal('t:local', bytes('${packed}'), ${packed.length / 2}); return 0`);
    await world.advance(50);
    expect(await jsServer("return globalThis.GOT_LOCAL")).toEqual([1, null, "two", { k: 3 }]);
  });
});

describe("Trigger*Internal in JS", () => {
  it("TriggerServerEventInternal sends the unpacked arguments to the server", async () => {
    await jsClient(`TriggerServerEventInternal('t:up', msgpack_pack([5, { a: 'b' }]), 4); return 0`);
    await jsClient(`TriggerLatentServerEventInternal('t:up', msgpack_pack([6]), 1, 100); return 0`);
    await world.advance(50);
    expect(await jsServer("return globalThis.GOT_UP")).toEqual([1, 6]);
  });

  it("TriggerClientEventInternal reaches a JS and a Lua client", async () => {
    await jsServer(`TriggerClientEventInternal('t:down', 1, msgpack_pack(['x', 2]), 3); return 0`);
    await world.advance(50);
    expect(await jsClient("return globalThis.GOT_DOWN")).toEqual(["x", 2]);
    expect(await nth(world.clients, 0).eval("return GOT_DOWN")).toEqual({ n: 2, "1": "x", "2": 2 });
    await jsServer(`TriggerLatentClientEventInternal('t:down', 1, msgpack_pack(['y']), 1, 100); return 0`);
    await world.advance(50);
    expect(await jsClient("return globalThis.GOT_DOWN")).toEqual(["y"]);
  });

  it("is absent on the wrong side and fails on a payload that is not an argument array", async () => {
    expect(await jsServer("return typeof TriggerServerEventInternal")).toBe("undefined");
    expect(await jsClient("return typeof TriggerClientEventInternal")).toBe("undefined");
    expect(await jsServer("try { TriggerEventInternal('t:local', msgpack_pack(5)); return ''; } catch (e) { return e.message; }")).toBe(
      "msgpack: unpack_args expects an array",
    );
  });
});
