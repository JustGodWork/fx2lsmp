import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAlias, lowerFirst, pascalCase, renderLua,
  type FxDatabase, type LsCatalogue,
} from "../tools/natives_alias.ts";

const ls: LsCatalogue = {
  namespaces: [
    {
      id: "ENTITY",
      natives: [
        { name: "getEntityCoords", native: "GET_ENTITY_COORDS", hash: "0x3FEF770D40960D5A" },
        { name: "setPedAmmoByType", native: "SET_PED_AMMO_BY_TYPE", hash: "0x1111111111111111" },
        { name: "startNewScript", native: "START_NEW_SCRIPT", hash: "0x2222222222222222", blocked: "scripts" },
        { name: "byNameOnly", native: "BY_NAME_ONLY" },
      ],
    },
  ],
};

const fx: FxDatabase = {
  ENTITY: {
    "0x3FEF770D40960D5A": { name: "GET_ENTITY_COORDS" },
    "0x1111111111111111": { name: "ADD_AMMO_TO_PED_BY_TYPE", aliases: ["0x1111111111111111", "_OLD_AMMO_NAME", "GET_ENTITY_COORDS"] },
    "0x2222222222222222": { name: "START_NEW_SCRIPT" },
    "0x3333333333333333": { name: "BY_NAME_ONLY" },
    "0x4444444444444444": { name: "_0x4444444444444444" },
    "0x5555555555555555": { name: "NOT_IN_LSMP" },
  },
};

describe("name helpers", () => {
  it("PascalCase of a native name", () => {
    expect(pascalCase("GET_ENTITY_COORDS")).toBe("GetEntityCoords");
    expect(pascalCase("_GET_SOMETHING")).toBe("GetSomething");
    expect(lowerFirst("GetEntityCoords")).toBe("getEntityCoords");
  });
});

describe("alias generation", () => {
  const alias = buildAlias(ls, fx);
  it("skips names that lowering the first character already resolves", () => {
    expect(alias.has("GetEntityCoords")).toBe(false);
    expect(alias.get("N_0x3FEF770D40960D5A")).toBe("getEntityCoords");
  });
  it("maps renamed natives by hash", () => {
    expect(alias.get("AddAmmoToPedByType")).toBe("setPedAmmoByType");
  });
  it("maps secondary names, never over a primary one", () => {
    expect(alias.get("OldAmmoName")).toBe("setPedAmmoByType");
    expect(alias.has("GetEntityCoords")).toBe(false);
  });
  it("falls back to the native name when the hash is unknown", () => {
    expect(alias.has("ByNameOnly")).toBe(false);
    expect(alias.has("N_0x3333333333333333")).toBe(true);
  });
  it("skips blocked natives and unmatched ones", () => {
    expect([...alias.keys()].some((k) => k.includes("StartNewScript") || k.includes("2222"))).toBe(false);
    expect(alias.has("NotInLsmp")).toBe(false);
  });
  it("adds only an N_0x entry for unnamed natives", () => {
    expect(alias.has("N_0x4444444444444444")).toBe(false);
  });
  it("renders an annotated Lua table", () => {
    const lua = renderLua(alias);
    expect(lua.startsWith("---@type table<string, string>\nlocal NATIVES_ALIAS <const> = {")).toBe(true);
    expect(lua).toContain('  AddAmmoToPedByType = "setPedAmmoByType",');
  });
});

describe("real catalogues", () => {
  it("resolves known renamed natives", () => {
    const real = buildAlias(
      JSON.parse(readFileSync(resolve(import.meta.dirname, "../docs/raw/natives.json"), "utf8")),
      JSON.parse(readFileSync("E:/GITHUB/fx-oop/data/natives.json", "utf8")),
    );
    expect(real.get("AddDispatchSpawnBlockingArea")).toBe("addDispatchSpawnSphereBlockingArea");
    expect(real.get("AddAmmoToPedByType")).toBe("addPedAmmoByType");
    expect(real.has("GetEntityCoords")).toBe(false);
    expect(real.size).toBeGreaterThan(1000);
  });
});
