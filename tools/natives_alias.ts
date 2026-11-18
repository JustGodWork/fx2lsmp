import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface LsNative {
  name: string;
  native: string;
  hash?: string;
  blocked?: string;
}

export interface LsCatalogue {
  namespaces: { id: string; natives: LsNative[] }[];
}

export interface FxNative {
  name?: string;
  /** Other names of the same native: hashes and underscore prefixed names. */
  aliases?: string[];
}

export type FxDatabase = Record<string, Record<string, FxNative>>;

const root = resolve(import.meta.dirname, "..");
const LS_PATH = resolve(root, "docs/raw/natives.json");
const FX_PATH = "E:/GITHUB/fx-oop/data/natives.json";
const OUT_PATH = resolve(root, "shim/natives_alias.lua");
export const JSON_PATH = resolve(root, "shim/js/natives_data.json");
export const HASHES_PATH = resolve(root, "shim/js/natives_hashes.json");

/** The generated data of the JS shim: renamed natives plus the names of every callable LS:MP native. */
export interface JsNativesData {
  alias: Record<string, string>;
  names: string[];
}

const HASH_PREFIX = "N_0x";

export function pascalCase(nativeName: string): string {
  return nativeName
    .toLowerCase()
    .replace(/^_+/, "")
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

export function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function normHash(h: string): string {
  return "0x" + h.replace(/^0x/i, "").toUpperCase();
}

/** FiveM Lua global name to LS:MP global name; only renamed natives plus N_0x entries. */
export function buildAlias(ls: LsCatalogue, fx: FxDatabase): Map<string, string> {
  const byHash = new Map<string, LsNative>();
  const byName = new Map<string, LsNative>();
  for (const ns of ls.namespaces) {
    for (const n of ns.natives) {
      if (n.blocked) continue;
      if (n.hash) byHash.set(normHash(n.hash), n);
      byName.set(n.native, n);
    }
  }
  const out = new Map<string, string>();
  const secondary: [string, string][] = [];
  const primary = new Set<string>();
  for (const entries of Object.values(fx)) {
    for (const [rawHash, fxNative] of Object.entries(entries)) {
      const hash = normHash(rawHash);
      const fxName = fxNative.name ?? "_" + hash;
      if (!/^_?0x/i.test(fxName)) primary.add(pascalCase(fxName));
      const hit = byHash.get(hash) ?? byName.get(fxName);
      if (!hit) continue;
      out.set("N_" + hash, hit.name);
      if (/^_?0x/i.test(fxName)) continue;
      const lua = pascalCase(fxName);
      if (lua !== "" && lowerFirst(lua) !== hit.name && !out.has(lua)) out.set(lua, hit.name);
      for (const other of fxNative.aliases ?? []) {
        if (/^_?0x/i.test(other)) continue;
        secondary.push([pascalCase(other), hit.name]);
      }
    }
  }
  // Applied last so an alias never shadows the primary name of another native.
  for (const [lua, target] of secondary) {
    if (lua !== "" && lowerFirst(lua) !== target && !out.has(lua) && !primary.has(lua)) out.set(lua, target);
  }
  return out;
}

export function renderLua(alias: Map<string, string>): string {
  const keys = [...alias.keys()].sort();
  const lines = keys.map((k) => `  ${k} = "${alias.get(k)}",`);
  return [
    "---@type table<string, string>",
    "local NATIVES_ALIAS <const> = {",
    ...lines,
    "}",
    "",
  ].join("\n");
}

export function nativeNames(ls: LsCatalogue): string[] {
  const names = new Set<string>();
  for (const ns of ls.namespaces) {
    for (const n of ns.natives) if (!n.blocked) names.add(n.name);
  }
  return [...names].sort();
}

/** FiveM names that differ from the LS:MP name, and the names of the callable natives. */
export function renderJson(alias: Map<string, string>, names: string[]): string {
  const sorted: Record<string, string> = {};
  for (const key of [...alias.keys()].sort()) if (!key.startsWith(HASH_PREFIX)) sorted[key] = alias.get(key) ?? "";
  const data: JsNativesData = { alias: sorted, names };
  return JSON.stringify(data) + "\n";
}

/** Native hash to LS:MP name, for `Citizen.invokeNative`: a separate file because only some resources need it. */
export function renderHashesJson(alias: Map<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of [...alias.keys()].sort()) if (key.startsWith(HASH_PREFIX)) sorted[key] = alias.get(key) ?? "";
  return JSON.stringify(sorted) + "\n";
}

function main(): void {
  const ls: LsCatalogue = JSON.parse(readFileSync(LS_PATH, "utf8"));
  const fx: FxDatabase = JSON.parse(readFileSync(FX_PATH, "utf8"));
  const alias = buildAlias(ls, fx);
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, renderLua(alias));
  mkdirSync(dirname(JSON_PATH), { recursive: true });
  writeFileSync(JSON_PATH, renderJson(alias, nativeNames(ls)));
  writeFileSync(HASHES_PATH, renderHashesJson(alias));
  console.log(`natives_alias.lua and natives_data.json: ${alias.size} entries`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
