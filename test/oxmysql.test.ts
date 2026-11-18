import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convertResource } from "../tools/fx2lsmp/cli.ts";
import { World, type Vm } from "./harness.ts";

const MOCK_MYSQL = `
  MOCKDB = { log = {}, opts = nil }
  MOCKDB.handler = function() return {} end
  local function run(kind, sql, params)
    MOCKDB.log[#MOCKDB.log + 1] = { kind = kind, sql = sql, params = params }
    return MOCKDB.handler(sql, params)
  end
  local tx = { query = function(_, sql, params) return run('tx', sql, params) end }
  local pool = {}
  function pool:query(sql, params, cb)
    local result, err, details = run('query', sql, params)
    if cb then return cb(result, err, details) end
    return result, err, details
  end
  function pool:transaction(fn)
    MOCKDB.log[#MOCKDB.log + 1] = { kind = 'begin' }
    local ok, result = pcall(fn, tx)
    if ok then
      MOCKDB.log[#MOCKDB.log + 1] = { kind = 'commit' }
      return result
    end
    MOCKDB.log[#MOCKDB.log + 1] = { kind = 'rollback' }
    return nil, 'error', { message = tostring(result) }
  end
  lsmp.mysql = { createPool = function(opts) MOCKDB.opts = opts return pool end }
`;

interface Booted {
  world: World;
  db: Vm;
  app: Vm;
  warnings: string[];
  appManifest: { server_scripts: string[] };
  appLoader: string;
}

function convertedManifest(dir: string): { shared_scripts: string[]; server_scripts?: string[] } {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
}

async function boot(connection: string): Promise<Booted> {
  const root = mkdtempSync(join(tmpdir(), "fxox-"));
  const cfg = join(root, "server.cfg");
  writeFileSync(cfg, `set mysql_connection_string "${connection}"\n`);
  const dbDir = join(root, "oxmysql");
  await convertResource({ resourceDir: resolve(import.meta.dirname, "../compat/oxmysql"), outDir: dbDir, cfg });

  const appSrc = join(root, "src", "app");
  mkdirSync(appSrc, { recursive: true });
  writeFileSync(join(appSrc, "fxmanifest.lua"), "fx_version 'cerulean'\ngame 'gta5'\nserver_scripts { '@oxmysql/lib/MySQL.lua', 'server.lua' }\n");
  writeFileSync(join(appSrc, "server.lua"), "APP_LOADED = MySQL ~= nil\n");
  const appDir = join(root, "app");
  const converted = await convertResource({ resourceDir: appSrc, outDir: appDir });

  const world = await World.create({ resource: "oxmysql", clients: 1, peers: true });
  const dbManifest = convertedManifest(dbDir);
  for (const path of dbManifest.shared_scripts.slice(0, 2)) world.server.load(path, readFileSync(join(dbDir, path), "utf8"));
  provideConvars(world.server, dbDir);
  world.server.load("mock.lua", MOCK_MYSQL);
  for (const path of [...dbManifest.shared_scripts.slice(2), ...(dbManifest.server_scripts ?? [])]) {
    world.server.load(path, readFileSync(join(dbDir, path), "utf8"));
  }
  const lua = await world.addLua("app");
  const appManifest = convertedManifest(appDir);
  provideConvars(lua.server, appDir);
  for (const path of [...appManifest.shared_scripts, ...(appManifest.server_scripts ?? [])]) {
    lua.server.load(path, readFileSync(join(appDir, path), "utf8"));
  }
  await world.advance(60);
  return { world, db: world.server, app: lua.server, warnings: converted.warnings, appManifest: { server_scripts: appManifest.server_scripts ?? [] }, appLoader: readFileSync(join(appDir, "_fxcompat/run_server.lua"), "utf8") };
}

interface Logged {
  kind: string;
  sql?: string;
  params?: unknown[];
}

function provideConvars(vm: { setFile(path: string, content: string): void }, dir: string): void {
  const path = "_fxcompat/server_convars.json";
  if (existsSync(join(dir, path))) vm.setFile(path, readFileSync(join(dir, path), "utf8"));
}

