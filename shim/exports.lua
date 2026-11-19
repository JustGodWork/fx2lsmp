---@diagnostic disable: lowercase-global
do
  local lsmp <const> = lsmp
  local null <const> = FXC.null
  local isServer <const> = FXC.side == 'server'
  local decode = FXC.decode
  local decodeArgs = FXC.decodeArgs
  local MARK <const> = FXC.MARK
  local CALLBACK <const> = '__callback'
  local CALLBACK_WINDOW <const> = 512
  local OBJECT_CALL <const> = '__objcall'
  local OBJECT_METHOD <const> = '__objmethod'
  local mathType <const> = math.type
  local scan <const> = FXC.scan
  local SCAN_CLEAN <const>, SCAN_FUNCTIONS <const> = FXC.SCAN_CLEAN, FXC.SCAN_FUNCTIONS
  local encodeDirty <const> = FXC.encodeDirty
  local isVector <const> = FXC.isVector
  local OBJECT_WINDOW <const> = 512
  local MAX_DEPTH <const> = 32

  ---@param resource string
  ---@param name string
  ---@return string
  local function rpcName(resource, name) return 'export:' .. resource .. ':' .. name end

  -- FiveM exports have no deadline and ESX callbacks wait on fades and spawns: LS:MP's 10 s default cuts them.
  local EXPORT_TIMEOUT_MS <const> = 300000

  ---@type table<string, { name: string, timeoutMs: integer }>
  local callOptions <const> = {}

  ---@param resource string
  ---@param name string
  ---@return { name: string, timeoutMs: integer }
  local function callOptionsOf(resource, name)
    local rpc <const> = rpcName(resource, name)
    local opts = callOptions[rpc]
    if opts == nil then
      opts = { name = rpc, timeoutMs = EXPORT_TIMEOUT_MS }
      callOptions[rpc] = opts
    end
    return opts
  end

  ---@type fun(resource: string, name: string, fn: fun(...: any): ...)
  local register
  ---@type fun(resource: string, name: string, ...: any): ...
  local callExport

  ---@type table<integer, fun(...: any): ...>
  local callbacks = {}
  local nextCallback = 0
  local callbackRegistered = false

  --- A function passed to or returned by an export at the top level travels as { __fx = 'fn', r = resource, id = n }
  --- and is called back through the "__callback" export of its owner. Only the last CALLBACK_WINDOW stay callable.
  ---@param fn fun(...: any): ...
  ---@return table
  local function lift(fn)
    if not callbackRegistered then
      callbackRegistered = true
      register(FXC.resource, CALLBACK, function(id, ...)
        local target = callbacks[id]
        if target == nil then error('callback ' .. tostring(id) .. ' expired', 0) end
        return target(...)
      end)
    end
    nextCallback = nextCallback + 1
    callbacks[nextCallback] = fn
    callbacks[nextCallback - CALLBACK_WINDOW] = nil
    return { [MARK] = 'fn', r = FXC.resource, id = nextCallback }
  end

  -- A table holding functions at any depth travels as { __fx = 'obj', r = resource, id = n, d = data, f = paths }:
  -- d is a snapshot of the data fields, f lists the key path of every function. The caller rebuilds the table with
  -- one proxy per path, each calling the "__objcall" export of the owner, which finds the live function by id and path.
  -- Registered tables live in two generations: when OBJECT_WINDOW more tables get registered, the current generation
  -- becomes the old one and the old one is dropped. A table sent or called again moves back to the current generation.
  ---@type table<integer, table>
  local currentObjects, previousObjects = {}, {}
  local currentCount = 0
  ---@type table<table, integer>
  local objectIds = setmetatable({}, { __mode = 'k' })
  local nextObject = 0
  local objectCallRegistered = false

  ---@param id integer
  ---@param t table
  local function putObject(id, t)
    if currentCount >= OBJECT_WINDOW then
      previousObjects, currentObjects, currentCount = currentObjects, {}, 0
    end
    currentObjects[id] = t
    currentCount = currentCount + 1
  end

  ---@param id integer
  ---@return table?
  local function findObject(id)
    local t = currentObjects[id]
    if t ~= nil then return t end
    t = previousObjects[id]
    if t == nil then return nil end
    previousObjects[id] = nil
    putObject(id, t)
    return t
  end

  ---@param key any
  ---@return boolean
  local function isPathKey(key)
    return type(key) == 'string' or (mathType(key) == 'integer' and key >= 1)
  end

  --- Copy of t without its functions; their key paths are appended to paths. Class tables are walked too: their
  --- self reference (`Point.__index = Point`) is cut by `ancestors`.
  ---@param t table
  ---@param path (string|integer)[]
  ---@param depth integer
  ---@param paths (string|integer)[][]
  ---@param ancestors table<table, boolean>
  ---@return table
  local function split(t, path, depth, paths, ancestors)
    if depth > MAX_DEPTH then error('fxcompat: payload nested deeper than ' .. MAX_DEPTH, 0) end
    ancestors[t] = true
    local data = {}
    local total, ints, maxInt = 0, 0, 0
    for k, e in next, t do
      total = total + 1
      if mathType(k) == 'integer' and k >= 1 then
        ints = ints + 1
        if k > maxInt then maxInt = k end
      end
      local kind = type(e)
      if kind == 'function' then
        if isPathKey(k) then
          local own = table.move(path, 1, depth - 1, 1, {})
          own[depth] = k
          paths[#paths + 1] = own
        end
      elseif kind == 'table' and e ~= null and not isVector(e) and isPathKey(k) then
        if not ancestors[e] then
          path[depth] = k
          data[k] = split(e, path, depth + 1, paths, ancestors)
        end
      else
        data[k] = e
      end
    end
    ancestors[t] = nil
    -- A pure list stays a list on the wire: its function slots become null holes.
    if total > 0 and ints == total then
      for i = 1, maxInt do
        if data[i] == nil then data[i] = null end
      end
    end
    return data
  end

  ---@type (fun(fn: function, n: integer): string?)?
  local getlocal
  do
    local ok, found = pcall(function() return debug.getlocal end)
    if ok and type(found) == 'function' then getlocal = found end
  end

  --- nil when the first parameter cannot be inspected (sandbox without debug).
  ---@param method function
  ---@return boolean?
  local function takesSelf(method)
    if getlocal == nil then return nil end
    local ok, name = pcall(getlocal, method, 1)
    if not ok then
      -- a host that refuses it (LS:MP) logs every refused call: ask once
      getlocal = nil
      return nil
    end
    return name == 'self'
  end

  --- A colon call passes the container unless the method visibly has no `self` parameter (closure style methods
  --- ignore the receiver); a plain call passes it only to a method whose first parameter is named `self`.
  ---@param colon boolean
  ---@param id any
  ---@param path any
  ---@param ... any
  ---@return ...
  local function runMethod(colon, id, path, ...)
    local node = mathType(id) == 'integer' and findObject(id) or nil
    if node == nil then error('object ' .. tostring(id) .. ' expired', 0) end
    if type(path) ~= 'table' or #path == 0 then error('bad method path', 0) end
    local count = #path
    for i = 1, count - 1 do
      node = node[path[i]]
      if type(node) ~= 'table' then error('no such method', 0) end
    end
    local method = node[path[count]]
    if type(method) ~= 'function' then error('no such method', 0) end
    local selfParam = takesSelf(method)
    if selfParam == true or (colon and selfParam == nil) then return method(node, ...) end
    return method(...)
  end

  ---@param t table
  ---@return table
  local function liftObject(t)
    if not objectCallRegistered then
      objectCallRegistered = true
      register(FXC.resource, OBJECT_CALL, function(...) return runMethod(false, ...) end)
      register(FXC.resource, OBJECT_METHOD, function(...) return runMethod(true, ...) end)
    end
    local id = objectIds[t]
    if id == nil or findObject(id) ~= t then
      nextObject = nextObject + 1
      id = nextObject
      objectIds[t] = id
      putObject(id, t)
    end
    local paths = {}
    local data = split(t, {}, 1, paths, {})
    return { [MARK] = 'obj', r = FXC.resource, id = id, d = data, f = paths }
  end

  --- The value as it travels: one scan decides between sending it as is, rebuilding it, or lifting its functions.
  ---@param v any
  ---@return any
  local function prepareValue(v)
    local kind = type(v)
    if kind == 'function' then return encodeDirty(lift(v)) end
    if kind ~= 'table' and kind ~= 'thread' then return v end
    local state = scan(v)
    if state == SCAN_CLEAN then return v end
    if state == SCAN_FUNCTIONS then return encodeDirty(liftObject(v)) end
    return encodeDirty(v)
  end

  ---@param ... any
  ---@return ...
  local function prepareArgs(...)
    local n = select('#', ...)
    if n == 0 then return end
    if n == 1 then return prepareValue((...)) end
    if n == 2 then
      local a, b = ...
      return prepareValue(a), prepareValue(b)
    end
    local args = table.pack(...)
    for i = 1, n do args[i] = prepareValue(args[i]) end
    return table.unpack(args, 1, n)
  end
  FXC.prepareArgs = prepareArgs

  ---@param t table
  ---@return table
  local function shallowCopy(t)
    local out = {}
    for k, e in next, t do out[k] = e end
    return out
  end

  ---@type fun(v: any, depth: integer): any
  local unlift

  ---@param v table
  ---@param depth integer
  ---@return table
  local function rebuildObject(v, depth)
    local resource, id = v.r, v.id
    local obj = type(v.d) == 'table' and unlift(v.d, depth + 1) or {}
    local paths = type(v.f) == 'table' and v.f or {}
    for i = 1, #paths do
      local path = paths[i]
      local count = type(path) == 'table' and #path or 0
      if count > 0 then
        local container = obj
        for j = 1, count - 1 do
          local child = container[path[j]]
          if type(child) ~= 'table' then
            child = {}
            container[path[j]] = child
          end
          container = child
        end
        local owner = container
        container[path[count]] = function(...)
          if rawequal((...), owner) then return callExport(resource, OBJECT_METHOD, id, path, select(2, ...)) end
          return callExport(resource, OBJECT_CALL, id, path, ...)
        end
      end
    end
    return obj
  end

  function unlift(v, depth)
    if type(v) ~= 'table' or getmetatable(v) ~= nil then return v end
    local tag = v[MARK]
    if tag == 'fn' and type(v.r) == 'string' and math.type(v.id) == 'integer' then
      local resource, id = v.r, v.id
      return function(...) return callExport(resource, CALLBACK, id, ...) end
    end
    if tag == 'obj' and type(v.r) == 'string' and math.type(v.id) == 'integer' then return rebuildObject(v, depth) end
    if depth > MAX_DEPTH then return v end
    local out
    for k, e in next, v do
      local converted = unlift(e, depth + 1)
      if converted ~= e then
        if out == nil then out = shallowCopy(v) end
        out[k] = converted
      end
    end
    return out or v
  end

  ---@param ... any
  ---@return ...
  local function unliftArgs(...)
    local n = select('#', ...)
    local args = table.pack(...)
    local changed = false
    for i = 1, n do
      local v = args[i]
      local converted = unlift(v, 1)
      if converted ~= v then
        args[i] = converted
        changed = true
      end
    end
    if not changed then return ... end
    return table.unpack(args, 1, n)
  end

  ---@param n integer
  ---@param ... any
  ---@return any[]
  local function packResults(n, ...)
    local list = {}
    for i = 1, n do
      local v = (select(i, ...))
      if v ~= nil then v = prepareValue(v) end
      if v == nil then v = null end
      list[i] = v
    end
    return list
  end

  function register(resource, name, fn)
    local function handle(...) return fn(unliftArgs(decodeArgs(...))) end
    local function splitRun(invoker, ...) return FXC.runAs(invoker, handle, ...) end
    local function run(...)
      local out = table.pack(splitRun(FXC.splitInvoker(...)))
      return packResults(out.n, table.unpack(out, 1, out.n))
    end
    if isServer then
      lsmp.onCall(rpcName(resource, name), function(_, ...) return run(...) end)
    else
      lsmp.onCall(rpcName(resource, name), run)
    end
  end

  function callExport(resource, name, ...)
    local list, err = lsmp.call(callOptionsOf(resource, name), FXC.invokerMarker, prepareArgs(...))
    if err ~= nil then
      if err == 'no-handler' then
        error(("export '%s' of resource '%s' is not available"):format(name, resource), 3)
      end
      error(("export '%s:%s' failed: %s"):format(resource, name, tostring(err)), 3)
    end
    if list == nil then return end
    local count = #list
    return unliftArgs(table.unpack(decode(list), 1, count))
  end

  ---@type table<string, table>
  local proxies = {}

  ---@param resource string
  ---@return table
  local function proxyFor(resource)
    local proxy = proxies[resource]
    if proxy ~= nil then return proxy end
    proxy = setmetatable({}, {
      __index = function(self, name)
        -- FiveM drops the first argument: `exports.r:f(a)` and `exports.r.f(nil, a)` both send `a`. A non nil first
        -- argument of a dot call is kept, as lenient callers expect.
        return function(first, ...)
          if first == nil or rawequal(first, self) then return callExport(resource, name, ...) end
          return callExport(resource, name, first, ...)
        end
      end,
    })
    proxies[resource] = proxy
    return proxy
  end

  ---@class FxExports
  ---@overload fun(name: string, fn: fun(...: any): ...)
  ---@field [string] table
  exports = setmetatable({}, {
    __call = function(_, name, fn) register(FXC.resource, name, fn) end,
    __index = function(_, resource) return proxyFor(resource) end,
  })
end
