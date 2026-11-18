---@diagnostic disable: lowercase-global
do
  local lib <const> = FXC.promiseLib
  local Promise <const> = lib.Promise
  local new <const> = Promise.new

  --- CfxLua scripts also write `promise:new()`, which passes the library table as the executor.
  ---@param executor? fun(resolve: fun(...: any), reject: fun(reason: any))|table
  ---@return table
  function Promise.new(executor)
    if type(executor) ~= 'function' then return new() end
    return new(executor)
  end

  promise = Promise
  Citizen.Await = lib.await
end
