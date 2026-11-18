---@diagnostic disable
local hostLoad = load
debug.getinfo = function() error('debug.getinfo is not available: only debug.traceback is available', 2) end
load = function() error('load is not available: gamescripts cannot load or dump code at runtime', 2) end
local SIDE = __SIDE
local RESOURCE = __RESOURCE
local LOCAL_ID = __LOCAL_PLAYER
local KEY = __KEY
local PEERS = __PEERS == true

local lsmp = {}
local null = setmetatable({}, { __tostring = function() return 'lsmp.null' end, __name = 'null' })
lsmp.null = null

local now, seq = 0, 0
local logs, errors = {}, {}
local host = setmetatable({}, { __mode = 'k' })
local timers, laterQueue = {}, {}
local pending, nextPending = {}, 0

local ENGINE_NAMES = {
  playerJoin = true, playerLeave = true, playerDeath = true, playerSpawn = true, resourceStart = true,
  resourceStop = true, metaChange = true, serverStart = true, serverStop = true, playerPreConnection = true,
  playerDimensionChange = true, entityOwnerChange = true, entityStreamIn = true, entityStreamOut = true,
}
local FLAT_NAMES = { vector2 = true, vector4 = true, quat = true }

local V3 = { __name = 'Vector3' }
V3.__index = V3
local function vec3(x, y, z) return setmetatable({ x = (x or 0) + 0.0, y = (y or 0) + 0.0, z = (z or 0) + 0.0 }, V3) end
V3.__add = function(a, b) return vec3(a.x + b.x, a.y + b.y, a.z + b.z) end
V3.__sub = function(a, b) return vec3(a.x - b.x, a.y - b.y, a.z - b.z) end
V3.__eq = function(a, b) return a.x == b.x and a.y == b.y and a.z == b.z end
V3.__tostring = function(v) return 'Vector3(' .. v.x .. ', ' .. v.y .. ', ' .. v.z .. ')' end
Vector3 = vec3

local json = {}
local ESC = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }

local function jsonString(s)
  return '"' .. s:gsub('[%c"\\]', function(c) return ESC[c] or string.format('\\u%04x', c:byte()) end) .. '"'
end

