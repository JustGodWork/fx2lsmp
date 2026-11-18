import { LuaFactory } from "wasmoon";
import { posix } from "node:path";
import { LOADER_CLIENT_FILE, LOADER_SERVER_FILE, MODULES_FILE, MODULES_SERVER_FILE } from "./modules.ts";

export interface DataFile {
  path: string;
  type: string;
}

/** Cross-resource script entries (`@resource/path`) that have a bundled replacement under compat/. */
export const COMPAT_LIBS: Readonly<Record<string, { source: string; target: string; note: string }>> = {
  "@oxmysql/lib/MySQL.lua": {
    source: "oxmysql/lib/MySQL.lua",
    target: "_fxcompat/libs/oxmysql/MySQL.lua",
    note: "the 'oxmysql' compat resource (compat/oxmysql) must be converted too and run unsandboxed",
  },
};

export type CrossRefKind = "client" | "server" | "shared" | "file";

/** A dropped `@resource/path` entry and where it stood in its list, so a vendored copy can take its place. */
export interface CrossRef {
  kind: CrossRefKind;
  value: string;
  index: number;
}

export interface FxManifest {
  clientScripts: string[];
  serverScripts: string[];
  sharedScripts: string[];
  files: string[];
  uiPage?: string;
  dataFiles: DataFile[];
  dependencies: string[];
  /** Keys of COMPAT_LIBS found in the script lists. */
  libs: string[];
  crossRefs: CrossRef[];
  exports: string[];
  serverExports: string[];
  provide: string[];
  /** Every key a script can read back with GetResourceMetadata, in declaration order. */
  metadata: Record<string, string[]>;
  loadscreen?: string;
  author?: string;
  description?: string;
  version?: string;
  warnings: string[];
}

export interface LsmpManifest {
  title: string;
  description?: string;
  author?: string;
  version?: string;
  shared_scripts: string[];
  client_scripts?: string[];
  server_scripts?: string[];
  files?: string[];
  webui?: string[];
  data_files?: DataFile[];
  dependencies?: string[];
}

/** Informational keys: kept as metadata, no warning. */
const INFO_DIRECTIVES: readonly string[] = ["repository", "url", "license", "name", "resource_manifest_version"];

const IGNORED_DIRECTIVES: readonly string[] = [
  "fx_version", "game", "games", "lua54", "rdr3_warning", "this_is_a_map", "clr_disable_task_scheduler",
  "node_version", "nui_callback_strict_mode", "use_fxv2_oal", "is_cfxv2", "server_only", "convar_category",
  "replace_level_meta", "resource_type", "mono_rt2", "map",
];

// Directives are plain functions: `client_script 'a.lua'` and `client_scripts { 'a.lua' }` are both ordinary Lua calls.
const PRELUDE = `
local rec, warn, ignored, info = ...
local env = {}
local function strings(kind, v)
  if type(v) == "table" then
    for _, item in ipairs(v) do strings(kind, item) end
  elseif v ~= nil then
    rec(kind, tostring(v))
  end
end
local lists = {
  client_script = "client", client_scripts = "client",
  server_script = "server", server_scripts = "server",
  shared_script = "shared", shared_scripts = "shared",
  file = "file", files = "file",
  dependency = "dependency", dependencies = "dependency",
  export = "export", exports = "export",
  server_export = "server_export", server_exports = "server_export",
  provide = "provide",
}
for name, kind in pairs(lists) do
  env[name] = function(v) strings(kind, v) end
end
for _, name in ipairs({ "ui_page", "loadscreen", "author", "description", "version" }) do
  env[name] = function(v)
    if type(v) == "table" then v = v[1] end
    rec(name, tostring(v))
    rec("meta", name .. "\\n" .. tostring(v))
  end
end
env.data_file = function(dtype, path)
  if path ~= nil then
    rec("data_file", tostring(dtype) .. "\\n" .. tostring(path))
    return nil
  end
  return function(p) rec("data_file", tostring(dtype) .. "\\n" .. tostring(p)) end
end
for _, name in ipairs(ignored) do env[name] = function() end end
for _, name in ipairs({ "string", "table", "math", "pairs", "ipairs", "type", "tostring", "tonumber", "print", "select", "next" }) do
  env[name] = _G[name]
end
local infoSet = {}
for _, name in ipairs(info) do infoSet[name] = true end
setmetatable(env, { __index = function(_, key)
  if not infoSet[key] then warn("unknown directive '" .. tostring(key) .. "'") end
  local function directive(v)
    if type(v) == "table" then
      for _, item in ipairs(v) do rec("meta", tostring(key) .. "\\n" .. tostring(item)) end
    elseif v ~= nil then
      rec("meta", tostring(key) .. "\\n" .. tostring(v))
    end
    return directive
  end
  return directive
end })
return env
`;

