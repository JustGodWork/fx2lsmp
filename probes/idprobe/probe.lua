---@param label string
---@param ... any
local function show(label, ...)
  local parts = {}
  for i = 1, select('#', ...) do parts[i] = tostring((select(i, ...))) end
  print(('[idprobe] %s: %s'):format(label, table.concat(parts, ', ')))
end

---@param playerId integer
---@param stage string
local function dump(playerId, stage)
  show(stage .. ' player', playerId, lsmp.getPlayerName(playerId))
  show(stage .. ' lsmpId', lsmp.getPlayerLsmpId(playerId))
  show(stage .. ' isGuest', lsmp.isPlayerGuest(playerId))
  for _, kind in ipairs({ 'lsmp', 'name', 'ip', 'hwid' }) do
    show(stage .. ' identifier ' .. kind, lsmp.getPlayerIdentifier(playerId, kind))
  end
  local all, err = lsmp.getPlayerIdentifiers(playerId)
  if type(all) == 'table' then
    for k, v in pairs(all) do show(stage .. ' identifiers.' .. tostring(k), v) end
  else
    show(stage .. ' identifiers', all, err)
  end
end

lsmp.on('playerPreConnection', function(p)
  show('pre', p.name, p.lsmpId, p.guest, p.verified, p.ip, p.hwid)
end)
lsmp.on('playerJoin', function(playerId) dump(playerId, 'join') end)
lsmp.on('playerLeave', function(playerId, _, reason) show('leave reason', reason) dump(playerId, 'leave') end)
