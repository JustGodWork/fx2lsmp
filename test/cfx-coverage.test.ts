import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CFX_PATH, computeCoverage, renderData } from "../tools/cfx_coverage.ts";
import { classOf, familyOf } from "../tools/cfx_coverage_doc.ts";
import {
  DATA_PATH, calledNames, coverageWarnings, definedNames, loadCfxData, looksLikeNative, stripNonCode,
  type CfxData, type UsedNames,
} from "../tools/fx2lsmp/cfxCoverage.ts";
import { convertResource, nativeCoverageWarnings } from "../tools/fx2lsmp/cli.ts";
import { parseFxManifest } from "../tools/fx2lsmp/manifest.ts";

const DATA: CfxData = {
  natives: {
    MumbleSetVolumeOverride: { apiset: "client", result: "void", covered: [] },
    GetPlayerName: { apiset: "shared", result: "char*", covered: ["lua.client", "js.client", "lua.server", "js.server"] },
    SetConvar: { apiset: "server", result: "void", covered: ["lua.server"] },
    SetNuiFocus: { apiset: "client", result: "void", covered: ["lua.client", "js.client"] },
  },
  globals: { "lua.client": ["Citizen"], "lua.server": ["Citizen"], "js.client": [], "js.server": [] },
};
const CATALOGUE: ReadonlySet<string> = new Set(["SetEntityCoords", "GetPlayerName"]);

function used(runtime: UsedNames["runtime"], names: string[], defined: string[] = []): UsedNames {
  return { runtime, names, defined: new Set(defined) };
}

describe.skipIf(!existsSync(CFX_PATH))("committed CFX coverage data", () => {
  it("matches what the shims define today (run npm run cfx:coverage)", async () => {
    const fresh = renderData(await computeCoverage());
    expect(fresh).toBe(readFileSync(DATA_PATH, "utf8"));
  }, 120000);
});

describe("committed CFX coverage data shape", () => {
  const data = loadCfxData();
  it("lists every CFX native with only the runtimes its apiset allows", () => {
    expect(Object.keys(data.natives).length).toBeGreaterThan(900);
    for (const [name, entry] of Object.entries(data.natives)) {
      for (const runtime of entry.covered) {
        expect(entry.apiset === "shared" || runtime.endsWith(`.${entry.apiset}`), `${name} ${runtime}`).toBe(true);
      }
    }
  });
});

describe("coverage heuristics", () => {
  it("names the family after the leading verbs", () => {
    expect(familyOf("GetPlayerPed")).toBe("Player");
    expect(familyOf("SetResourceKvp")).toBe("Kvp");
    expect(familyOf("MumbleIsConnected")).toBe("Mumble");
  });
  it("marks every class as a guess except unclassified", () => {
    expect(classOf("MumbleIsConnected", { apiset: "client", result: "bool", covered: [] })).toBe("lsmp-api candidate: lsmp.voice (guess)");
    expect(classOf("GetVehicleWheelSize", { apiset: "client", result: "float", covered: [] })).toBe("impossible (guess)");
    expect(classOf("ProfilerIsRecording", { apiset: "server", result: "bool", covered: [] })).toBe("harmless no-op (guess)");
  });
});

