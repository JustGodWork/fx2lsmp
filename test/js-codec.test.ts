import { describe, expect, it } from "vitest";
import { MARK, decode, encode, encodeArgs, exportEvent, isFnRef, isVec3, toJson } from "../shim/js/protocol.ts";
import { WireError, fromWire, toWire } from "./wire.ts";

describe("encode", () => {
  it("returns the very same value when it can already travel", () => {
    const clean = { a: [1, "two", null, { b: true }], c: 3.5 };
    expect(encode(clean)).toBe(clean);
    expect(encode("text")).toBe("text");
    const bytes = new Uint8Array([1, 2]);
    expect(encode(bytes)).toBe(bytes);
  });

  it("turns undefined into null and drops it from maps", () => {
    expect(encode(undefined)).toBeNull();
    expect(encode([1, undefined, 3])).toEqual([1, null, 3]);
    expect(encode({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it("drops functions and reports them once per call site", () => {
    const seen: string[] = [];
    const out = encode({ ok: 1, f: () => 1, nested: [() => 2] }, (what) => seen.push(what));
    expect(out).toEqual({ ok: 1, nested: [null] });
    expect(seen).toEqual(["function", "function"]);
  });

  it("keeps non string keys of a Map in the integer key marker", () => {
    const out = encode(new Map<unknown, unknown>([[5, "five"], ["a", "x"]]));
    expect(out).toEqual({ [MARK]: "m", k: [5, "a"], v: ["five", "x"] });
    expect(decode(out)).toEqual({ "5": "five", a: "x" });
    expect(encode(new Map([["a", 1]]))).toEqual({ a: 1 });
  });

  it("wraps an object that owns the reserved key", () => {
    const out = encode({ [MARK]: "mine", x: 1 });
    expect(out).toEqual({ [MARK]: "m", k: [MARK, "x"], v: ["mine", 1] });
    expect(decode(out)).toEqual({ [MARK]: "mine", x: 1 });
  });

  it("flattens class instances, Sets and toJSON values", () => {
    class Point {
      x = 1;
      y = 2;
    }
    expect(encode(new Point())).toEqual({ x: 1, y: 2 });
    expect(encode(new Set([1, 2]))).toEqual([1, 2]);
    expect(encode(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
  });

  it("refuses payloads nested deeper than 32", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => encode(deep)).toThrow(/nested deeper/);
  });

  it("encodes every argument", () => {
    expect(encodeArgs([undefined, { f() {}, a: 1 }])).toEqual([null, { a: 1 }]);
  });
});

describe("decode", () => {
  it("restores the vector markers of the Lua shim as plain objects", () => {
    expect(decode({ [MARK]: "v2", x: 1, y: 2 })).toEqual({ x: 1, y: 2 });
    expect(decode({ [MARK]: "v4", x: 1, y: 2, z: 3, w: 4 })).toEqual({ x: 1, y: 2, z: 3, w: 4 });
    expect(decode({ [MARK]: "q", x: 1, y: 2, z: 3, w: 4 })).toEqual({ x: 1, y: 2, z: 3, w: 4 });
  });

  it("restores integer keyed maps, also nested", () => {
    const wire = { list: [{ [MARK]: "m", k: [101, 205], v: ["trowel", "bucket"] }] };
    expect(decode(wire)).toEqual({ list: [{ "101": "trowel", "205": "bucket" }] });
  });

  it("returns the same value when no marker is present and leaves function references", () => {
    const clean = { a: [1, { b: 2 }] };
    expect(decode(clean)).toBe(clean);
    const ref = { [MARK]: "fn", r: "res", id: 4 };
    expect(decode([ref])).toEqual([ref]);
    expect(isFnRef(ref)).toBe(true);
    expect(isFnRef({ [MARK]: "fn", r: 1, id: 4 })).toBe(false);
  });
});

describe("toJson", () => {
  it("is the identity on clean values and a JSON round trip otherwise", () => {
    const clean = { a: 1, b: [true, null] };
    expect(toJson(clean)).toBe(clean);
    expect(toJson({ a: 1, f() {}, u: undefined, d: new Date(0) })).toEqual({ a: 1, d: "1970-01-01T00:00:00.000Z" });
    expect(toJson(undefined)).toBeNull();
  });
});

describe("protocol constants", () => {
  it("names exports like the Lua shim", () => {
    expect(exportEvent("bank", "getBalance")).toBe("export:bank:getBalance");
    expect(isVec3({ x: 1, y: 2, z: 3 })).toBe(true);
    expect(isVec3({ x: 1, y: 2 })).toBe(false);
  });
});

describe("wire helper of the mock", () => {
  it("round trips values and enforces the LS:MP transport rules", () => {
    const value = [1, 2.5, "é\"\n", null, true, { a: [1], b: {} }, { x: 1, y: 2, z: 3 }];
    expect(fromWire(toWire("t", [value]))).toEqual([fix(value)]);
    expect(() => toWire("t", [() => 1])).toThrow(WireError);
    expect(() => toWire("t", [new Map()])).toThrow(/Map is not transportable/);
    expect(() => toWire("t", [NaN])).toThrow(/non-finite/);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The helper turns an empty JS object into an empty list, like LS:MP. */
function fix(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fix);
  if (isRecord(value)) {
    if (Object.keys(value).length === 0) return [];
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fix(v)]));
  }
  return value;
}
