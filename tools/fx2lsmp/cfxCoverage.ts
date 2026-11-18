import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LOADER_SERVER_FILE, MODULES_FILE } from "./modules.ts";

export type Apiset = "shared" | "client" | "server";
export type Side = "client" | "server";
export type Runtime = "lua.client" | "lua.server" | "js.client" | "js.server";

export const RUNTIMES: readonly Runtime[] = ["lua.client", "lua.server", "js.client", "js.server"];
export const DATA_PATH: string = resolve(import.meta.dirname, "cfx_natives.json");
const CATALOGUE_PATH: string = resolve(import.meta.dirname, "../../shim/js/natives_data.json");

export interface CfxEntry {
  apiset: Apiset;
  result: string;
  /** Runtimes whose shim defines the native, among those its apiset allows. */
  covered: Runtime[];
}

export interface CfxData {
  /** Keyed by FiveM Lua/JS global name. */
  natives: Record<string, CfxEntry>;
  /** Capitalised globals the shim defines per runtime that are not CFX natives (Citizen, Wait...). */
  globals: Record<Runtime, string[]>;
}

export function sidesOf(apiset: Apiset): readonly Side[] {
  return apiset === "shared" ? ["client", "server"] : [apiset];
}

export function runtimesOf(apiset: Apiset): Runtime[] {
  return RUNTIMES.filter((runtime) => sidesOf(apiset).includes(sideOf(runtime)));
}

export function sideOf(runtime: Runtime): Side {
  return runtime.endsWith(".client") ? "client" : "server";
}

export function loadCfxData(path: string = DATA_PATH): CfxData {
  const data: CfxData = JSON.parse(readFileSync(path, "utf8"));
  return data;
}

interface CatalogueFile {
  alias: Record<string, string>;
  names: string[];
}

/** FiveM names of the natives the LS:MP client really provides: catalogue names and their FiveM aliases. */
export function loadCatalogueNames(path: string = CATALOGUE_PATH): Set<string> {
  const file: CatalogueFile = JSON.parse(readFileSync(path, "utf8"));
  const out = new Set<string>();
  for (const name of file.names) out.add(name.charAt(0).toUpperCase() + name.slice(1));
  for (const key of Object.keys(file.alias)) out.add(key);
  return out;
}

/** Capitalised words of a loader file or module registry: a superset of the natives a resource calls. */
export function capitalisedNames(outDir: string, files: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    const path = join(outDir, file);
    if (!existsSync(path)) continue;
    for (const m of readFileSync(path, "utf8").matchAll(/(?<![.:\w$])[A-Z][A-Za-z0-9_]*\b/g)) names.add(m[0]);
  }
  return names;
}

/** Names defined by the scripts themselves, read from the same files as the used names. */
export function definedInFiles(outDir: string, files: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    const path = join(outDir, file);
    if (existsSync(path)) for (const name of definedNames(readFileSync(path, "utf8"))) out.add(name);
  }
  return out;
}

const LUA_NON_CODE = /--\[(=*)\[[\s\S]*?\]\1\]|--[^\n]*|\[(=*)\[[\s\S]*?\]\2\]|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
const JS_NON_CODE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g;

/** Comments and string literals blanked out, so words inside them are not mistaken for calls. */
export function stripNonCode(code: string, lang: "lua" | "js"): string {
  return code.replace(lang === "lua" ? LUA_NON_CODE : JS_NON_CODE, " ");
}

/** Capitalised names in call position (`Name(`) in the code of these files. */
export function calledNames(outDir: string, files: readonly string[], lang: "lua" | "js"): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    const path = join(outDir, file);
    if (!existsSync(path)) continue;
    for (const m of stripNonCode(readFileSync(path, "utf8"), lang).matchAll(/(?<![.:\w$])[A-Z][A-Za-z0-9_]*(?=\s*\()/g)) names.add(m[0]);
  }
  return names;
}

export function serverNativeNames(outDir: string): string[] {
  return [...capitalisedNames(outDir, [LOADER_SERVER_FILE, MODULES_FILE])].sort();
}

/** Globals the resource defines itself (functions, variables, class names, table keys): never natives. */
export function definedNames(code: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(/\b(?:function|local|const|let|var|class)\s+([A-Z]\w*)|(?<![.:\w$])([A-Z]\w*)\s*=(?![=>])/g)) {
    out.add((m[1] ?? m[2]) as string);
  }
  return out;
}

const NOT_NATIVES: ReadonlySet<string> = new Set(["Config", "Locales", "Locale", "Lang", "QBCore", "Framework", "Core", "Shared"]);

/** Constants (all upper case), hash literals and well known framework tables are never reported. */
export function looksLikeNative(name: string): boolean {
  return !/^[A-Z][A-Z0-9_]*$/.test(name) && !/^N_0x/i.test(name) && !NOT_NATIVES.has(name);
}

export interface UsedNames {
  runtime: Runtime;
  names: readonly string[];
  /** Names the resource defines itself. */
  defined: ReadonlySet<string>;
}

const RUNTIME_LABEL: Record<Runtime, string> = {
  "lua.client": "Lua client",
  "lua.server": "Lua server",
  "js.client": "JS client",
  "js.server": "JS server",
};

function line(runtime: Runtime, text: string, names: string[]): string {
  return `${RUNTIME_LABEL[runtime]}: ${text} (${names.length}): ${names.join(", ")}`;
}

/**
 * One warning per category and runtime: CFX natives the shim does not provide, CFX natives of the other side, and
 * names that are not CFX natives, LS:MP catalogue natives (client only: the LS:MP server has none) or shim globals.
 */
export function coverageWarnings(data: CfxData, catalogue: ReadonlySet<string>, used: readonly UsedNames[]): string[] {
  const warnings: string[] = [];
  for (const { runtime, names, defined } of used) {
    const side = sideOf(runtime);
    const shimGlobals = new Set(data.globals[runtime]);
    const uncovered: string[] = [];
    const otherSide: string[] = [];
    const unknown: string[] = [];
    for (const name of names) {
      if (defined.has(name) || !looksLikeNative(name)) continue;
      const entry = data.natives[name];
      const lsmp = side === "client" && catalogue.has(name);
      if (entry !== undefined) {
        // server apiset entries are the server variants of GTA natives the client has under the same name
        if (!sidesOf(entry.apiset).includes(side)) {
          if (!lsmp) otherSide.push(name);
        } else if (!entry.covered.includes(runtime)) uncovered.push(name);
      } else if (!shimGlobals.has(name) && !lsmp) {
        unknown.push(name);
      }
    }
    if (uncovered.length > 0) warnings.push(line(runtime, "CFX natives with no implementation in the shim, calls will fail", uncovered));
    if (otherSide.length > 0) warnings.push(line(runtime, `CFX natives that FiveM only provides on the ${side === "client" ? "server" : "client"} side`, otherSide));
    if (unknown.length > 0) warnings.push(line(runtime, "names that are not CFX natives, LS:MP natives or shim globals (missing GTA natives or plain globals)", unknown));
  }
  return warnings;
}
