local TROWEL = `prop_cs_trowel`
local sent = 0

RegisterCommand('hello', function(source, args, rawCommand)
  local ped = PlayerPedId()
  local coords = GetEntityCoords(ped)
  sent += 1
  TriggerServerEvent('hello:greet', {
    name = args[1] or 'stranger',
    items = { [101] = 'trowel', [205] = 'bucket' },
    position = coords,
    attempt = sent,
  })
end, false)

RegisterNetEvent('hello:welcome')
AddEventHandler('hello:welcome', function(from, items, total, license)
  print(('welcome from %s (source %s): %d greetings, %s'):format(from, source, total, license))
  SendNUIMessage({ type = 'welcome', from = from, items = items, total = total })
  SetNuiFocus(true, true)
end)

RegisterNetEvent('hello:broadcast', function(text)
  SendNUIMessage({ type = 'broadcast', text = text })
end)

RegisterNUICallback('close', function(data, cb)
  SetNuiFocus(false, false)
  TriggerServerEvent('hello:closed', data.reason)
  cb({ ok = true })
end)

RegisterKeyMapping('+hello_panel', 'Toggle the hello panel', 'keyboard', 'F5')
RegisterCommand('+hello_panel', function()
  SendNUIMessage({ type = 'toggle', visible = true })
end, false)
RegisterCommand('-hello_panel', function()
  SendNUIMessage({ type = 'toggle', visible = false })
end, false)

CreateThread(function()
  Wait(100)
  TriggerServerEvent('hello:ready', GetHashKey(Config.model) == TROWEL)
end)
