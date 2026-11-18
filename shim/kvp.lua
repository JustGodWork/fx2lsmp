---@diagnostic disable: lowercase-global
if FXC.side == 'client' then
  local lsmp <const> = lsmp
  local sort = table.sort

  local WAIT_MS <const> = 5000
  local CALL_TIMEOUT_MS <const> = 3000
  local RETRY_MS <const> = 250
  local MAX_ATTEMPTS <const> = 20

  ---@class FxKvpEntry
  ---@field t 's'|'i'|'f'
  ---@field v string|number

  ---@type table<string, FxKvpEntry>
  local cache = {}
  -- keys written or deleted before the page answered: they win over the loaded values
  ---@type table<string, true>
  local touched = {}
  ---@type 'idle'|'loading'|'ready'|'failed'
  local state = 'idle'
  local attempts = 0
  ---@type LsmpBrowser?
  local browser

  ---@return LsmpBrowser?
  local function page()
    if browser ~= nil and browser:isValid() then return browser end
    local relative = FXCOMPAT_CONFIG.kvpPage
    if relative == nil then
      FXC.warnOnce('kvp-page', 'this resource was not built with the KVP page: client KVP lives in memory only')
      return nil
    end
    browser = lsmp.createBrowser('rsc://' .. FXC.resource .. '/' .. relative, { visible = false, focus = false })
    return browser
  end

  ---@param entry any
  ---@return boolean
  local function validEntry(entry)
    if type(entry) ~= 'table' then return false end
    if entry.t == 's' then return type(entry.v) == 'string' end
    return (entry.t == 'i' or entry.t == 'f') and type(entry.v) == 'number'
  end

  local function startLoad()
    state = 'loading'
    local b = page()
    if b == nil then
      state = 'failed'
      return
    end
    attempts = attempts + 1
    b:call({ name = 'kvp:all', timeoutMs = CALL_TIMEOUT_MS }, function(entries, err)
      if err ~= nil or type(entries) ~= 'table' then
        if attempts >= MAX_ATTEMPTS then
          state = 'failed'
          FXC.warnOnce('kvp-load', 'client KVP could not be loaded from the page: ' .. tostring(err))
          return
        end
        setTimeout(startLoad, RETRY_MS)
        return
      end
      for key, entry in pairs(entries) do
        if not touched[key] and validEntry(entry) then cache[key] = entry end
      end
      state = 'ready'
    end)
  end

  -- Getters stay synchronous: the first read waits (bounded) for the page, inside a host coroutine.
  local function ensureLoaded()
    if state == 'ready' or state == 'failed' then return end
    if state == 'idle' then startLoad() end
    local deadline = lsmp.getTickCount() + WAIT_MS
    while state == 'loading' and lsmp.getTickCount() < deadline do
      if not pcall(lsmp.wait, 0) then break end
    end
    if state == 'loading' then
      FXC.warnOnce('kvp-wait', 'client KVP was read before the page answered: values may be missing')
    end
  end

  ---@param event string
  ---@param ... any
  local function write(event, ...)
    if state == 'idle' then startLoad() end
    local b = page()
    if b == nil then return end
    local ok, err = pcall(b.emit, b, event, ...)
    if not ok then FXC.warnOnce('kvp-emit', 'client KVP write was not persisted: ' .. tostring(err)) end
  end

  ---@param key string
  ---@param t 's'|'i'|'f'
  ---@param v string|number
  local function put(key, t, v)
    cache[key] = { t = t, v = v }
    touched[key] = true
    write('kvp:set', key, t, v)
  end

  ---@param key string
  ---@param value any
  function SetResourceKvp(key, value) put(key, 's', tostring(value)) end

  ---@param key string
  ---@param value number
  function SetResourceKvpInt(key, value) put(key, 'i', math.tointeger(value) or math.floor(value)) end

  ---@param key string
  ---@param value number
  function SetResourceKvpFloat(key, value) put(key, 'f', value + 0.0) end

  SetResourceKvpNoSync, SetResourceKvpIntNoSync, SetResourceKvpFloatNoSync =
    SetResourceKvp, SetResourceKvpInt, SetResourceKvpFloat

  function FlushResourceKvp() end

  ---@param key string
  ---@return string?
  function GetResourceKvpString(key)
    ensureLoaded()
    local entry = cache[key]
    if entry == nil then return nil end
    return tostring(entry.v)
  end

  ---@param key string
  ---@return integer
  function GetResourceKvpInt(key)
    ensureLoaded()
    local entry = cache[key]
    local n = entry ~= nil and tonumber(entry.v) or nil
    if n == nil then return 0 end
    return math.tointeger(n) or math.floor(n)
  end

  ---@param key string
  ---@return number
  function GetResourceKvpFloat(key)
    ensureLoaded()
    local entry = cache[key]
    local n = entry ~= nil and tonumber(entry.v) or nil
    return n ~= nil and n + 0.0 or 0.0
  end

  ---@param key string
  function DeleteResourceKvp(key)
    cache[key] = nil
    touched[key] = true
    write('kvp:del', key)
  end
  DeleteResourceKvpNoSync = DeleteResourceKvp

  ---@class FxKvpFind
  ---@field keys string[]
  ---@field index integer

  ---@type table<integer, FxKvpFind>
  local finds = {}
  local nextFind = 0

  ---@param prefix string
  ---@return integer
  function StartFindKvp(prefix)
    ensureLoaded()
    local keys = {}
    for key in pairs(cache) do
      if key:sub(1, #prefix) == prefix then keys[#keys + 1] = key end
    end
    sort(keys)
    nextFind = nextFind + 1
    finds[nextFind] = { keys = keys, index = 0 }
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
end
