---@diagnostic disable: lowercase-global
if FXC.side == 'server' then
  local lsmp <const> = lsmp
  local toPlayerId <const> = FXC.toPlayerId

  ---@return string[]
  function GetPlayers()
    local out = {}
    for i, id in ipairs(lsmp.getPlayers()) do out[i] = tostring(id) end
    return out
  end

  local pending <const> = FXC.pendingConnections

  --- A temporary `playerConnecting` source, before LS:MP gives the player an id.
  ---@param src integer|string
  ---@return FxPendingConnection?
  local function connecting(src)
    local id <const> = toPlayerId(src)
    return id and pending[id] or nil
  end

  ---@param src integer|string
  ---@return string?
  function GetPlayerName(src)
    local record <const> = connecting(src)
    if record ~= nil then return record.name end
    local id = toPlayerId(src)
    return id and lsmp.getPlayerName(id) or nil
  end

  ---@param src integer|string
  ---@return string[]
  function GetPlayerIdentifiers(src)
    local out = {}
    local record <const> = connecting(src)
    if record ~= nil then
      if record.lsmpId ~= nil then out[#out + 1] = 'license:' .. tostring(record.lsmpId) end
      if record.ip ~= nil then out[#out + 1] = 'ip:' .. record.ip end
      out[#out + 1] = 'name:' .. record.name
      return out
    end
    local id = toPlayerId(src)
    if id == nil then return out end
    local account = lsmp.getPlayerLsmpId(id)
    if account ~= nil then out[#out + 1] = 'license:' .. tostring(account) end
    local ip = lsmp.getPlayerIdentifier(id, 'ip')
    if ip ~= nil then out[#out + 1] = 'ip:' .. ip end
    local name = lsmp.getPlayerName(id)
    if name ~= nil then out[#out + 1] = 'name:' .. name end
    return out
  end

  ---@param src integer|string
  ---@param kind string
  ---@return string?
  function GetPlayerIdentifierByType(src, kind)
    local prefix = kind .. ':'
    for _, identifier in ipairs(GetPlayerIdentifiers(src)) do
      if identifier:sub(1, #prefix) == prefix then return identifier end
    end
    return nil
  end

  ---@param src integer|string
  ---@return integer
  function GetNumPlayerIdentifiers(src) return #GetPlayerIdentifiers(src) end

  --- Zero based, like FiveM.
  ---@param src integer|string
  ---@param index integer
  ---@return string?
  function GetPlayerIdentifier(src, index) return GetPlayerIdentifiers(src)[index + 1] end

  ---@param src integer|string
  ---@param reason? string
  function DropPlayer(src, reason)
    local id = toPlayerId(src)
    if id ~= nil then lsmp.kickPlayer(id, reason) end
  end

  --- LS:MP exposes no latency: a connected player reports 1 ms and a missing one 0, which is what callers test.
  ---@param src integer|string
  ---@return integer
  function GetPlayerPing(src)
    FXC.warnOnce('ping', 'GetPlayerPing: LS:MP has no latency API, a connected player always reports 1')
    local id = toPlayerId(src)
    return id ~= nil and lsmp.getPlayerName(id) ~= nil and 1 or 0
  end

  ---@type table<integer, integer> tick count of the first sighting of each player
  local joinedAt = {}

  lsmp.on('playerJoin', function(id) joinedAt[id] = lsmp.getTickCount() end)
  lsmp.on('playerLeave', function(id) joinedAt[id] = nil end)

  --- Seconds since the player joined, counted from the first sighting for players present before the shim loaded.
  ---@param src integer|string
  ---@return integer
  function GetPlayerTimeOnline(src)
    local id = toPlayerId(src)
    if id == nil or lsmp.getPlayerName(id) == nil then return 0 end
    local since = joinedAt[id]
    if since == nil then
      since = lsmp.getTickCount()
      joinedAt[id] = since
    end
    return (lsmp.getTickCount() - since) // 1000
  end

  --- LS:MP cannot stop a resource while the server runs.
  ---@param name string
  ---@return boolean
  function StopResource(name)
    FXC.warnOnce('stopresource', 'StopResource(' .. tostring(name) .. '): LS:MP resources cannot be stopped at runtime, ignored')
    return false
  end

  ---@param src integer|string
  ---@return integer
  function GetPlayerPed(src)
    local id = toPlayerId(src)
    return id and lsmp.getPlayerPed(id) or 0
  end

  ---@param entity integer
  ---@return any
  function GetEntityCoords(entity) return lsmp.getEntityCoords(entity) or vector3(0.0, 0.0, 0.0) end

  ---@param entity integer
  ---@return boolean
  function DoesEntityExist(entity) return lsmp.entityExists(entity) end

  ---@param entity integer
  function DeleteEntity(entity) lsmp.deleteEntity(entity) end

  --- A netId and a server entity handle are the same number in LS:MP.
  ---@param entity integer
  ---@return integer
  function NetworkGetNetworkIdFromEntity(entity) return entity end

  ---@param netId integer
  ---@return integer
  function NetworkGetEntityFromNetworkId(netId) return netId end

  ---@param src integer|string
  ---@return integer
  function GetPlayerRoutingBucket(src)
    local id = toPlayerId(src)
    return id and lsmp.getPlayerDimension(id) or 0
  end

  ---@param src integer|string
  ---@param bucket integer
  function SetPlayerRoutingBucket(src, bucket)
    local id = toPlayerId(src)
    if id ~= nil then lsmp.setPlayerDimension(id, bucket) end
  end

  ---@param src integer|string
  ---@param ace string
  ---@return boolean
  function IsPlayerAceAllowed(src, ace)
    local id = toPlayerId(src)
    return id ~= nil and lsmp.perms.has(id, ace:lower()) == true
  end

  ---@return integer
  function GetGameTimer() return lsmp.getTickCount() end

  ---@param key string
  ---@param value string
  function SetResourceKvp(key, value) lsmp.storage.set(key, tostring(value)) end

  ---@param key string
  ---@param value number
  function SetResourceKvpInt(key, value) lsmp.storage.set(key, math.tointeger(value) or math.floor(value)) end

  ---@param key string
  ---@param value number
  function SetResourceKvpFloat(key, value) lsmp.storage.set(key, value + 0.0) end

  SetResourceKvpNoSync = SetResourceKvp
  SetResourceKvpIntNoSync = SetResourceKvpInt
  SetResourceKvpFloatNoSync = SetResourceKvpFloat

  ---@param key string
  ---@return string?
  function GetResourceKvpString(key)
    local value = lsmp.storage.get(key)
    if value == nil then return nil end
    return tostring(value)
  end

  ---@param key string
  ---@return integer
  function GetResourceKvpInt(key)
    local n = tonumber(lsmp.storage.get(key))
    if n == nil then return 0 end
    return math.tointeger(n) or math.floor(n)
  end

  ---@param key string
  ---@return number
  function GetResourceKvpFloat(key)
    local n = tonumber(lsmp.storage.get(key))
    return n and n + 0.0 or 0.0
  end

  ---@param key string
  function DeleteResourceKvp(key) lsmp.storage.delete(key) end

  ---@class FxServerKvpFind
  ---@field keys string[]
  ---@field index integer

  ---@type table<integer, FxServerKvpFind>
  local finds = {}
  local nextFind = 0

  ---@param prefix string
  ---@return integer
  function StartFindKvp(prefix)
    nextFind = nextFind + 1
    finds[nextFind] = { keys = lsmp.storage.keys(prefix), index = 0 }
    return nextFind
  end

  ---@param handle integer
  ---@return string?
  function FindKvp(handle)
    local find = finds[handle]
    if find == nil then return nil end
    find.index = find.index + 1
    return find.keys[find.index]
  end

  ---@param handle integer
  function EndFindKvp(handle) finds[handle] = nil end

  ---@param url string
  ---@param callback? fun(status: integer, body: string?, headers: table<string, any>, errorData: string?)
  ---@param method? string
  ---@param data? string
  ---@param headers? table<string, string>
  function PerformHttpRequest(url, callback, method, data, headers)
    local verb = (method or 'GET'):upper()
    ---@type table<string, any>
    local request = { url = url, method = verb, headers = headers }
    if data ~= nil and data ~= '' and verb ~= 'GET' and verb ~= 'HEAD' then request.body = data end
    lsmp.http.request(request, function(response, code)
      if callback == nil then return end
      if response == nil then return callback(0, nil, {}, code) end
      callback(response.status, response.body, response.headers or {}, nil)
    end)
  end

  ---@param line string
  function ExecuteCommand(line) lsmp.executeCommand(nil, line) end

  --- Console and admin panel source is 0, as in FiveM. Without `restricted = true` every player may run the command (FiveM default).
  ---@param name string
  ---@param handler fun(source: integer, args: string[], rawCommand: string)
  ---@param restricted? boolean
  function RegisterCommand(name, handler, restricted)
    FXC.noteCommand(name)
    ---@type table<string, any>
    local opts = {}
    if restricted ~= true then opts.permission = false end
    lsmp.registerCommand(name, opts, function(args, raw, src)
      local rawCommand = name
      if raw ~= nil and raw ~= '' then rawCommand = name .. ' ' .. raw end
      local id = src or 0
      source = id
      return handler(id, args, rawCommand)
    end)
  end
end
