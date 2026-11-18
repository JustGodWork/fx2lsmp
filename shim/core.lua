---@class FxCompat
---@field side 'client'|'server'
---@field resource string
---@field pendingConnections table<integer, FxPendingConnection>
---@field null any
---@field MARK string
---@field SERVER_SOURCE integer
---@field encode fun(value: any): any
---@field decode fun(value: any): any
---@field encodeArgs fun(...: any): ...
---@field scan fun(value: any): integer
---@field encodeDirty fun(value: any): any
---@field SCAN_CLEAN integer
---@field SCAN_DIRTY integer
---@field SCAN_FUNCTIONS integer
---@field liftArgs fun(...: any): ...
---@field prepareArgs fun(...: any): ...
---@field invokerMarker table<string, string>
---@field splitInvoker fun(...: any): string?, ...
---@field runAs fun(invoker: string?, fn: function, ...: any): ...
---@field decodeArgs fun(...: any): ...
---@field toJson fun(value: any): any
---@field fromJson fun(value: any): any
---@field warnOnce fun(key: string, message: string)
---@field TEMP_ID_FIRST integer
---@field toLsmp fun(value: any): integer?
---@field toFiveM fun(id: integer): integer
---@field guestLicense fun(hwid: string?): string?
---@field noteCommand fun(name: string)
---@field promiseDeps FxPromiseDeps
---@field promiseLib FxPromiseModule
---@field debug FxDebug
---@field registerModule fun(path: string, hash: string, factory: FxModuleFactory)
---@field registry fun(file: string): fun(path: string, hash: string, factory: FxModuleFactory, firstLine?: integer)
---@field moduleHash fun(text: string): string
---@field script fun(file: string, path: string, hash: string, factory: FxModuleFactory, firstLine: integer)
---@field run fun(file: string)
---@field vector2 fun(x?: number, y?: number): FxVector2
---@field vector4 fun(x?: number, y?: number, z?: number, w?: number): FxVector4
---@field isVector fun(t: table): boolean
local FXC <const> = {}

---@alias FxLoad fun(chunk: string, chunkname?: string, mode?: string, env?: table): (fun(...: any): ...)?, string?
---@alias FxModuleFactory fun(env: table): fun(...: any): ...

--- Empty operand of the `a?.b` form the transpiler emits: reading a field of it gives nil.
---@type table<string, nil>
__fxc_nil = setmetatable({}, { __newindex = function() end })

---@class FxPromiseDeps
---@field SetTimeout fun(ms: integer, fn: fun())
---@field ClearTimeout fun(id: integer)
---@field Await fun(p: FxPromise)
---@field CreateThreadNow fun(fn: fun(...: any), ...: any)
---@field trace fun(text: string)
---@field config { debug: boolean }

---@class FxPromise
---@field state integer
---@field value any
---@field resolve fun(self: FxPromise, ...: any): FxPromise
---@field reject fun(self: FxPromise, reason: any): FxPromise
---@field next fun(self: FxPromise, onOk?: (fun(...: any): any), onErr?: (fun(reason: any): any)): FxPromise
---@field catch fun(self: FxPromise, onErr: fun(reason: any): any): FxPromise
---@field finally fun(self: FxPromise, fn: fun(): any): FxPromise
---@field await fun(self: FxPromise): ...

---@class FxPromiseLib
---@field new fun(executor?: fun(resolve: fun(...: any), reject: fun(reason: any))): FxPromise
---@field resolve fun(...: any): FxPromise
---@field reject fun(reason: any): FxPromise
---@field all fun(list: any[]): FxPromise
---@field allSettled fun(list: any[]): FxPromise
---@field race fun(list: any[]): FxPromise
---@field any fun(list: any[]): FxPromise
---@field delay fun(ms?: integer, ...: any): FxPromise

---@class FxPromiseModule
---@field Promise FxPromiseLib
---@field async fun(fn: fun(...: any): ...): fun(...: any): FxPromise
---@field await fun(x: any): ...

---@class FxDebug
---@field traceback fun(message?: string, level?: integer): string

---@class FxVector2
---@field x number
---@field y number

---@class FxVector4
---@field x number
---@field y number
---@field z number
---@field w number

---@class FxCitizen
---@field CreateThread fun(fn: fun(...: any), ...: any)
---@field CreateThreadNow fun(fn: fun(...: any), ...: any)
---@field Wait fun(ms?: integer)
---@field SetTimeout fun(ms: integer, fn: fun()): integer
---@field ClearTimeout fun(id: integer)
---@field Trace fun(text: string)
---@field Await fun(p: any): ...
---@field InvokeNative fun(hash: integer|string, ...: any): ...

---@class FxConfig
---@field uiPage string?
---@field kvpPage string?
---@field b1Workarounds boolean?
---@field applyEntities boolean?
---@field convars table<string, string>
---@field metadata table<string, string[]>?
---@field natives string[]? FiveM native names the client code uses, defined up front when the _G metatable is protected
---@field chatBridge boolean?
---@field expose boolean?

---@type FxConfig
FXCOMPAT_CONFIG = FXCOMPAT_CONFIG or { convars = {} }