let ctx: Booted;

const log = (): Promise<Logged[]> => ctx.db.eval<Logged[]>("return MOCKDB.log");
const reset = async (handler: string): Promise<void> => {
  await ctx.db.eval(`MOCKDB.log = {} MOCKDB.handler = ${handler} return true`);
};

beforeAll(async () => {
  ctx = await boot("mysql://root:p%40ss@db.local:3307/game?charset=utf8mb4_unicode_ci&connectionLimit=4");
});
afterAll(() => ctx.world.close());

describe("oxmysql compat: setup", () => {
  it("fx2lsmp replaces the cross-resource lib and warns about the unsandboxed requirement", () => {
    expect(ctx.appManifest.server_scripts).toEqual(["_fxcompat/run_server.lua"]);
    expect(ctx.appLoader).toContain("_fxcompat/libs/oxmysql/MySQL.lua");
    expect(ctx.warnings.some((w) => w.includes("@oxmysql/lib/MySQL.lua") && w.includes("unsandboxed"))).toBe(true);
  });

  it("builds the pool from a mysql:// URI", async () => {
    expect(await ctx.db.eval("return MOCKDB.opts")).toEqual({
      user: "root", password: "p@ss", host: "db.local", port: 3307, database: "game", connectionLimit: 4, charset: "utf8mb4",
    });
    expect(await ctx.app.eval("return APP_LOADED")).toBe(true);
  });

  it("builds the pool from a key=value string", async () => {
    const other = await boot("host=10.0.0.5;port=3306;user=fx;password=secret;database=rp;charset=latin1");
    try {
      expect(await other.db.eval("return MOCKDB.opts")).toEqual({
        user: "fx", password: "secret", host: "10.0.0.5", port: 3306, database: "rp", charset: "latin1",
      });
    } finally {
      other.world.close();
    }
  });
});

