import { describe, expect, it } from "vitest";
import { joaat, transpile } from "../tools/fx2lsmp/transpile.ts";

const code = (src: string): string => transpile(src).code;

describe("joaat", () => {
  it("matches known hashes (unsigned)", () => {
    expect(joaat("adder")).toBe(3078201489);
    expect(joaat("ADDER")).toBe(3078201489);
    expect(joaat("")).toBe(0);
  });
});

describe("backtick hashes", () => {
  it("becomes the unsigned decimal joaat", () => {
    expect(code("local m = `adder`")).toBe("local m = 3078201489");
    expect(code("f(`adder`, `Adder`)")).toBe("f(3078201489, 3078201489)");
  });
  it("leaves backticks in strings and comments", () => {
    expect(code('print("`adder`")')).toBe('print("`adder`")');
    expect(code("-- `adder`")).toBe("-- `adder`");
    expect(code("--[[ `adder` ]]")).toBe("--[[ `adder` ]]");
    expect(code("x = [[ `adder` ]]")).toBe("x = [[ `adder` ]]");
  });
});

describe("strings, long strings and comments stay untouched", () => {
  const same = [
    'local s = "a += 1"',
    "local s = 'a += 1'",
    'local s = "esc \\" x += 1"',
    "local s = [[ x += 1\n y -= 2 ]]",
    "local s = [==[ x += 1 ]] y -= 2 ]==]",
    "-- x += 1",
    "--[[ x += 1\n y -= 2 ]]",
    "--[==[ x += 1 ]] ]==]\nlocal a = 1",
    "local a = 1 -- b += 2",
  ];
  for (const src of same) {
    it(JSON.stringify(src), () => {
      const result = transpile(src);
      expect(result.code).toBe(src);
      expect(result.issues).toEqual([]);
    });
  }
});

describe("compound assignment", () => {
  const cases: [string, string][] = [
    ["x += 1", "x = x + (1)"],
    ["x -= 1", "x = x - (1)"],
    ["x *= 2", "x = x * (2)"],
    ["x /= 2", "x = x / (2)"],
    ["x //= 2", "x = x // (2)"],
    ["x %= 3", "x = x % (3)"],
    ["x ^= 2", "x = x ^ (2)"],
    ['x ..= "s"', 'x = x .. ("s")'],
    ["x &= 3", "x = x & (3)"],
    ["x |= 4", "x = x | (4)"],
    ["x <<= 1", "x = x << (1)"],
    ["x >>= 1", "x = x >> (1)"],
  ];
  for (const [src, expected] of cases) {
    it(src, () => expect(code(src)).toBe(expected));
  }
  it("keeps indentation and parenthesizes the whole expression", () => {
    expect(code("  count += a + b * 2")).toBe("  count = count + (a + b * 2)");
  });
  it("handles complex lvalues", () => {
    expect(code("self.items[i].n += 1")).toBe("self.items[i].n = self.items[i].n + (1)");
  });
  it("ends at a trailing comment, keeping it", () => {
    expect(code("x += 1 -- bump")).toBe("x = x + (1) -- bump");
  });
  it("ends at ; and at end in one-liners", () => {
    expect(code("x += 1; y += 2")).toBe("x = x + (1); y = y + (2)");
    expect(code("if a then x += 1 end")).toBe("if a then x = x + (1) end");
  });
  it("ignores operators inside brackets and strings on the right side", () => {
    expect(code('x += f(a, "b;c", {1; 2})')).toBe('x = x + (f(a, "b;c", {1; 2}))');
  });
  it("does not touch comparisons or plain operators", () => {
    const src = "if a == b and c <= d and e >= f and g ~= h then x = a - -1 end";
    expect(code(src)).toBe(src);
  });
  it("transpiles backticks on the right side", () => {
    expect(code("h |= `adder`")).toBe("h = h | (3078201489)");
  });
  it("preserves the line count", () => {
    const src = "local a = 1\na += 2\n\nb *= 3\n";
    expect(code(src).split("\n").length).toBe(src.split("\n").length);
  });
});

