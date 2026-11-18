import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clientNativeNames, renderConfig } from "../tools/fx2lsmp/cli.ts";

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
});