export async function parseFxManifest(source: string): Promise<FxManifest> {
  const out: FxManifest = {
    clientScripts: [], serverScripts: [], sharedScripts: [], files: [], dataFiles: [], dependencies: [], libs: [], crossRefs: [],
    exports: [], serverExports: [], provide: [], metadata: {}, warnings: [],
  };
  const factory = new LuaFactory();
  const lua = await factory.createEngine({ injectObjects: false });
  try {
    const rec = (kind: string, value: string): void => record(out, kind, value);
    const warn = (message: string): void => {
      if (!out.warnings.includes(message)) out.warnings.push(message);
    };
    const ignored = IGNORED_DIRECTIVES.map((name) => `"${name}"`).join(", ");
    const info = INFO_DIRECTIVES.map((name) => `"${name}"`).join(", ");
    lua.global.set("__rec", rec);
    lua.global.set("__warn", warn);
    lua.global.set("__src", source);
    lua.global.set("__prelude", PRELUDE);
    await lua.doString(`
      local env = assert(load(__prelude, "=prelude"))(__rec, __warn, { ${ignored} }, { ${info} })
      local chunk, err = load(__src, "@fxmanifest.lua", "t", env)
      if not chunk then error(err, 0) end
      chunk()
    `);
  } finally {
    lua.global.close();
  }
  return out;
}

function record(out: FxManifest, kind: string, value: string): void {
  const isScript = kind === "client" || kind === "server" || kind === "shared";
  const lib = isScript ? COMPAT_LIBS[value] : undefined;
  if (lib !== undefined) {
    if (!out.libs.includes(value)) out.libs.push(value);
    out.warnings.push(`'${value}' replaced by a bundled copy: ${lib.note}`);
    record(out, kind, lib.target);
    return;
  }
  if ((isScript || kind === "file") && value.startsWith("@")) {
    out.warnings.push(`cross-resource path '${value}' ignored: LS:MP has no cross-resource paths (pass --resources <dir> to vendor it)`);
    const lists: Record<CrossRefKind, string[]> = {
      client: out.clientScripts, server: out.serverScripts, shared: out.sharedScripts, file: out.files,
    };
    out.crossRefs.push({ kind: kind as CrossRefKind, value, index: lists[kind as CrossRefKind].length });
    return;
  }
  switch (kind) {
    case "client": out.clientScripts.push(value); break;
    case "server": out.serverScripts.push(value); break;
    case "shared": out.sharedScripts.push(value); break;
    case "file": out.files.push(value); break;
    case "dependency":
      if (value.startsWith("/")) out.warnings.push(`dependency '${value}' ignored: server feature requirement`);
      else out.dependencies.push(value);
      break;
    case "export": out.exports.push(value); break;
    case "server_export": out.serverExports.push(value); break;
    case "provide": out.provide.push(value); break;
    case "meta": {
      const cut = value.indexOf("\n");
      (out.metadata[value.slice(0, cut)] ??= []).push(value.slice(cut + 1));
      break;
    }
    case "ui_page": out.uiPage = value; break;
    case "loadscreen": out.loadscreen = value; break;
    case "author": out.author = value; break;
    case "description": out.description = value; break;
    case "version": out.version = value; break;
    case "data_file": {
      const [type = "", path = ""] = value.split("\n");
      out.dataFiles.push({ type, path });
      break;
    }
  }
}

export function normalizeResourceName(dirName: string, warnings: string[]): string {
  const safe = dirName.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^[^a-z0-9]+/, "");
  if (safe !== dirName) warnings.push(`resource name '${dirName}' became '${safe}'`);
  return safe;
}

