---@diagnostic disable: lowercase-global
do
  local lib <const> = FXC.promiseLib
  promise = lib.Promise
  Citizen.Await = lib.await
end
