import { clientHost, config, expose, host, native, resource, serverHost, warnOnce } from "./runtime.ts";

const EVENT = `fxcompat:b1:delete:${resource}`;

const DELETES: readonly [string, string][] = [
  ["DeleteEntity", "deleteEntity"],
  ["DeleteVehicle", "deleteVehicle"],
  ["DeletePed", "deletePed"],
  ["DeleteObject", "deleteObject"],
];

const BLIP_CREATORS: readonly [string, string][] = [
  ["AddBlipForCoord", "addBlipForCoord"],
  ["AddBlipForEntity", "addBlipForEntity"],
  ["AddBlipForArea", "addBlipForArea"],
  ["AddBlipForRadius", "addBlipForRadius"],
  ["AddBlipForPickup", "addBlipForPickup"],
];

// A client can only delete entities it owns, and the delete runs under the capabilities of this resource.
function installServerSide(server: LsmpServer): void {
  server.onClient(EVENT, (playerId, netId) => {
    if (typeof netId !== "number" || !Number.isInteger(netId) || !server.entityExists(netId)) return;
    if (server.getEntityOwner(netId) !== playerId) {
      warnOnce("b1-owner", `player ${String(playerId)} asked to delete entity ${netId} it does not own`);
      return;
    }
    let deleted = false;
    try {
      deleted = server.deleteEntity(netId);
    } catch (error) {
      host.warn(`[fxcompat] deleteEntity ${netId} refused: ${String(error)}`);
      return;
    }
    if (!deleted) host.warn(`[fxcompat] deleteEntity ${netId} refused: ${String(server.getLastError())}`);
  });
}

function installClientSide(client: LsmpClient): void {
  for (const [fiveM, lsmpName] of DELETES) {
    expose(fiveM, (entity: unknown) => {
      if (typeof entity !== "number" || entity === 0) return;
      const netId = client.getNetIdFromEntity(entity);
      if (netId === null) {
        warnOnce("b1-local", `${fiveM} on a non-networked entity does nothing until LS:MP fixes B1`);
        return native(lsmpName)(entity);
      }
      client.emitServer(EVENT, netId);
    });
  }

  const removed = new Set<number>();
  expose("RemoveBlip", (blip: unknown) => {
    if (typeof blip !== "number") return;
    native("setBlipDisplay")(blip, 0);
    native("setBlipAlpha")(blip, 0);
    removed.add(blip);
  });
  expose("DoesBlipExist", (blip: number) => !removed.has(blip) && native("doesBlipExist")(blip) === true);

  // a new blip may reuse the handle of a removed one
  for (const [fiveM, lsmpName] of BLIP_CREATORS) {
    expose(fiveM, (...args: unknown[]) => {
      const blip = native(lsmpName)(...args);
      if (typeof blip === "number") removed.delete(blip);
      return blip;
    });
  }
}

export function installB1(): void {
  if (config.b1Workarounds === false) return;
  if (serverHost !== null) installServerSide(serverHost);
  else if (clientHost !== null) installClientSide(clientHost);
}
