import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientNativeNames, renderConfig } from "../tools/fx2lsmp/cli.ts";
import { World, nth } from "./harness.ts";

describe("client native names", () => {
  it("lists PascalCase and N_0x names of the client loader and modules, not fields or methods", () => {
    const dir = mkdtempSync(join(tmpdir(), "fxnames-"));
    mkdirSync(join(dir, "_fxcompat"));
    writeFileSync(join(dir, "_fxcompat", "run_client.lua"), "local ped = PlayerPedId()\nESX.ShowNotification('x')\nobj:Method()\nN_0x1234(ped)\n");
    writeFileSync(join(dir, "_fxcompat", "modules.lua"), "SetEntityCoords(ped, 0.0, 0.0, 0.0)\n");
    expect(clientNativeNames(dir)).toEqual(["ESX", "N_0x1234", "PlayerPedId", "SetEntityCoords"]);
  });

  it("writes them into the shared config", () => {
    expect(renderConfig(undefined, {}, undefined, {}, ["PlayerPedId"])).toContain('natives = { "PlayerPedId" },');
  });

  it("defines listed natives on a client whose _G metatable is protected", async () => {
    const world = await World.create({ luaMain: false, clients: 1 });
    try {
      const res = await world.addLua("protected");
      const client = nth(res.clients, 0);
      // The LS:MP client answers getmetatable(_G) with a boolean
      client.load("protect.lua", "probeNative = function() return 7 end setmetatable(_G, { __metatable = true })");
      await world.loadLuaShim(res, "client", "FXCOMPAT_CONFIG.natives = { 'ProbeNative' }");
      expect(client.errors()).toEqual([]);
      expect(await client.eval("return ProbeNative()")).toBe(7);
      client.load("keys.lua", "RegisterKeyMapping('+probe', 'Probe', 'keyboard', 'E') RegisterCommand('+probe', function() end)");
      await world.advance(100);
      expect(await client.eval("return GetPlayerServerId(0)")).toBeGreaterThan(0);
      expect(client.errors()).toEqual([]);
    } finally {
      world.close();
    }
  });
});