/** `nui://res/dir/index.html` and `dir/index.html` both become `dir/index.html`. */
export function normalizeUiPage(uiPage: string, resource: string, warnings: string[]): string | undefined {
  const nui = /^nui:\/\/([^/]+)\/(.*)$/.exec(uiPage);
  if (nui) return nui[2];
  if (/^[a-z]+:\/\//i.test(uiPage)) {
    warnings.push(`ui_page '${uiPage}' is not a file of resource '${resource}' and was ignored`);
    return undefined;
  }
  return uiPage.replace(/^\.\//, "");
}

/** Folder served by LS:MP for the page; a page at the resource root is staged into `webui`. */
export function webuiFolder(uiPage: string): string {
  const dir = posix.dirname(uiPage);
  return dir === "." ? "webui" : dir;
}

export const JS_SHIM_SCRIPTS: readonly string[] = ["_fxcompat/config.js", "_fxcompat/init.js"];
export const LUA_SHIM_SCRIPTS: readonly string[] = ["_fxcompat/config.lua", "_fxcompat/init.lua"];
export const SERVER_CONVARS_FILE = "_fxcompat/server_convars.json";

export function isJsScript(path: string): boolean {
  return /\.(c|m)?js$/i.test(path);
}

export interface ModuleFlags {
  client: boolean;
  server: boolean;
}

/** A resource with no script at all keeps the Lua shim: it is the one that existed first. */
export function usesLuaShim(fx: FxManifest): boolean {
  const all = [...fx.sharedScripts, ...fx.clientScripts, ...fx.serverScripts];
  return !all.some(isJsScript) || all.some((s) => !isJsScript(s));
}

/** Replaces the run of Lua scripts of `list` by `loader`, put where the first of them stood. */
function withLoader(list: readonly string[], loader: string): string[] {
  const out: string[] = [];
  let placed = false;
  for (const script of list) {
    if (isJsScript(script)) out.push(script);
    else if (!placed) {
      out.push(loader);
      placed = true;
    }
  }
  return out;
}

/**
 * `loaders` replaces the Lua scripts of each side by one generated script (see renderLoader), which needs
 * `modules_server.lua` and the client registry to stay ahead of it; the manifest scripts are then only the shim, the
 * registries, JS scripts and the loaders.
 */
export function toLsmpManifest(fx: FxManifest, name: string, modules: ModuleFlags = { client: false, server: false }, loaders = false): LsmpManifest {
  const warnings = fx.warnings;
  const uiPage = fx.uiPage === undefined ? undefined : normalizeUiPage(fx.uiPage, name, warnings);
  // a client resource always gets a webui folder: it carries the hidden KVP page
  const webui = uiPage !== undefined ? webuiFolder(uiPage) : fx.clientScripts.length > 0 ? "webui" : undefined;
  const dataPaths = new Set(fx.dataFiles.map((d) => d.path));
  const files = fx.files.filter((f) => !dataPaths.has(f) && (webui === undefined || !f.startsWith(webui + "/")));
  const luaShim = usesLuaShim(fx);
  const jsShared = fx.sharedScripts.some(isJsScript);
  const jsClient = fx.clientScripts.some(isJsScript);
  const jsServer = fx.serverScripts.some(isJsScript);
  // the JS shim must precede the shared scripts, so it travels with them unless one side alone needs it
  const jsInShared = jsShared || (jsClient && jsServer);
  const useLoaders = loaders && luaShim;
  const luaAt = (list: readonly string[]): boolean => list.some((s) => !isJsScript(s));
  const clientLoader = useLoaders && luaAt([...fx.sharedScripts, ...fx.clientScripts]);
  const serverLoader = useLoaders && luaAt([...fx.sharedScripts, ...fx.serverScripts]);
  // modules_server.lua must run before the shared scripts on the server, so they move to each side's own list
  const serverFirst = luaShim && modules.server && !useLoaders;
  const manifest: LsmpManifest = {
    title: name,
    shared_scripts: [
      ...(luaShim ? LUA_SHIM_SCRIPTS : []),
      ...(luaShim && modules.client ? [MODULES_FILE] : []),
      ...(jsInShared ? JS_SHIM_SCRIPTS : []),
      ...(serverFirst ? [] : useLoaders ? fx.sharedScripts.filter(isJsScript) : fx.sharedScripts),
    ],
  };
  if (fx.description !== undefined) manifest.description = fx.description;
  if (fx.author !== undefined) manifest.author = fx.author;
  if (fx.version !== undefined) manifest.version = fx.version;
  const moved = serverFirst ? fx.sharedScripts : [];
  const luaShared = fx.sharedScripts.filter((script) => !isJsScript(script));
  if (fx.clientScripts.length > 0 || moved.length > 0 || clientLoader) {
    const shim = jsClient && !jsInShared ? JS_SHIM_SCRIPTS : [];
    const own = clientLoader ? withLoader([...luaShared, ...fx.clientScripts], LOADER_CLIENT_FILE) : fx.clientScripts;
    manifest.client_scripts = [...shim, ...moved, ...own];
  }
  if (fx.serverScripts.length > 0 || fx.sharedScripts.length > 0 || serverFirst) {
    const shim = jsServer && !jsInShared ? JS_SHIM_SCRIPTS : [];
    const own = serverLoader ? withLoader([...luaShared, ...fx.serverScripts], LOADER_SERVER_FILE) : fx.serverScripts;
    const registry = serverFirst || (useLoaders && modules.server) ? [MODULES_SERVER_FILE] : [];
    manifest.server_scripts = [...shim, ...registry, ...moved, ...own];
  }
  if (files.length > 0) manifest.files = files;
  if (webui !== undefined) manifest.webui = [webui];
  if (fx.dataFiles.length > 0) manifest.data_files = fx.dataFiles.map((d) => ({ path: d.path, type: d.type }));
  if (fx.dependencies.length > 0) manifest.dependencies = fx.dependencies;
  if (fx.loadscreen !== undefined) warnings.push("loadscreen is not supported by LS:MP and was ignored");
  if (fx.exports.length + fx.serverExports.length > 0) {
    warnings.push("export declarations are dropped: the shim registers exports at runtime");
  }
  return manifest;
}
