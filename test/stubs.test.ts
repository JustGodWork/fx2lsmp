import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { stubKindOf, stubsFor, type CfxData } from "../tools/fx2lsmp/cfxCoverage.ts";
import { convertResource } from "../tools/fx2lsmp/cli.ts";
import { World, nth } from "./harness.ts";

const LUA_STUBS = `FXCOMPAT_CONFIG.stubs = {
  client = { StubBool = 'bool', StubInt = 'int', StubFloat = 'float', StubString = 'string', StubVector = 'vector', StubVoid = 'nil', ServerOnly = 'int' },
  server = { StubSrvInt = 'int', StubSrvVoid = 'nil' },
}`;

const JS_STUBS = {
  client: { StubBool: "bool", StubInt: "int", StubFloat: "float", StubString: "string", StubVector: "vector", StubVoid: "nil" },
  server: { StubSrvInt: "int", StubSrvVoid: "nil" },
} as const;

function warnings(lines: string[], needle: string): number {
  return lines.filter((line) => line.includes("WARN") && line.includes(needle)).length;
}

describe("Lua stubs", () => {
  it("answer the typed default of a client native and warn once", async () => {
    const world = await World.withShim({ clients: 1, extraConfig: LUA_STUBS });
    try {
      const client = nth(world.clients, 0);
      expect(await client.eval("return { StubBool(), StubInt(), StubFloat(), StubString() }")).toEqual([false, 0, 0, ""]);
      expect(await client.eval("local v = StubVector() return { v.x, v.y, v.z, StubVoid() == nil }")).toEqual([0, 0, 0, true]);
      await client.eval("StubInt() StubInt()");
      expect(warnings(await client.logs(), "StubInt has no LS:MP counterpart")).toBe(1);
      expect(client.errors()).toEqual([]);
    } finally {
      world.close();
    }
  });

  it("answer on the server, and keep a client stub off the server", async () => {
    const world = await World.withShim({ clients: 1, extraConfig: LUA_STUBS });
    try {
      expect(await world.server.eval("return StubSrvInt()")).toBe(0);
      expect(await world.server.eval("StubSrvVoid() StubSrvVoid() return StubSrvVoid() == nil")).toBe(true);
      expect(warnings(await world.server.logs(), "StubSrvVoid has no LS:MP counterpart")).toBe(1);
      expect(await world.server.eval("return StubInt == nil and ServerOnly == nil")).toBe(true);
    } finally {
      world.close();
    }
  });

  it("never replace an existing function", async () => {
    const world = await World.create({ luaMain: false, clients: 1 });
    try {
      const res = await world.addLua("keep");
      const client = nth(res.clients, 0);
      client.load("pre.lua", "StubInt = function() return 42 end");
      await world.loadLuaShim(res, "client", LUA_STUBS);
      expect(await client.eval("return StubInt()")).toBe(42);
    } finally {
      world.close();
    }
  });
});

describe("JS stubs", () => {
  it("answer the typed default of a client native and warn once", async () => {
    const world = await World.create({ luaMain: false, clients: 1 });
    try {
      const res = world.addJs("stubs");
      await world.loadJsShim(res, { stubs: JS_STUBS });
      const client = nth(res.clients, 0);
      expect(await client.eval("return [StubBool(), StubInt(), StubFloat(), StubString(), StubVector(), StubVoid() === undefined]")).toEqual([false, 0, 0, "", [0, 0, 0], true]);
      await client.eval("StubInt(); StubInt();");
      expect(warnings(client.logs(), "StubInt has no LS:MP counterpart")).toBe(1);
    } finally {
      world.close();
    }
  });

  it("answer on the server only with the server list", async () => {
    const world = await World.create({ luaMain: false, clients: 1 });
    try {
      const res = world.addJs("stubs");
      await world.loadJsShim(res, { stubs: JS_STUBS });
      expect(await res.server.eval("return [StubSrvInt(), typeof StubInt, typeof StubSrvVoid]")).toEqual([0, "undefined", "function"]);
      await res.server.eval("StubSrvVoid(); StubSrvVoid();");
      expect(warnings(res.server.logs(), "StubSrvVoid has no LS:MP counterpart")).toBe(1);
    } finally {
      world.close();
    }
  });
});

const DATA: CfxData = {
  natives: {
    MumbleIsConnected: { apiset: "client", result: "bool", covered: [] },
    SetNuiFocus: { apiset: "client", result: "void", covered: ["lua.client"] },
    GetPlayerWantedLevel: { apiset: "server", result: "int", covered: [] },
    GetEntityCoordsX: { apiset: "shared", result: "Vector3", covered: ["lua.server"] },
  },
  globals: { "lua.client": [], "lua.server": [], "js.client": [], "js.server": [] },
};

describe("stub selection", () => {
  it("maps result types to kinds", () => {
    expect(["BOOL", "Hash", "float", "char*", "Vector3", "void", "object", "Any*"].map(stubKindOf)).toEqual(["bool", "int", "float", "string", "vector", "nil", "nil", "nil"]);
  });

  it("keeps used natives that the runtime lacks and its side allows", () => {
    const used = (runtime: "lua.client" | "lua.server" | "js.client", names: string[]) => ({ runtime, names, defined: new Set<string>() });
    expect(stubsFor(DATA, [used("lua.client", ["MumbleIsConnected", "SetNuiFocus", "GetPlayerWantedLevel", "GetEntityCoordsX", "Unknown"])])).toEqual({
      client: { MumbleIsConnected: "bool", GetEntityCoordsX: "vector" },
      server: {},
    });
    expect(stubsFor(DATA, [used("lua.server", ["MumbleIsConnected", "GetPlayerWantedLevel", "GetEntityCoordsX"])])).toEqual({
      client: {},
      server: { GetPlayerWantedLevel: "int" },
    });
  });
});

function put(root: string, files: Record<string, string>): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

describe("converted config", () => {
  it("carries only the used uncovered natives of each side", async () => {
    const root = mkdtempSync(join(tmpdir(), "fxstubs-"));
    const src = put(join(root, "src", "res"), {
      "fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nclient_script 'c.lua'\nserver_script 's.lua'\n",
      "c.lua": "MumbleIsConnected()\nGetPlayerName(1)\nlocal Hidden = 1\n",
      "s.lua": "GetPlayerWantedLevel(1)\nGetPlayerName(1)\n",
    });
    const out = join(root, "out");
    await convertResource({ resourceDir: src, outDir: out });
    const config = readFileSync(join(out, "_fxcompat", "config.lua"), "utf8");
    expect(config).toContain('stubs = { client = { MumbleIsConnected = "bool" }, server = { GetPlayerWantedLevel = "int" } },');
    expect(config).not.toContain("GetPlayerName =");
  });

  it("writes the JS stubs per side", async () => {
    const root = mkdtempSync(join(tmpdir(), "fxstubsjs-"));
    const src = put(join(root, "src", "res"), {
      "fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nclient_script 'c.js'\nserver_script 's.js'\n",
      "c.js": "MumbleIsConnected(); GetPlayerName(1);\n",
      "s.js": "GetPlayerWantedLevel(1); MumbleIsConnected();\n",
    });
    const out = join(root, "out");
    await convertResource({ resourceDir: src, outDir: out });
    const config = readFileSync(join(out, "_fxcompat", "config.js"), "utf8");
    expect(config).toContain('"stubs":{"client":{"MumbleIsConnected":"bool"},"server":{"GetPlayerWantedLevel":"int"}}');
  });
});
