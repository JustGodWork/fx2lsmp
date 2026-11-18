import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SHIM_ORDER } from "./fx2lsmp/cli.ts";

interface LuaLsDiagnostic {
  code: string;
  message: string;
  severity: number;
  range: { start: { line: number } };
}

export interface LuaLsFinding {
  file: string;
  line: number;
  code: string;
  message: string;
}

const ROOT = resolve(import.meta.dirname, "..");
const EXE = process.platform === "win32" ? "lua-language-server.exe" : "lua-language-server";

/** `LUALS_BIN`, then the repo `.tools`, then the sibling fx-oop checkout. */
export function findLuaLs(): string | undefined {
  const candidates = [
    process.env["LUALS_BIN"],
    join(ROOT, ".tools/luals/bin", EXE),
    `E:/GITHUB/fx-oop/.tools/luals/bin/${EXE}`,
  ];
  return candidates.find((c): c is string => c !== undefined && existsSync(c));
}

/** Compat resources run on top of the shim globals: each file is checked on its own next to the concatenated shim. */
const COMPAT_FILES: readonly { path: string; name: string }[] = [
  { path: "compat/oxmysql/server.lua", name: "compat_oxmysql_server.lua" },
  { path: "compat/oxmysql/lib/MySQL.lua", name: "compat_oxmysql_MySQL.lua" },
];

/** The vendored promise body is a byte copy of third party code with its own annotations: only its typed surface (FxPromiseModule) is checked. */
const SKIPPED_PARTS: ReadonlySet<string> = new Set(["@promise"]);

export interface Span {
  file: string;
  start: number;
  end: number;
}

/** Maps a 0-based line of a LuaLS report (by file uri) to the source file and 1-based line. */
export function locate(uri: string, abs: number, spans: readonly Span[]): { file: string; line: number } {
  const path = uri.split("\\").join("/");
  if (path.endsWith("/lsmp.meta.lua")) return { file: "lsmp.meta.lua", line: abs + 1 };
  const compat = COMPAT_FILES.find((f) => path.endsWith("/" + f.name));
  if (compat !== undefined) return { file: compat.path, line: abs + 1 };
  const span = spans.find((s) => abs >= s.start && abs <= s.end);
  return { file: span?.file ?? "?", line: span === undefined ? abs + 1 : abs - span.start + 1 };
}

/**
 * The shim files share one chunk once built (file level locals), so they are checked concatenated,
 * in build order, and each finding is mapped back to its source file.
 */
export function checkShim(luals: string): LuaLsFinding[] {
  const work = mkdtempSync(join(tmpdir(), "fxlint-"));
  try {
    const shimDir = join(ROOT, "shim");
    const spans: Span[] = [];
    const parts: string[] = [];
    let line = 0;
    for (const name of SHIM_ORDER) {
      if (SKIPPED_PARTS.has(name)) continue;
      const text = readFileSync(join(shimDir, `${name}.lua`), "utf8");
      const count = text.split("\n").length;
      spans.push({ file: `${name}.lua`, start: line, end: line + count });
      parts.push(text);
      line = line + count;
    }
    mkdirSync(join(work, "src"));
    writeFileSync(join(work, "src/init.lua"), parts.join("\n"));
    copyFileSync(join(shimDir, "lsmp.meta.lua"), join(work, "src/lsmp.meta.lua"));
    for (const file of COMPAT_FILES) copyFileSync(join(ROOT, file.path), join(work, "src", file.name));
    const config = join(work, "luarc.json");
    writeFileSync(config, JSON.stringify({ "runtime.version": "Lua 5.4", "diagnostics.globals": ["FXCOMPAT_CONFIG"] }));
    try {
      execFileSync(luals, [`--check=${join(work, "src")}`, `--configpath=${config}`, "--checklevel=Warning", "--check_format=json", `--logpath=${join(work, "log")}`], {
        stdio: "ignore",
        timeout: 180000,
      });
    } catch {
      // LuaLS exits non zero on findings; the report file is the result.
    }
    const report = join(work, "log/check.json");
    if (!existsSync(report)) return [];
    const data: Record<string, LuaLsDiagnostic[]> = JSON.parse(readFileSync(report, "utf8"));
    const findings: LuaLsFinding[] = [];
    for (const [uri, diags] of Object.entries(data)) {
      for (const d of diags) {
        const where = locate(uri, d.range.start.line, spans);
        findings.push({ ...where, code: d.code, message: d.message.split("\n")[0] ?? "" });
      }
    }
    return findings;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const luals = findLuaLs();
  if (luals === undefined) {
    console.error("lint:lua: LuaLS not found (set LUALS_BIN)");
    process.exitCode = 2;
  } else {
    const findings = checkShim(luals);
    for (const f of findings) console.log(`${f.file}:${f.line} ${f.code} ${f.message}`);
    console.log(`lint:lua: ${findings.length} diagnostics`);
    process.exitCode = findings.length === 0 ? 0 : 1;
  }
}
