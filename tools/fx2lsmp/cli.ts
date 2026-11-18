import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SKIP_DIRS, vendorImports } from "./imports.ts";
import { buildJsShim } from "./jsShim.ts";
import { COMPAT_LIBS, isJsScript, type FxManifest, type LsmpManifest, normalizeResourceName, normalizeUiPage, parseFxManifest, toLsmpManifest, usesLuaShim, SERVER_CONVARS_FILE, webuiFolder } from "./manifest.ts";
import { collectModules, IMPORTS_DIR, LOADER_CLIENT_FILE, LOADER_SERVER_FILE, luaString, MODULES_FILE, renderLoader, type ModuleEntry, withoutRegisteredModules, writeModules } from "./modules.ts";
import { globToRegExp, listFiles, stageNui } from "./nui.ts";
import { transpile } from "./transpile.ts";
import { calledNames, capitalisedNames, coverageWarnings, definedInFiles, loadCatalogueNames, loadCfxData, serverNativeNames, stubsFor, type CfxData, type Runtime, type StubConfig, type StubKind, type UsedNames } from "./cfxCoverage.ts";

export { luaString };

export const SHIM_ORDER: readonly string[] = ["core", "@promise", "promise", "natives_alias", "msgpack", "events", "exports", "server", "client", "entities", "statebags", "kvp", "b1", "stubs"];
/** Resources LS:MP starts by itself (docs/notes/c.md): a converted resource with one of these names would clash. */
const BUNDLED_RESOURCES: ReadonlySet<string> = new Set([
  "spawn-mgr", "chat", "death-mgr", "voice-mgr", "admin-tools", "scoreboard", "player-blips", "event-logger",
]);
const MANIFEST_NAMES: ReadonlySet<string> = new Set(["fxmanifest.lua", "__resource.lua"]);

export interface ConvertOptions {
  resourceDir: string;
  outDir: string;
  cfg?: string;
  shimDir?: string;
  /** Folder holding the bundled replacements of cross-resource scripts (default: compat/ of this repository). */
  compatDir?: string;
  /** Folder searched recursively for sibling resources referenced as `@name/path` in the manifest. */
  resourcesDir?: string;
  /** Keep shipping the text of the Lua files the client registry precompiles (default: only their hash and code travel). */
  keepModuleText?: boolean;
}

export interface ConvertResult {
  name: string;
  warnings: string[];
}

