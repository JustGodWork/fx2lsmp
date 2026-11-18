import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

export const PRELUDE_SCRIPT_TAG = '<script src="/_fxcompat/nui-prelude.js"></script>';
const PRELUDE_URL_MARK = "/_fxcompat/nui-prelude.js";
const WEB_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".json", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".ogg", ".wav", ".webm", ".mp4",
]);

/** Inserts the prelude before the first script of the page; idempotent. */
export function injectPrelude(html: string): string {
  if (html.includes(PRELUDE_URL_MARK)) return html;
  const script = /<script\b/i.exec(html);
  if (script) return html.slice(0, script.index) + PRELUDE_SCRIPT_TAG + html.slice(script.index);
  const head = /<\/head\s*>/i.exec(html);
  if (head) return html.slice(0, head.index) + PRELUDE_SCRIPT_TAG + html.slice(head.index);
  const body = /<\/body\s*>/i.exec(html);
  if (body) return html.slice(0, body.index) + PRELUDE_SCRIPT_TAG + html.slice(body.index);
  return PRELUDE_SCRIPT_TAG + html;
}

/** `*` within one folder level, `**` any depth, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else {
        re += ".*";
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function listFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(dir, path));
    else out.push(path);
  }
  return out;
}

export interface NuiStage {
  webui: string;
  /** Page path relative to the served folder. */
  page: string;
  htmlFiles: string[];
}

/**
 * Builds the webui folder in `outDir`. A page inside a folder is already copied with the resource, so it only needs the
 * prelude. A page at the resource root is staged into `webui/` together with the web files listed in `files`.
 */
export function stageNui(
  srcDir: string,
  outDir: string,
  uiPage: string,
  webui: string,
  files: readonly string[],
  prelude?: string,
): NuiStage {
  const atRoot = posix.dirname(uiPage) === ".";
  if (atRoot) {
    const matchers = files.map(globToRegExp);
    const staged = new Set<string>([uiPage]);
    for (const f of listFiles(srcDir)) {
      if (WEB_EXTENSIONS.has(posix.extname(f).toLowerCase()) && matchers.some((m) => m.test(f))) staged.add(f);
    }
    for (const f of staged) {
      if (!existsSync(join(srcDir, f))) continue;
      const dest = join(outDir, webui, f);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(srcDir, f), dest);
    }
  }
  const root = join(outDir, webui);
  const htmlFiles = existsSync(root) ? listFiles(root).filter((f) => /\.html?$/i.test(f)) : [];
  for (const f of htmlFiles) {
    const path = join(root, f);
    writeFileSync(path, injectPrelude(readFileSync(path, "utf8")));
  }
  if (prelude !== undefined) {
    const dest = join(root, "_fxcompat", "nui-prelude.js");
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(prelude, dest);
  }
  return { webui, page: atRoot ? uiPage : posix.relative(webui, uiPage), htmlFiles };
}
