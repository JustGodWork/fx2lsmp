---@diagnostic disable: lowercase-global
-- B1 workarounds (docs/LSMP-FEEDBACK.md): `b1Workarounds = false` in FXCOMPAT_CONFIG disables them all, deleting this
-- file and its SHIM_ORDER entry in tools/fx2lsmp/cli.ts removes them once B1 is fixed.
if FXCOMPAT_CONFIG.b1Workarounds ~= false then
  local lsmp <const> = lsmp
  local EVENT <const> = 'fxcompat:b1:delete:' .. FXC.resource

  if FXC.side == 'server' then
    -- Limits: a client can only delete entities it owns (orphans and foreign entities are refused), and the delete
    -- runs under the capabilities of this resource (`entities.foreign` for entities of other owners).
    lsmp.onClient(EVENT, function(playerId, netId)
      if math.type(netId) ~= 'integer' or not lsmp.entityExists(netId) then return end
      if lsmp.getEntityOwner(netId) ~= playerId then
        FXC.warnOnce('b1-owner', 'player ' .. tostring(playerId) .. ' asked to delete entity ' .. tostring(netId) .. ' it does not own')
        return
      end
      local ok, code = lsmp.deleteEntity(netId)
      if not ok then lsmp.warn('[fxcompat] deleteEntity ' .. tostring(netId) .. ' refused: ' .. tostring(code)) end
    end)
  else
    local aliases <const> = NATIVES_ALIAS
    ---@type table<string, fun(...: any): ...>
    local G <const> = _G

    ---@param name string PascalCase FiveM name
    ---@return fun(...: any): ...
    local function native(name)
      local fn = G[aliases[name] or (name:sub(1, 1):lower() .. name:sub(2))]
      if fn == nil then error('fxcompat: native ' .. name .. ' is not available', 3) end
      return fn
    end

    ---@param name string
    ---@return fun(entity: integer?)
    local function networkedDelete(name)
      return function(entity)
        if math.type(entity) ~= 'integer' or entity == 0 then return end
        local netId = lsmp.getNetIdFromEntity(entity)
        if netId == nil then
          FXC.warnOnce('b1-local', name .. ' on a non-networked entity does nothing until LS:MP fixes B1')
          return native(name)(entity)
        end
        lsmp.emitServer(EVENT, netId)
      end
    end

    DeleteEntity = networkedDelete('DeleteEntity')
    DeleteVehicle = networkedDelete('DeleteVehicle')
    DeletePed = networkedDelete('DeletePed')
    DeleteObject = networkedDelete('DeleteObject')

    ---@type table<integer, true>
    local removed = {}

    ---@param blip any
    function RemoveBlip(blip)
      if math.type(blip) ~= 'integer' then return end
      native('SetBlipDisplay')(blip, 0)
      native('SetBlipAlpha')(blip, 0)
      removed[blip] = true
    end

    ---@param blip integer
    ---@return boolean
    function DoesBlipExist(blip)
      if removed[blip] then return false end
      return native('DoesBlipExist')(blip)
    end

    -- a new blip may reuse the handle of a removed one
    ---@param name string
    ---@return fun(...: any): integer?
    local function blipCreator(name)
      return function(...)
        local blip = native(name)(...)
        if blip ~= nil then removed[blip] = nil end
        return blip
      end
    end

    AddBlipForCoord = blipCreator('AddBlipForCoord')
    AddBlipForEntity = blipCreator('AddBlipForEntity')
    AddBlipForArea = blipCreator('AddBlipForArea')
    AddBlipForRadius = blipCreator('AddBlipForRadius')
    AddBlipForPickup = blipCreator('AddBlipForPickup')
  end
end
