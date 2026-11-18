let greetings = 0;
let boots = GetResourceKvpInt('boots');
boots += 1;
SetResourceKvpInt('boots', boots);

exports('getGreetings', () => [greetings, GetResourceKvpString('last_greeter')]);

onNet('hello:greet', async (payload) => {
  const src = source;
  greetings += 1;
  SetResourceKvp('last_greeter', payload.name);
  console.log(`greeting from source ${src}: ${payload.name}, item 101 = ${payload.items[101]}, attempt ${payload.attempt}`);

  const [total] = await exports[GetCurrentResourceName()].getGreetings();
  const license = GetPlayerIdentifierByType(src, 'license') || 'unknown';
  TriggerClientEvent('hello:welcome', src, payload.name, payload.items, total, license);
  TriggerClientEvent('hello:broadcast', -1, Config.greeting.replace('%s', payload.name));
});

onNet('hello:ready', (hashesMatch) => {
  console.log(`client ${source} ready, hash matches GetHashKey: ${hashesMatch}`);
});

onNet('hello:closed', (reason) => {
  SetResourceKvp('last_close', `${source}:${reason}`);
});

RegisterCommand('greetings', () => {
  console.log(`greetings so far: ${greetings}`);
}, true);

on('onResourceStart', (resource) => {
  if (resource !== GetCurrentResourceName()) return;
  console.log(`${resource} started, boot number ${boots}, model ${Config.model}`);
  const car = CreateVehicle('adder', 0.0, 0.0, 72.0, 90.0, true, true);
  SetVehicleNumberPlateText(car, 'FXC 001');
  SetEntityHeading(car, 180.0);
  SetVehicleDoorsLocked(car, 2);
  SetEntityRoutingBucket(car, 0);
  console.log(`${resource} vehicle created, netId ${car}, model ${GetEntityModel(car)}, type ${GetEntityType(car)}`);
});

on('playerDropped', (reason) => {
  console.log(`player ${source} left: ${reason}`);
});

setTick(async () => {
  await Wait(1000);
  console.log(`tick: ${GetPlayers().length} players`);
});
