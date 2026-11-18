import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { globToRegExp, listFiles } from "./nui.ts";
import type { FxManifest } from "./manifest.ts";

export const MODULES_FILE = "_fxcompat/modules.lua";
export const IMPORTS_DIR = "_fxcompat/imports";
export const MODULES_SERVER_FILE = "_fxcompat/modules_server.lua";

export function luaString(value: string): string {
  let out = '"';
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (ch === '"' || ch === "\\") out += "\\" + ch;
    else if (byte >= 0x20 && byte < 0x7f) out += ch;
    else out += "\\" + String(byte).padStart(3, "0");
  }
  return out + '"';
}

/** `<byteLength>:<fnv1a32 hex>` over the UTF-8 bytes: the shim computes the same value from the file text. */
export function moduleHash(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  let h = 0x811c9dc5;
  for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return `${bytes.length}:${h.toString(16).padStart(8, "0")}`;
}

export interface ModuleEntry {
  path: string;
  text: string;
}

export interface ModuleRegistries {
  client: ModuleEntry[];
  server: ModuleEntry[];
}

function renderEntry(entry: ModuleEntry, firstLine: number): string {
  const body = entry.text.replace(/^#![^\n]*/, "");
  return `FXC.registerModule(${luaString(entry.path)}, ${luaString(moduleHash(entry.text))}, function(_ENV) return function(...)\n${body}\nend end, ${firstLine})\n`;
}

/** Number of Lua line breaks in `text`, counted as the compiler does. */
function countLines(text: string): number {
  return (text.match(/\r\n|\n\r|\n|\r/g) ?? []).length;
}

/** The module registry file `file`: `FXC` registers into it, and each entry gets the line where its body starts. */
export function renderModules(entries: readonly ModuleEntry[], file: string = MODULES_FILE): string {
  let line = 2;
  const rendered = entries.map((entry) => {
    const text = renderEntry(entry, line + 1);
    line += countLines(text);
    return text;
  });
  return `local FXC <const> = { registerModule = __fxc_registry(${luaString(file)}) }\n${rendered.join("")}`;
}

function walkLua(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkLua(dir, path));
    else if (path.toLowerCase().endsWith(".lua")) out.push(path);
  }
  return out;
}

/**
 * Lua files a resource can read back and `load`: everything but listed scripts and the shim. Files the client package
 * receives (`files` patterns) go to the client registry, the others stay on the server.
 */
export function collectModules(outDir: string, fx: FxManifest): ModuleRegistries {
  const listed = [...fx.sharedScripts, ...fx.clientScripts, ...fx.serverScripts].map(globToRegExp);
  const shipped = fx.files.map(globToRegExp);
  const paths = existsSync(outDir)
    ? walkLua(outDir).filter((p) => (!p.startsWith("_fxcompat/") || p.startsWith(IMPORTS_DIR + "/")) && !listed.some((m) => m.test(p))).sort()
    : [];
  const text = new Map(paths.map((p) => [p, readFileSync(join(outDir, p), "utf8")]));
  const isClient = (p: string): boolean => shipped.some((m) => m.test(p));
  const result: ModuleRegistries = { client: [], server: [] };
  for (const path of paths) {
    (isClient(path) ? result.client : result.server).push({ path, text: text.get(path) as string });
  }
  for (const path of paths) {
    if (posix.basename(path) !== "shared.lua") continue;
    const dir = posix.dirname(path);
    const side = (name: string): string => (dir === "." ? name : `${dir}/${name}`);
    const shared = text.get(path) as string;
    for (const name of ["client.lua", "server.lua"]) {
      const other = text.get(side(name));
      if (other === undefined) continue;
      const entry: ModuleEntry = { path: side(name), text: `${shared}\n${other}` };
      if (name === "client.lua") {
        if (isClient(path) && isClient(side(name))) result.client.push(entry);
      } else result.server.push(entry);
    }
  }
  return result;
}

export function writeModules(outDir: string, registries: ModuleRegistries): { client: boolean; server: boolean } {
  const write = (file: string, entries: readonly ModuleEntry[]): boolean => {
    if (entries.length === 0) return false;
    mkdirSync(dirname(join(outDir, file)), { recursive: true });
    writeFileSync(join(outDir, file), renderModules(entries, file));
    return true;
  };
  return { client: write(MODULES_FILE, registries.client), server: write(MODULES_SERVER_FILE, registries.server) };
}

/**
 * `files` patterns minus the Lua files of the client registry: the client reads them back through the shim as a marker
 * and runs the precompiled code, so their text never needs to travel. A pattern that matched any of them becomes the
 * explicit list of its other matches.
 */
export function withoutRegisteredModules(patterns: readonly string[], outDir: string, registries: ModuleRegistries): string[] {
  const registered = new Set(registries.client.map((entry) => entry.path));
  if (registered.size === 0) return [...patterns];
  const present = listFiles(outDir);
  const out: string[] = [];
  for (const pattern of patterns) {
    const matcher = globToRegExp(pattern);
    const matches = present.filter((file) => matcher.test(file));
    if (!matches.some((file) => registered.has(file))) out.push(pattern);
    else out.push(...matches.filter((file) => !registered.has(file)));
  }
  return [...new Set(out)];
}
