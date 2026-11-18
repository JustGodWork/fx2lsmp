---@alias OxParams any[]|table<string, any>
---@alias OxOperation fun(a: any, b: any): any

---@class OxPart
---@field name string
---@field raw string

local null <const> = lsmp.null
local RESOURCE <const> = 'oxmysql'
local COMPILED_LIMIT <const> = 512

---@type table<string, true>
local CHARSETS <const> = { utf8mb4 = true, utf8 = true, latin1 = true, binary = true }

---@type table<string, string>
local ALIASES <const> = {
  server = 'host', hostname = 'host', userid = 'user', uid = 'user', username = 'user', pwd = 'password',
  pass = 'password', db = 'database', dbname = 'database', initialcatalog = 'database',
  connectionlimit = 'connectionlimit', connecttimeout = 'connecttimeout',
}

---@param message string
---@return string
local function tag(message) return '[' .. RESOURCE .. '] ' .. message end

---@param text string
---@return string
local function urlDecode(text)
  return (text:gsub('%%(%x%x)', function(hex) return string.char(tonumber(hex, 16) or 63) end))
end

---@param settings table<string, string>
---@param key string
---@param value string
local function setting(settings, key, value)
  local name = key:lower():gsub('[%s_%-]', '')
  settings[ALIASES[name] or name] = value
end

--- `mysql://user:password@host:port/database?charset=utf8mb4&connectionLimit=4`
---@param text string
---@param settings table<string, string>
local function parseUri(text, settings)
  local rest = text:match('^mysql://(.*)$') or ''
  local main, query = rest:match('^([^?]*)%??(.*)$')
  local authority, path = main:match('^([^/]*)/?(.*)$')
  local credentials, hostPort = authority:match('^(.*)@(.*)$')
  if credentials == nil then hostPort = authority end
  if credentials ~= nil then
    local user, password = credentials:match('^([^:]*):?(.*)$')
    setting(settings, 'user', urlDecode(user))
    if password ~= '' then setting(settings, 'password', urlDecode(password)) end
  end
  local host, port = hostPort:match('^([^:]*):?(%d*)$')
  if host ~= nil and host ~= '' then setting(settings, 'host', host) end
  if port ~= nil and port ~= '' then setting(settings, 'port', port) end
  if path ~= '' then setting(settings, 'database', urlDecode(path)) end
  for key, value in query:gmatch('([^&=]+)=?([^&]*)') do setting(settings, key, urlDecode(value)) end
end

--- `host=127.0.0.1;port=3306;user=root;password=secret;database=game`
---@param text string
---@param settings table<string, string>
local function parseKeyValue(text, settings)
  for pair in text:gmatch('[^;]+') do
    local key, value = pair:match('^%s*([^=]-)%s*=%s*(.-)%s*$')
    if key ~= nil and key ~= '' then setting(settings, key, value) end
  end
end

---@param settings table<string, string>
---@return LsmpMysqlPoolOptions
local function toPoolOptions(settings)
  ---@type LsmpMysqlPoolOptions
  local opts = { user = settings.user or 'root' }
  opts.host = settings.host
  opts.port = math.tointeger(tonumber(settings.port))
  opts.password = settings.password
  opts.database = settings.database
  opts.connectionLimit = math.tointeger(tonumber(settings.connectionlimit))
  opts.connectTimeoutMs = math.tointeger(tonumber(settings.connecttimeout))
  local charset = settings.charset and settings.charset:lower():match('^[^_]+')
  if charset ~= nil and CHARSETS[charset] then
    opts.charset = charset
  elseif settings.charset ~= nil then
    lsmp.warn(('[%s] charset %s is not supported by LS:MP (utf8mb4, utf8, latin1, binary): default kept'):format(
      RESOURCE, settings.charset))
  end
  return opts
end

---@param connection string
---@return LsmpMysqlPoolOptions
local function parseConnection(connection)
  ---@type table<string, string>
  local settings = {}
  if connection:match('^mysql://') then parseUri(connection, settings) else parseKeyValue(connection, settings) end
  return toPoolOptions(settings)
end

---@type LsmpMysqlPool?
local pool

