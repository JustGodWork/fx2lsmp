---@diagnostic disable: lowercase-global
do
  local lsmp <const> = lsmp
  local isServer <const> = FXC.side == 'server'
  local encode <const>, decode <const> = FXC.encode, FXC.decode
  local warnOnce <const> = FXC.warnOnce

  ---@alias FxBagScope 'global'|'player'|'entity'

  ---@class FxBagCore
  ---@field scope FxBagScope
  ---@field target integer?
  ---@field name string

  ---@class FxStateBag
  ---@field set fun(self: FxStateBag, key: string, value: any, replicated?: boolean)
  ---@field [string] any

  ---@class FxBagOwner
  ---@field state FxStateBag

  ---@class FxBagHandler
  ---@field cookie integer
  ---@field key string?
  ---@field bag string?
  ---@field fn fun(bagName: string, key: string, value: any, reserved: integer, replicated: boolean)

  ---@type table<FxStateBag, FxBagCore>
  local cores <const> = setmetatable({}, { __mode = 'k' })
  ---@type table<string, table<string, any>>
  local localValues <const> = {}
  ---@type table<integer, FxBagOwner>
  local players <const> = {}
  ---@type table<integer, FxBagOwner>
  local entities <const> = setmetatable({}, { __mode = 'v' })
  ---@type (FxBagHandler|false)[]
  local handlers <const> = {}
  local nextCookie, depth, dirty, hooked, leaveHooked = 0, 0, false, false, false

  ---@param scope FxBagScope
  ---@param target integer?
  ---@return string
  local function bagName(scope, target)
    if scope == 'global' then return 'global' end
    return scope .. ':' .. tostring(target)
  end

  ---@param bag string
  ---@param key string
  ---@param value any
  ---@param replicated boolean
  local function dispatch(bag, key, value, replicated)
    local count <const> = #handlers
    depth = depth + 1
    for i = 1, count do
      local h <const> = handlers[i]
      if h and (h.key == nil or h.key == key) and (h.bag == nil or h.bag == bag) then
        local ok <const>, err <const> = pcall(h.fn, bag, key, value, 0, replicated)
        if not ok then lsmp.error('[fxcompat] state bag handler failed: ' .. tostring(err)) end
      end
    end
    depth = depth - 1
    if depth == 0 and dirty then
      dirty = false
      for i = #handlers, 1, -1 do
        if not handlers[i] then table.remove(handlers, i) end
      end
    end
  end

  local function hookMeta()
    if hooked then return end
    hooked = true
    lsmp.on('metaChange', function(scope, target, key, value)
      dispatch(bagName(scope, target), key, decode(value), true)
    end)
  end

  local function hookLeave()
    if leaveHooked or not isServer then return end
    leaveHooked = true
    lsmp.on('playerLeave', function(id)
      SetTimeout(1000, function() localValues[bagName('player', id)] = nil end)
    end)
  end

  ---@param core FxBagCore
  ---@param key string
  ---@return any
  local function readLocal(core, key)
    local values <const> = localValues[core.name]
    if values == nil then return nil end
    if core.scope == 'entity' and not lsmp.entityExists(core.target) then
      localValues[core.name] = nil
      return nil
    end
    return values[key]
  end

  ---@param core FxBagCore
  ---@param key string
  ---@return any
  local function readMeta(core, key)
    local scope <const>, target <const> = core.scope, core.target
    if scope == 'global' then return decode(lsmp.getGlobalMeta(key)) end
    if target == nil then return nil end
    if scope == 'player' then return decode(lsmp.getPlayerMeta(target, key)) end
    return decode(lsmp.getEntityMeta(target, key))
  end

  ---@param core FxBagCore
  ---@param key any
  ---@return any
  local function read(core, key)
    if type(key) ~= 'string' then return nil end
    local value <const> = readLocal(core, key)
    if value ~= nil then return value end
    return readMeta(core, key)
  end

  ---@param core FxBagCore
  ---@param key string
  ---@param value any
  ---@return boolean?
  ---@return string?
  local function setMeta(core, key, value)
    local scope <const>, target <const> = core.scope, core.target
    if scope == 'global' then return lsmp.setGlobalMeta(key, value) end
    if target == nil then return false, 'no network id' end
    if scope == 'player' then return lsmp.setPlayerMeta(target, key, value) end
    return lsmp.setEntityMeta(target, key, value)
  end

  ---@param core FxBagCore
  ---@param key string
  ---@param value any
  local function writeLocal(core, key, value)
    local values = localValues[core.name]
    if values == nil then
      if value == nil then return end
      values = {}
      localValues[core.name] = values
    end
    if rawequal(values[key], value) then return end
    values[key] = value
    if next(values) == nil then localValues[core.name] = nil end
    if core.scope == 'player' then hookLeave() end
    dispatch(core.name, key, value, false)
  end

  ---@param core FxBagCore
  ---@param key string
  ---@param value any
  local function writeReplicated(core, key, value)
    local values <const> = localValues[core.name]
    if values ~= nil and values[key] ~= nil then
      values[key] = nil
      if next(values) == nil then localValues[core.name] = nil end
    end
    local ok <const>, res <const>, why <const> = pcall(setMeta, core, key, encode(value))
    if ok and res ~= false then return end
    warnOnce('statebag:' .. core.scope .. ':' .. key, 'state bag write of "' .. key .. '" on ' .. core.scope
      .. ' refused (' .. tostring(ok and (why or 'refused') or res) .. '): values are limited to 8 KiB, clients may only write their own'
      .. ' player and the entities they own, and only the server writes global')
  end

  ---@param core FxBagCore
  ---@param key any
  ---@param value any
  ---@param replicated boolean?
  local function write(core, key, value, replicated)
    if type(key) ~= 'string' or key == '' then
      warnOnce('statebag:key', 'state bag keys must be non empty strings')
      return
    end
    if replicated == false then return writeLocal(core, key, value) end
    return writeReplicated(core, key, value)
  end

  ---@param self FxStateBag
  ---@param key string
  ---@param value any
  ---@param replicated? boolean
  local function setMethod(self, key, value, replicated)
    local core <const> = cores[self]
    if core ~= nil then write(core, key, value, replicated) end
  end

  ---@type metatable
  local BAG_MT <const> = {
    __index = function(self, key)
      if key == 'set' then return setMethod end
      local core <const> = cores[self]
      return core ~= nil and read(core, key) or nil
    end,
    __newindex = function(self, key, value)
      local core <const> = cores[self]
      if core ~= nil then write(core, key, value, true) end
    end,
  }

  ---@param scope FxBagScope
  ---@param target integer?
  ---@return FxStateBag
  local function newBag(scope, target)
    local bag <const> = setmetatable({}, BAG_MT)
    cores[bag] = { scope = scope, target = target, name = bagName(scope, target) }
    return bag
  end

  GlobalState = newBag('global', nil)

  ---@param id integer|string
  ---@return FxBagOwner
  function Player(id)
    local playerId <const> = FXC.toPlayerId(id) or 0
    local owner = players[playerId]
    if owner == nil then
      owner = { state = newBag('player', playerId) }
      players[playerId] = owner
    end
    return owner
  end

  ---@param handle integer
  ---@return FxBagOwner
  function Entity(handle)
    local netId <const> = isServer and math.tointeger(handle) or lsmp.getNetIdFromEntity(handle)
    if netId == nil then return { state = newBag('entity', nil) } end
    local owner = entities[netId]
    if owner == nil then
      owner = { state = newBag('entity', netId) }
      entities[netId] = owner
    end
    return owner
  end

  if not isServer then
    LocalPlayer = setmetatable({}, {
      __index = function(_, key)
        if key ~= 'state' then return nil end
        local id <const> = lsmp.getLocalPlayer()
        return id ~= nil and Player(id).state or nil
      end,
    })
  end

  ---@param keyFilter string?
  ---@param bagFilter string?
  ---@param handler fun(bagName: string, key: string, value: any, reserved: integer, replicated: boolean)
  ---@return integer cookie
  function AddStateBagChangeHandler(keyFilter, bagFilter, handler)
    hookMeta()
    nextCookie = nextCookie + 1
    handlers[#handlers + 1] = {
      cookie = nextCookie,
      key = keyFilter ~= '' and keyFilter or nil,
      bag = bagFilter ~= '' and bagFilter or nil,
      fn = handler,
    }
    return nextCookie
  end

  ---@param cookie integer
  function RemoveStateBagChangeHandler(cookie)
    for i, h in ipairs(handlers) do
      if h and h.cookie == cookie then
        if depth > 0 then
          handlers[i] = false
          dirty = true
        else
          table.remove(handlers, i)
        end
        return
      end
    end
  end

  ---@param name string
  ---@return integer
  function GetPlayerFromStateBagName(name)
    local id <const> = tonumber(string.match(name, '^player:(%d+)$'))
    if id == nil then return 0 end
    if isServer then return id end
    local slot <const> = GetPlayerFromServerId(id)
    return slot >= 0 and slot or 0
  end

  ---@param name string
  ---@return integer
  function GetEntityFromStateBagName(name)
    local netId <const> = tonumber(string.match(name, '^entity:(%d+)$'))
    if netId == nil then return 0 end
    if isServer then return netId end
    return lsmp.getEntityFromNetId(netId) or 0
  end
end
