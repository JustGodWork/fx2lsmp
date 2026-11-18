---@alias OxCallback fun(result: any)

---@class OxMethod
---@overload fun(query: any, parameters?: any, cb?: OxCallback)
---@field await fun(query: any, parameters?: any): any

---@class OxLegacy
---@field fetchAll OxMethod
---@field fetchScalar OxMethod
---@field execute OxMethod
---@field insert OxMethod
---@field transaction OxMethod

---@class OxSync
---@field fetchAll fun(query: string, parameters?: any): any
---@field fetchScalar fun(query: string, parameters?: any): any
---@field execute fun(query: string, parameters?: any): any
---@field insert fun(query: string, parameters?: any): any
---@field transaction fun(queries: any[], parameters?: any): any

---@class OxMySQL
---@field query OxMethod
---@field single OxMethod
---@field scalar OxMethod
---@field insert OxMethod
---@field update OxMethod
---@field prepare OxMethod
---@field rawExecute OxMethod
---@field transaction OxMethod
---@field startTransaction fun(fn: fun(query: fun(sql: string, parameters?: any): any): boolean?): boolean
---@field Async OxLegacy
---@field Sync OxSync
---@field ready OxReady
---@field isReady fun(): boolean
---@field awaitConnection fun(): boolean
---@field store fun(query: string, cb?: fun(query: string)): string

do
  local oxmysql <const> = exports.oxmysql

  ---@param method string
  ---@param a any
  ---@param b any
  ---@return any
  local function await(method, a, b)
    local ok, result = oxmysql:__await(method, a, b)
    if not ok then error(tostring(result), 3) end
    return result
  end

  ---@param method string
  ---@return OxMethod
  local function command(method)
    return setmetatable({
      await = function(query, parameters) return await(method, query, parameters) end,
    }, {
      __call = function(_, query, parameters, cb)
        if type(parameters) == 'function' then parameters, cb = nil, parameters end
        CreateThread(function()
          local ok, result = pcall(await, method, query, parameters)
          if not ok then
            print(('^1[oxmysql] %s^7'):format(tostring(result)))
            result = nil
          end
          if cb ~= nil then cb(result) end
        end)
      end,
    })
  end

  ---@type OxMySQL
  ---@diagnostic disable-next-line: missing-fields
  MySQL = {
    query = command('query'),
    single = command('single'),
    scalar = command('scalar'),
    insert = command('insert'),
    update = command('update'),
    prepare = command('prepare'),
    rawExecute = command('rawExecute'),
    transaction = command('transaction'),
  }

  ---@param fn fun(query: fun(sql: string, parameters?: any): any): boolean?
  ---@return boolean
  function MySQL.startTransaction(fn) return await('startTransaction', fn, nil) end

  ---@return boolean
  function MySQL.isReady() return oxmysql:isReady() end

  ---@return boolean
  function MySQL.awaitConnection() return oxmysql:awaitConnection() end

  ---@class OxReady
  ---@field await fun()
  ---@overload fun(cb: fun())
  MySQL.ready = setmetatable({
    await = function() MySQL.awaitConnection() end,
  }, {
    __call = function(_, cb)
      CreateThread(function()
        MySQL.awaitConnection()
        cb()
      end)
    end,
  })

  ---@param query string
  ---@param cb? fun(query: string)
  ---@return string
  function MySQL.store(query, cb)
    if cb ~= nil then cb(query) end
    return query
  end

  ---@type OxLegacy
  MySQL.Async = {
    fetchAll = MySQL.query,
    fetchScalar = MySQL.scalar,
    execute = MySQL.update,
    insert = MySQL.insert,
    transaction = MySQL.transaction,
  }

  ---@type OxSync
  MySQL.Sync = {
    fetchAll = function(query, parameters) return MySQL.query.await(query, parameters) end,
    fetchScalar = function(query, parameters) return MySQL.scalar.await(query, parameters) end,
    execute = function(query, parameters) return MySQL.update.await(query, parameters) end,
    insert = function(query, parameters) return MySQL.insert.await(query, parameters) end,
    transaction = function(queries, parameters) return MySQL.transaction.await(queries, parameters) end,
  }
end
