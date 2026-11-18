---@diagnostic disable: lowercase-global
if FXC.side == 'client' then
  local lsmp <const> = lsmp
  local aliases <const> = NATIVES_ALIAS
  local byte, sub, lower = string.byte, string.sub, string.lower

  ---@param previous any
  ---@param t table
  ---@param key any
  ---@return any
  local function chain(previous, t, key)
    if type(previous) == 'function' then return previous(t, key) end
    if type(previous) == 'table' then return previous[key] end
    return nil
  end

  --- The catalogue holds N_0x names as 16 upper case hex digits; user code writes other forms.
  ---@param key string
  ---@return string?
  local function hashAlias(key)
    local digits = key:match('^N_0[xX](%x+)$')
    if digits == nil or #digits > 16 then return nil end
    return aliases['N_0x' .. string.rep('0', 16 - #digits) .. digits:upper()]
  end

  ---@param key string
  ---@return string
  local function aliasOf(key)
    return aliases[key] or hashAlias(key) or (lower(sub(key, 1, 1)) .. sub(key, 2))
  end

  --- A native by its FiveM name. Does not rely on the lazy _G lookup, which the LS:MP client refuses.
  ---@param key string
  ---@return (fun(...: any): ...)?
  local function native(key)
    local fn = rawget(_G, key)
    if fn == nil then
      local ok, found = pcall(function() return _G[aliasOf(key)] end)
      fn = ok and found or nil
    end
    return type(fn) == 'function' and fn or nil
  end

  ---@param key string
  ---@return fun(...: any): ...
  local function requireNative(key)
    local fn <const> = native(key)
    if fn == nil then error('LS:MP has no native ' .. key, 2) end
    return fn
  end

  do
    local meta = getmetatable(_G)
    local previous = type(meta) == 'table' and meta.__index or nil
    ---@param t table
    ---@param key any
    ---@return any
    local function resolve(t, key)
      if type(key) == 'string' then
        local first = byte(key, 1)
        if first ~= nil and first >= 65 and first <= 90 then
          local alias = aliasOf(key)
          local fn = rawget(t, alias)
          if fn == nil then fn = chain(previous, t, alias) end
          if fn ~= nil then
            rawset(t, key, fn)
            return fn
          end
        end
      end
      return chain(previous, t, key)
    end
    -- The LS:MP client protects the _G metatable (getmetatable returns a boolean): only the eager pass below works there.
    if type(meta) == 'table' then
      pcall(function() meta.__index = resolve end)
    elseif meta == nil then
      pcall(setmetatable, _G, { __index = resolve })
    end
    for _, key in ipairs(FXCOMPAT_CONFIG.natives or {}) do
      if rawget(_G, key) == nil then
        local fn = native(key)
        if fn ~= nil then rawset(_G, key, fn) end
      end
    end
  end

  ---@type table<string, fun(...: any): ...>
  local G <const> = _G

  ---@type table<table, true>
  local invokeMarkers <const> = {}

  ---@param name string
  ---@return fun(): table
  local function markerFactory(name)
    return function()
      local m = setmetatable({}, { __name = name })
      invokeMarkers[m] = true
      return m
    end
  end

  -- LS:MP natives return their results directly and out parameters as extra results: the FiveM result and pointer
  -- markers that trail an InvokeNative call carry no information here and are removed from the arguments.
  for _, name in ipairs({
    'ResultAsInteger', 'ResultAsLong', 'ResultAsFloat', 'ResultAsString', 'ResultAsVector', 'ResultAsObject',
    'ResultAsObject2', 'ReturnResultAnyway', 'PointerValueInt', 'PointerValueFloat', 'PointerValueVector',
    'PointerValueIntInitialized', 'PointerValueFloatInitialized',
  }) do
    Citizen[name] = markerFactory(name)
  end

  --- Resolves the hash through the generated N_0x table of the alias file.
  ---@param hash integer|string
  ---@param ... any
  ---@return ...
  function Citizen.InvokeNative(hash, ...)
    local number = math.tointeger(tonumber(hash))
    if number == nil then error('Citizen.InvokeNative: invalid native hash ' .. tostring(hash), 2) end
    local name = aliases[string.format('N_0x%016X', number)]
    if name == nil then
      error(string.format('Citizen.InvokeNative: native 0x%016X is not in the LS:MP catalogue', number), 2)
    end
    local fn = G[name]
    if fn == nil then error('Citizen.InvokeNative: LS:MP has no native ' .. name, 2) end
    local args = table.pack(...)
    local count = 0
    for i = 1, args.n do
      local v = args[i]
      if not (type(v) == 'table' and invokeMarkers[v]) then
        count = count + 1
        args[count] = v
      end
    end
    for i = count + 1, args.n do args[i] = nil end
    return fn(table.unpack(args, 1, count))
  end

  ---@param serverId integer|string
  ---@return integer
  function GetPlayerFromServerId(serverId)
    local id = FXC.toLsmp(serverId)
    if id == nil then return -1 end
    if id == lsmp.getLocalPlayer() then return requireNative('PlayerId')() end
    local ped = lsmp.getPlayerPed(id)
    if ped == nil then return -1 end
    local getPlayerPed <const> = requireNative('GetPlayerPed')
    for slot = 0, 63 do
      if getPlayerPed(slot) == ped then return slot end
    end
    return -1
  end

  ---@param slot integer
  ---@return integer
  function GetPlayerServerId(slot)
    if slot == requireNative('PlayerId')() then
      local own <const> = lsmp.getLocalPlayer()
      return own ~= nil and FXC.toFiveM(own) or 0
    end
    local ped = requireNative('GetPlayerPed')(slot)
    if ped == nil or ped == 0 then return 0 end
    for _, id in ipairs(lsmp.getPlayers()) do
      if lsmp.getPlayerPed(id) == ped then return FXC.toFiveM(id) end
    end
    return 0
  end

  ---@return integer[]
  function GetActivePlayers()
    local out = {}
    for _, id in ipairs(lsmp.getPlayers()) do
      local slot = GetPlayerFromServerId(FXC.toFiveM(id))
      if slot ~= -1 then out[#out + 1] = slot end
    end
    return out
  end

  ---@param handle integer
  ---@return integer
  function NetworkGetNetworkIdFromEntity(handle) return lsmp.getNetIdFromEntity(handle) or 0 end

  ---@param netId integer
  ---@return integer
  function NetworkGetEntityFromNetworkId(netId) return lsmp.getEntityFromNetId(netId) or 0 end

  NetToEnt, NetToVeh, NetToPed, NetToObj = NetworkGetEntityFromNetworkId, NetworkGetEntityFromNetworkId,
    NetworkGetEntityFromNetworkId, NetworkGetEntityFromNetworkId
  VehToNet, PedToNet, ObjToNet = NetworkGetNetworkIdFromEntity, NetworkGetNetworkIdFromEntity,
    NetworkGetNetworkIdFromEntity

  ---@type LsmpBrowser?
  local browser
  ---@type table<string, fun(data: any, cb: fun(response?: any, error?: any))>
  local callbacks = {}
  ---@type table<string, boolean>
  local bound = {}
  local focused, cursor, keepInput = false, false, false
  local CALLBACK_TIMEOUT_MS <const> = 15000

  ---@param fn fun(data: any, cb: fun(response?: any, error?: any))
  ---@param data any
  ---@return any
  local function runCallback(fn, data)
    local done, answer = false, nil
    local function cb(value)
      if done then return end
      done, answer = true, value
    end
    fn(FXC.fromJson(data), cb)
    if not done then
      local deadline = lsmp.getTickCount() + CALLBACK_TIMEOUT_MS
      while not done and lsmp.getTickCount() < deadline do lsmp.wait(0) end
    end
    if answer == nil then return nil end
    return FXC.toJson(answer)
  end

  ---@param b LsmpBrowser
  local function bindCallbacks(b)
    for name, fn in pairs(callbacks) do
      if not bound[name] then
        bound[name] = true
        b:on(name, function(data) return runCallback(fn, data) end)
      end
    end
  end

  ---@return LsmpBrowser?
  local function nuiBrowser()
    if browser ~= nil and browser:isValid() then
      bindCallbacks(browser)
      return browser
    end
    local page = FXCOMPAT_CONFIG.uiPage
    if page == nil then
      FXC.warnOnce('nui', 'this resource has no ui_page: NUI calls are ignored')
      return nil
    end
    bound = {}
    browser = lsmp.createBrowser('rsc://' .. FXC.resource .. '/' .. page, { visible = true, focus = false })
    if browser ~= nil then bindCallbacks(browser) end
    return browser
  end

  ---@param data any
  ---@return boolean
  function SendNUIMessage(data)
    local b = nuiBrowser()
    if b == nil then return false end
    return b:emit('__fxnui', FXC.toJson(data))
  end

  ---@param name string
  ---@param fn fun(data: any, cb: fun(response?: any, error?: any))
  function RegisterNUICallback(name, fn)
    callbacks[name] = fn
    nuiBrowser()
  end

  ---@class FxRawNuiRequest
  ---@field resource string
  ---@field path string
  ---@field method string
  ---@field headers table<string, string>
  ---@field body string

  ---@class FxRawNuiResponse
  ---@field body string?
  ---@field status integer?
  ---@field headers table<string, string>?

  --- The handler gets the page data as JSON text; the body of its answer is decoded before it reaches the page.
  ---@param name string
  ---@param fn fun(request: FxRawNuiRequest, cb: fun(response?: FxRawNuiResponse))
  function RegisterRawNuiCallback(name, fn)
    RegisterNUICallback(name, function(data, cb)
      fn({
        resource = FXC.resource,
        path = '/' .. name,
        method = 'POST',
        headers = {},
        body = json.encode(data),
      }, function(response)
        local body = type(response) == 'table' and response.body or nil
        if body == nil then return cb() end
        local value, err = json.decode(body)
        if err ~= nil then return cb(body) end
        cb(value)
      end)
    end)
  end

  --- LS:MP has no game text chat to switch off.
  ---@param _enabled boolean
  function SetTextChatEnabled(_enabled) end

  --- The client cannot read server permissions: always false, the server decides.
  ---@param _ace string
  ---@return boolean
  function IsAceAllowed(_ace) return false end

  local function applyFocus()
    local b = nuiBrowser()
    if b == nil then return end
    if not focused then
      b:setFocus(false)
    else
      b:setFocus(true, { cursor = cursor or keepInput, keepInput = keepInput })
    end
  end

  ---@param hasFocus boolean
  ---@param hasCursor boolean
  function SetNuiFocus(hasFocus, hasCursor)
    focused, cursor = hasFocus == true, hasCursor == true
    applyFocus()
  end

  ---@param keep boolean
  function SetNuiFocusKeepInput(keep)
    keepInput = keep == true
    if focused then applyFocus() end
  end

  ---@return boolean
  function IsNuiFocused() return focused end

  ---@type table<string, (fun(source: integer, args: string[], rawCommand: string))[]>
  local commands = {}

  ---@param line string
  ---@return string name
  ---@return string[] args
  ---@return string rest
  local function splitLine(line)
    local name, rest = line:match('^%s*/?(%S+)%s*(.*)$')
    local args = {}
    for word in (rest or ''):gmatch('%S+') do args[#args + 1] = word end
    return name or '', args, rest or ''
  end

  ---@param name string
  ---@param handler fun(source: integer, args: string[], rawCommand: string)
  ---@param _restricted? boolean
  function RegisterCommand(name, handler, _restricted)
    FXC.noteCommand(name)
    local key = lower(name)
    local list = commands[key]
    if list == nil then
      list = {}
      commands[key] = list
    end
    list[#list + 1] = handler
    -- '+name' and '-name' are not valid LS:MP command names: only key mappings and ExecuteCommand reach them
    if name:find('^[%w_.:%-]+$') then
      lsmp.registerCommand(name, function(args, raw)
        local rawCommand = name
        if raw ~= nil and raw ~= '' then rawCommand = name .. ' ' .. raw end
        return handler(0, args, rawCommand)
      end)
    end
  end

  ---@param name string
  ---@param args string[]
  ---@param rawCommand string
  ---@return boolean
  local function runLocal(name, args, rawCommand)
    local list = commands[lower(name)]
    if list == nil then return false end
    for i = 1, #list do lsmp.createThread(list[i], 0, args, rawCommand) end
    return true
  end

  ---@param line string
  function ExecuteCommand(line)
    local name, args, rest = splitLine(line)
    runLocal(name, args, rest ~= '' and (name .. ' ' .. rest) or name)
  end

  --- Game control ids (INPUT_*) of the keyboard keys FiveM key mappings usually use.
  ---@type table<string, integer>
  local KEY_CONTROLS <const> = {
    Q = 44, E = 38, R = 45, T = 245, Y = 246, U = 303, H = 74, F = 23, G = 47, K = 311, L = 182, Z = 20, X = 73,
    C = 26, V = 0, B = 29, N = 249, M = 244, TAB = 37, SPACE = 22, LSHIFT = 21, LCONTROL = 36, LMENU = 19,
    RETURN = 191, BACK = 177, UP = 172, DOWN = 173, LEFT = 174, RIGHT = 175, DELETE = 178, HOME = 212,
    PAGEUP = 10, PAGEDOWN = 11, F1 = 288, F2 = 289, F3 = 170, F5 = 166, F6 = 167, F7 = 168, F8 = 169, F9 = 56,
    F10 = 57,
  }

  ---@class FxKeyMapping
  ---@field control integer
  ---@field press string
  ---@field release string?

  ---@type FxKeyMapping[]
  local mappings = {}
  local polling = false
  ---@type fun(...: any): ...
  local justPressed, justReleased

  local function poll()
    for i = 1, #mappings do
      local m = mappings[i]
      if justPressed(0, m.control) then runLocal(m.press, {}, m.press) end
      if m.release ~= nil and justReleased(0, m.control) then runLocal(m.release, {}, m.release) end
    end
  end

  --- Polls the control natives once per frame: LS:MP has no key mapping API.
  ---@param command string
  ---@param _description string
  ---@param device string
  ---@param key string
  function RegisterKeyMapping(command, _description, device, key)
    if lower(device) ~= 'keyboard' then
      FXC.warnOnce('keymap:' .. device, "key mapping device '" .. device .. "' is not supported")
      return
    end
    local control = KEY_CONTROLS[key:upper()]
    if control == nil then
      FXC.warnOnce('key:' .. key, "key '" .. key .. "' has no control id in the shim table: mapping ignored")
      return
    end
    ---@type FxKeyMapping
    local mapping = { control = control, press = command }
    if command:sub(1, 1) == '+' then mapping.release = '-' .. command:sub(2) end
    mappings[#mappings + 1] = mapping
    if not polling then
      polling = true
      justPressed, justReleased = requireNative('IsControlJustPressed'), requireNative('IsControlJustReleased')
      lsmp.onTick(poll)
    end
  end
end
