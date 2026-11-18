import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { World, nth } from "../test/harness.ts";
import { pascalCase } from "./natives_alias.ts";
import {
  DATA_PATH, RUNTIMES, loadCatalogueNames, runtimesOf, sideOf,
  type Apiset, type CfxData, type CfxEntry, type Runtime,
} from "./fx2lsmp/cfxCoverage.ts";
import { renderCoverageDoc } from "./cfx_coverage_doc.ts";

export const CFX_PATH = "E:/GITHUB/fx-oop/data/natives_cfx.json";
const DOC_PATH: string = resolve(import.meta.dirname, "../docs/notes/cfx-coverage.md");

interface RawNative {
  name: string;
  results: string;
  apiset: Apiset;
}

interface RawFile {
  CFX: Record<string, RawNative>;
}

/** Names a runtime defines once the shim is loaded: present afterwards, absent before (the fake host is excluded). */
interface Probe {
  natives: Set<string>;
  globals: string[];
}

export function readCfx(path: string = CFX_PATH): Map<string, RawNative> {
  const raw: RawFile = JSON.parse(readFileSync(path, "utf8"));
  const out = new Map<string, RawNative>();
  for (const native of Object.values(raw.CFX)) {
    const name = pascalCase(native.name);
    // a name used by several apisets keeps the widest one
    const known = out.get(name);
    if (known === undefined || (known.apiset !== native.apiset && native.apiset === "shared")) out.set(name, native);
  }
  return out;
}

function luaProbeCode(names: readonly string[]): string {
  const list = names.map((n) => `'${n}'`).join(",");
  return `local out, globals = {}, {}
for _, n in ipairs({${list}}) do if type(rawget(_G, n)) == 'function' then out[#out + 1] = n end end
for k, v in pairs(_G) do
  if type(k) == 'string' and k:match('^%u') and (type(v) == 'function' or type(v) == 'table') then globals[#globals + 1] = k end
end
return table.concat(out, ',') .. '|' .. table.concat(globals, ',')`;
}

function jsProbeCode(names: readonly string[]): string {
  return `const names = ${JSON.stringify(names)};
const globals = Object.getOwnPropertyNames(globalThis).filter((k) => /^[A-Z]/.test(k) && ['function', 'object'].includes(typeof globalThis[k]));
return [names.filter((n) => typeof globalThis[n] === 'function'), globals];`;
}

function splitLua(text: string): { natives: string[]; globals: string[] } {
  const [natives = "", globals = ""] = text.split("|");
  const list = (s: string): string[] => (s === "" ? [] : s.split(","));
  return { natives: list(natives), globals: list(globals) };
}

function diff(before: { natives: string[]; globals: string[] }, after: { natives: string[]; globals: string[] }): Probe {
  const had = new Set([...before.natives, ...before.globals]);
  return {
    natives: new Set(after.natives.filter((n) => !had.has(n))),
    globals: after.globals.filter((n) => !had.has(n)),
  };
}

async function probeLua(names: readonly string[]): Promise<Record<"client" | "server", Probe>> {
  const world = await World.create({ luaMain: false, clients: 1 });
  try {
    const res = await world.addLua("coverage");
    const client = nth(res.clients, 0);
    const code = luaProbeCode(names);
    const before = { server: splitLua(await res.server.eval<string>(code)), client: splitLua(await client.eval<string>(code)) };
    await world.loadLuaShim(res);
    const after = { server: splitLua(await res.server.eval<string>(code)), client: splitLua(await client.eval<string>(code)) };
    return { server: diff(before.server, after.server), client: diff(before.client, after.client) };
  } finally {
    world.close();
  }
}

async function probeJs(names: readonly string[]): Promise<Record<"client" | "server", Probe>> {
  const world = await World.create({ luaMain: false, clients: 1 });
  try {
    const res = world.addJs("coverage");
    const client = nth(res.clients, 0);
    const code = jsProbeCode(names);
    const read = async (vm: { eval<T>(code: string): Promise<T> }): Promise<{ natives: string[]; globals: string[] }> => {
      const [natives = [], globals = []] = await vm.eval<[string[], string[]]>(code);
      return { natives, globals };
    };
    const before = { server: await read(res.server), client: await read(client) };
    await world.loadJsShim(res);
    const after = { server: await read(res.server), client: await read(client) };
    return { server: diff(before.server, after.server), client: diff(before.client, after.client) };
  } finally {
    world.close();
  }
}

/** Loads the real shims in the harness worlds and records which CFX names are functions afterwards. */
export async function computeCoverage(cfxPath: string = CFX_PATH): Promise<CfxData> {
  const cfx = readCfx(cfxPath);
  const names = [...cfx.keys()].sort();
  const catalogue = loadCatalogueNames();
  const lua = await probeLua(names);
  const js = await probeJs(names);
  const probes: Record<Runtime, Probe> = {
    "lua.client": lua.client, "lua.server": lua.server, "js.client": js.client, "js.server": js.server,
  };
  const natives: Record<string, CfxEntry> = {};
  for (const name of names) {
    const raw = cfx.get(name) as RawNative;
    const covered = runtimesOf(raw.apiset).filter((runtime) =>
      (probes[runtime].natives.has(name)) || (sideOf(runtime) === "client" && catalogue.has(name)));
    natives[name] = { apiset: raw.apiset, result: raw.results, covered };
  }
  const known = new Set(names);
  const globals = {} as Record<Runtime, string[]>;
  for (const runtime of RUNTIMES) globals[runtime] = probes[runtime].globals.filter((g) => !known.has(g) && !(sideOf(runtime) === "client" && catalogue.has(g))).sort();
  return { natives, globals };
}

export function renderData(data: CfxData): string {
  const lines = Object.keys(data.natives).sort().map((name) => `    ${JSON.stringify(name)}: ${JSON.stringify(data.natives[name])}`);
  const globals = RUNTIMES.map((rt) => `    ${JSON.stringify(rt)}: ${JSON.stringify(data.globals[rt])}`);
  return `{\n  "natives": {\n${lines.join(",\n")}\n  },\n  "globals": {\n${globals.join(",\n")}\n  }\n}\n`;
}

async function main(): Promise<void> {
  if (!existsSync(CFX_PATH)) throw new Error(`missing ${CFX_PATH}`);
  const data = await computeCoverage();
  writeFileSync(DATA_PATH, renderData(data));
  writeFileSync(DOC_PATH, renderCoverageDoc(data));
  const total = Object.keys(data.natives).length;
  console.log(`cfx_natives.json: ${total} natives`);
  for (const runtime of RUNTIMES) {
    const applicable = Object.values(data.natives).filter((e) => runtimesOf(e.apiset).includes(runtime));
    console.log(`${runtime}: ${applicable.filter((e) => e.covered.includes(runtime)).length}/${applicable.length}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
