---@param label string
---@param fn fun(): ...
local function show(label, fn)
  local res <const> = table.pack(pcall(fn))
  local parts <const> = {}
  for i = 2, res.n do parts[#parts + 1] = tostring(res[i]) end
  print(('[netprobe] %s: %s%s'):format(label, res[1] and '' or 'ERROR ', table.concat(parts, ', ')))
end

---@param stage string
local function dump(stage)
  print('[netprobe] stage: ' .. stage)
  local me <const> = playerId()
  local ped <const> = getPlayerPed(me)
  local netId <const> = lsmp.getNetIdFromEntity(ped)
  show('lsmp.getLocalPlayer', function() return lsmp.getLocalPlayer() end)
  show('playerId (slot)', function() return me end)
  show('networkIsSessionStarted', function() return networkIsSessionStarted() end)
  show('networkIsGameInProgress', function() return networkIsGameInProgress() end)
  show('networkIsInSession', function() return networkIsInSession() end)
  show('networkIsPlayerActive(me)', function() return networkIsPlayerActive(me) end)
  show('networkIsPlayerConnected(me)', function() return networkIsPlayerConnected(me) end)
  show('networkIsPlayerActive(other slots 1..3)', function()
    return networkIsPlayerActive(1), networkIsPlayerActive(2), networkIsPlayerActive(3)
  end)
  show('networkGetNumConnectedPlayers', function() return networkGetNumConnectedPlayers() end)
  show('getNumberOfPlayers', function() return getNumberOfPlayers() end)
  show('networkIsHost', function() return networkIsHost() end)
  show('networkGetPlayerIndexFromPed(own ped), expect slot ' .. tostring(me), function()
    return networkGetPlayerIndexFromPed(ped)
  end)
  show('networkPlayerIdToInt', function() return networkPlayerIdToInt() end)
  show('lsmp.getNetIdFromEntity(own ped)', function() return netId end)
  show('networkGetNetworkIdFromEntity(own ped)', function() return networkGetNetworkIdFromEntity(ped) end)
  show('networkGetEntityIsNetworked(own ped)', function() return networkGetEntityIsNetworked(ped) end)
  show('networkDoesNetworkIdExist(lsmp net id)', function() return networkDoesNetworkIdExist(netId or 0) end)
  show('networkDoesEntityExistWithNetworkId(lsmp net id)', function()
    return networkDoesEntityExistWithNetworkId(netId or 0)
  end)
  show('networkGetEntityFromNetworkId(lsmp net id), expect ' .. tostring(ped), function()
    return networkGetEntityFromNetworkId(netId or 0)
  end)
  show('networkHasControlOfEntity(own ped)', function() return networkHasControlOfEntity(ped) end)
  show('isNetworkLoadingScene', function() return isNetworkLoadingScene() end)
  show('isPedAPlayer(own ped)', function() return isPedAPlayer(ped) end)
  show('isPauseMenuActive', function() return isPauseMenuActive() end)
  show('networkSetFriendlyFireOption(true)', function() networkSetFriendlyFireOption(true) end)
  show('networkSetLocalPlayerSyncLookAt(true)', function() networkSetLocalPlayerSyncLookAt(true) end)
  show('shutdownLoadingScreen (blocked: expect policy error)', function() shutdownLoadingScreen() end)
  show('setNetworkIdCanMigrate (blocked: expect policy error)', function() setNetworkIdCanMigrate(netId or 0, true) end)
  show('setWeatherTypeNow (blocked: expect policy error)', function() setWeatherTypeNow('CLEAR') end)
end

local started <const> = lsmp.getTickCount()
local done = { false, false }
lsmp.onTick(function()
  local elapsed <const> = lsmp.getTickCount() - started
  if not done[1] and elapsed > 5000 then
    done[1] = true
    dump('early (just loaded)')
  elseif not done[2] and elapsed > 45000 then
    done[2] = true
    dump('late (spawned and walking around)')
  end
end)
