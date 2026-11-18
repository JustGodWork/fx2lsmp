local greetings = 0
local boots = GetResourceKvpInt('boots')
boots += 1
SetResourceKvpInt('boots', boots)

exports('getGreetings', function()
  return greetings, GetResourceKvpString('last_greeter')
end)

RegisterNetEvent('hello:greet')
AddEventHandler('hello:greet', function(payload)
  local src = source
  greetings += 1
  SetResourceKvp('last_greeter', payload.name)
  print(('greeting from source %s: %s, item 101 = %s, attempt %d'):format(src, payload.name, payload.items[101], payload.attempt))

  local total = exports.hello:getGreetings()
  local license = GetPlayerIdentifierByType(src, 'license') or 'unknown'
  TriggerClientEvent('hello:welcome', src, payload.name, payload.items, total, license)
  TriggerClientEvent('hello:broadcast', -1, Config.greeting:format(payload.name))
end)

RegisterNetEvent('hello:ready', function(hashesMatch)
  print(('client %s ready, backtick hash matches GetHashKey: %s'):format(source, tostring(hashesMatch)))
end)

RegisterNetEvent('hello:closed', function(reason)
  SetResourceKvp('last_close', ('%s:%s'):format(source, reason))
end)

RegisterCommand('greetings', function(source, args)
  print(('greetings so far: %d'):format(greetings))
end, true)

AddEventHandler('onResourceStart', function(resource)
  if resource ~= GetCurrentResourceName() then return end
  print(('%s started, boot number %d'):format(resource, boots))
end)

AddEventHandler('playerDropped', function(reason)
  print(('player %s left: %s'):format(source, reason))
end)

CreateThread(function()
  local ready = promise.new()
  SetTimeout(50, function() ready:resolve('ready') end)
  READY = Citizen.Await(ready)
end)