describe("oxmysql compat: queries", () => {
  it("query returns rows, with SQL NULL as nil, and sends ? parameters in order", async () => {
    await reset("function() return { { id = 1, name = lsmp.null, kept = 'x' }, { id = 2, name = 'b' } } end");
    const rows = await ctx.app.eval("return MySQL.query.await('SELECT * FROM t WHERE a = ? AND b = ?', { 5, 'x' })");
    expect(rows).toEqual([{ id: 1, kept: "x" }, { id: 2, name: "b" }]);
    expect(await log()).toEqual([{ kind: "query", sql: "SELECT * FROM t WHERE a = ? AND b = ?", params: [5, "x"] }]);
  });

  it("turns nil parameters into SQL NULL", async () => {
    await reset("function() return {} end");
    await ctx.app.eval("return MySQL.query.await('SELECT ?, ?, ?', { 1, nil, 3 })");
    expect((await log())[0]?.params).toEqual([1, null, 3]);
  });

  it("fills trailing nil parameters with SQL NULL up to the ? count, ignoring quoted marks", async () => {
    await reset("function() return {} end");
    await ctx.app.eval("return MySQL.query.await(\"SELECT ?, '?', ?, ? -- ?\", { 'a', nil, nil })");
    expect((await log())[0]?.params).toEqual(["a", null, null]);
  });

  it("rewrites @name and :name to ? outside quotes, comments and @@variables", async () => {
    await reset("function() return {} end");
    const sql = "SELECT * FROM t WHERE a = @a AND b = :b AND c = '@a ? :b' AND d = @@version /* @a */ AND e = @missing AND a2 = @a";
    await ctx.app.eval(`return MySQL.query.await("${sql}", { a = 1, ['@b'] = 'x' })`);
    expect(await log()).toEqual([
      { kind: "query", sql: "SELECT * FROM t WHERE a = ? AND b = ? AND c = '@a ? :b' AND d = @@version /* @a */ AND e = @missing AND a2 = ?", params: [1, "x", 1] },
    ]);
  });

  it("single, scalar, insert and update shape their results", async () => {
    await reset(`function(sql)
      if sql:find('^SELECT') then return { { total = 7, other = 3 }, { total = 8 } } end
      return { affectedRows = 4, insertId = 99, warningCount = 0 }
    end`);
    expect(await ctx.app.eval("return MySQL.single.await('SELECT 1')")).toEqual({ total: 7, other: 3 });
    expect(await ctx.app.eval("return MySQL.scalar.await('SELECT COUNT(*) AS total, x AS other FROM t')")).toBe(7);
    expect(await ctx.app.eval("return MySQL.scalar.await('SELECT t.total, other FROM t')")).toBe(7);
    expect(await ctx.app.eval("return MySQL.insert.await('INSERT INTO t VALUES (?)', { 1 })")).toBe(99);
    expect(await ctx.app.eval("return MySQL.update.await('UPDATE t SET a = ?', { 1 })")).toBe(4);
  });

  it("returns nil for single and scalar without a row", async () => {
    await reset("function() return {} end");
    expect(await ctx.app.eval("return { MySQL.single.await('SELECT 1') == nil, MySQL.scalar.await('SELECT 1') == nil }")).toEqual([true, true]);
  });

  it("prepare unpacks one value, one row or several rows", async () => {
    await reset(`function(sql)
      if sql == 'one' then return { { v = 5 } } end
      if sql == 'row' then return { { a = 1, b = 2 } } end
      if sql == 'none' then return {} end
      return { { a = 1 }, { a = 2 } }
    end`);
    expect(await ctx.app.eval("return MySQL.prepare.await('one')")).toBe(5);
    expect(await ctx.app.eval("return MySQL.prepare.await('row')")).toEqual({ a: 1, b: 2 });
    expect(await ctx.app.eval("return MySQL.prepare.await('none') == nil")).toBe(true);
    expect(await ctx.app.eval("return MySQL.prepare.await('many')")).toEqual([{ a: 1 }, { a: 2 }]);
    expect(await ctx.app.eval("return MySQL.prepare.await('one', { { 1 }, { 2 } })")).toEqual([5, 5]);
  });

  it("rawExecute runs one statement per parameter set", async () => {
    await reset("function() return { affectedRows = 1, insertId = 0, warningCount = 0 } end");
    const result = await ctx.app.eval("return MySQL.rawExecute.await('UPDATE t SET a = ?', { { 1 }, { 2 } })");
    expect(result).toEqual([
      { affectedRows: 1, insertId: 0, warningCount: 0 },
      { affectedRows: 1, insertId: 0, warningCount: 0 },
    ]);
    expect((await log()).map((e) => e.params)).toEqual([[1], [2]]);
  });

  it("raises the database error message from the await form", async () => {
    await reset("function() return nil, 'error', { errno = 1064, sqlState = '42000', message = 'syntax error' } end");
    const result = await ctx.app.eval("local ok, err = pcall(function() return MySQL.query.await('BAD') end) return { ok, err }");
    expect(result).toEqual([false, expect.stringContaining("syntax error")]);
  });
});

describe("oxmysql compat: callbacks and exports", () => {
  it("calls the callback of the MySQL global forms", async () => {
    await reset("function() return { { id = 1 } } end");
    await ctx.app.eval("MySQL.query('SELECT 1', function(rows) CB_ROWS = rows end) MySQL.Async.fetchScalar('SELECT 2', {}, function(v) CB_SCALAR = v end)");
    await ctx.world.advance(100);
    expect(await ctx.app.eval("return { CB_ROWS, CB_SCALAR }")).toEqual([[{ id: 1 }], 1]);
  });

  it("serves the raw exports in callback and _async forms", async () => {
    await reset("function() return { { id = 3 } } end");
    await ctx.app.eval("exports.oxmysql:query('SELECT 1', { 1 }, function(rows) EXPORT_ROWS = rows end)");
    await ctx.world.advance(100);
    expect(await ctx.app.eval("return EXPORT_ROWS")).toEqual([{ id: 3 }]);
    expect(await ctx.app.eval("return exports.oxmysql:query_async('SELECT 1', { 1 })")).toEqual([{ id: 3 }]);
    expect(await ctx.app.eval("return exports.oxmysql:single_async('SELECT 1')")).toEqual({ id: 3 });
    expect(await ctx.app.eval("return exports.oxmysql:isReady()")).toBe(true);
  });

  it("legacy Sync forms return directly", async () => {
    await reset("function() return { { n = 4 } } end");
    expect(await ctx.app.eval("return MySQL.Sync.fetchScalar('SELECT 4')")).toBe(4);
    expect(await ctx.app.eval("return MySQL.Sync.fetchAll('SELECT 4')")).toEqual([{ n: 4 }]);
  });
});