local function jenc(v)
  local t = type(v)
  if v == nil or v == null then return 'null' end
  if t == 'boolean' then return tostring(v) end
  if t == 'number' then
    if math.type(v) == 'integer' then return string.format('%d', v) end
    return string.format('%.17g', v)
  end
  if t == 'string' then return jsonString(v) end
  if t ~= 'table' then error('json: cannot encode ' .. t, 0) end
  if getmetatable(v) == V3 then return string.format('{"x":%s,"y":%s,"z":%s}', jenc(v.x), jenc(v.y), jenc(v.z)) end
  local n, listy = 0, true
  for _ in pairs(v) do n = n + 1 end
  if n == 0 then return '[]' end
  for i = 1, n do
    if v[i] == nil then listy = false break end
  end
  local parts = {}
  if listy then
    for i = 1, n do parts[i] = jenc(v[i]) end
    return '[' .. table.concat(parts, ',') .. ']'
  end
  local keys, byName = {}, {}
  for k in pairs(v) do
    local name = tostring(k)
    keys[#keys + 1] = name
    byName[name] = v[k]
  end
  table.sort(keys)
  for i, k in ipairs(keys) do parts[i] = jsonString(k) .. ':' .. jenc(byName[k]) end
  return '{' .. table.concat(parts, ',') .. '}'
end

local function jdec(text)
  local pos = 1
  local function skip() pos = text:find('[^ \t\r\n]', pos) or #text + 1 end
  local value
  local function str()
    local out = {}
    pos = pos + 1
    while true do
      local c = text:sub(pos, pos)
      if c == '"' then pos = pos + 1 break end
      if c == '\\' then
        local e = text:sub(pos + 1, pos + 1)
        if e == 'u' then
          out[#out + 1] = utf8.char(tonumber(text:sub(pos + 2, pos + 5), 16))
          pos = pos + 6
        else
          out[#out + 1] = ({ n = '\n', r = '\r', t = '\t', b = '\b', f = '\f' })[e] or e
          pos = pos + 2
        end
      else
        out[#out + 1] = c
        pos = pos + 1
      end
    end
    return table.concat(out)
  end
  function value()
    skip()
    local c = text:sub(pos, pos)
    if c == '{' then
      local out = {}
      pos = pos + 1
      skip()
      if text:sub(pos, pos) == '}' then pos = pos + 1 return out end
      while true do
        skip()
        local k = str()
        skip()
        pos = pos + 1
        local v = value()
        if v ~= null then out[k] = v end
        skip()
        local d = text:sub(pos, pos)
        pos = pos + 1
        if d == '}' then return out end
      end
    elseif c == '[' then
      local out = {}
      pos = pos + 1
      skip()
      if text:sub(pos, pos) == ']' then pos = pos + 1 return out end
      while true do
        out[#out + 1] = value()
        skip()
        local d = text:sub(pos, pos)
        pos = pos + 1
        if d == ']' then return out end
      end
    elseif c == '"' then
      return str()
    elseif text:sub(pos, pos + 3) == 'true' then
      pos = pos + 4
      return true
    elseif text:sub(pos, pos + 4) == 'false' then
      pos = pos + 5
      return false
    elseif text:sub(pos, pos + 3) == 'null' then
      pos = pos + 4
      return null
    end
    local num = text:match('^-?%d+%.?%d*[eE]?[+-]?%d*', pos)
    if num == nil or num == '' then error('json: unexpected character at ' .. pos, 0) end
    pos = pos + #num
    return math.tointeger(tonumber(num)) or tonumber(num)
  end
  local v = value()
  skip()
  if pos <= #text then error('json: trailing characters', 0) end
  return v
end

json.encode = function(value, opts)
  local text = jenc(value)
  if opts and opts.pretty then text = text:gsub('([{,])', '%1\n') end
  return text
end
json.decode = function(text)
  local ok, v = pcall(jdec, text)
  if not ok then return nil, 'invalid', { message = tostring(v) } end
  return v
end
lsmp.json = json

local function W(v, path, depth)
  local t = type(v)
  if v == nil or v == null then return 'N' end
  if t == 'boolean' then return tostring(v) end
  if t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then error(path .. ': non-finite number is not transportable', 0) end
    if math.type(v) == 'integer' then return string.format('%d', v) end
    return string.format('%a', v)
  end
  if t == 'string' then return string.format('%q', v) end
  if t ~= 'table' then error(path .. ': ' .. t .. ' is not transportable', 0) end
  if depth > 32 then error(path .. ': nesting deeper than 32', 0) end
  local mt = getmetatable(v)
  if mt == V3 then return string.format('V(%a,%a,%a)', v.x, v.y, v.z) end
  if mt ~= nil and FLAT_NAMES[mt.__name] then error(path .. ': ' .. mt.__name .. ' is not transportable', 0) end
  local n, ints, strs, maxInt = 0, 0, 0, 0
  for k in next, v do
    n = n + 1
    if type(k) == 'string' then
      strs = strs + 1
    elseif math.type(k) == 'integer' and k >= 1 then
      ints = ints + 1
      if k > maxInt then maxInt = k end
    end
  end
  if n == 0 then return '{}' end
  local parts = {}
  if ints == n and maxInt == n then
    for i = 1, n do parts[i] = W(v[i], path .. '[' .. i .. ']', depth + 1) end
    return '{' .. table.concat(parts, ',') .. '}'
  end
  if strs == n then
    for k, e in next, v do
      parts[#parts + 1] = '[' .. string.format('%q', k) .. ']=' .. W(e, path .. '.' .. k, depth + 1)
    end
    return '{' .. table.concat(parts, ',') .. '}'
  end
  error(path .. ': table keys must be 1..n (array) or strings (map)', 0)
end

local WIRE_ENV = { V = vec3, N = null }
local function wdec(wire)
  local chunk = assert(hostLoad('return ' .. wire, 'wire', 't', WIRE_ENV))
  return chunk()
end

local function wdecOne(wire)
  local v = wdec(wire)
  if v == null then return nil end
  return v
end

local function wireArgs(fnName, ...)
  local n = select('#', ...)
  while n > 0 and select(n, ...) == nil do n = n - 1 end
  if n > 32 then error(fnName .. ': too many arguments (max 32)', 0) end
  local parts = {}
  for i = 1, n do
    local v = select(i, ...)
    parts[i] = W(v, fnName .. ': args[' .. i .. ']', 1)
  end
  return '{' .. table.concat(parts, ',') .. '}'
end

local function checkName(fnName, name)
  if type(name) ~= 'string' or #name < 1 or #name > 128 then error(fnName .. ': event name must be 1..128 bytes', 0) end
  if name:sub(1, 5) == 'lsmp:' then error(fnName .. ": the 'lsmp:' prefix is reserved", 0) end
end

local function checkNet(fnName, name)
  checkName(fnName, name)
  if ENGINE_NAMES[name] then error(fnName .. ": event name '" .. name .. "' is reserved by LS:MP", 0) end
end

local function record(err)
  errors[#errors + 1] = tostring(err)
end

local function step(co, ...)
  local ok, a = coroutine.resume(co, ...)
  if not ok then
    record(a)
    return
  end
  if coroutine.status(co) == 'suspended' and type(a) == 'table' and a.wait then
    seq = seq + 1
    timers[#timers + 1] = { at = now + a.wait, co = co, seq = seq }
  end
end

local function spawn(fn, ...)
  local co = coroutine.create(fn)
  host[co] = true
  step(co, ...)
  return co
end

local function later(fn) laterQueue[#laterQueue + 1] = fn end

function lsmp.createThread(fn, ...) spawn(fn, ...) end

function lsmp.wait(ms)
  local co, main = coroutine.running()
  if main or not host[co] then error('lsmp.wait: needs a host coroutine', 2) end
  coroutine.yield({ wait = ms or 0 })
end

local function settle(id, ...)
  local p = pending[id]
  if p == nil then return end
  pending[id] = nil
  if p.cb then
    local ok, err = pcall(p.cb, ...)
    if not ok then record(err) end
  else
    step(p.co, ...)
  end
end

local function suspendOrCallback(fnName, cb, start)
  nextPending = nextPending + 1
  local id = nextPending
  if cb then
    pending[id] = { cb = cb }
    start(id)
    return
  end
  local co, main = coroutine.running()
  if main or not host[co] then error(fnName .. ': needs a callback here (not inside a coroutine)', 3) end
  pending[id] = { co = co }
  start(id)
  return coroutine.yield({ suspend = id })
end

local function splitCallback(...)
  local args = table.pack(...)
  local cb
  if args.n > 0 and type(args[args.n]) == 'function' then
    cb = args[args.n]
    args[args.n] = nil
    args.n = args.n - 1
  end
  return cb, args
end

function lsmp.getTickCount() return now end
function lsmp.nowMs() return now end

setTimeout = function(fn, ms, ...)
  seq = seq + 1
  local timer = { at = now + (ms or 0), fn = fn, args = table.pack(...), seq = seq }
  timers[#timers + 1] = timer
  return seq
end
clearTimeout = function(id)
  for i, t in ipairs(timers) do
    if t.seq == id then table.remove(timers, i) return end
  end
end

local function send(msg) __send(jenc(msg)) end

local listeners, netListeners, calls = {}, {}, {}

local function addListener(map, name, fn)
  local list = map[name]
  if list == nil then list = {} map[name] = list end
  for _, f in ipairs(list) do
    if f == fn then return function() return false end end
  end
  list[#list + 1] = fn
  return function()
    for i, f in ipairs(list) do
      if f == fn then table.remove(list, i) return true end
    end
    return false
  end
end

function lsmp.on(name, fn, filter)
  if filter == nil then return addListener(listeners, name, fn) end
  return addListener(listeners, name, function(...)
    local args = table.pack(...)
    if filter.scope ~= nil and filter.scope ~= args[1] then return end
    if filter.target ~= nil and filter.target ~= args[2] then return end
    if filter.key ~= nil and filter.key ~= args[3] then return end
    return fn(...)
  end)
end
function lsmp.once(name, fn)
  local off
  off = addListener(listeners, name, function(...) off() return fn(...) end)
  return off
end
function lsmp.off(name, fn)
  local list = listeners[name] or {}
  for i, f in ipairs(list) do
    if f == fn then table.remove(list, i) return true end
  end
  return false
end

function lsmp.emit(name, ...)
  checkNet('lsmp.emit', name)
  if lsmp.__strictLocal then wireArgs('lsmp.emit', ...) end
  if PEERS then send({ to = 'peers', from = KEY, kind = 'localEvent', name = name, wire = wireArgs('lsmp.emit', ...) }) end
  local list = listeners[name]
  if list == nil then return end
  for _, fn in ipairs({ table.unpack(list) }) do spawn(fn, ...) end
end

local function fireEngine(name, ...)
  local list = listeners[name]
  if list == nil then return end
  for _, fn in ipairs({ table.unpack(list) }) do spawn(fn, ...) end
end
lsmp.__fire = fireEngine

if SIDE == 'client' then
  function lsmp.emitServer(name, ...)
    checkNet('lsmp.emitServer', name)
    send({ to = 's', from = LOCAL_ID, kind = 'event', name = name, wire = wireArgs('lsmp.emitServer', ...) })
    return true
  end
  function lsmp.onServer(name, fn)
    checkNet('lsmp.onServer', name)
    return addListener(netListeners, name, fn)
  end
  function lsmp.getLocalPlayer() return LOCAL_ID end
else
  local function targetsOf(target)
    if type(target) == 'number' then return { target } end
    return target
  end
  function lsmp.emitClient(target, name, ...)
    checkNet('lsmp.emitClient', name)
    local wire = wireArgs('lsmp.emitClient', ...)
    local sent = false
    for _, id in ipairs(targetsOf(target)) do
      if lsmp.__players[id] then
        send({ to = 'c' .. id, kind = 'event', name = name, wire = wire })
        sent = true
      end
    end
    return sent
  end
  function lsmp.emitAllClients(name, ...)
    checkNet('lsmp.emitAllClients', name)
    local wire = wireArgs('lsmp.emitAllClients', ...)
    local count = 0
    for id in pairs(lsmp.__players) do
      send({ to = 'c' .. id, kind = 'event', name = name, wire = wire })
      count = count + 1
    end
    return count
  end
  function lsmp.onClient(name, fn)
    checkNet('lsmp.onClient', name)
    return addListener(netListeners, name, fn)
  end
end

local function invokeHandler(handler, source, list, reply)
  spawn(function()
    local ok, result
    if SIDE == 'server' then
      ok, result = pcall(handler, source, table.unpack(list))
    else
      ok, result = pcall(handler, table.unpack(list))
    end
    if not ok then
      record(result)
      return reply(nil, 'error')
    end
    local okWire, wire = pcall(W, result, 'result', 1)
    if not okWire then
      record(wire)
      return reply(nil, 'error')
    end
    reply(wire)
  end)
end

function lsmp.onCall(name, fn)
  checkNet('lsmp.onCall', name)
  if calls[name] ~= nil then error("lsmp.onCall: '" .. name .. "' is already handled by resource '" .. RESOURCE .. "'", 0) end
  calls[name] = fn
  return function()
    if calls[name] == fn then calls[name] = nil return true end
    return false
  end
end

local function nameOf(opts) return type(opts) == 'table' and opts.name or opts end

function lsmp.call(nameOrOpts, ...)
  local name = nameOf(nameOrOpts)
  checkNet('lsmp.call', name)
  local cb, args = splitCallback(...)
  local wire = wireArgs('lsmp.call', table.unpack(args, 1, args.n))
  return suspendOrCallback('lsmp.call', cb, function(id)
    later(function()
      local handler = calls[name]
      if handler == nil and PEERS then
        return send({ to = 'peers', ret = KEY, kind = 'localCall', id = id, name = name, wire = wire })
      end
      if handler == nil then return settle(id, nil, 'no-handler') end
      invokeHandler(handler, nil, wdec(wire), function(resultWire, err)
        if err then return settle(id, nil, err) end
        settle(id, wdecOne(resultWire))
      end)
    end)
  end)
end

local function networkCall(fnName, to, nameOrOpts, ...)
  local name = nameOf(nameOrOpts)
  checkNet(fnName, name)
  local cb, args = splitCallback(...)
  local wire = wireArgs(fnName, table.unpack(args, 1, args.n))
  return suspendOrCallback(fnName, cb, function(id)
    send({ to = to, from = LOCAL_ID, ret = KEY, kind = 'call', id = id, name = name, wire = wire })
  end)
end

if SIDE == 'client' then
  function lsmp.callServer(nameOrOpts, ...) return networkCall('lsmp.callServer', 's', nameOrOpts, ...) end
else
  function lsmp.callClient(playerId, nameOrOpts, ...) return networkCall('lsmp.callClient', 'c' .. playerId, nameOrOpts, ...) end
end

local deliver = {}
deliver.event = function(m)
  local list = netListeners[m.name]
  if list == nil then return end
  local args = wdec(m.wire)
  for _, fn in ipairs({ table.unpack(list) }) do
    if SIDE == 'server' then spawn(fn, m.from, table.unpack(args)) else spawn(fn, table.unpack(args)) end
  end
end
deliver.call = function(m)
  local handler = calls[m.name]
  local back = m.from and ('c' .. m.from) or 's'
  if SIDE == 'client' then back = 's' end
  if m.ret then back = 'vm:' .. m.ret end
  if handler == nil then
    return send({ to = back, kind = 'result', id = m.id, err = 'no-handler' })
  end
  invokeHandler(handler, m.from, wdec(m.wire), function(resultWire, err)
    send({ to = back, kind = 'result', id = m.id, wire = resultWire, err = err })
  end)
end
deliver.localEvent = function(m)
  local list = listeners[m.name]
  if list == nil then return end
  local args = wdec(m.wire)
  for _, fn in ipairs({ table.unpack(list) }) do spawn(fn, table.unpack(args)) end
end
deliver.localCall = function(m)
  local handler = calls[m.name]
  if handler == nil then return send({ to = 'vm:' .. m.ret, kind = 'result', id = m.id, err = 'no-handler' }) end
  invokeHandler(handler, nil, wdec(m.wire), function(resultWire, err)
    send({ to = 'vm:' .. m.ret, kind = 'result', id = m.id, wire = resultWire, err = err })
  end)
end
function __hasCall(name) return calls[name] ~= nil end

local META_MAX_BYTES = 8192
local metaStore = { global = {}, player = {}, entity = {} }

local function metaBucket(scope, target)
  if scope == 'global' then return metaStore.global end
  local scoped = metaStore[scope]
  scoped[target] = scoped[target] or {}
  return scoped[target]
end

local function checkMetaKey(fnName, key)
  if type(key) ~= 'string' or #key < 1 or #key > 128 then error(fnName .. ': key must be 1..128 bytes', 3) end
  if key:sub(1, 5) == 'lsmp:' then error(fnName .. ": the 'lsmp:' prefix is reserved", 3) end
end

local function applyMeta(scope, target, key, wire, source)
  local value = wdec(wire)[1]
  local bucket = metaBucket(scope, target)
  local same = W(bucket[key], 'meta', 1) == W(value, 'meta', 1)
  bucket[key] = value
  if same then return end
  fireEngine('metaChange', scope, target, key, value, source)
end

local function metaGet(scope, target, key)
  checkMetaKey('lsmp.getMeta', key)
  return metaBucket(scope, target)[key]
end
function lsmp.getGlobalMeta(key) return metaGet('global', nil, key) end
function lsmp.getPlayerMeta(id, key) return metaGet('player', id, key) end
function lsmp.getEntityMeta(netId, key) return metaGet('entity', netId, key) end

local function metaSet(fnName, scope, target, key, value)
  checkMetaKey(fnName, key)
  local wire = wireArgs(fnName, value)
  local record = { scope = scope, target = target, key = key, side = SIDE }
  lsmp.__test.metaWrites[#lsmp.__test.metaWrites + 1] = record
  if #wire > META_MAX_BYTES then return false, 'too-large' end
  if SIDE == 'client' then
    local allowed = (scope == 'player' and target == LOCAL_ID) or (scope == 'entity' and lsmp.__test.owners[target] == LOCAL_ID)
    if not allowed then return false, 'permission' end
    send({ to = 's', from = LOCAL_ID, kind = 'metaWrite', scope = scope, target = target, key = key, wire = wire })
    return true
  end
  if scope == 'player' and lsmp.__players[target] == nil then return false, 'not-found' end
  applyMeta(scope, target, key, wire, nil)
  for id in pairs(lsmp.__players) do
    send({ to = 'c' .. id, kind = 'meta', scope = scope, target = target, key = key, wire = wire })
  end
  if PEERS then send({ to = 'peers', kind = 'metaPeer', scope = scope, target = target, key = key, wire = wire }) end
  return true
end
function lsmp.setGlobalMeta(key, value) return metaSet('lsmp.setGlobalMeta', 'global', nil, key, value) end
function lsmp.setPlayerMeta(id, key, value) return metaSet('lsmp.setPlayerMeta', 'player', id, key, value) end
function lsmp.setEntityMeta(netId, key, value) return metaSet('lsmp.setEntityMeta', 'entity', netId, key, value) end

deliver.meta = function(m) applyMeta(m.scope, m.target, m.key, m.wire, nil) end
deliver.metaPeer = deliver.meta
deliver.metaWrite = function(m)
  applyMeta(m.scope, m.target, m.key, m.wire, m.from)
  for id in pairs(lsmp.__players) do
    send({ to = 'c' .. id, kind = 'meta', scope = m.scope, target = m.target, key = m.key, wire = m.wire })
  end
end
deliver.result = function(m)
  if m.err then return settle(m.id, nil, m.err) end
  settle(m.id, wdecOne(m.wire))
end

function __deliver(text)
  local m = jdec(text)
  deliver[m.kind](m)
end

lsmp.__players = {}
lsmp.__slots = {}
lsmp.__test = { metaWrites = {}, kicks = {}, grants = {}, coords = {}, dimensions = {}, files = {}, httpRequests = {}, commandsRun = {} }

function __addPlayer(id, name, lsmpId, ip, hwid)
  lsmp.__players[id] = { name = name, lsmpId = lsmpId, ip = ip, hwid = hwid }
  local slot = 0
  for _ in pairs(lsmp.__slots) do slot = slot + 1 end
  lsmp.__slots[slot] = id
end

function lsmp.getPlayers()
  local ids = {}
  for id in pairs(lsmp.__players) do ids[#ids + 1] = id end
  table.sort(ids)
  return ids
end
function lsmp.getPlayerName(id) return lsmp.__players[id] and lsmp.__players[id].name end
function lsmp.getPlayerLsmpId(id) return lsmp.__players[id] and lsmp.__players[id].lsmpId end
function lsmp.getPlayerIdentifier(id, kind)
  local p = lsmp.__players[id]
  if p == nil then return nil end
  if kind == 'ip' then return p.ip end
  if kind == 'name' then return p.name end
  if kind == 'hwid' then return p.hwid end
  if kind == 'lsmp' then return p.lsmpId and tostring(p.lsmpId) or nil end
end
function lsmp.getPlayerPed(id)
  if lsmp.__players[id] == nil then return nil end
  return (SIDE == 'server' and 1000 or 500) + id
end
function lsmp.getPlayerDimension(id) return lsmp.__test.dimensions[id] or 0 end
function lsmp.setPlayerDimension(id, d) lsmp.__test.dimensions[id] = d return true end
function lsmp.kickPlayer(id, reason)
  lsmp.__test.kicks[#lsmp.__test.kicks + 1] = { id = id, reason = reason }
  return true
end
function lsmp.getEntityCoords(netId) return lsmp.__test.coords[netId] or vec3(1, 2, 3) end
lsmp.__test.deleted, lsmp.__test.owners, lsmp.__test.deleteRefusals = {}, {}, {}
function lsmp.entityExists(netId) return netId ~= nil and netId > 0 and not lsmp.__test.deleted[netId] end
function lsmp.getEntityOwner(netId) return lsmp.__test.owners[netId] end
function lsmp.deleteEntity(netId)
  if not lsmp.entityExists(netId) then return false, 'not-found' end
  if lsmp.__test.deleteRefusals[netId] then return false, 'permission' end
  lsmp.__test.deleted[netId] = true
  return true
end
lsmp.__test.entities, lsmp.__test.nextNetId, lsmp.__test.dimensionsOf = {}, 100, {}
local ENTITY_TYPES = { vehicle = true, ped = true, object = true }
local LIFE_POLICIES = { whileRelevant = true, keep = true, withCreator = true }
function lsmp.createEntity(kind, model, position, opts)
  if not ENTITY_TYPES[kind] then error("lsmp.createEntity: unknown type '" .. tostring(kind) .. "'", 2) end
  if model == nil or model == 0 then error('lsmp.createEntity: model must not be 0', 2) end
  if type(model) ~= 'string' and math.type(model) ~= 'integer' then error('lsmp.createEntity: model must be a name or a hash', 2) end
  if type(position) ~= 'table' or type(position.x) ~= 'number' or type(position.y) ~= 'number' or type(position.z) ~= 'number' then
    error('lsmp.createEntity: argument #3: position expected', 2)
  end
  opts = opts or {}
  if opts.heading ~= nil and opts.rotation ~= nil then error('lsmp.createEntity: heading and rotation are exclusive', 2) end
  if opts.lifePolicy ~= nil and not LIFE_POLICIES[opts.lifePolicy] then error('lsmp.createEntity: bad lifePolicy', 2) end
  local test = lsmp.__test
  test.nextNetId = test.nextNetId + 1
  local netId = test.nextNetId
  test.entities[netId] = {
    type = kind, model = type(model) == 'string' and lsmp.hash(model) or model, position = position, opts = opts,
    dimension = opts.dimension or 0,
  }
  test.owners[netId] = opts.owner
  return netId
end
function lsmp.getEntityModel(netId)
  local e = lsmp.__test.entities[netId]
  return e and e.model or nil
end
function lsmp.getEntityType(netId)
  local e = lsmp.__test.entities[netId]
  return e and e.type or nil
end
function lsmp.getPedInVehicleSeat(vehicle, seat) if vehicle == 900 and seat == 0 then return 901 end end
function lsmp.getVehiclePedIsIn(ped) if ped == 901 then return 900 end end
function lsmp.getEntities(opts)
  local out, types = {}, opts and opts.types
  for netId, e in pairs(lsmp.__test.entities) do
    local match = types == nil
    for _, t in ipairs(types or {}) do if t == e.type then match = true end end
    if match and lsmp.entityExists(netId) then out[#out + 1] = netId end
  end
  table.sort(out)
  return out
end
function lsmp.setEntityDimension(netId, dimension)
  local e = lsmp.__test.entities[netId]
  if e == nil then return false, 'not-found' end
  e.dimension = dimension
  return true
end
function lsmp.getEntityDimension(netId)
  local e = lsmp.__test.entities[netId]
  return e and e.dimension or nil
end
function lsmp.__test.setOwner(netId, owner)
  local old = lsmp.__test.owners[netId]
  lsmp.__test.owners[netId] = owner
  if SIDE == 'server' then fireEngine('entityOwnerChange', netId, old, owner, owner and 'adopt' or 'release') end
end
lsmp.perms = {
  has = function(id, perm)
    local g = lsmp.__test.grants[id]
    return g ~= nil and (g[perm] == true or g['*'] == true)
  end,
}

local store = {}
lsmp.storage = {
  get = function(key) return store[key] end,
  set = function(key, value)
    if value == nil then store[key] = nil return true end
    store[key] = wdec(W(value, 'storage.set: value', 1))
    return true
  end,
  delete = function(key)
    local had = store[key] ~= nil
    store[key] = nil
    return had
  end,
  keys = function(prefix)
    local out = {}
    for k in pairs(store) do
      if prefix == nil or k:sub(1, #prefix) == prefix then out[#out + 1] = k end
    end
    table.sort(out)
    return out
  end,
}
function __storageDump() return W(store, 'store', 1) end
function __storageLoad(wire) store = wdec(wire) end

function lsmp.log(...)
  local parts = {}
  for i = 1, select('#', ...) do parts[i] = tostring((select(i, ...))) end
  logs[#logs + 1] = table.concat(parts, '\t')
end
lsmp.warn = function(...) lsmp.log('WARN', ...) end
lsmp.error = function(...) lsmp.log('ERROR', ...) end
print = lsmp.log

function lsmp.hash(text)
  local h = 0
  for i = 1, #text do
    h = (h + text:lower():byte(i)) & 0xFFFFFFFF
    h = (h + (h << 10)) & 0xFFFFFFFF
    h = h ~ (h >> 6)
  end
  h = (h + (h << 3)) & 0xFFFFFFFF
  h = h ~ (h >> 11)
  h = (h + (h << 15)) & 0xFFFFFFFF
  return h
end
lsmp.joaat = lsmp.hash

function lsmp.getResourceName() return RESOURCE end
function lsmp.getResourceState(name)
  if name == RESOURCE then return 'started' end
  return nil
end
function lsmp.readResourceFile(path) return lsmp.__test.files[path] end

lsmp.http = {
  request = function(opts, cb)
    lsmp.__test.httpRequests[#lsmp.__test.httpRequests + 1] = opts
    later(function() cb({ ok = true, status = 200, headers = {}, body = '{"ok":true}' }) end)
  end,
}

local commandTable = {}
function lsmp.registerCommand(name, optsOrFn, fn)
  local opts = {}
  if type(optsOrFn) == 'function' then fn = optsOrFn else opts = optsOrFn or {} end
  if not name:match('^[%w_.:%-]+$') or #name > 64 then error('lsmp.registerCommand: invalid command name', 0) end
  local key = name:lower()
  commandTable[key] = commandTable[key] or {}
  table.insert(commandTable[key], { fn = fn, opts = opts })
  return function() return true end
end
function lsmp.executeCommand(source, line)
  later(function() __runCommand(source, line) end)
  return 'ok'
end
function __runCommand(source, line)
  local name, rest = line:match('^%s*/?(%S+)%s*(.*)$')
  local list = commandTable[(name or ''):lower()]
  if list == nil then return 'unknown' end
  local args = {}
  for word in rest:gmatch('%S+') do args[#args + 1] = word end
  lsmp.__test.commandsRun[#lsmp.__test.commandsRun + 1] = line
  local result = 'denied'
  for _, entry in ipairs(list) do
    local permission = entry.opts.permission
    local allowed = SIDE == 'client' or source == nil or permission == false
      or lsmp.perms.has(source, permission or ('command.' .. name:lower()))
    if allowed then
      result = 'ok'
      if SIDE == 'server' then spawn(entry.fn, args, rest, source, 'test') else spawn(entry.fn, args, rest) end
    end
  end
  return result
end

local browsers, nextBrowser = {}, 0
local BrowserMT = {}
BrowserMT.__index = BrowserMT
function BrowserMT:destroy() self.valid = false return true end
function BrowserMT:isValid() return self.valid end
function BrowserMT:setVisible(v) self.visible = v return true end
function BrowserMT:setUrl(url) self.url = url return true end
function BrowserMT:hasFocus() return self.focus end
function BrowserMT:setFocus(focused, opts)
  opts = opts or {}
  if focused and opts.cursor == false and opts.keepInput == true then error('lsmp: cursor=false cannot combine with keepInput', 0) end
  self.focus = focused
  self.focusOpts = opts
  return true
end
function BrowserMT:emit(event, ...)
  if not self.valid then return false end
  checkName('browser:emit', event)
  local wire = wireArgs('browser:emit', ...)
  local args = wdec(wire)
  send({ to = 'page', browser = self.id, kind = 'pageEmit', event = event, args = args })
  return true
end
function BrowserMT:on(event, fn)
  self.handlers[event] = self.handlers[event] or {}
  table.insert(self.handlers[event], fn)
  return function() return true end
end
function BrowserMT:off() return true end
function BrowserMT:call(nameOrOpts, ...)
  local name = nameOf(nameOrOpts)
  checkName('browser:call', name)
  local cb, args = splitCallback(...)
  local wire = wireArgs('browser:call', table.unpack(args, 1, args.n))
  return suspendOrCallback('browser:call', cb, function(id)
    send({ to = 'page', browser = self.id, kind = 'pageCallIn', id = id, event = name, args = wdec(wire) })
  end)
end

function __pageResult(id, json, err)
  if err ~= nil and err ~= '' then return settle(id, nil, err) end
  local value = jdec(json)
  if value == null then value = nil end
  settle(id, value)
end

function lsmp.createBrowser(url, opts)
  nextBrowser = nextBrowser + 1
  local b = setmetatable({ id = nextBrowser, url = url, opts = opts or {}, valid = true, visible = true, focus = false, handlers = {} }, BrowserMT)
  browsers[b.id] = b
  lsmp.__test.browsers = browsers
  send({ to = 'page', browser = b.id, kind = 'pageCreate', url = url })
  return b
end

function __pageEmit(browserId, event, argsJson)
  local b = browsers[browserId]
  local args = jdec(argsJson)
  for _, fn in ipairs(b.handlers[event] or {}) do spawn(fn, table.unpack(args)) end
end

function __pageCall(callId, browserId, event, argsJson)
  local b = browsers[browserId]
  local args = jdec(argsJson)
  local handlers = b.handlers[event]
  if handlers == nil or #handlers == 0 then
    return send({ to = 'page', kind = 'pageResult', browser = browserId, id = callId, err = 'no-handler' })
  end
  spawn(function()
    for _, fn in ipairs(handlers) do
      local ok, result = pcall(fn, table.unpack(args))
      if not ok then
        record(result)
        return send({ to = 'page', kind = 'pageResult', browser = browserId, id = callId, err = 'error' })
      end
      if result ~= nil then
        local okWire, wire = pcall(W, result, 'result', 1)
        if not okWire then
          record(wire)
          return send({ to = 'page', kind = 'pageResult', browser = browserId, id = callId, err = 'error' })
        end
        return send({ to = 'page', kind = 'pageResult', browser = browserId, id = callId, value = wdec(wire) })
      end
    end
    send({ to = 'page', kind = 'pageResult', browser = browserId, id = callId, value = null })
  end)
end

local jp, jr = {}, {}
function __press(control) jp[control] = true end
function __release(control) jr[control] = true end
local tickHandlers = {}
function lsmp.onTick(fn)
  table.insert(tickHandlers, fn)
  return function() return true end
end

if SIDE == 'client' then
  function playerId() return 0 end
  function playerPedId() return 500 + LOCAL_ID end
  function getPlayerPed(slot)
    local id = lsmp.__slots[slot]
    return id and 500 + id or 0
  end
  function getEntityCoords(handle) return lsmp.__test.coords[handle] or vec3(100, 200, 30) end
  function isControlJustPressed(_, control) return jp[control] == true end
  function isControlJustReleased(_, control) return jr[control] == true end
  function getGameTimer() return now end
  function lsmp.getEntityFromNetId(netId) return netId + 10000 end
  function lsmp.getNetIdFromEntity(handle)
    if handle > 10000 then return handle - 10000 end
    return nil
  end

  local test = lsmp.__test
  test.spawns, test.resurrects, test.natives, test.dead, test.autoSpawn = {}, {}, {}, false, true
  local firstSpawn = true

  local function spawnEvent(pos, opts)
    local first = firstSpawn
    firstSpawn = false
    fireEngine('playerSpawn', LOCAL_ID, vec3(pos.x, pos.y, pos.z), (opts or {}).heading or 0.0, (opts or {}).model, first)
  end
  function lsmp.spawn(pos, opts)
    test.spawns[#test.spawns + 1] = { pos = { x = pos.x, y = pos.y, z = pos.z }, opts = opts }
    spawnEvent(pos, opts)
    return true
  end
  function lsmp.resurrect(pos, opts)
    test.resurrects[#test.resurrects + 1] = { pos = { x = pos.x, y = pos.y, z = pos.z }, opts = opts }
    return true
  end
  function lsmp.setAutoSpawn(enabled) test.autoSpawn = enabled end
  function lsmp.setAutoSpawnHandler(fn) test.autoHandler = fn end
  function lsmp.closeLoadingScreen() test.loadingClosed = true end
  function __runAutoSpawn()
    if test.autoSpawn and test.autoHandler then spawn(test.autoHandler) end
  end

  local function recorder(name)
    return function(...)
      test.natives[#test.natives + 1] = { name = name, args = table.pack(...) }
    end
  end
  for _, name in ipairs({ 'deleteEntity', 'deleteVehicle', 'deletePed', 'deleteObject', 'removeBlip', 'setBlipDisplay', 'setBlipAlpha',
    'setEntityCoords', 'setEntityHeading', 'freezeEntityPosition', 'setEntityVelocity', 'setVehicleNumberPlateText',
    'setVehicleDoorsLocked', 'setPedIntoVehicle', 'giveWeaponToPed', 'removeAllPedWeapons', 'setPlayerModel', 'setPedArmour',
    'setEntityHealth', 'requestModel', 'setModelAsNoLongerNeeded', 'removeWeaponFromPed', 'giveWeaponComponentToPed', 'setPedAmmo' }) do
    _G[name] = recorder(name)
  end
  local nextBlip = 100
  function addBlipForCoord() nextBlip = nextBlip + 1 return nextBlip end
  function addBlipForEntity() nextBlip = nextBlip + 1 return nextBlip end
  function doesBlipExist(blip) return blip <= nextBlip end
  function isEntityDead() return test.dead end
  function hasModelLoaded() return true end
  function getEntityHeading() return 123.5 end
  function getEntityHealth() return 187 end
  function getPedArmour() return 42 end
  function getVehicleNumberPlateText() return 'LIVE 01' end
  function getEntityVelocity() return 1.0, 2.0, 3.0 end
end

function __tick(dt)
  now = now + dt
  local queue = laterQueue
  laterQueue = {}
  for _, fn in ipairs(queue) do
    local ok, err = pcall(fn)
    if not ok then record(err) end
  end
  local due, rest = {}, {}
  for _, t in ipairs(timers) do
    if t.at <= now then due[#due + 1] = t else rest[#rest + 1] = t end
  end
  timers = rest
  table.sort(due, function(a, b) return a.seq < b.seq end)
  for _, t in ipairs(due) do
    if t.co then
      step(t.co)
    else
      local ok, err = pcall(t.fn, table.unpack(t.args, 1, t.args.n))
      if not ok then record(err) end
    end
  end
  for _, fn in ipairs(tickHandlers) do
    local ok, err = pcall(fn, dt)
    if not ok then record(err) end
  end
  jp, jr = {}, {}
end

local evals, nextEval = {}, 0
function __eval(code)
  nextEval = nextEval + 1
  local id = nextEval
  local chunk, err = hostLoad(code, '=eval', 't')
  if not chunk then
    evals[id] = jenc({ ok = false, error = tostring(err) })
    return id
  end
  spawn(function()
    local ok, result = pcall(chunk)
    if not ok then
      evals[id] = jenc({ ok = false, error = tostring(result) })
    else
      local okJson, text = pcall(jenc, result)
      if okJson then evals[id] = '{"ok":true,"value":' .. text .. '}' else evals[id] = jenc({ ok = false, error = text }) end
    end
  end)
  return id
end
function __evalResult(id) return evals[id] end

function __load(name, source)
  local chunk, err = hostLoad(source, '@' .. RESOURCE .. '/' .. name, 't')
  if not chunk then error(err, 0) end
  spawn(chunk)
end

function __fire(name, argsJson) fireEngine(name, table.unpack(jdec(argsJson))) end
function __logs() return jenc(logs) end
function __errors() return jenc(errors) end

lsmp.__strictLocal = false
_G.lsmp = lsmp
