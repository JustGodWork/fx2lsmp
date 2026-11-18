import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { convertResource } from "./fx2lsmp/cli.ts";

interface SmokeExample {
  /** Source FiveM resource folder, relative to the repository root or absolute. */
  source: string;
  /** Resource name inside LS:MP; prefixed so the user's own resources are never overwritten. */
  name: string;
  /** Regular expressions, each of which must match a line of the server log. */
  expected: readonly RegExp[];
}

const ROOT = resolve(import.meta.dirname, "..");
const LSMP_DIR = resolve(process.env["LSMP_DIR"] ?? "C:/lsmp");
const SMOKE_LOG = join(ROOT, ".tmp/smoke.log");
const RUN_MS = Number(process.env["LSMP_SMOKE_MS"] ?? 25000);

const EXAMPLES: readonly SmokeExample[] = [
  {
    source: "examples/fivem/hello",
    name: "fxsmoke_hello",
    expected: [
      /resource 'fxsmoke_hello' \[server\] built/,
      /resource 'fxsmoke_hello' \[client\] built/,
      /fxsmoke_hello started, boot number \d+/,
    ],
  },
  {
    source: "examples/fivem/hello_js",
    name: "fxsmoke_hello_js",
    expected: [
      /resource 'fxsmoke_hello_js' \[server\] built/,
      /resource 'fxsmoke_hello_js' \[client\] built/,
      /fxsmoke_hello_js started, boot number \d+/,
      /fxsmoke_hello_js vehicle created, netId [1-9]\d*, model \d+, type 2/,
    ],
  },
  {
    source: "compat/spawnmanager",
    name: "fxsmoke_spawnmanager",
    expected: [/resource 'fxsmoke_spawnmanager' \[client\] built/],
  },
];

/** Extra source folders from `LSMP_SMOKE_EXTRA` (separated like PATH): only a clean load is expected from them. */
function extraExamples(): SmokeExample[] {
  const list = process.env["LSMP_SMOKE_EXTRA"];
  if (list === undefined || list === "") return [];
  return list.split(delimiter).filter((p) => p !== "").map((source) => ({
    source: resolve(source),
    name: `fxsmoke_x_${basename(source).toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
    expected: [],
  }));
}

/** The unregistered gameserver notice and the default admin credentials banner are properties of the local install, not of the resources. */
const IGNORED_ERR: readonly RegExp[] = [/\[ERR\] \[lsmp:web\]/, /\[ERR\] \[admin\]/];

function killTree(pid: number): void {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(pid, "SIGKILL");
}

function cleanup(installed: readonly string[]): void {
  for (const name of installed) {
    rmSync(join(LSMP_DIR, "resources", name), { recursive: true, force: true });
    const storage = join(LSMP_DIR, "storage");
    if (existsSync(storage)) {
      for (const file of readdirSync(storage)) {
        if (file.startsWith(`${name}.`)) rmSync(join(storage, file), { force: true });
      }
    }
  }
}

/** Session logs carry the level tags (`[ERR]`) that the console output lacks. */
function newSessionLogs(since: number): string[] {
  const dir = join(LSMP_DIR, "logs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).mtimeMs >= since);
}

async function run(): Promise<number> {
  const examples: readonly SmokeExample[] = [...EXAMPLES, ...extraExamples()];
  const exe = join(LSMP_DIR, "lsmp-server", process.platform === "win32" ? "lsmp-server.exe" : "lsmp-server");
  if (!existsSync(exe)) {
    console.error(`lsmp:smoke: server not found at ${exe} (set LSMP_DIR)`);
    return 2;
  }
  const work = mkdtempSync(join(tmpdir(), "fxsmoke-"));
  const logPath = join(work, "server.log");
  const installed: string[] = [];
  let pid: number | undefined;
  const abort = (): void => {
    if (pid !== undefined) killTree(pid);
    cleanup(installed);
    process.exit(130);
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    for (const ex of examples) {
      const out = join(work, ex.name);
      const result = await convertResource({ resourceDir: resolve(ROOT, ex.source), outDir: out });
      if (result.warnings.length > 0) console.warn(`${ex.name}: ${result.warnings.length} conversion warnings`);
      const dest = join(LSMP_DIR, "resources", ex.name);
      installed.push(ex.name);
      cpSync(out, dest, { recursive: true });
    }
    const started = Date.now() - 1000;
    const fd = openSync(logPath, "w");
    const child = spawn(exe, [], { cwd: LSMP_DIR, stdio: ["ignore", fd, fd], windowsHide: true });
    closeSync(fd);
    pid = child.pid;
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        if (pid !== undefined) killTree(pid);
        done();
      }, RUN_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        done();
      });
    });
    if (pid !== undefined) killTree(pid);

    const sessionLogs = newSessionLogs(started);
    const log = [readFileSync(logPath, "utf8"), ...sessionLogs.map((f) => readFileSync(f, "utf8"))].join(String.fromCharCode(10));
    for (const f of sessionLogs) rmSync(f, { force: true });
    const lines = log.split(/\r?\n/);
    const problems: string[] = [];
    for (const line of lines) {
      if (line.includes("[ERR]") && !IGNORED_ERR.some((re) => re.test(line))) problems.push(`error line: ${line}`);
    }
    for (const ex of examples) {
      for (const re of ex.expected) {
        if (!lines.some((l) => re.test(l))) problems.push(`${ex.name}: missing log line ${re}`);
      }
    }
    mkdirSync(dirname(SMOKE_LOG), { recursive: true });
    writeFileSync(SMOKE_LOG, log);
    console.log(`lsmp:smoke: ${lines.length} log lines, ${problems.length} problems (log: ${SMOKE_LOG})`);
    for (const p of problems) console.log(`  ${p}`);
    return problems.length === 0 ? 0 : 1;
  } finally {
    if (pid !== undefined) killTree(pid);
    cleanup(installed);
    rmSync(work, { recursive: true, force: true });
  }
}

process.exitCode = await run();
