import { describe, expect, it } from "vitest";
import { checkShim, findLuaLs, locate } from "../tools/lint-lua.ts";

const luals = findLuaLs();

describe.skipIf(luals === undefined)("LuaLS on the shim", () => {
  it("reports no diagnostic at warning level or above", () => {
    const findings = checkShim(luals ?? "");
    expect(findings.map((f) => `${f.file}:${f.line} ${f.code}`)).toEqual([]);
  }, 180000);
});

describe("locate", () => {
  const spans = [{ file: "core.lua", start: 0, end: 100 }, { file: "exports.lua", start: 101, end: 200 }];

  it("reports a meta file finding at its own line", () => {
    expect(locate("file:///tmp/src/lsmp.meta.lua", 150, spans)).toEqual({ file: "lsmp.meta.lua", line: 151 });
  });

  it("maps a concatenated shim line onto its source file", () => {
    expect(locate("file:///tmp/src/init.lua", 120, spans)).toEqual({ file: "exports.lua", line: 20 });
  });
});