describe("oxmysql compat: transactions", () => {
  it("runs the list form (strings, {query, values}, {sql, values}) in one transaction", async () => {
    await reset("function() return { affectedRows = 1, insertId = 0, warningCount = 0 } end");
    const result = await ctx.app.eval(`return MySQL.transaction.await({
      'DELETE FROM a', { query = 'INSERT INTO b VALUES (?)', values = { 1 } }, { 'UPDATE c SET x = @x', { x = 2 } },
    })`);
    expect(result).toBe(true);
    expect((await log()).map((e) => e.kind)).toEqual(["begin", "tx", "tx", "tx", "commit"]);
    expect((await log()).map((e) => e.sql)).toEqual([undefined, "DELETE FROM a", "INSERT INTO b VALUES (?)", "UPDATE c SET x = ?", undefined]);
  });

  it("applies shared parameters to string entries and reports a rollback as false", async () => {
    await reset("function(sql) if sql:find('BAD') then return nil, 'error', { message = 'boom' } end return {} end");
    const ok = await ctx.app.eval("return MySQL.transaction.await({ 'SELECT ?', 'BAD ?' }, { 7 })");
    expect(ok).toBe(false);
    const entries = await log();
    expect(entries.map((e) => e.kind)).toEqual(["begin", "tx", "tx", "rollback"]);
    expect(entries[1]?.params).toEqual([7]);
  });

  it("startTransaction hands a query function to the callback and commits unless it returns false", async () => {
    await reset("function() return { { v = 1 } } end");
    const committed = await ctx.app.eval("return MySQL.startTransaction(function(query) local rows = query('SELECT ?', { 1 }) return rows ~= nil end)");
    expect(committed).toBe(true);
    expect((await log()).map((e) => e.kind)).toEqual(["begin", "tx", "commit"]);
    await reset("function() return {} end");
    expect(await ctx.app.eval("return MySQL.startTransaction(function(query) query('SELECT 1') return false end)")).toBe(false);
    expect((await log()).map((e) => e.kind)).toEqual(["begin", "tx", "rollback"]);
  });

  it("startTransaction returning false rolls back without logging an error", async () => {
    await reset("function() return {} end");
    const failures = (): number => [...ctx.db.logs(), ...ctx.app.logs()].filter((l) => l.includes("transaction failed")).length;
    const before = failures();
    await ctx.app.eval("return MySQL.startTransaction(function(query) query('SELECT 1') return false end)");
    expect(failures()).toBe(before);
  });
});

describe("oxmysql compat: errors", () => {
  it("raised nothing unexpected in any VM", () => {
    const errors = ctx.world.allErrors().filter((e) => !e.includes("syntax error") && !e.includes("boom") && !e.includes("rolled back"));
    expect(errors).toEqual([]);
  });
});

describe("oxmysql compat: MySQL.ready", () => {
  it("calls the callback and lets ready.await return inside a thread", async () => {
    await ctx.app.eval(`
      READY_CB, READY_AWAIT = false, false
      MySQL.ready(function() READY_CB = true end)
      CreateThread(function() MySQL.ready.await() READY_AWAIT = true end)
      return true
    `);
    await ctx.world.advance(60);
    expect(await ctx.app.eval("return { READY_CB, READY_AWAIT }")).toEqual([true, true]);
  });
});
