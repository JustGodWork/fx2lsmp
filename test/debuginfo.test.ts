import { afterAll, describe, expect, it } from "vitest";
import { renderModules } from "../tools/fx2lsmp/modules.ts";
import { TICK_MS, World } from "./harness.ts";

const SCRIPT = [
  "local function probe(level)",
  "  local info <const> = debug.getinfo(level, 'S')",
  "  if info == nil then return nil end",
  "  return { source = info.source, short = info.short_src, line = info.currentline, what = info.what, name = info.name }",
  "end",
  "local function outer()",
  "  local r <const> = { probe(1), probe(2) }",
  "  return r",
  "end",
  "local resources = {}",
  "local idx = 1",
  "while true do",
  "  local info <const> = debug.getinfo(idx, 'S')",
  "  if info == nil then break end",
  "  local name <const> = info.source:match('^@@([^/]+)/')",
  "  if name ~= nil then resources[#resources + 1] = name end",
  "  idx = idx + 1",
  "end",
  "DBG = {",
  "  levels = outer(),",
  "  main = probe(2),",
  "  past = debug.getinfo(50, 'S') == nil,",
  "  walked = resources,",
  "  steps = idx,",
  "  esx = debug.getinfo(1, 'S').short_src:find('@dbg/server') ~= nil,",
  "  fn = debug.getinfo(print, 'S'),",
  "}",
  "",
].join("\n");

const MODULES = [
  { path: "_fxcompat/imports/other/p.lua", text: "local a = 1\nlocal b = 2\nreturn a + b\n" },
  { path: "lib/m.lua", text: "local pad = 1\nlocal info <const> = debug.getinfo(1, 'S')\nreturn { source = info.source, short = info.short_src, line = info.currentline }\n" },
  { path: "_fxcompat/imports/other/q.lua", text: "local info <const> = debug.getinfo(1, 'S')\nreturn { source = info.source, line = info.currentline }\n" },
];

interface Frame {
  source: string;
  short: string;
  line: number;
  what: string;
  name: string;
}

interface DbgResult {
  levels: Frame[];
  main: Frame;
  past: boolean;
  walked: string[];
  steps: number;
  esx: boolean;
  fn: unknown;
}

let world: World | undefined;
afterAll(() => world?.close());

describe("debug.getinfo emulation", () => {
  it("reads frames of scripts from the traceback", async () => {
    world = await World.withShim({ resource: "dbg", clients: 1, server: SCRIPT });
    const dbg = (await world.server.eval("return DBG")) as DbgResult;
    expect(dbg.levels[0]).toMatchObject({ source: "@@dbg/server.lua", short: "@dbg/server.lua", line: 2, what: "Lua", name: "probe" });
    expect(dbg.levels[1]).toMatchObject({ source: "@@dbg/server.lua", line: 7, what: "Lua", name: "outer" });
    expect(dbg.main).toMatchObject({ source: "@@dbg/server.lua", line: 21, what: "main" });
    expect(dbg.past).toBe(true);
    expect(dbg.walked).toEqual(["dbg"]);
    expect(dbg.steps).toBe(2);
    expect(dbg.esx).toBe(true);
    expect(dbg.fn).toEqual({ source: "=?", short_src: "?", what: "Lua", linedefined: -1, currentline: -1, lastlinedefined: -1, namewhat: "" });
    world.close();
    world = undefined;
  });

  it("maps frames of precompiled registries back to their module", async () => {
    world = await World.withShim({ resource: "dbg", clients: 1 });
    const server = world.server;
    server.load("_fxcompat/modules.lua", renderModules(MODULES));
    await world.advance(TICK_MS);
    const run = (i: number): Promise<unknown> =>
      server.eval(`return load(${JSON.stringify(MODULES[i]?.text)}, '@@x', 't', _ENV)()`);
    expect(await run(1)).toEqual({ source: "@@dbg/lib/m.lua", short: "@dbg/lib/m.lua", line: 2 });
    expect(await run(2)).toEqual({ source: "@@other/q.lua", line: 1 });
  });
});