describe("reported CfxLua extensions", () => {
  it("safe navigation on a name, a field chain, a call and an index", () => {
    expect(code("local b = t?.x")).toBe("local b = (t or __fxc_nil).x");
    expect(code("return a.b:c(1)?.d")).toBe("return (a.b:c(1) or __fxc_nil).d");
    expect(code("x = type(getmetatable(v)?.__call)")).toBe("x = type((getmetatable(v) or __fxc_nil).__call)");
    expect(code("x = t[i]?.y")).toBe("x = (t[i] or __fxc_nil).y");
    expect(code("x = t?.[k]")).toBe("x = (t or __fxc_nil)[k]");
    expect(code("x = a?.b?.c")).toBe("x = ((a or __fxc_nil).b or __fxc_nil).c");
    expect(transpile("local a = 1\nlocal b = t?.x").issues).toEqual([]);
  });
  it("safe navigation without a plain operand stays reported", () => {
    expect(transpile("x = ?.y").issues).toMatchObject([{ line: 1, kind: "safe-navigation" }]);
  });
  it("leaves safe navigation text in strings and comments", () => {
    expect(code('print("a?.b")')).toBe('print("a?.b")');
    expect(code("-- a?.b")).toBe("-- a?.b");
  });
  it("in unpacking", () => {
    expect(transpile("\nlocal a, b in t").issues).toMatchObject([{ line: 2, kind: "in-unpacking" }]);
    expect(transpile("for k in pairs(t) do end").issues).toEqual([]);
  });
  it("set constructors", () => {
    expect(transpile("local s = { .a, .b }").issues).toMatchObject([{ line: 1, kind: "set-constructor" }]);
    expect(transpile("local s = t.a .. u.b").issues).toEqual([]);
  });
  it("C comments", () => {
    const r = transpile("x = 1\n/* gone\n x += 1 */\ny = 2");
    expect(r.issues).toMatchObject([{ line: 2, kind: "c-comment" }]);
    expect(r.code).toBe("x = 1\n/* gone\n x += 1 */\ny = 2");
  });
});

describe("assigned for loop variables (constant in Lua 5.5)", () => {
  it("copies a generic loop variable that the body assigns", () => {
    expect(code('for k, v in pairs(t) do\n  if x then k = "q" end\n  f(k, v)\nend')).toBe(
      'for k__fxc, v in pairs(t) do local k = k__fxc;\n  if x then k = "q" end\n  f(k, v)\nend',
    );
  });
  it("copies a numeric loop variable and several assigned variables", () => {
    expect(code("for i = 1, 3 do i = i + 1 end")).toBe("for i__fxc = 1, 3 do local i = i__fxc; i = i + 1 end");
    expect(code("for a, b in next, t do a, b = b, a end")).toBe(
      "for a__fxc, b__fxc in next, t do local a = a__fxc; local b = b__fxc; a, b = b, a end",
    );
  });
  it("handles an assignment inside a nested block and function", () => {
    expect(code("for k in pairs(t) do if c then (function() k = 1 end)() end end")).toBe(
      "for k__fxc in pairs(t) do local k = k__fxc; if c then (function() k = 1 end)() end end",
    );
  });
  it("leaves loops that only read the variable, fields and comparisons alone", () => {
    const same = [
      "for k, v in pairs(t) do t.k = v; x.k = 1; if k == 2 then end end",
      "for i = 1, 3 do local j = i; j = j + 1 end",
      "for k in pairs(t) do local s = 'k = 1' -- k = 2\nend",
      "for k in pairs(t) do t[k] = 1 end",
    ];
    for (const src of same) expect(code(src)).toBe(src);
  });
  it("keeps the line count", () => {
    const src = "for k in pairs(t) do\n  k = k .. 'x'\nend\n";
    expect(code(src).split("\n").length).toBe(src.split("\n").length);
  });
});