const KVP_USE = /ResourceKvp|FindKvp/;
const HASH_USE = /invokeNative|InvokeNative|N_0x/i;
const RUNTIME_LOAD = /(?<![.:\w])(load|loadstring|loadfile|dofile)\s*\(/;

/** LS:MP refuses runtime code loading: the shim resolves `load` only for precompiled Lua files of the resource. */
export function findRuntimeLoads(code: string): { line: number; name: string }[] {
  const found: { line: number; name: string }[] = [];
  code.split("\n").forEach((text, index) => {
    const match = RUNTIME_LOAD.exec(text.replace(/--.*$/, ""));
    if (match !== null) found.push({ line: index + 1, name: match[1] as string });
  });
  return found;
}

export type ConvarKind = "set" | "setr" | "sets";

export interface Convar {
  value: string;
  kind: ConvarKind;
}

/** `set`, `setr` and `sets` lines of a server.cfg; the last line of a name wins, kind included. */
export function parseConvars(cfg: string): Record<string, Convar> {
  const convars: Record<string, Convar> = {};
  for (const raw of cfg.split(/\r?\n/)) {
    const m = /^\s*\+?(set|setr|sets)\s+(\S+)\s+(.*)$/.exec(raw);
    if (!m) continue;
    const kind = m[1] === "setr" ? "setr" : m[1] === "sets" ? "sets" : "set";
    const name = m[2] as string;
    let value = (m[3] as string).trim();
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    if (quoted) value = quoted[1] as string;
    else value = value.replace(/\s+(#|\/\/).*$/, "");
    convars[name] = { value, kind };
  }
  return convars;
}

const SECRET_NAME = /mysql|connection|license|key|token|password|secret|webhook/i;

/**
 * FiveM semantics: only `setr` convars reach clients. LS:MP has no replicated convars, so the build splits them:
 * replicated ones go to the shared config, `set` and `sets` to a server-only file.
 */
export function splitConvars(
  convars: Record<string, Convar>,
  warnings: string[] = [],
): { replicated: Record<string, string>; server: Record<string, string> } {
  const replicated: Record<string, string> = {};
  const server: Record<string, string> = {};
  for (const name of Object.keys(convars).sort()) {
    const convar = convars[name] as Convar;
    if (convar.kind === "setr") {
      replicated[name] = convar.value;
      if (SECRET_NAME.test(name)) {
        warnings.push(`convar '${name}' is replicated (setr) and looks secret: every client receives it, use set`);
      }
    } else {
      server[name] = convar.value;
    }
  }
  return { replicated, server };
}

/** Server-only data file with the `set` and `sets` convars, read on demand by the server shims, never listed. */
export function renderServerConvars(convars: Record<string, string>): string {
  return JSON.stringify(convars, null, 2) + "\n";
}

/**
 * PascalCase and `N_0x` names in the client code. LS:MP protects the client `_G` metatable, so the shim cannot
 * resolve FiveM native names lazily: it defines these up front. Names that are not natives resolve to nothing.
 */
export function clientNativeNames(outDir: string): string[] {
  const names = new Set<string>();
  for (const file of [LOADER_CLIENT_FILE, MODULES_FILE]) {
    const path = join(outDir, file);
    if (!existsSync(path)) continue;
    for (const m of readFileSync(path, "utf8").matchAll(/(?<![.:\w])(?:N_0[xX][0-9A-Fa-f]+|[A-Z][A-Za-z0-9_]*)\b/g)) names.add(m[0]);
  }
  return [...names].sort();
}

/** Names each runtime of a converted resource calls, shared by the coverage warnings and the stubs. */
export function usedNames(outDir: string, fx: FxManifest, luaShim: boolean): UsedNames[] {
  const used: UsedNames[] = [];
  if (luaShim) {
    // the module registry is shared by both sides and holds text loaded on demand: only the loaders count as use
    const clientCalls = calledNames(outDir, [LOADER_CLIENT_FILE], "lua");
    const serverCalls = calledNames(outDir, [LOADER_SERVER_FILE], "lua");
    used.push({ runtime: "lua.client", names: clientNativeNames(outDir).filter((n) => clientCalls.has(n)), defined: definedInFiles(outDir, [LOADER_CLIENT_FILE]) });
    used.push({ runtime: "lua.server", names: serverNativeNames(outDir).filter((n) => serverCalls.has(n)), defined: definedInFiles(outDir, [LOADER_SERVER_FILE]) });
  }
  const present = existsSync(outDir) ? listFiles(outDir) : [];
  const jsFiles = (scripts: readonly string[]): string[] => {
    const matchers = scripts.filter(isJsScript).map(globToRegExp);
    return present.filter((file) => matchers.some((m) => m.test(file)));
  };
  const jsSides: [Runtime, readonly string[]][] = [
    ["js.client", [...fx.sharedScripts, ...fx.clientScripts]],
    ["js.server", [...fx.sharedScripts, ...fx.serverScripts]],
  ];
  for (const [runtime, scripts] of jsSides) {
    const files = jsFiles(scripts);
    if (files.length === 0) continue;
    const calls = calledNames(outDir, files, "js");
    used.push({ runtime, names: [...capitalisedNames(outDir, files)].filter((n) => calls.has(n)).sort(), defined: definedInFiles(outDir, files) });
  }
  return used;
}

/** Coverage warnings for the Lua loaders and the JS scripts a converted resource ships. */
export function nativeCoverageWarnings(
  outDir: string,
  fx: FxManifest,
  luaShim: boolean,
  data: CfxData = loadCfxData(),
  catalogue: ReadonlySet<string> = loadCatalogueNames(),
): string[] {
  const used = usedNames(outDir, fx, luaShim);
  return used.length === 0 ? [] : coverageWarnings(data, catalogue, used);
}

/** The stubs of the natives a converted resource calls that no shim provides, per runtime family. */
export function resourceStubs(outDir: string, fx: FxManifest, luaShim: boolean, data: CfxData = loadCfxData()): { lua: StubConfig; js: StubConfig } {
  const used = usedNames(outDir, fx, luaShim);
  return {
    lua: stubsFor(data, used.filter((u) => u.runtime.startsWith("lua."))),
    js: stubsFor(data, used.filter((u) => u.runtime.startsWith("js."))),
  };
}

function hasStubs(stubs: StubConfig): boolean {
  return Object.keys(stubs.client).length + Object.keys(stubs.server).length > 0;
}

function luaStubTable(side: Record<string, StubKind>): string {
  const entries = Object.keys(side).sort().map((name) => `${name} = ${luaString(side[name] as string)}`);
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

export function renderConfig(
  uiPage: string | undefined,
  convars: Record<string, string>,
  kvpPage?: string,
  metadata: Record<string, string[]> = {},
  natives: readonly string[] = [],
  stubs: StubConfig = { client: {}, server: {} },
): string {
  const metaLines = Object.keys(metadata)
    .sort()
    .map((k) => `    [${luaString(k)}] = { ${(metadata[k] ?? []).map(luaString).join(", ")} },`);
  const convarLines = Object.keys(convars)
    .sort()
    .map((k) => `    [${luaString(k)}] = ${luaString(convars[k] as string)},`);
  return [
    "---@class FxcompatConfig",
    "---@field uiPage string?",
    "---@field kvpPage string?",
    "---@field convars table<string, string>",
    "---@field metadata table<string, string[]>",
    "---@field natives string[]?",
    "---@field stubs table<'client'|'server', table<string, 'bool'|'int'|'float'|'string'|'vector'|'nil'>>?",
    "",
    "---@type FxcompatConfig",
    "FXCOMPAT_CONFIG = {",
    ...(uiPage === undefined ? [] : [`  uiPage = ${luaString(uiPage)},`]),
    ...(kvpPage === undefined ? [] : [`  kvpPage = ${luaString(kvpPage)},`]),
    "  convars = {",
    ...convarLines,
    "  },",
    "  metadata = {",
    ...metaLines,
    "  },",
    ...(natives.length === 0 ? [] : [`  natives = { ${natives.map(luaString).join(", ")} },`]),
    ...(hasStubs(stubs) ? [`  stubs = { client = ${luaStubTable(stubs.client)}, server = ${luaStubTable(stubs.server)} },`] : []),
    "}",
    "",
  ].join("\n");
}

export interface JsConfig {
  uiPage?: string;
  kvpPage?: string;
  b1Workarounds?: boolean;
  applyEntities?: boolean;
  convars: Record<string, string>;
  metadata: Record<string, string[]>;
  stubs?: StubConfig;
}

const TOP_DECLARATION = /^(?:const|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/gm;
const TOP_LET = /^let\s+([A-Za-z_$][\w$]*)\s*(?:=(?!=)|;|,|$)/gm;
const TOP_FUNCTION = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;
const MODULE_STYLE = /\bmodule\.exports\b|\brequire\s*\(|^\s*import\s/m;

/**
 * LS:MP runs each server JS script as its own CommonJS module, FiveM scripts share one global scope and an `exports`
 * global: the `exports` parameter of the module wrapper would hide that global, and the top-level declarations of a
 * script that is not written as a module are also published on `globalThis`. A top-level `let` is published as an
 * accessor pair over the binding, so a reassignment in any script stays visible to the others (a copy would go stale).
 */
export function adaptJsScript(code: string): string {
  const moduleStyle = MODULE_STYLE.test(code);
  const functions = moduleStyle ? [] : [...code.matchAll(TOP_FUNCTION)].map((m) => m[1] ?? "");
  const body = moduleStyle
    ? code
    : code.replace(TOP_DECLARATION, (match, name: string) => `${match.slice(0, -1).replace(/\s+$/, "")} = globalThis.${name} =`);
  const lets = moduleStyle ? [] : [...new Set([...code.matchAll(TOP_LET)].map((m) => m[1] ?? ""))];
  const accessors = lets.map(
    (name) =>
      `try{Object.defineProperty(globalThis,${JSON.stringify(name)},{get:()=>{try{return ${name}}catch{}},` +
      `set:(v)=>{try{${name}=v}catch{Object.defineProperty(globalThis,${JSON.stringify(name)},{value:v,writable:true,configurable:true,enumerable:true})}},` +
      `configurable:true,enumerable:true})}catch{}`,
  );
  const prelude = `var exports=globalThis.exports;${functions.map((name) => `globalThis.${name}=${name};`).join("")}${accessors.join("")}`;
  const directive = /^[ \t]*(?:"use strict"|'use strict');?[ \t]*/.exec(body);
  const at = directive === null ? 0 : directive[0].length;
  return body.slice(0, at) + prelude + body.slice(at);
}

/** The JS twin of config.lua: a global read by the JS shim. */
export function renderConfigJs(config: JsConfig): string {
  return `globalThis.FXCOMPAT_CONFIG = ${JSON.stringify(config)};
`;
}

/** LS:MP has no `load`: the vendored library body becomes a function called with its dependencies. */
export function embedPromise(body: string): string {
  return `FXC.promiseLib = (function(...)
local debug = FXC.debug
${body}
end)(FXC.promiseDeps)
`;
}

export function concatShim(shimDir: string): string {
  const parts: string[] = [];
  for (const name of SHIM_ORDER) {
    if (name === "@promise") {
      const vendored = join(shimDir, "vendor", "promise.lua");
      if (existsSync(vendored)) parts.push(embedPromise(readFileSync(vendored, "utf8")));
      continue;
    }
    const path = join(shimDir, `${name}.lua`);
    if (existsSync(path)) parts.push(readFileSync(path, "utf8"));
  }
  return parts.join("\n");
}

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...walk(dir, path));
    } else out.push(path);
  }
  return out;
}

function writeLua(from: string, dest: string, label: string, warnings: string[]): void {
  const result = transpile(readFileSync(from, "utf8"));
  for (const issue of result.issues) warnings.push(`${label}:${issue.line}: ${issue.message}`);
  for (const use of findRuntimeLoads(result.code)) {
    warnings.push(`${label}:${use.line}: '${use.name}' only works on Lua files of this resource that fx2lsmp precompiled; dynamic source text, loadfile and dofile are refused by LS:MP`);
  }
  writeFileSync(dest, result.code);
}

/** LS:MP expands manifest globs in alphabetical order; the loaders need the explicit list. */
function expandScriptGlobs(fx: FxManifest, outDir: string): void {
  const present = (existsSync(outDir) ? listFiles(outDir) : []).filter((file) => !file.startsWith("_fxcompat/") || file.startsWith(IMPORTS_DIR + "/"));
  const expand = (list: readonly string[]): string[] =>
    list.flatMap((entry) => (/[*?]/.test(entry) ? present.filter((file) => globToRegExp(entry).test(file)).sort() : [entry]));
  fx.sharedScripts = expand(fx.sharedScripts);
  fx.clientScripts = expand(fx.clientScripts);
  fx.serverScripts = expand(fx.serverScripts);
}

function writeLoaders(outDir: string, fx: FxManifest, manifest: LsmpManifest): void {
  const read = (scripts: readonly string[]): ModuleEntry[] =>
    scripts.filter((s) => !isJsScript(s) && existsSync(join(outDir, s))).map((path) => ({ path, text: readFileSync(join(outDir, path), "utf8") }));
  const write = (file: string, scripts: readonly string[]): void => {
    if (![...(manifest.client_scripts ?? []), ...(manifest.server_scripts ?? [])].includes(file)) return;
    const entries = read(scripts);
    mkdirSync(join(outDir, "_fxcompat"), { recursive: true });
    writeFileSync(join(outDir, file), renderLoader(entries, file));
  };
  write(LOADER_CLIENT_FILE, [...fx.sharedScripts, ...fx.clientScripts]);
  write(LOADER_SERVER_FILE, [...fx.sharedScripts, ...fx.serverScripts]);
}

export async function convertResource(opts: ConvertOptions): Promise<ConvertResult> {
  const srcDir = resolve(opts.resourceDir);
  const outDir = resolve(opts.outDir);
  const shimDir = opts.shimDir ?? resolve(import.meta.dirname, "../../shim");
  const manifestPath = [...MANIFEST_NAMES].map((n) => join(srcDir, n)).find(existsSync);
  if (manifestPath === undefined) throw new Error(`no fxmanifest.lua in ${srcDir}`);

  const fx = await parseFxManifest(readFileSync(manifestPath, "utf8"));
  const warnings = fx.warnings;
  const name = normalizeResourceName(basename(srcDir), warnings);
  if (BUNDLED_RESOURCES.has(name)) {
    warnings.push(`'${name}' is also a resource bundled with LS:MP: rename the folder; chat events are bridged to the bundled chat by the shim`);
  }

  const vendored = await vendorImports(fx, opts.resourcesDir === undefined ? undefined : resolve(opts.resourcesDir));
  rmSync(outDir, { recursive: true, force: true });
  // the client KVP lives in a hidden page: only client and shared JS scripts can need it
  const clientScripts = [...fx.clientScripts, ...fx.sharedScripts].filter(isJsScript).map(globToRegExp);
  const jsScripts = [...fx.clientScripts, ...fx.serverScripts, ...fx.sharedScripts].filter(isJsScript).map(globToRegExp);
  let jsUsesKvp = false;
  let jsUsesHashes = false;
  for (const rel of walk(srcDir)) {
    if (MANIFEST_NAMES.has(rel)) continue;
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (rel.toLowerCase().endsWith(".lua")) {
      writeLua(join(srcDir, rel), dest, rel, warnings);
    } else if (isJsScript(rel)) {
      const code = readFileSync(join(srcDir, rel), "utf8");
      if (clientScripts.some((m) => m.test(rel)) && KVP_USE.test(code)) jsUsesKvp = true;
      if (HASH_USE.test(code)) jsUsesHashes = true;
      const listed = !rel.toLowerCase().endsWith(".mjs") && jsScripts.some((m) => m.test(rel));
      writeFileSync(dest, listed ? adaptJsScript(code) : code);
    } else {
      copyFileSync(join(srcDir, rel), dest);
    }
  }

  for (const file of vendored) {
    const dest = join(outDir, file.to);
    mkdirSync(dirname(dest), { recursive: true });
    if (file.to.toLowerCase().endsWith(".lua")) writeLua(file.from, dest, file.to, warnings);
    else copyFileSync(file.from, dest);
  }

  const registries = usesLuaShim(fx) ? collectModules(outDir, fx) : undefined;
  const modules = registries === undefined ? { client: false, server: false } : writeModules(outDir, registries);
  const shippedFiles = registries === undefined || opts.keepModuleText === true ? fx.files : withoutRegisteredModules(fx.files, outDir, registries);
  const luaShim = registries !== undefined;
  if (luaShim) expandScriptGlobs(fx, outDir);
  const manifest = toLsmpManifest({ ...fx, files: shippedFiles }, name, modules, luaShim);

  const compatDir = opts.compatDir ?? resolve(import.meta.dirname, "../../compat");
  for (const key of fx.libs) {
    const lib = COMPAT_LIBS[key];
    if (lib === undefined) continue;
    const source = join(compatDir, lib.source);
    if (!existsSync(source)) {
      warnings.push(`'${key}': bundled copy ${lib.source} not found in ${compatDir}`);
      continue;
    }
    mkdirSync(dirname(join(outDir, lib.target)), { recursive: true });
    writeFileSync(join(outDir, lib.target), transpile(readFileSync(source, "utf8")).code);
  }
  if (luaShim) writeLoaders(outDir, fx, manifest);

  let uiPage: string | undefined;
  if (fx.uiPage !== undefined) {
    const page = normalizeUiPage(fx.uiPage, name, warnings);
    if (page !== undefined) {
      const preludePath = join(shimDir, "nui-prelude.js");
      uiPage = stageNui(srcDir, outDir, page, webuiFolder(page), fx.files, existsSync(preludePath) ? preludePath : undefined).page;
    }
  }

  const present = listFiles(srcDir);
  if (fx.uiPage !== undefined) {
    const page = normalizeUiPage(fx.uiPage, name, []);
    if (page !== undefined && !present.includes(page)) {
      warnings.push(`ui_page '${fx.uiPage}' is not in the source folder (a build step may not have run)`);
    }
  }
  for (const pattern of fx.files) {
    if (pattern.startsWith("_fxcompat/")) continue;
    const matcher = globToRegExp(pattern);
    if (!present.some((f) => matcher.test(f))) warnings.push(`files pattern '${pattern}' matches no file`);
  }

  const kvpSource = join(shimDir, "kvp-page.html");
  const webuiDir = manifest.webui?.[0];
  let kvpPage: string | undefined;
  if (webuiDir !== undefined && existsSync(kvpSource)) {
    kvpPage = "_fxcompat/kvp.html";
    mkdirSync(join(outDir, webuiDir, "_fxcompat"), { recursive: true });
    copyFileSync(kvpSource, join(outDir, webuiDir, "_fxcompat", "kvp.html"));
  }

  const parsed = opts.cfg === undefined ? {} : parseConvars(readFileSync(opts.cfg, "utf8"));
  const { replicated: convars, server: serverConvars } = splitConvars(parsed, warnings);
  mkdirSync(join(outDir, "_fxcompat"), { recursive: true });
  const scripts = [...manifest.shared_scripts, ...(manifest.client_scripts ?? []), ...(manifest.server_scripts ?? [])];
  if (Object.keys(serverConvars).length > 0) {
    writeFileSync(join(outDir, SERVER_CONVARS_FILE), renderServerConvars(serverConvars));
  }
  const stubs = resourceStubs(outDir, fx, luaShim);
  if (scripts.includes("_fxcompat/init.lua")) {
    writeFileSync(join(outDir, "_fxcompat", "config.lua"), renderConfig(uiPage, convars, kvpPage, fx.metadata, clientNativeNames(outDir), stubs.lua));
    writeFileSync(join(outDir, "_fxcompat", "init.lua"), concatShim(shimDir));
  }
  if (scripts.includes("_fxcompat/init.js")) {
    // the KVP page is a hidden browser: a JS resource only gets it when its scripts use KVP
    const jsConfig: JsConfig = { convars, metadata: fx.metadata };
    // the Lua shim is the single entity applier on a client that runs both
    if (scripts.includes("_fxcompat/init.lua")) jsConfig.applyEntities = false;
    if (uiPage !== undefined) jsConfig.uiPage = uiPage;
    if (kvpPage !== undefined && jsUsesKvp) jsConfig.kvpPage = kvpPage;
    if (hasStubs(stubs.js)) jsConfig.stubs = stubs.js;
    writeFileSync(join(outDir, "_fxcompat", "config.js"), renderConfigJs(jsConfig));
    writeFileSync(join(outDir, "_fxcompat", "init.js"), await buildJsShim(shimDir, jsUsesHashes));
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  warnings.push(...nativeCoverageWarnings(outDir, fx, luaShim));
  return { name, warnings };
}

async function main(argv: string[]): Promise<number> {
  const positional: string[] = [];
  let cfg: string | undefined;
  let resourcesDir: string | undefined;
  let keepModuleText = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cfg") cfg = argv[++i];
    else if (argv[i] === "--resources") resourcesDir = argv[++i];
    else if (argv[i] === "--keep-module-text") keepModuleText = true;
    else positional.push(argv[i] as string);
  }
  const [resourceDir, outDir] = positional;
  if (resourceDir === undefined || outDir === undefined) {
    console.error("usage: fx2lsmp <fivemResourceDir> <outDir> [--cfg server.cfg] [--resources dir] [--keep-module-text]");
    return 2;
  }
  const result = await convertResource({ resourceDir, outDir, ...(cfg === undefined ? {} : { cfg }), ...(resourcesDir === undefined ? {} : { resourcesDir }), keepModuleText });
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  console.log(`converted '${result.name}' to ${outDir} (${result.warnings.length} warnings)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main(process.argv.slice(2));
}
