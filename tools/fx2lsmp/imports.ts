import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { parseFxManifest } from "./manifest.ts";
import type { CrossRef, CrossRefKind, FxManifest } from "./manifest.ts";
import { IMPORTS_DIR } from "./modules.ts";
import { globToRegExp } from "./nui.ts";

export const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", ".svn", ".hg"]);
const MANIFEST_NAMES: readonly string[] = ["fxmanifest.lua", "__resource.lua"];
/** Files read back at runtime without being listed: only text data is vendored for them. */
const DATA_EXTENSIONS: ReadonlySet<string> = new Set([".lua", ".json"]);
const GLOB = /[*?]/;

export interface VendoredFile {
  /** Absolute path of the source file. */
  from: string;
  /** Path inside the converted resource. */
  to: string;
  /** Delivered to clients by the other resource, so it may be listed in the consumer manifest. */
  shipped: boolean;
}

function hasManifest(dir: string): boolean {
  return MANIFEST_NAMES.some((name) => existsSync(join(dir, name)));
}

/** A folder named `name` holding a manifest, searched through category folders such as `[core]`. */
export function findResourceDir(root: string, name: string): string | undefined {
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const dir = join(root, entry.name);
    if (entry.name === name && hasManifest(dir)) return dir;
  }
  for (const entry of entries) {
    if (!hasManifest(join(root, entry.name))) {
      const found = findResourceDir(join(root, entry.name), name);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function listResourceFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...listResourceFiles(dir, path));
    } else if (!(rel === "" && MANIFEST_NAMES.includes(entry.name))) out.push(path);
  }
  return out.sort();
}

interface Other {
  dir: string;
  files: string[];
  shippedMatchers: RegExp[];
  /** The other resource's own scripts: they run there, a consumer only gets the ones it references. */
  scriptMatchers: RegExp[];
  vendored: Map<string, VendoredFile>;
  scripts: number;
}

async function openOther(dir: string): Promise<Other> {
  const manifestPath = MANIFEST_NAMES.map((n) => join(dir, n)).find(existsSync) as string;
  const fx = await parseFxManifest(readFileSync(manifestPath, "utf8"));
  return {
    dir,
    files: listResourceFiles(dir),
    shippedMatchers: fx.files.map(globToRegExp),
    scriptMatchers: [...fx.sharedScripts, ...fx.clientScripts, ...fx.serverScripts].map(globToRegExp),
    vendored: new Map(),
    scripts: 0,
  };
}

function add(other: Other, name: string, rel: string, shipped: boolean): string {
  const to = `${IMPORTS_DIR}/${name}/${rel}`;
  const known = other.vendored.get(to);
  if (known === undefined) other.vendored.set(to, { from: join(other.dir, rel), to, shipped });
  else if (shipped) known.shipped = true;
  return to;
}

function splice(list: readonly string[], refs: readonly { index: number; paths: string[] }[]): string[] {
  const out: string[] = [];
  let next = 0;
  for (let i = 0; i <= list.length; i++) {
    while (next < refs.length && refs[next]?.index === i) out.push(...(refs[next++]?.paths ?? []));
    if (i < list.length) out.push(list[i] as string);
  }
  return out;
}

function summary(name: string, other: Other): string {
  const all = [...other.vendored.values()];
  const shipped = all.filter((f) => f.shipped).length;
  const bytes = all.reduce((sum, f) => sum + statSync(f.from).size, 0);
  return `vendored resource '${name}' from ${other.dir}: ${other.scripts} listed script(s), ${shipped} client file(s), ${all.length - shipped} server-only file(s), ${bytes} bytes`;
}

/**
 * Replaces the `@other/path` entries of the manifest with vendored copies under `_fxcompat/imports/<other>/` and
 * returns the files to write. Content the other resource does not ship to clients is never listed in the manifest.
 */
export async function vendorImports(fx: FxManifest, resourcesDir: string | undefined): Promise<VendoredFile[]> {
  const others = new Map<string, Other | undefined>();
  const resolved = new Map<CrossRefKind, { index: number; paths: string[] }[]>();
  for (const ref of fx.crossRefs as readonly CrossRef[]) {
    const slash = ref.value.indexOf("/");
    const name = slash < 0 ? ref.value.slice(1) : ref.value.slice(1, slash);
    const path = slash < 0 ? "" : ref.value.slice(slash + 1);
    if (resourcesDir !== undefined && name !== "" && !others.has(name)) {
      const dir = findResourceDir(resourcesDir, name);
      others.set(name, dir === undefined ? undefined : await openOther(dir));
    }
    const other = others.get(name);
    const matches = other === undefined || path === ""
      ? []
      : GLOB.test(path) ? other.files.filter((f) => globToRegExp(path).test(f)) : other.files.includes(path) ? [path] : [];
    if (other === undefined || matches.length === 0) {
      if (other !== undefined) fx.warnings.push(`'${ref.value}' matches no file of resource '${name}'`);
      else if (resourcesDir !== undefined) fx.warnings.push(`'${ref.value}': resource '${name}' not found under ${resourcesDir}`);
      continue;
    }
    const client = ref.kind !== "server";
    const paths = matches.map((m) => add(other, name, m, client));
    if (ref.kind !== "file") other.scripts += paths.length;
    const list = resolved.get(ref.kind) ?? [];
    list.push({ index: ref.index, paths });
    resolved.set(ref.kind, list);
    const warning = `cross-resource path '${ref.value}' ignored`;
    const at = fx.warnings.findIndex((w) => w.startsWith(warning));
    if (at >= 0) fx.warnings.splice(at, 1);
  }
  fx.sharedScripts = splice(fx.sharedScripts, resolved.get("shared") ?? []);
  fx.clientScripts = splice(fx.clientScripts, resolved.get("client") ?? []);
  fx.serverScripts = splice(fx.serverScripts, resolved.get("server") ?? []);
  fx.files = splice(fx.files, resolved.get("file") ?? []);

  const result: VendoredFile[] = [];
  const listedClient = new Set([...fx.sharedScripts, ...fx.clientScripts, ...fx.files]);
  for (const [name, other] of others) {
    if (other === undefined || other.vendored.size === 0) continue;
    for (const rel of other.files) {
      if (!DATA_EXTENSIONS.has(posix.extname(rel).toLowerCase())) continue;
      if (other.scriptMatchers.some((m) => m.test(rel))) continue;
      add(other, name, rel, other.shippedMatchers.some((m) => m.test(rel)));
    }
    for (const file of other.vendored.values()) {
      if (file.shipped && !listedClient.has(file.to)) fx.files.push(file.to);
      result.push(file);
    }
    fx.warnings.push(summary(name, other));
  }
  return result;
}
