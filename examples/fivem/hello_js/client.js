const TROWEL = GetHashKey('prop_cs_trowel');
let sent = 0;

RegisterCommand('hello', (_source, args) => {
  const [x, y, z] = GetEntityCoords(PlayerPedId());
  sent += 1;
  TriggerServerEvent('hello:greet', {
    name: args[0] || 'stranger',
    items: { 101: 'trowel', 205: 'bucket' },
    position: { x, y, z },
    attempt: sent,
  });
}, false);

onNet('hello:welcome', (from, items, total, license) => {
  console.log(`welcome from ${from} (source ${source}): ${total} greetings, ${license}`);
  SendNUIMessage({ type: 'welcome', from, items, total });
  SetNuiFocus(true, true);
});

onNet('hello:broadcast', (text) => {
  SendNUIMessage({ type: 'broadcast', text });
});

RegisterNuiCallbackType('close');
on('__cfx_nui:close', (data, cb) => {
  SetNuiFocus(false, false);
  TriggerServerEvent('hello:closed', data.reason);
  cb({ ok: true });
});

RegisterKeyMapping('+hello_panel', 'Toggle the hello panel', 'keyboard', 'F5');
RegisterCommand('+hello_panel', () => SendNUIMessage({ type: 'toggle', visible: true }), false);
RegisterCommand('-hello_panel', () => SendNUIMessage({ type: 'toggle', visible: false }), false);

(async () => {
  await Wait(100);
  TriggerServerEvent('hello:ready', GetHashKey('prop_cs_trowel') === TROWEL);
})();