describe("name scanning", () => {
  it("blanks comments and strings", () => {
    const lua = stripNonCode("Foo() -- Bar()\nlocal s = 'Baz()' --[[ Qux() ]] Quux()", "lua");
    expect(lua).toContain("Foo()");
    expect(lua).toContain("Quux()");
    expect(lua).not.toMatch(/Bar|Baz|Qux\(/);
    const js = stripNonCode("Foo(); // Bar()\nconst s = `Baz()`; /* Qux() */ Quux()", "js");
    expect(js).not.toMatch(/Bar|Baz|Qux\(/);
    expect(js).toContain("Quux()");
  });
  it("collects names defined by the script and ignores constants", () => {
    const defined = definedNames("function Notify() end\nlocal Helper = 1\nConfig = {}\nconst Thing = 1; class Box {}");
    expect([...defined].sort()).toEqual(["Box", "Config", "Helper", "Notify", "Thing"]);
    expect(looksLikeNative("PlayerPedId")).toBe(true);
    expect(["ESX", "Config", "N_0x1234"].filter(looksLikeNative)).toEqual([]);
  });
  it("only counts names in call position", () => {
    const dir = mkdtempSync(join(tmpdir(), "fxcalls-"));
    writeFileSync(join(dir, "a.lua"), "local x = Player\nSetThing(1)\nobj.Other(2)\nobj:Method()\n");
    expect([...calledNames(dir, ["a.lua"], "lua")]).toEqual(["SetThing"]);
  });
});

describe("coverage warnings", () => {
  it("prints one line per category and runtime", () => {
    const lines = coverageWarnings(DATA, CATALOGUE, [
      used("lua.client", ["MumbleSetVolumeOverride", "GetPlayerName", "SetConvar", "SetNuiFocus", "SetEntityCoords", "Citizen", "Missing", "Mine", "ESX"], ["Mine"]),
    ]);
    expect(lines).toEqual([
      "Lua client: CFX natives with no implementation in the shim, calls will fail (1): MumbleSetVolumeOverride",
      "Lua client: CFX natives that FiveM only provides on the server side (1): SetConvar",
      "Lua client: names that are not CFX natives, LS:MP natives or shim globals (missing GTA natives or plain globals) (1): Missing",
    ]);
  });
  it("applies the same checks to JS and to the server", () => {
    const lines = coverageWarnings(DATA, CATALOGUE, [
      used("js.server", ["GetPlayerName", "SetNuiFocus", "SetEntityCoords"]),
      used("js.client", ["MumbleSetVolumeOverride"]),
    ]);
    expect(lines).toEqual([
      "JS server: CFX natives that FiveM only provides on the client side (1): SetNuiFocus",
      "JS server: names that are not CFX natives, LS:MP natives or shim globals (missing GTA natives or plain globals) (1): SetEntityCoords",
      "JS client: CFX natives with no implementation in the shim, calls will fail (1): MumbleSetVolumeOverride",
    ]);
  });
  it("prints nothing when everything is covered", () => {
    expect(coverageWarnings(DATA, CATALOGUE, [used("lua.server", ["GetPlayerName", "SetConvar", "Wait"], ["Wait"])])).toEqual([]);
  });
});

function put(root: string, files: Record<string, string>): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

describe("conversion report", () => {
  it("reads the loaders of the output, not the module registry", async () => {
    const out = put(mkdtempSync(join(tmpdir(), "fxreport-")), {
      "_fxcompat/run_client.lua": "MumbleSetVolumeOverride(1)\nlocal ok = SetEntityCoords(1)\nNotify()\n-- Skipped()\nfunction Notify() end\n",
      "_fxcompat/run_server.lua": "SetConvar('a', 'b')\nMumbleSetVolumeOverride(1)\n",
      "_fxcompat/modules.lua": "FromModule()\n",
    });
    const fx = await parseFxManifest("fx_version 'cerulean'\ngame 'gta5'\n");
    expect(nativeCoverageWarnings(out, fx, true, DATA, CATALOGUE)).toEqual([
      "Lua client: CFX natives with no implementation in the shim, calls will fail (1): MumbleSetVolumeOverride",
      "Lua server: CFX natives that FiveM only provides on the client side (1): MumbleSetVolumeOverride",
    ]);
  });

  it("reports JS scripts of a converted resource", async () => {
    const root = mkdtempSync(join(tmpdir(), "fxreportjs-"));
    const src = put(join(root, "src", "app"), {
      "fxmanifest.lua": "fx_version 'cerulean'\ngame 'gta5'\nclient_script 'c.js'\nserver_script 's.js'\n",
      "c.js": "TotallyMissingNative(1); // Commented()\n",
      "s.js": "console.log(GetPlayerName(1));\n",
    });
    const result = await convertResource({ resourceDir: src, outDir: join(root, "out") });
    const lines = result.warnings.filter((w) => w.startsWith("JS "));
    expect(lines.some((l) => l.startsWith("JS client: names that are not") && l.includes("TotallyMissingNative"))).toBe(true);
    expect(lines.some((l) => l.includes("Commented"))).toBe(false);
  });
});