---@return LsmpMysqlPool?
local function openPool()
  local connection <const> = GetConvar('mysql_connection_string', '')
  if connection == '' then
    lsmp.warn(('[%s] convar mysql_connection_string is empty: queries will fail'):format(RESOURCE))
    return nil
  end
  local created, err = lsmp.mysql.createPool(parseConnection(connection))
  if created == nil then
    local hint = err == 'permission'
        and ' (the resource must be unsandboxed: "sandbox": false in resources.json)'
        or ''
    lsmp.error(('[%s] cannot create the pool: %s%s'):format(RESOURCE, tostring(err), hint))
  end
  return created
end

---@type table<string, (string|OxPart)[]>
local compiled = {}
---@type table<string, integer>
local compiledMarks = {}
local compiledCount = 0

---@param sql string
---@param from integer
---@param quote string
---@return integer next index after the closing quote
local function skipQuoted(sql, from, quote)
  local i, n = from + 1, #sql
  while i <= n do
    local c = sql:sub(i, i)
    if c == '\\' and quote ~= '`' then
      i = i + 2
    elseif c == quote then
      if sql:sub(i + 1, i + 1) == quote then i = i + 2 else return i + 1 end
    else
      i = i + 1
    end
  end
  return n + 1
end

--- Splits the SQL into literal text and `@name` / `:name` candidates, leaving quotes and comments alone; counts the `?`
--- marks into compiledMarks.
---@param sql string
---@return (string|OxPart)[]
local function compile(sql)
  local cached = compiled[sql]
  if cached ~= nil then return cached end
  ---@type (string|OxPart)[]
  local parts = {}
  local start, i, n, marks = 1, 1, #sql, 0
  while i <= n do
    local c = sql:sub(i, i)
    if c == "'" or c == '"' or c == '`' then
      i = skipQuoted(sql, i, c)
    elseif c == '#' or (c == '-' and sql:sub(i, i + 1) == '--') then
      local stop = sql:find('\n', i, true)
      i = stop and stop + 1 or n + 1
    elseif c == '/' and sql:sub(i + 1, i + 1) == '*' then
      local _, stop = sql:find('*/', i + 2, true)
      i = stop and stop + 1 or n + 1
    elseif c == '?' then
      marks = marks + 1
      i = i + 1
    elseif c == '@' or c == ':' then
      local name = sql:match('^[%w_]+', i + 1)
      local previous = i > 1 and sql:sub(i - 1, i - 1) or ''
      if name ~= nil and not previous:match('[%w_@:]') then
        if i > start then parts[#parts + 1] = sql:sub(start, i - 1) end
        parts[#parts + 1] = { name = name, raw = sql:sub(i, i + #name) }
        start = i + #name + 1
        i = start
      else
        i = i + 1
      end
    else
      i = i + 1
    end
  end
  if start <= n then parts[#parts + 1] = sql:sub(start) end
  if compiledCount >= COMPILED_LIMIT then compiled, compiledMarks, compiledCount = {}, {}, 0 end
  compiled[sql] = parts
  compiledMarks[sql] = marks
  compiledCount = compiledCount + 1
  return parts
end

---@param params table
---@return boolean
local function isNamed(params)
  for key in next, params do
    if type(key) == 'string' then return true end
  end
  return false
end

--- `@name` and `:name` become `?` when params has the key (with or without its prefix); the rest stays as written.
---@param sql string
---@param params OxParams
---@return string, any[]
local function bindNamed(sql, params)
  local out, values = {}, {}
  for _, part in ipairs(compile(sql)) do
    if type(part) == 'string' then
      out[#out + 1] = part
    else
      local value = params[part.name]
      if value == nil then value = params['@' .. part.name] end
      if value == nil then value = params[':' .. part.name] end
      if value == nil then
        out[#out + 1] = part.raw
      else
        out[#out + 1] = '?'
        values[#values + 1] = value
      end
    end
  end
  return table.concat(out), values
end

---@param sql any
---@param params any
---@return string, any[]
local function bind(sql, params)
  if type(sql) ~= 'string' then error(tag('the query must be a string, got ' .. type(sql)), 0) end
  if params == nil then return sql, {} end
  if type(params) ~= 'table' then return sql, { params } end
  if isNamed(params) then return bindNamed(sql, params) end
  compile(sql)
  -- Trailing nils are lost over the export boundary: missing values become NULL, as oxmysql does.
  local top = compiledMarks[sql] or 0
  for key in next, params do
    if math.type(key) == 'integer' and key > top then top = key end
  end
  local values = {}
  for i = 1, top do
    local value = params[i]
    if value == nil then value = null end
    values[i] = value
  end
  return sql, values
end

---@param err string?
---@param details LsmpMysqlError?
---@return string
local function describe(err, details)
  if details ~= nil and details.message ~= nil then
    if details.errno == nil and details.sqlState == nil then return details.message end
    return ('%s (errno %s, %s)'):format(details.message, tostring(details.errno), tostring(details.sqlState))
  end
  return tostring(err)
end

---@param sql any
---@param params any
---@return LsmpMysqlResult
local function execute(sql, params)
  if pool == nil then error(tag('no database connection: check mysql_connection_string and that the resource is unsandboxed'), 0) end
  local text, values = bind(sql, params)
  local result, err, details = pool:query(text, values)
  if result == nil then error(tag(describe(err, details) .. ' [' .. text .. ']'), 0) end
  return result
end

---@param result LsmpMysqlResult
---@return boolean
local function isSummary(result) return result[1] == nil and type(result.affectedRows) == 'number' end

---@param row LsmpMysqlRow
---@return LsmpMysqlRow
local function clean(row)
  for key, value in next, row do
    if value == null then row[key] = nil end
  end
  return row
end

---@param rows LsmpMysqlRow[]
---@return LsmpMysqlRow[]
local function cleanRows(rows)
  for i = 1, #rows do clean(rows[i]) end
  return rows
end

---@param result LsmpMysqlResult
---@return LsmpMysqlResult
local function shape(result)
  if isSummary(result) then return result end
  ---@cast result LsmpMysqlRow[]
  return cleanRows(result)
end

--- Name of the first selected column when it can be read from the SQL (the row table has no column order).
---@param sql string
---@return string?
local function firstSelectedName(sql)
  local rest = sql:match('^%s*[Ss][Ee][Ll][Ee][Cc][Tt]%s+(.*)$')
  if rest == nil then return nil end
  local depth, i, n = 0, 1, #rest
  while i <= n do
    local c = rest:sub(i, i)
    if c == "'" or c == '"' or c == '`' then
      i = skipQuoted(rest, i, c) - 1
    elseif c == '(' then
      depth = depth + 1
    elseif c == ')' then
      depth = depth - 1
    elseif depth == 0 and (c == ',' or (c:match('%s') and rest:sub(i + 1):match('^[Ff][Rr][Oo][Mm]%f[%W]'))) then
      break
    end
    i = i + 1
  end
  local expression = rest:sub(1, i - 1)
  local name = expression:match('[Aa][Ss]%s+`?([%w_]+)`?%s*$')
      or expression:match('^%s*`?[%w_]+`?%.`?([%w_]+)`?%s*$')
      or expression:match('^%s*`?([%w_]+)`?%s*$')
  return name
end

local ambiguousWarned = false

---@param sql string
---@param row LsmpMysqlRow
---@return any
local function firstColumn(sql, row)
  local key, value = next(row)
  if key ~= nil and next(row, key) ~= nil then
    local name = firstSelectedName(sql)
    if name ~= nil and row[name] ~= nil then
      value = row[name]
    elseif not ambiguousWarned then
      ambiguousWarned = true
      lsmp.warn(('[%s] scalar on several columns: LS:MP rows have no column order, select one column'):format(RESOURCE))
    end
  end
  if value == null then return nil end
  return value
end

---@type table<string, OxOperation>
local ops = {}

---@param sql string
---@param params any
---@return any
function ops.query(sql, params) return shape(execute(sql, params)) end

---@param sql string
---@param params any
---@return any
function ops.single(sql, params)
  local result = execute(sql, params)
  if isSummary(result) then return nil end
  local row = result[1]
  if row == nil then return nil end
  return clean(row)
end

---@param sql string
---@param params any
---@return any
function ops.scalar(sql, params)
  local result = execute(sql, params)
  if isSummary(result) then return nil end
  local row = result[1]
  if row == nil then return nil end
  return firstColumn(sql, row)
end

---@param sql string
---@param params any
---@return any
function ops.insert(sql, params)
  local result = execute(sql, params)
  if isSummary(result) then return result.insertId end
  return nil
end

---@param sql string
---@param params any
---@return any
function ops.update(sql, params)
  local result = execute(sql, params)
  if isSummary(result) then return result.affectedRows end
  return nil
end

--- One row of one column gives the value, one row gives the row, several rows give the rows, none gives nil.
---@param sql string
---@param params any
---@return any
local function prepared(sql, params)
  local result = execute(sql, params)
  if isSummary(result) then return result end
  ---@cast result LsmpMysqlRow[]
  local rows = result
  if #rows == 0 then return nil end
  if #rows > 1 then return cleanRows(rows) end
  local row = rows[1]
  local key = next(row)
  if key ~= nil and next(row, key) == nil then return firstColumn(sql, row) end
  return clean(row)
end

---@param sql string
---@param params any
---@return any
function ops.prepare(sql, params)
  if type(params) == 'table' and type(params[1]) == 'table' then
    local results = {}
    for i = 1, #params do results[i] = prepared(sql, params[i]) end
    return results
  end
  return prepared(sql, params)
end

---@param sql string
---@param params any
---@return any
function ops.rawExecute(sql, params)
  if type(params) == 'table' and type(params[1]) == 'table' then
    local results = {}
    for i = 1, #params do results[i] = shape(execute(sql, params[i])) end
    return results
  end
  return shape(execute(sql, params))
end

---@param entry any
---@param shared any
---@return string, any
local function transactionEntry(entry, shared)
  if type(entry) == 'string' then return entry, shared end
  if type(entry) ~= 'table' then error(tag('a transaction entry must be a string or a table'), 0) end
  if entry.query ~= nil then return entry.query, entry.values or entry.parameters or shared end
  return entry[1], entry[2] or shared
end

--- Returns true when every statement ran and the transaction was committed.
---@param queries any
---@param params any
---@return boolean
function ops.transaction(queries, params)
  if pool == nil then error(tag('no database connection'), 0) end
  if type(queries) ~= 'table' then error(tag('transaction expects a list of queries'), 0) end
  local ok, result, err = pcall(function()
    return pool:transaction(function(tx)
      for i = 1, #queries do
        local sql, values = transactionEntry(queries[i], params)
        local text, bound = bind(sql, values)
        local rows, queryErr, details = tx:query(text, bound)
        if rows == nil then error(tag(describe(queryErr, details) .. ' [' .. text .. ']'), 0) end
      end
      return true
    end)
  end)
  if not ok then
    lsmp.error(tostring(result))
    return false
  end
  if err ~= nil then lsmp.error(('[%s] transaction failed: %s'):format(RESOURCE, tostring(err))) end
  return result == true
end

--- fn receives a query function; the transaction commits unless fn returns false or raises.
---@param fn any
---@return boolean
function ops.startTransaction(fn)
  if pool == nil then error(tag('no database connection'), 0) end
  if type(fn) ~= 'function' then error(tag('startTransaction expects a function'), 0) end
  local declined = false
  local ok, result, err = pcall(function()
    return pool:transaction(function(tx)
      local outcome = fn(function(sql, params)
        local text, values = bind(sql, params)
        local rows, queryErr, details = tx:query(text, values)
        if rows == nil then error(tag(describe(queryErr, details) .. ' [' .. text .. ']'), 0) end
        return shape(rows)
      end)
      if outcome == false then
        declined = true
        error('rolled back', 0)
      end
      return true
    end)
  end)
  if not ok then
    lsmp.error(tostring(result))
    return false
  end
  if err ~= nil and not declined then lsmp.error(('[%s] transaction failed: %s'):format(RESOURCE, tostring(err))) end
  return result == true
end

pool = openPool()

for name, op in pairs(ops) do
  exports(name, function(a, b, cb)
    if type(b) == 'function' then a, b, cb = a, nil, b end
    if type(cb) ~= 'function' then return op(a, b) end
    CreateThread(function()
      local ok, result = pcall(op, a, b)
      if ok then return cb(result) end
      lsmp.error(tostring(result))
      cb(nil)
    end)
  end)
  exports(name .. '_async', function(a, b) return op(a, b) end)
end

exports('isReady', function() return pool ~= nil end)
exports('awaitConnection', function() return pool ~= nil end)

--- Used by lib/MySQL.lua: an error comes back as a value so its message survives the call.
exports('__await', function(method, a, b)
  local op = ops[method]
  if op == nil then return false, 'unknown method ' .. tostring(method) end
  local ok, result = pcall(op, a, b)
  if ok then return true, result end
  return false, tostring(result)
end)
