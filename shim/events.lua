---@diagnostic disable: lowercase-global
do
  local lsmp <const> = lsmp
  local side <const> = FXC.side
  local encodeArgs, decodeArgs = FXC.encodeArgs, FXC.decodeArgs

  ---@class FxEventHandle
  ---@field fn fun(...: any)
  ---@field event string

  ---@class FxEngineRoute
  ---@field event string
  ---@field adapt fun(...: any): any, ...
  ---@field accept? fun(...: any): boolean

  ---@type integer|string|nil
  source = nil

  ---@type table<string, FxEventHandle[]>
  local registry = {}
  ---@type table<string, boolean>
  local localSubscribed, netSubscribed = {}, {}

  ---@param ... any
  ---@return nil, ...
  local function passthrough(...) return nil, ... end

  ---@type table<string, FxEngineRoute>
  local ENGINE = {
    onResourceStart = { event = 'resourceStart', adapt = passthrough },
    onClientResourceStart = { event = 'resourceStart', adapt = passthrough },
    onServerResourceStart = { event = 'resourceStart', adapt = passthrough },
    onResourceStop = { event = 'resourceStop', adapt = passthrough },
    onClientResourceStop = { event = 'resourceStop', adapt = passthrough },
  }

  if side == 'server' then
    ---@class FxPendingConnection
    ---@field name string
    ---@field lsmpId integer?
    ---@field ip string?
    ---@field hwid string?

    --- FiveM gives playerConnecting a temporary source (65536 and up) that already answers the identifier natives.
    --- LS:MP has no player id before admission, so every resource derives the same id from the connection itself.
    ---@type table<integer, FxPendingConnection>
    local pending <const> = {}
    FXC.pendingConnections = pending

    ---@param p { name: string, lsmpId: integer?, ip: string?, hwid: string? }
    ---@return integer
    local function connectionId(p)
      local key <const> = table.concat({ p.name or '', tostring(p.lsmpId), p.ip or '', p.hwid or '' }, '|')
      local id <const> = 65536 + lsmp.hash(key) % 65536
      if pending[id] == nil then
        pending[id] = { name = p.name, lsmpId = p.lsmpId, ip = p.ip, hwid = p.hwid }
        setTimeout(function() pending[id] = nil end, 120000)
      end
      return id
    end

    -- Registered before any script handler, so the record exists when they run.
    lsmp.on('playerPreConnection', function(p) connectionId(p) end)

    ENGINE.playerDropped = {
      event = 'playerLeave',
      adapt = function(playerId, _, reason, detail)
        local text = tostring(reason)
        if detail ~= nil and detail ~= '' then text = text .. ': ' .. tostring(detail) end
        return playerId, text
      end,
    }
    ENGINE.playerSpawned = {
      event = 'playerSpawn',
      adapt = function(playerId, position, heading, model)
        return playerId, { x = position.x, y = position.y, z = position.z, heading = heading, model = model }
      end,
    }
    --- FiveM passes the temporary connection id as `oldID`.
    ENGINE.playerJoining = {
      event = 'playerJoin',
      adapt = function(playerId, name)
        local account <const> = lsmp.getPlayerLsmpId(playerId)
        for id, record in next, pending do
          if (account ~= nil and record.lsmpId == account) or (account == nil and record.name == name) then
            pending[id] = nil
            return playerId, tostring(id)
          end
        end
        return playerId, tostring(playerId)
      end,
    }
    -- Documented for JS only; a Lua subscription loads fine (docs/notes/probe-server.md), a real connection is unverified.
    ENGINE.playerConnecting = {
      event = 'playerPreConnection',
      adapt = function(p)
        local function setKickReason(reason) p.deny(tostring(reason)) end
        local deferrals = {
          defer = function() end,
          update = function() end,
          presentCard = function() end,
          done = function(reason)
            if reason ~= nil then p.deny(tostring(reason)) end
          end,
        }
        return connectionId(p), p.name, setKickReason, deferrals
      end,
    }
  end

  if side == 'client' then
    ENGINE.playerSpawned = {
      event = 'playerSpawn',
      accept = function(playerId) return playerId == lsmp.getLocalPlayer() end,
      adapt = function(_, position, heading, model)
        return nil, { x = position.x, y = position.y, z = position.z, heading = heading, model = model }
      end,
    }
  end

  --- Runs the handlers of one event. A single handler runs inline (the LS:MP handler coroutine is its own thread),
  --- several get one thread each so that a Wait in one does not delay the others.
  ---@param name string
  ---@param invoker string?
  ---@param src integer|string|nil
  ---@param ... any
  local function dispatch(name, invoker, src, ...)
    local list = registry[name]
    if list == nil then return end
    local count = #list
    if count == 0 then return end
    if src ~= nil then source = src end
    if count == 1 then return FXC.runAs(invoker, list[1].fn, ...) end
    local snapshot = table.pack(table.unpack(list, 1, count))
    local args = table.pack(...)
    for i = 1, count do
      local fn = snapshot[i].fn
      lsmp.createThread(function()
        if src ~= nil then source = src end
        FXC.runAs(invoker, fn, table.unpack(args, 1, args.n))
      end)
    end
  end

  ---@param name string
  ---@param invoker string?
  ---@param ... any
  local function dispatchLocal(name, invoker, ...) return dispatch(name, invoker, nil, decodeArgs(...)) end

  ---@param name string
  local function subscribeLocal(name)
    if localSubscribed[name] then return end
    localSubscribed[name] = true
    local route = ENGINE[name]
    if route ~= nil then
      local accept = route.accept
      lsmp.on(route.event, function(...)
        if accept ~= nil and not accept(...) then return end
        return dispatch(name, nil, route.adapt(...))
      end)
    else
      lsmp.on(name, function(...) return dispatchLocal(name, FXC.splitInvoker(...)) end)
    end
  end

  ---@param name string
  local function subscribeNet(name)
    if netSubscribed[name] then return end
    netSubscribed[name] = true
    if side == 'server' then
      lsmp.onClient(name, function(src, ...) return dispatch(name, nil, src, decodeArgs(...)) end)
    else
      lsmp.onServer(name, function(...) return dispatch(name, nil, FXC.SERVER_SOURCE, decodeArgs(...)) end)
    end
  end

  ---@param name string
  ---@param fn fun(...: any)
  ---@return FxEventHandle
  function AddEventHandler(name, fn)
    ---@type FxEventHandle
    local handle = { fn = fn, event = name }
    local list = registry[name]
    if list == nil then
      list = {}
      registry[name] = list
    end
    list[#list + 1] = handle
    subscribeLocal(name)
    return handle
  end

  ---@param handle FxEventHandle
  function RemoveEventHandler(handle)
    local list = registry[handle.event]
    if list == nil then return end
    for i = 1, #list do
      if list[i] == handle then
        table.remove(list, i)
        return
      end
    end
  end

  ---@param name string
  ---@param fn? fun(...: any)
  ---@return FxEventHandle?
  function RegisterNetEvent(name, fn)
    subscribeNet(name)
    if fn ~= nil then return AddEventHandler(name, fn) end
  end
  RegisterServerEvent = RegisterNetEvent

  --- Engine-routed names are dispatched in the shim and never emitted (LS:MP rejects reserved names).
  ---@param name string
  ---@param ... any
  function TriggerEvent(name, ...)
    if ENGINE[name] ~= nil then return dispatch(name, FXC.resource, nil, ...) end
    lsmp.emit(name, FXC.invokerMarker, encodeArgs(...))
  end

  ---@param name string
  ---@param payload string
  ---@param _length? integer
  function TriggerEventInternal(name, payload, _length)
    return TriggerEvent(name, msgpack.unpack_args(payload))
  end

  function CancelEvent() FXC.warnOnce('cancel', 'CancelEvent has no LS:MP equivalent and does nothing') end
  ---@return boolean
  function WasEventCanceled() return false end

  if side == 'client' then
    ---@param name string
    ---@param ... any
    function TriggerServerEvent(name, ...)
      lsmp.emitServer(name, encodeArgs(...))
    end

    ---@param name string
    ---@param _bps integer
    ---@param ... any
    function TriggerLatentServerEvent(name, _bps, ...)
      lsmp.emitServer(name, encodeArgs(...))
    end

    ---@param name string
    ---@param payload string
    ---@param _length? integer
    function TriggerServerEventInternal(name, payload, _length)
      return TriggerServerEvent(name, msgpack.unpack_args(payload))
    end

    ---@param name string
    ---@param payload string
    ---@param _length? integer
    ---@param _bps? integer
    function TriggerLatentServerEventInternal(name, payload, _length, _bps)
      return TriggerServerEvent(name, msgpack.unpack_args(payload))
    end
  else
    ---@class FxChatLine
    ---@field name string
    ---@field text string
    ---@field system boolean

    ---@param text any
    ---@return string
    local function plainChat(text) return (tostring(text):gsub('%^%d', '')) end

    --- FiveM chat events as the line shape of the LS:MP bundled chat (`chat:message`).
    ---@param event string
    ---@param ... any
    ---@return FxChatLine?
    local function chatLine(event, ...)
      if event == 'chatMessage' then
        local author, _, text = ...
        if text == nil then return nil end
        local name = author == nil and '' or plainChat(author)
        return { name = name, text = plainChat(text), system = name == '' }
      end
      local message = ...
      if type(message) == 'string' then return { name = '', text = plainChat(message), system = true } end
      if type(message) ~= 'table' or type(message.args) ~= 'table' or #message.args == 0 then return nil end
      local args = message.args
      local name = #args > 1 and plainChat(args[1]) or ''
      return { name = name, text = plainChat(args[#args]), system = name == '' }
    end

    ---@param name string
    ---@param target integer|string
    ---@param ... any
    function TriggerClientEvent(name, target, ...)
      local id = FXC.toPlayerId(target)
      if id == nil then error("TriggerClientEvent: invalid target '" .. tostring(target) .. "'", 2) end
      local line = (name == 'chatMessage' or name == 'chat:addMessage') and FXCOMPAT_CONFIG.chatBridge ~= false
        and chatLine(name, ...) or nil
      if id == -1 then
        if line ~= nil then lsmp.emitAllClients('chat:message', line) end
        return lsmp.emitAllClients(name, encodeArgs(...))
      end
      if line ~= nil then lsmp.emitClient(id, 'chat:message', line) end
      return lsmp.emitClient(id, name, encodeArgs(...))
    end

    ---@param name string
    ---@param target integer|string
    ---@param _bps integer
    ---@param ... any
    function TriggerLatentClientEvent(name, target, _bps, ...)
      return TriggerClientEvent(name, target, ...)
    end

    ---@param name string
    ---@param target integer|string
    ---@param payload string
    ---@param _length? integer
    function TriggerClientEventInternal(name, target, payload, _length)
      return TriggerClientEvent(name, target, msgpack.unpack_args(payload))
    end

    ---@param name string
    ---@param target integer|string
    ---@param payload string
    ---@param _length? integer
    ---@param _bps? integer
    function TriggerLatentClientEventInternal(name, target, payload, _length, _bps)
      return TriggerClientEvent(name, target, msgpack.unpack_args(payload))
    end
  end
end