---@diagnostic disable: lowercase-global
do
  local lsmp <const> = lsmp
  local onLsmp <const> = lsmp ~= nil
  local null <const> = lsmp.null
  local type, next, getmetatable, setmetatable, select = type, next, getmetatable, setmetatable, select
  local mathType = math.type

  if lsmp.emitServer ~= nil then
    FXC.side = 'client'
  elseif lsmp.emitClient ~= nil then
    FXC.side = 'server'
  else
    error('fxcompat: neither lsmp.emitServer nor lsmp.emitClient exists', 0)
  end
  FXC.resource = lsmp.getResourceName()
  if FXCOMPAT_CONFIG.expose then _G.__fxc = FXC end
  FXC.null = null
  FXC.SERVER_SOURCE = 65535

  local MARK <const> = '__fx'
  local MAX_DEPTH <const> = 32
  FXC.MARK = MARK

  local warned = {}
  ---@param key string
  ---@param message string
  function FXC.warnOnce(key, message)
    if warned[key] then return end
    warned[key] = true
    lsmp.warn('[fxcompat] ' .. message)
  end

  FXC.TEMP_ID_FIRST = 65536

  --- FiveM-visible player id (number or numeric string) to LS:MP id. FiveM ids are LS:MP ids + 1: 0 is the console and
  --- never a player. -1 (everyone) and the temporary playerConnecting ids (65536 and up) pass through unchanged.
  ---@param value any
  ---@return integer?
  function FXC.toLsmp(value)
    local n <const> = math.tointeger(tonumber(value))
    if n == nil then return nil end
    if n == -1 or n >= FXC.TEMP_ID_FIRST then return n end
    if n < 1 then return nil end
    return n - 1
  end

  ---@param id integer
  ---@return integer
  function FXC.toFiveM(id)
    if id >= FXC.TEMP_ID_FIRST then return id end
    return id + 1
  end

  --- Accounts get their `license:` from LS:MP; a guest gets a stable one derived from the hardware id.
  ---@param hwid string?
  ---@return string?
  function FXC.guestLicense(hwid)
    if hwid == nil or hwid == '' then return nil end
    return string.format('license:hwid-%x', lsmp.hash(hwid) & 0xFFFFFFFF)
  end

  ---@param name string
  ---@param keys string[]
  ---@return table metatable
  ---@return fun(...: number): table constructor
  local function vectorType(name, keys)
    local count = #keys
    local mt = { __name = name }
    local function make(...)
      local v = {}
      for i = 1, count do v[keys[i]] = ((select(i, ...)) or 0) + 0.0 end
      return setmetatable(v, mt)
    end
    local function zip(a, b, op)
      local r = {}
      for i = 1, count do
        local k = keys[i]
        local av, bv = a, b
        if type(a) == 'table' then av = a[k] end
        if type(b) == 'table' then bv = b[k] end
        r[k] = op(av, bv)
      end
      return setmetatable(r, mt)
    end
    local function add(x, y) return x + y end
    local function sub(x, y) return x - y end
    local function mul(x, y) return x * y end
    local function div(x, y) return x / y end
    mt.__add = function(a, b) return zip(a, b, add) end
    mt.__sub = function(a, b) return zip(a, b, sub) end
    mt.__mul = function(a, b) return zip(a, b, mul) end
    mt.__div = function(a, b) return zip(a, b, div) end
    mt.__unm = function(a) return zip(a, 0, function(x) return -x end) end
    mt.__len = function(a)
      local sum = 0.0
      for i = 1, count do sum = sum + a[keys[i]] ^ 2 end
      return math.sqrt(sum)
    end
    mt.__eq = function(a, b)
      for i = 1, count do
        if a[keys[i]] ~= b[keys[i]] then return false end
      end
      return true
    end
    mt.__tostring = function(a)
      local parts = {}
      for i = 1, count do parts[i] = tostring(a[keys[i]]) end
      return name .. '(' .. table.concat(parts, ', ') .. ')'
    end
    return mt, make
  end

  local vec2mt, vec2 = vectorType('vector2', { 'x', 'y' })
  local vec4mt, vec4 = vectorType('vector4', { 'x', 'y', 'z', 'w' })
  local quatmt, quat = vectorType('quat', { 'x', 'y', 'z', 'w' })
  FXC.vector2, FXC.vector4 = vec2, vec4

  ---@type table<table, string[]>
  local FLAT_VECTORS <const> = {
    [vec2mt] = { 'x', 'y' }, [vec4mt] = { 'x', 'y', 'z', 'w' }, [quatmt] = { 'x', 'y', 'z', 'w' },
  }
  -- Wire form { __fx = tag, x = .., y = .. [, z, w] }: the tags are part of the language-neutral protocol.
  ---@type table<table, string>
  local FLAT_TAGS <const> = { [vec2mt] = 'v2', [vec4mt] = 'v4', [quatmt] = 'q' }
  ---@type table<string, fun(v: table): table>
  local FLAT_BUILDERS <const> = {
    v2 = function(v) return vec2(v.x, v.y) end,
    v4 = function(v) return vec4(v.x, v.y, v.z, v.w) end,
    q = function(v) return quat(v.x, v.y, v.z, v.w) end,
  }

  ---@type table?
  local vec3mt
  ---@type fun(x?: number, y?: number, z?: number): any
  local vec3
  if type(Vector3) == 'function' then
    vec3 = Vector3
    local sample = Vector3(0, 0, 0)
    -- the engine vector has its own type name; only a table based vector needs the metatable check
    if type(sample) == 'table' then vec3mt = getmetatable(sample) end
  else
    local make
    vec3mt, make = vectorType('vector3', { 'x', 'y', 'z' })
    vec3 = make
  end

  ---@param t table
  ---@return boolean
  function FXC.isVector(t)
    local mt <const> = getmetatable(t)
    return mt ~= nil and (mt == vec3mt or FLAT_VECTORS[mt] ~= nil)
  end

  vector3, vector2, vector4 = vec3, vec2, vec4
  quaternion = quat
  _G.vec2, _G.vec3, _G.vec4, _G.quat = vec2, vec3, vec4, quat

  --- CfxLua unpacks a vector into its components (`{ table.unpack(GetEntityCoords(ped)) }`); LS:MP raises on its Vector3.
  do
    local unpack <const> = table.unpack
    ---@type table<table, string[]>
    local components <const> = {}
    if vec3mt ~= nil then components[vec3mt] = { 'x', 'y', 'z' } end
    for mt, keys in pairs(FLAT_VECTORS) do components[mt] = keys end
    ---@param t any
    ---@param i? integer
    ---@param j? integer
    ---@return any ...
    local function unpackVector(t, i, j)
      local kind = type(t)
      if kind == 'vector3' then return t.x, t.y, t.z end
      if kind == 'table' then
        local mt = getmetatable(t)
        local keys = mt ~= nil and components[mt] or nil
        if keys ~= nil then return unpack({ t[keys[1]], t[keys[2]], t[keys[3]], t[keys[4]] }, 1, #keys) end
      end
      return unpack(t, i, j)
    end
    local ok = pcall(function() table.unpack = unpackVector end)
    if not ok then FXC.warnOnce('unpack', 'table.unpack is read only: unpacking a vector raises') end
  end

  --- Helpers FiveM's Lua runtime adds to the standard libraries (ESX and ox_lib code calls them).
  if table.wipe == nil then
    ---@param t table
    ---@return table
    local function wipe(t)
      for key in next, t do t[key] = nil end
      return t
    end
    if not pcall(function() table.wipe = wipe end) then FXC.warnOnce('wipe', 'table.wipe could not be defined') end
  end

  if string.strsplit == nil then
    --- WoW style split: every character of `delimiter` separates, empty pieces are kept, `pieces` caps the count.
    ---@param delimiter string
    ---@param text string
    ---@param pieces? integer
    ---@return string ...
    local function strsplit(delimiter, text, pieces)
      if delimiter == '' then return text end
      local out <const> = {}
      local set <const> = '[' .. string.gsub(delimiter, '[%^%]%-%%]', '%%%0') .. ']'
      local start = 1
      while pieces == nil or #out < pieces - 1 do
        local at <const> = string.find(text, set, start)
        if at == nil then break end
        out[#out + 1] = string.sub(text, start, at - 1)
        start = at + 1
      end
      out[#out + 1] = string.sub(text, start)
      return table.unpack(out)
    end
    if not pcall(function() string.strsplit = strsplit end) then FXC.warnOnce('strsplit', 'string.strsplit could not be defined') end
  end

  ---@param t table
  ---@param checkMark boolean
  ---@return 'empty'|'list'|'map'|'other' kind
  ---@return integer count
  local function classify(t, checkMark)
    local total, ints, strs, maxInt = 0, 0, 0, 0
    for k in next, t do
      total = total + 1
      if type(k) == 'string' then
        if checkMark and k == MARK then return 'other', 0 end
        strs = strs + 1
      elseif mathType(k) == 'integer' and k >= 1 then
        ints = ints + 1
        if k > maxInt then maxInt = k end
      end
    end
    if total == 0 then return 'empty', 0 end
    if strs == total then return 'map', total end
    if ints == total and maxInt == total then return 'list', total end
    return 'other', total
  end

  ---@param v any
  ---@param depth integer
  ---@param json boolean
  ---@return boolean
  local function isClean(v, depth, json)
    if v == null then return true end
    local tv = type(v)
    if tv == 'function' or tv == 'thread' then return false end
    if tv ~= 'table' then return true end
    if depth > MAX_DEPTH then error('fxcompat: payload nested deeper than ' .. MAX_DEPTH, 0) end
    local mt = getmetatable(v)
    if mt ~= nil then return mt == vec3mt end
    local kind = classify(v, not json)
    if kind == 'empty' then return true end
    if kind ~= 'list' and kind ~= 'map' then return false end
    for _, e in next, v do
      if not isClean(e, depth + 1, json) then return false end
    end
    return true
  end

  local SCAN_CLEAN <const>, SCAN_DIRTY <const>, SCAN_FUNCTIONS <const> = 0, 1, 2
  FXC.SCAN_CLEAN, FXC.SCAN_DIRTY, FXC.SCAN_FUNCTIONS = SCAN_CLEAN, SCAN_DIRTY, SCAN_FUNCTIONS

  --- One read only traversal: SCAN_FUNCTIONS as soon as a function sits in a plain table, else SCAN_DIRTY when the
  --- value needs a rebuild to travel, else SCAN_CLEAN.
  ---@param v any
  ---@param depth integer
  ---@return integer
  local function scan(v, depth)
    if v == null then return SCAN_CLEAN end
    local tv = type(v)
    if tv == 'function' then return SCAN_FUNCTIONS end
    if tv == 'thread' then return SCAN_DIRTY end
    if tv ~= 'table' then return SCAN_CLEAN end
    if depth > MAX_DEPTH then error('fxcompat: payload nested deeper than ' .. MAX_DEPTH, 0) end
    local mt = getmetatable(v)
    if mt ~= nil then return mt == vec3mt and SCAN_CLEAN or SCAN_DIRTY end
    local total, ints, strs, maxInt = 0, 0, 0, 0
    local state = SCAN_CLEAN
    for k, e in next, v do
      total = total + 1
      if type(k) == 'string' then
        if k == MARK then state = SCAN_DIRTY end
        strs = strs + 1
      elseif mathType(k) == 'integer' and k >= 1 then
        ints = ints + 1
        if k > maxInt then maxInt = k end
      end
      if e ~= null then
        local te = type(e)
        if te == 'function' then return SCAN_FUNCTIONS end
        if te == 'table' or te == 'thread' then
          local sub = scan(e, depth + 1)
          if sub == SCAN_FUNCTIONS then return SCAN_FUNCTIONS end
          if sub == SCAN_DIRTY then state = SCAN_DIRTY end
        end
      end
    end
    if state == SCAN_CLEAN and total > 0 and strs ~= total and (ints ~= total or maxInt ~= total) then
      return SCAN_DIRTY
    end
    return state
  end
  FXC.scan = function(v) return scan(v, 1) end

  ---@param v any
  ---@param depth integer
  ---@return any
  local function build(v, depth)
    if v == null then return v end
    local tv = type(v)
    if tv == 'function' then
      FXC.warnOnce('function', 'a function inside a payload cannot be transported and was dropped')
      return nil
    end
    if tv == 'thread' then return nil end
    if tv ~= 'table' then return v end
    if depth > MAX_DEPTH then error('fxcompat: payload nested deeper than ' .. MAX_DEPTH, 0) end
    local mt = getmetatable(v)
    if vec3mt ~= nil and mt == vec3mt then return v end
    local flat = mt ~= nil and FLAT_VECTORS[mt] or nil
    if flat ~= nil then
      local r = { [MARK] = FLAT_TAGS[mt] }
      for i = 1, #flat do r[flat[i]] = v[flat[i]] end
      return r
    end
    local kind, total = classify(v, true)
    if kind == 'empty' then return v end
    if kind == 'list' then
      local out = {}
      for i = 1, total do
        local c = build(v[i], depth + 1)
        if c == nil then c = null end
        out[i] = c
      end
      return out
    end
    if kind == 'map' then
      local out = {}
      for k, e in next, v do
        local c = build(e, depth + 1)
        if c ~= nil then out[k] = c end
      end
      return out
    end
    local keys, vals, n = {}, {}, 0
    for k, e in next, v do
      local tk = type(k)
      if tk == 'string' or tk == 'number' or tk == 'boolean' then
        local c = build(e, depth + 1)
        if c ~= nil then
          n = n + 1
          keys[n], vals[n] = k, c
        end
      end
    end
    return { [MARK] = 'm', k = keys, v = vals }
  end

  --- Returns the very same table when it can already travel.
  ---@param v any
  ---@return any
  function FXC.encode(v)
    if type(v) ~= 'table' and type(v) ~= 'function' and type(v) ~= 'thread' then return v end
    if scan(v, 1) == SCAN_CLEAN then return v end
    return build(v, 1)
  end

  --- Rebuild without the clean check, for a value the scan already classified.
  ---@param v any
  ---@return any
  function FXC.encodeDirty(v) return build(v, 1) end

  ---@param v any
  ---@param depth integer
  ---@return boolean
  local function needsDecode(v, depth)
    if v == null then return true end
    if type(v) ~= 'table' then return false end
    if depth > MAX_DEPTH then error('fxcompat: payload nested deeper than ' .. MAX_DEPTH, 0) end
    if getmetatable(v) ~= nil then return false end
    if v[MARK] ~= nil then return true end
    for _, e in next, v do
      if needsDecode(e, depth + 1) then return true end
    end
    return false
  end

  ---@param v any
  ---@param depth integer
  ---@return any
  local function unbuild(v, depth)
    if v == null then return nil end
    if type(v) ~= 'table' or getmetatable(v) ~= nil then return v end
    if depth > MAX_DEPTH then error('fxcompat: payload nested deeper than ' .. MAX_DEPTH, 0) end
    local tag = v[MARK]
    local builder = type(tag) == 'string' and FLAT_BUILDERS[tag] or nil
    if builder ~= nil then return builder(v) end
    local out = {}
    if tag == 'm' and type(v.k) == 'table' and type(v.v) == 'table' then
      local keys, vals = v.k, v.v
      for i = 1, #keys do out[keys[i]] = unbuild(vals[i], depth + 1) end
      return out
    end
    for k, e in next, v do out[k] = unbuild(e, depth + 1) end
    return out
  end

  ---@param v any
  ---@return any
  function FXC.decode(v)
    if v ~= null and type(v) ~= 'table' then return v end
    if not needsDecode(v, 1) then return v end
    return unbuild(v, 1)
  end

  local encode, decode = FXC.encode, FXC.decode

  ---@param ... any
  ---@return ...
  function FXC.encodeArgs(...)
    local n = select('#', ...)
    if n == 0 then return end
    if n == 1 then return encode((...)) end
    if n == 2 then
      local a, b = ...
      return encode(a), encode(b)
    end
    local t = table.pack(...)
    for i = 1, n do t[i] = encode(t[i]) end
    return table.unpack(t, 1, n)
  end

  ---@param ... any
  ---@return ...
  function FXC.decodeArgs(...)
    local n = select('#', ...)
    if n == 0 then return end
    if n == 1 then return decode((...)) end
    if n == 2 then
      local a, b = ...
      return decode(a), decode(b)
    end
    local t = table.pack(...)
    for i = 1, n do t[i] = decode(t[i]) end
    return table.unpack(t, 1, n)
  end

  --- FiveM JSON semantics (NUI messages, json.encode): integer keys become strings, functions vanish.
  ---@param v any
  ---@param depth integer
  ---@return any
  local function jsonBuild(v, depth)
    if v == null then return v end
    local tv = type(v)
    if tv == 'function' or tv == 'thread' then return nil end
    if tv ~= 'table' then return v end
    if depth > MAX_DEPTH then error('fxcompat: payload nested deeper than ' .. MAX_DEPTH, 0) end
    local mt = getmetatable(v)
    if vec3mt ~= nil and mt == vec3mt then return v end
    local flat = mt ~= nil and FLAT_VECTORS[mt] or nil
    if flat ~= nil then
      local r = {}
      for i = 1, #flat do r[flat[i]] = v[flat[i]] end
      return r
    end
    local kind, total = classify(v, false)
    if kind == 'empty' then return v end
    local out = {}
    if kind == 'list' then
      for i = 1, total do
        local c = jsonBuild(v[i], depth + 1)
        if c == nil then c = null end
        out[i] = c
      end
      return out
    end
    for k, e in next, v do
      local tk = type(k)
      if tk == 'string' or tk == 'number' or tk == 'boolean' then
        local c = jsonBuild(e, depth + 1)
        if c ~= nil then out[tk == 'string' and k or tostring(k)] = c end
      end
    end
    return out
  end

  ---@param v any
  ---@return any
  function FXC.toJson(v)
    local tv = type(v)
    if tv ~= 'table' and tv ~= 'function' and tv ~= 'thread' then return v end
    if isClean(v, 1, true) then return v end
    return jsonBuild(v, 1)
  end

  ---@param v any
  ---@param depth integer
  ---@return boolean
  local function hasNull(v, depth)
    if v == null then return true end
    if type(v) ~= 'table' or getmetatable(v) ~= nil then return false end
    if depth > MAX_DEPTH then return false end
    for _, e in next, v do
      if hasNull(e, depth + 1) then return true end
    end
    return false
  end

  ---@param v any
  ---@param depth integer
  ---@return any
  local function stripNulls(v, depth)
    if v == null then return nil end
    if type(v) ~= 'table' or getmetatable(v) ~= nil or depth > MAX_DEPTH then return v end
    local out = {}
    for k, e in next, v do out[k] = stripNulls(e, depth + 1) end
    return out
  end

  --- JSON null becomes nil, as in FiveM.
  ---@param v any
  ---@return any
  function FXC.fromJson(v)
    if not hasNull(v, 1) then return v end
    return stripNulls(v, 1)
  end

  ---@type FxDebug
  FXC.debug = {
    traceback = function(message, level)
      local ok, text = pcall(debug.traceback, message, (level or 1) + 1)
      if ok and type(text) == 'string' then return text end
      return message or ''
    end,
  }

  Citizen = {}
  ---@type FxCitizen
  Citizen = Citizen

  ---@param fn fun(...: any)
  ---@param ... any
  local function createThread(fn, ...) return lsmp.createThread(fn, ...) end
  CreateThread = createThread
  Citizen.CreateThread = createThread
  Citizen.CreateThreadNow = createThread

  ---@param ms? integer
  function Wait(ms) return lsmp.wait(ms or 0) end
  Citizen.Wait = Wait

  --- Timer callbacks are not host coroutines in LS:MP, so each one runs in a thread to be allowed to Wait.
  ---@param ms integer
  ---@param fn fun()
  ---@return integer
  function SetTimeout(ms, fn)
    return setTimeout(function() lsmp.createThread(fn) end, ms)
  end
  Citizen.SetTimeout = SetTimeout

  ---@param id integer
  function ClearTimeout(id) return clearTimeout(id) end
  Citizen.ClearTimeout = ClearTimeout

  ---@param text string
  function Citizen.Trace(text) lsmp.log(text) end

  ---@return boolean
  function IsDuplicityVersion() return FXC.side == 'server' end

  ---@return string
  function GetCurrentResourceName() return FXC.resource end

  ---@type fun(): thread|boolean
  local running <const> = coroutine ~= nil and coroutine.running or function() return false end
  ---@type table<thread|boolean, string>
  local invokers <const> = setmetatable({}, { __mode = 'k' })

  --- Splits the leading marker { __fx = 'inv', r = caller } off the arguments of an export call or local event.
  ---@param ... any
  ---@return string?, ...
  function FXC.splitInvoker(...)
    local first = ...
    if type(first) == 'table' and first[FXC.MARK] == 'inv' then
      local from = first.r
      return type(from) == 'string' and from or nil, select(2, ...)
    end
    return nil, ...
  end

  FXC.invokerMarker = { __fx = 'inv', r = FXC.resource }

  ---@param co thread|boolean
  ---@param previous string?
  ---@param ok boolean
  ---@param ... any
  ---@return ...
  local function restore(co, previous, ok, ...)
    invokers[co] = previous
    if not ok then error((...), 0) end
    return ...
  end

  --- The error is raised again outside the handler: keep the handler frames in the message.
  ---@param err any
  ---@return any
  local function withTraceback(err)
    if type(err) ~= 'string' then return err end
    return debug.traceback(err, 2)
  end

  --- Runs fn with `invoker` as the answer of GetInvokingResource for the current coroutine, restoring the previous one.
  ---@param invoker string?
  ---@param fn function
  ---@param ... any
  ---@return ...
  function FXC.runAs(invoker, fn, ...)
    local co <const> = running()
    local previous <const> = invokers[co]
    invokers[co] = invoker
    return restore(co, previous, xpcall(fn, withTraceback, ...))
  end

  ---@return string?
  function GetInvokingResource() return invokers[running()] end

  ---@type table<string, string>?
  local serverConvars

  --- Server-only convars (`set`, `sets`) live in a data file the client package never lists.
  ---@return table<string, string>
  local function loadServerConvars()
    if serverConvars ~= nil then return serverConvars end
    serverConvars = {}
    local text <const> = lsmp.readResourceFile('_fxcompat/server_convars.json')
    if text == nil then return serverConvars end
    local data <const> = lsmp.json.decode(text)
    if type(data) == 'table' then
      for k, v in next, data do
        if type(k) == 'string' and type(v) == 'string' then serverConvars[k] = v end
      end
    end
    return serverConvars
  end

  --- Values set at runtime stay in this resource: LS:MP has no shared convar store.
  ---@type table<string, string>
  local runtimeConvars <const> = {}

  if FXC.side == 'server' then
    ---@param name string
    ---@param value string
    function SetConvar(name, value) runtimeConvars[name] = tostring(value) end
    SetConvarReplicated = SetConvar
    SetConvarServerInfo = SetConvar

    --- LS:MP has no server list map or game type field.
    ---@param _ string
    function SetMapName(_) end
    SetGameType = SetMapName

    --- LS:MP sets the entity life policy at creation only.
    ---@param _entity integer
    ---@param _mode integer
    function SetEntityOrphanMode(_entity, _mode) end
  end

  --- FiveM built-in convars scripts check: LS:MP syncs every entity through its server, like OneSync Infinity.
  ---@type table<string, string>
  local builtinConvars <const> = {
    onesync = 'on',
    onesync_enabled = 'true',
    onesync_enableInfinity = 'true',
    gamename = 'gta5',
  }

  --- Convars come from the build (server.cfg): the client only gets the replicated ones (`setr`).
  ---@param name string
  ---@return string?
  local function convar(name)
    local set <const> = runtimeConvars[name]
    if set ~= nil then return set end
    if FXC.side == 'server' then
      local value <const> = loadServerConvars()[name]
      if value ~= nil then return value end
    end
    local replicated <const> = FXCOMPAT_CONFIG.convars[name]
    if replicated ~= nil then return replicated end
    return builtinConvars[name]
  end

  ---@param name string
  ---@param default? string
  ---@return string
  function GetConvar(name, default)
    local value = convar(name)
    if value == nil then return default or '' end
    return value
  end

  ---@param name string
  ---@param default? integer
  ---@return integer
  function GetConvarInt(name, default)
    local n = tonumber(convar(name))
    if n == nil then return default or 0 end
    return math.tointeger(n) or math.floor(n)
  end

  ---@param name string
  ---@param default? boolean
  ---@return boolean
  function GetConvarBool(name, default)
    local value = convar(name)
    if value == nil then return default or false end
    return value == 'true' or value == '1'
  end

  --- LS:MP cannot list other resources: the calling resource is the only one found.
  ---@return integer
  function GetNumResources() return 1 end

  ---@param index integer
  ---@return string?
  function GetResourceByFindIndex(index)
    if index == 0 then return FXC.resource end
    return nil
  end

  ---@param resource string
  ---@param key string
  ---@return string[]
  local function metadataOf(resource, key)
    if resource ~= FXC.resource then return {} end
    local all = FXCOMPAT_CONFIG.metadata
    return all ~= nil and all[key] or {}
  end

  ---@param resource string
  ---@param key string
  ---@return integer
  function GetNumResourceMetadata(resource, key) return #metadataOf(resource, key) end

  ---@param resource string
  ---@param key string
  ---@param index? integer
  ---@return string?
  function GetResourceMetadata(resource, key, index) return metadataOf(resource, key)[(index or 0) + 1] end

  ---@type string[]
  local commandNames <const> = {}
  ---@type table<string, true>
  local commandSeen <const> = {}

  ---@param name string
  function FXC.noteCommand(name)
    if commandSeen[name] then return end
    commandSeen[name] = true
    commandNames[#commandNames + 1] = name
  end

  --- Only the commands this resource registered are known.
  ---@return { name: string }[]
  function GetRegisteredCommands()
    local list = {}
    for i = 1, #commandNames do list[i] = { name = commandNames[i] } end
    return list
  end

  GetHashKey = lsmp.hash
  joaat = lsmp.hash

  ---@param name string
  ---@return string
  function GetResourceState(name)
    return lsmp.getResourceState(name) or 'missing'
  end

  ---@type table<string, string>
  local markersByPath <const> = {}

  --- The build does not ship the text of precompiled client modules: a read that finds no file answers with a marker
  --- that `load` resolves to the module.
  ---@param path string
  ---@return string?
  local function readOwnFile(path)
    local text <const> = lsmp.readResourceFile(path)
    if text ~= nil or FXC.side == 'server' then return text end
    return markersByPath[path]
  end

  --- Another resource's files come from the copies the build vendored under `_fxcompat/imports`.
  ---@param resource string
  ---@param path string
  ---@return string?
  function LoadResourceFile(resource, path)
    if resource == FXC.resource then return readOwnFile(path) end
    return readOwnFile('_fxcompat/imports/' .. resource .. '/' .. path)
  end

  ---@type table<string, FxModuleFactory>
  local modulesByHash <const> = {}
  ---@type table<string, string>
  local pathsByHash <const> = {}

  --- FNV-1a over the bytes, prefixed by the byte length: the build computes the same value for every precompiled file.
  ---@param text string
  ---@return string
  function FXC.moduleHash(text)
    local byte <const> = string.byte
    local length <const> = #text
    local h = 2166136261
    local i = 1
    while i <= length do
      local last <const> = math.min(i + 255, length)
      local bytes <const> = { byte(text, i, last) }
      for k = 1, #bytes do
        h = ((h ~ bytes[k]) * 16777619) & 0xFFFFFFFF
      end
      i = last + 1
    end
    return string.format('%d:%08x', length, h)
  end

  --- A path registered twice is a shared.lua .. client.lua pair: the plain entry comes first and gives the marker, the
  --- pair answers to the two markers joined by a line break, as the resource builds it.
  ---@param path string
  ---@param hash string
  ---@param factory FxModuleFactory
  function FXC.registerModule(path, hash, factory)
    modulesByHash[hash] = factory
    pathsByHash[hash] = path
    local plain <const> = markersByPath[path]
    if plain == nil then
      local marker <const> = '--fxc:module:' .. hash
      markersByPath[path] = marker
      modulesByHash[FXC.moduleHash(marker)] = factory
      return
    end
    local sharedPath <const> = string.gsub(path, '[^/]*$', 'shared.lua')
    local shared <const> = markersByPath[sharedPath]
    if shared ~= nil then modulesByHash[FXC.moduleHash(shared .. '\n' .. plain)] = factory end
  end

  ---@class FxModuleRange
  ---@field first integer
  ---@field path string

  ---@type table<string, FxModuleRange[]>
  local rangesByFile <const> = {}

  --- Registers the modules of one registry file and records where each body starts, in file order.
  ---@param file string
  ---@return fun(path: string, hash: string, factory: FxModuleFactory, firstLine?: integer)
  function FXC.registry(file)
    local ranges <const> = {}
    rangesByFile[file] = ranges
    return function(path, hash, factory, firstLine)
      FXC.registerModule(path, hash, factory)
      if firstLine ~= nil then ranges[#ranges + 1] = { first = firstLine, path = path } end
    end
  end
  _G.__fxc_registry = FXC.registry

  ---@class FxDebugInfo
  ---@field source string
  ---@field short_src string
  ---@field what string
  ---@field currentline integer
  ---@field linedefined integer
  ---@field lastlinedefined integer
  ---@field name? string
  ---@field namewhat string

  --- Maps a line of a registry file back to the module it holds, as `<resource>/<path>` and the line inside it.
  ---@param path string
  ---@param line integer
  ---@return string, integer
  local function unmapModule(path, line)
    for file, ranges in next, rangesByFile do
      if path == file or string.sub(path, -#file - 1) == '/' .. file then
        local lo, hi, found = 1, #ranges, nil
        while lo <= hi do
          local mid <const> = (lo + hi) // 2
          if ranges[mid].first <= line then found = ranges[mid]; lo = mid + 1 else hi = mid - 1 end
        end
        if found == nil then return path, line end
        local other <const>, rest <const> = string.match(found.path, '^_fxcompat/imports/([^/]+)/(.+)$')
        local mapped <const> = other and (other .. '/' .. rest) or (FXC.resource .. '/' .. found.path)
        return mapped, line - found.first + 1
      end
    end
    return path, line
  end

  ---@class FxScript
  ---@field path string
  ---@field factory FxModuleFactory

  ---@type table<string, FxScript[]>
  local scriptsByFile <const> = {}

  --- Adds one Lua script of the resource to the loader `file`, also as a module, and records where its body starts.
  ---@param file string
  ---@param path string
  ---@param hash string
  ---@param factory FxModuleFactory
  ---@param firstLine integer
  function FXC.script(file, path, hash, factory, firstLine)
    FXC.registerModule(path, hash, factory)
    local list = scriptsByFile[file]
    if list == nil then
      list = {}
      scriptsByFile[file] = list
      rangesByFile[file] = {}
    end
    list[#list + 1] = { path = path, factory = factory }
    local ranges <const> = rangesByFile[file]
    ranges[#ranges + 1] = { first = firstLine, path = path }
  end
  _G.__fxc_script = FXC.script

  --- Runs the scripts in manifest order in the calling coroutine; an error names the original file and line.
  ---@param file string
  function FXC.run(file)
    local list <const> = scriptsByFile[file] or {}
    for i = 1, #list do
      local ok <const>, err <const> = pcall(list[i].factory(_G))
      if not ok then
        if type(err) ~= 'string' then error(err, 0) end
        error((string.gsub(err, '([^%s:]+):(%d+):', function(path, line)
          local mapped <const>, mappedLine <const> = unmapModule(path, tonumber(line) or -1)
          return mapped .. ':' .. mappedLine .. ':'
        end)), 0)
      end
    end
  end
  _G.__fxc_run = FXC.run

  ---@param frame string
  ---@return FxDebugInfo
  local function parseFrame(frame)
    if string.sub(frame, 1, 4) == '[C]:' then
      local kind <const>, name <const> = string.match(frame, "in (%a+) '([^']*)'")
      return {
        source = '=[C]', short_src = '[C]', what = 'C', currentline = -1, linedefined = -1, lastlinedefined = -1,
        name = name, namewhat = kind == 'function' and 'global' or kind or '',
      }
    end
    local path, line, rest = string.match(frame, '^(.-):(%d+):%s*(.*)$')
    if path == nil then path, line, rest = '?', '-1', frame end
    local currentline = tonumber(line) or -1
    path, currentline = unmapModule(path, currentline)
    local what, linedefined, name, namewhat = 'Lua', -1, nil, ''
    if string.find(rest, '^in main chunk') then
      what = 'main'
      linedefined = 0
    else
      local kind <const>, found <const> = string.match(rest, "^in (%a+) '([^']*)'")
      if kind ~= nil then
        name, namewhat = found, kind == 'function' and 'global' or kind
      else
        local definedPath <const>, definedLine <const> = string.match(rest, '^in function <(.-):(%d+)>')
        if definedPath ~= nil then
          local _, mapped <const> = unmapModule(definedPath, tonumber(definedLine) or -1)
          linedefined = mapped
        end
      end
    end
    return {
      source = '@@' .. path, short_src = '@' .. path, what = what, currentline = currentline,
      linedefined = linedefined, lastlinedefined = -1, name = name, namewhat = namewhat,
    }
  end

  ---@type (fun(level: integer, what?: string): FxDebugInfo?)?
  local nativeGetinfo <const> = debug ~= nil and debug.getinfo or nil
  ---@type (fun(message?: string, level?: integer): string)?
  local nativeTraceback <const> = debug ~= nil and debug.traceback or nil

  --- Level 1 is the function calling `debug.getinfo`, as in Lua: the traceback starts at this function, hence `level + 1`.
  --- Parsing happens per call only.
  ---@param target integer|function
  ---@param _what? string
  ---@return FxDebugInfo?
  local function emulatedGetinfo(target, _what)
    if type(target) == 'function' then
      return { source = '=?', short_src = '?', what = 'Lua', linedefined = -1, currentline = -1, lastlinedefined = -1, namewhat = '' }
    end
    if type(target) ~= 'number' then error("bad argument #1 to 'getinfo' (function or level expected)", 2) end
    if target < 0 then return nil end
    if target == 0 then return parseFrame("[C]: in field 'getinfo'") end
    local trace <const> = nativeTraceback and nativeTraceback(nil, target + 1) or ''
    local frame <const> = string.match(trace, '\n\t([^\n]+)')
    if frame == nil or string.sub(frame, 1, 3) == '...' then return nil end
    return parseFrame(frame)
  end

  if nativeGetinfo == nil or onLsmp or not pcall(nativeGetinfo, 1, 'S') then
    if not pcall(function() debug.getinfo = emulatedGetinfo end) then
      _G.debug = setmetatable({ getinfo = emulatedGetinfo }, { __index = debug })
    end
  end

  ---@type FxLoad?
  local nativeLoad <const> = load

  ---@param chunk string|(fun(): string?)
  ---@return string?, string?
  local function readChunk(chunk)
    if type(chunk) == 'string' then return chunk end
    if type(chunk) ~= 'function' then return nil, 'bad argument #1 to load (string or function expected)' end
    local pieces <const> = {}
    while true do
      local piece <const> = chunk()
      if piece == nil or piece == '' then break end
      if type(piece) ~= 'string' then return nil, 'reader function must return a string' end
      pieces[#pieces + 1] = piece
    end
    return table.concat(pieces)
  end

  --- LS:MP refuses runtime `load`: only files the build precompiled (found by hash of their text) can be loaded.
  ---@param chunk string|(fun(): string?)
  ---@param chunkname? string
  ---@param mode? string
  ---@param env? table
  ---@return (fun(...: any): ...)?, string?
  function load(chunk, chunkname, mode, env)
    if mode ~= nil and not string.find(mode, 't', 1, true) then
      return nil, "attempt to load a text chunk (mode is '" .. mode .. "')"
    end
    local text <const>, readError <const> = readChunk(chunk)
    if text == nil then return nil, readError end
    local factory <const> = modulesByHash[FXC.moduleHash(text)]
    if factory ~= nil then return factory(env or _G) end
    if nativeLoad ~= nil then
      local ok <const>, fn <const>, err <const> = pcall(nativeLoad, text, chunkname, mode, env)
      if ok and fn ~= nil then return fn end
      if ok then return nil, err end
    end
    return nil, 'cannot load chunk ' .. tostring(chunkname) .. ' (' .. #text .. ' bytes): LS:MP runs no code at runtime '
      .. 'and fx2lsmp precompiles only the Lua files of the resource'
  end
  loadstring = load

  ---@class FxJson
  ---@field encode fun(value: any, options?: { indent?: boolean }): string
  ---@field decode fun(text: string): any, string?
  json = {
    encode = function(value, options)
      local pretty = options ~= nil and options.indent == true
      return lsmp.json.encode(FXC.toJson(value), pretty and { pretty = true } or nil)
    end,
    decode = function(text)
      local value, code, details = lsmp.json.decode(text)
      if code ~= nil then return nil, details and details.message or code end
      return FXC.fromJson(value)
    end,
  }

  ---@type FxPromiseDeps
  FXC.promiseDeps = {
    SetTimeout = SetTimeout,
    ClearTimeout = ClearTimeout,
    CreateThreadNow = createThread,
    trace = Citizen.Trace,
    config = { debug = false },
    -- Polls once per tick: LS:MP has no primitive that wakes a coroutine. A rejected promise carries the misuse
    -- message out because the caller wraps this function in pcall.
    Await = function(p)
      while p.state == 0 do
        local ok, err = pcall(lsmp.wait, 0)
        if not ok then
          p:reject('Await needs a host coroutine (a thread, event handler or command): ' .. tostring(err))
          return
        end
      end
    end,
  }
end
