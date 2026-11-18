---@class SpawnPoint
---@field x number
---@field y number
---@field z number
---@field heading number?
---@field model integer|string?
---@field idx integer?

local DEATH_RESPAWN_DELAY_MS <const> = 2000

---@type table<integer, SpawnPoint>
local spawnPoints = {}
local nextIndex = 0
local autoSpawnEnabled = true
---@type (fun())?
local autoSpawnCallback

---@param spawn any
---@return boolean
local function isSpawn(spawn)
  return type(spawn) == 'table' and type(spawn.x) == 'number' and type(spawn.y) == 'number' and type(spawn.z) == 'number'
end

--- A dead ped is revived in place (LS:MP never respawns after death); the model of a revived ped does not change.
---@param spawnIdxOrTable integer|SpawnPoint
---@param cb? fun(spawn: SpawnPoint)
---@return boolean
local function spawnPlayer(spawnIdxOrTable, cb)
  local spawn = spawnIdxOrTable
  if type(spawnIdxOrTable) == 'number' then spawn = spawnPoints[spawnIdxOrTable] end
  if not isSpawn(spawn) then error('spawnPlayer: expected a spawn table with x, y, z or the index of a spawn point', 2) end
  local position = { x = spawn.x, y = spawn.y, z = spawn.z }
  local ok
  if IsEntityDead(PlayerPedId()) then
    ok = lsmp.resurrect(position, { heading = spawn.heading })
  else
    ok = lsmp.spawn(position, { heading = spawn.heading or 0.0, model = spawn.model })
  end
  if ok and cb ~= nil then cb(spawn) end
  return ok
end

---@param spawn SpawnPoint
---@return integer
local function addSpawnPoint(spawn)
  if not isSpawn(spawn) then error('addSpawnPoint: a spawn point needs x, y and z', 2) end
  nextIndex = nextIndex + 1
  spawn.idx = nextIndex
  spawnPoints[nextIndex] = spawn
  return nextIndex
end

---@param index integer
local function removeSpawnPoint(index) spawnPoints[index] = nil end

---@param spawnsJson string
local function loadSpawns(spawnsJson)
  local data, err = json.decode(spawnsJson)
  if type(data) ~= 'table' or type(data.spawns) ~= 'table' then
    error('loadSpawns: ' .. tostring(err or 'no spawns array'), 2)
  end
  for _, spawn in ipairs(data.spawns) do addSpawnPoint(spawn) end
end

local function runAutoSpawn()
  if autoSpawnCallback ~= nil then return autoSpawnCallback() end
  local indexes = {}
  for index in pairs(spawnPoints) do indexes[#indexes + 1] = index end
  if #indexes == 0 then
    print('spawnmanager: no spawn point and no auto spawn callback, the player stays unspawned')
    lsmp.closeLoadingScreen()
    return
  end
  table.sort(indexes)
  spawnPlayer(indexes[math.random(#indexes)])
end

---@param enabled boolean
local function setAutoSpawn(enabled)
  autoSpawnEnabled = enabled == true
  lsmp.setAutoSpawn(autoSpawnEnabled)
end

---@param callback fun()
local function setAutoSpawnCallback(callback)
  autoSpawnCallback = callback
  setAutoSpawn(true)
end

local function forceRespawn() runAutoSpawn() end

lsmp.setAutoSpawnHandler(runAutoSpawn)

lsmp.on('playerDeath', function(playerId)
  if playerId ~= lsmp.getLocalPlayer() then return end
  Wait(DEATH_RESPAWN_DELAY_MS)
  if autoSpawnEnabled and IsEntityDead(PlayerPedId()) then runAutoSpawn() end
end)

exports('spawnPlayer', spawnPlayer)
exports('addSpawnPoint', addSpawnPoint)
exports('removeSpawnPoint', removeSpawnPoint)
exports('loadSpawns', loadSpawns)
exports('setAutoSpawn', setAutoSpawn)
exports('setAutoSpawnCallback', setAutoSpawnCallback)
exports('forceRespawn', forceRespawn)
