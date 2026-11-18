import { decode, isRecord } from "./protocol.ts";
import { clientHost, config, expose, host, native, resource, serverHost, toPlayerId, warnOnce } from "./runtime.ts";

// Wire protocol shared with shim/entities.lua, identical for every language shim:
//   server -> owner client, event ENT_EVENT: { netId, ops: EntityOp[] }, netId 0 = the receiving player
//   server -> owner client, call QUERY(netId, field), field = heading|health|plate|velocity|armour, null when the callee does
//   not own the entity or cannot read it, velocity is { x, y, z }
const ENT_EVENT = `fxcompat:ent:${resource}`;
const QUERY = `fxcompat:entq:${resource}`;

const TWO_32 = 4294967296;
const MAX_QUEUE = 32;
const RETRIES = 30;
const RETRY_MS = 100;
const REFRESH_MS = 250;

type EntityKind = "vehicle" | "ped" | "object";
type OpName =
  | "state" | "coords" | "heading" | "velocity" | "warp" | "weapon" | "clearWeapons" | "armour" | "health" | "playerModel"
  | "removeWeapon" | "component" | "ammo";
type QueryField = "heading" | "health" | "plate" | "velocity" | "armour";

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface EntityOp {
  op: OpName;
  plate?: string;
  locks?: number;
  frozen?: boolean;
  x?: number;
  y?: number;
  z?: number;
  h?: number;
  value?: number;
  vehicle?: number;
  seat?: number;
  hash?: number;
  component?: number;
  ammo?: number;
  model?: number;
}

interface EntityRecord {
  model: number | null;
  plate?: string;
  locks?: number;
  frozen?: boolean;
  health?: number;
  armour?: number;
  heading?: number;
  velocity?: Vec3;
  queue: EntityOp[];
}

const OP_NAMES: readonly string[] = [
  "state", "coords", "heading", "velocity", "warp", "weapon", "clearWeapons", "armour", "health", "playerModel",
  "removeWeapon", "component", "ammo",
];
const COALESCED: ReadonlySet<string> = new Set(["coords", "heading", "velocity", "armour", "health"]);
const TYPE_IDS: Readonly<Record<string, number>> = { ped: 1, playerPed: 1, vehicle: 2, object: 3 };

function num(value: unknown): number {
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

function integerOf(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() === "" ? Number.NaN : Number(value);
  return Number.isInteger(n) ? n : null;
}

/** A model hash (unsigned) or a model name, null when invalid. */
function toModel(model: unknown): number | string | null {
  if (typeof model === "string" && model.trim() !== "" && Number.isNaN(Number(model))) return model;
  const n = integerOf(model);
  if (n === null) return null;
  const unsigned = ((n % TWO_32) + TWO_32) % TWO_32;
  return unsigned === 0 ? null : unsigned;
}

function toHash(value: unknown): number | null {
  if (typeof value === "string" && value.trim() !== "" && Number.isNaN(Number(value))) return host.hash(value) >>> 0;
  const n = integerOf(value);
  return n === null ? null : ((n % TWO_32) + TWO_32) % TWO_32;
}

function isOpName(value: unknown): value is OpName {
  return typeof value === "string" && OP_NAMES.includes(value);
}

function isVec3Like(value: unknown): value is Vec3 {
  return isRecord(value) && typeof value["x"] === "number" && typeof value["y"] === "number" && typeof value["z"] === "number";
}

function installServerEntities(server: LsmpServer): void {
  const records = new Map<number, EntityRecord>();
  const cacheStamp = new Map<string, number>();

  const recordOf = (netId: unknown): EntityRecord | null => {
    if (typeof netId !== "number" || !Number.isInteger(netId)) return null;
    if (!server.entityExists(netId)) {
      records.delete(netId);
      return null;
    }
    let rec = records.get(netId);
    const model = server.getEntityModel(netId);
    // LS:MP reuses a netId after a delete
    if (rec !== undefined && rec.model !== null && model !== null && rec.model !== model) rec = undefined;
    if (rec === undefined) {
      rec = { model, queue: [] };
      records.set(netId, rec);
    }
    return rec;
  };

  const send = (owner: number, netId: number, ops: EntityOp[]): void => {
    server.emitClient(owner, ENT_EVENT, { netId, ops });
  };

  const stateOp = (rec: EntityRecord): EntityOp | null => {
    if (rec.plate === undefined && rec.locks === undefined && rec.frozen === undefined) return null;
    const op: EntityOp = { op: "state" };
    if (rec.plate !== undefined) op.plate = rec.plate;
    if (rec.locks !== undefined) op.locks = rec.locks;
    if (rec.frozen !== undefined) op.frozen = rec.frozen;
    return op;
  };

  const flush = (netId: number, rec: EntityRecord, owner: number): void => {
    const ops: EntityOp[] = [];
    const state = stateOp(rec);
    if (state !== null) ops.push(state);
    ops.push(...rec.queue);
    rec.queue = [];
    if (ops.length > 0) send(owner, netId, ops);
  };

  const submit = (netId: number, rec: EntityRecord, op: EntityOp): void => {
    const owner = server.getEntityOwner(netId);
    if (owner !== null) return send(owner, netId, [op]);
    const queue = rec.queue;
    if (COALESCED.has(op.op)) {
      const at = queue.findIndex((queued) => queued.op === op.op);
      if (at >= 0) {
        queue[at] = op;
        return;
      }
    }
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(op);
  };

  // persistent fields wait in the record for the next owner
  const submitState = (netId: number, op: EntityOp): void => {
    const owner = server.getEntityOwner(netId);
    if (owner !== null) send(owner, netId, [op]);
  };

  const create = (kind: EntityKind, model: unknown, x: unknown, y: unknown, z: unknown, heading?: unknown): number => {
    const resolved = toModel(model);
    if (resolved === null) return 0;
    const opts: LsmpCreateEntityOptions = { lifePolicy: "keep" };
    if (kind !== "object" && heading !== undefined) opts.heading = num(heading);
    let netId: number | null = null;
    try {
      netId = server.createEntity(kind, resolved, { x: num(x), y: num(y), z: num(z) }, opts);
    } catch (error) {
      host.warn(`[fxcompat] createEntity(${kind}) failed: ${String(error)}`);
      return 0;
    }
    if (netId === null) {
      host.warn(`[fxcompat] createEntity(${kind}) failed: ${String(server.getLastError())}`);
      return 0;
    }
    const rec: EntityRecord = { model: server.getEntityModel(netId), queue: [] };
    if (opts.heading !== undefined) rec.heading = opts.heading;
    records.set(netId, rec);
    return netId;
  };

  expose("CreateVehicleServerSetter", (model: unknown, _type: unknown, x: unknown, y: unknown, z: unknown, h: unknown) =>
    create("vehicle", model, x, y, z, h));
  expose("CreateVehicle", (model: unknown, x: unknown, y: unknown, z: unknown, h: unknown) => create("vehicle", model, x, y, z, h));
  expose("CreatePed", (_pedType: unknown, model: unknown, x: unknown, y: unknown, z: unknown, h: unknown) =>
    create("ped", model, x, y, z, h));
  const createObject = (model: unknown, x: unknown, y: unknown, z: unknown): number => create("object", model, x, y, z);
  expose("CreateObject", createObject);
  expose("CreateObjectNoOffset", createObject);

  expose("DeleteEntity", (entity: unknown) => {
    if (typeof entity !== "number") return;
    records.delete(entity);
    server.deleteEntity(entity);
  });

  const setCoords = (entity: unknown, x: unknown, y: unknown, z: unknown): void => {
    const rec = recordOf(entity);
    if (rec === null || typeof entity !== "number") return;
    submit(entity, rec, { op: "coords", x: num(x), y: num(y), z: num(z) });
  };
  expose("SetEntityCoords", setCoords);
  expose("SetEntityCoordsNoOffset", setCoords);

  expose("SetEntityHeading", (entity: unknown, heading: unknown) => {
    const rec = recordOf(entity);
    if (rec === null || typeof entity !== "number") return;
    rec.heading = num(heading);
    submit(entity, rec, { op: "heading", h: rec.heading });
  });

  expose("FreezeEntityPosition", (entity: unknown, toggle: unknown) => {
    const rec = recordOf(entity);
    if (rec === null || typeof entity !== "number") return;
    rec.frozen = toggle === true;
    submitState(entity, { op: "state", frozen: rec.frozen });
  });

  expose("SetEntityVelocity", (entity: unknown, x: unknown, y: unknown, z: unknown) => {
    const rec = recordOf(entity);
    if (rec === null || typeof entity !== "number") return;
    rec.velocity = { x: num(x), y: num(y), z: num(z) };
    submit(entity, rec, { op: "velocity", ...rec.velocity });
  });

  expose("SetVehicleNumberPlateText", (vehicle: unknown, text: unknown) => {
    const rec = recordOf(vehicle);
    if (rec === null || typeof vehicle !== "number") return;
    rec.plate = String(text);
    submitState(vehicle, { op: "state", plate: rec.plate });
  });

  expose("SetVehicleDoorsLocked", (vehicle: unknown, status: unknown) => {
    const rec = recordOf(vehicle);
    if (rec === null || typeof vehicle !== "number") return;
    rec.locks = integerOf(status) ?? 0;
    submitState(vehicle, { op: "state", locks: rec.locks });
  });

  expose("SetPedIntoVehicle", (ped: unknown, vehicle: unknown, seat: unknown) => {
    const rec = recordOf(ped);
    if (rec === null || typeof ped !== "number") return;
    submit(ped, rec, { op: "warp", vehicle: num(vehicle), seat: integerOf(seat) ?? -1 });
  });

  expose("TaskWarpPedIntoVehicle", (ped: unknown, vehicle: unknown, seat: unknown) => {
    const rec = recordOf(ped);
    if (rec === null || typeof ped !== "number") return;
    submit(ped, rec, { op: "warp", vehicle: num(vehicle), seat: integerOf(seat) ?? -1 });
  });

  // the ped appears at the vehicle position, then its owner seats it
  expose("CreatePedInsideVehicle", (vehicle: unknown, _pedType: unknown, model: unknown, seat: unknown) => {
    if (typeof vehicle !== "number" || !server.entityExists(vehicle)) return 0;
    const at = server.getEntityCoords(vehicle);
    if (at === null) return 0;
    const ped = create("ped", model, at.x, at.y, at.z, 0);
    const rec = ped === 0 ? null : recordOf(ped);
    if (rec !== null) submit(ped, rec, { op: "warp", vehicle, seat: integerOf(seat) ?? -1 });
    return ped;
  });

  expose("GiveWeaponComponentToPed", (ped: unknown, weapon: unknown, component: unknown) => {
    const rec = recordOf(ped);
    const hash = toHash(weapon);
    const componentHash = toHash(component);
    if (rec === null || hash === null || componentHash === null || typeof ped !== "number") return;
    submit(ped, rec, { op: "component", hash, component: componentHash });
  });

  expose("RemoveWeaponFromPed", (ped: unknown, weapon: unknown) => {
    const rec = recordOf(ped);
    const hash = toHash(weapon);
    if (rec === null || hash === null || typeof ped !== "number") return;
    submit(ped, rec, { op: "removeWeapon", hash });
  });

  expose("SetPedAmmo", (ped: unknown, weapon: unknown, ammo: unknown) => {
    const rec = recordOf(ped);
    const hash = toHash(weapon);
    if (rec === null || hash === null || typeof ped !== "number") return;
    submit(ped, rec, { op: "ammo", hash, ammo: integerOf(ammo) ?? 0 });
  });

  // seat -1 is the driver in FiveM and 0 in LS:MP
  expose("GetPedInVehicleSeat", (vehicle: unknown, seat: unknown) =>
    typeof vehicle === "number" && server.entityExists(vehicle)
      ? (server.getPedInVehicleSeat(vehicle, (integerOf(seat) ?? -1) + 1) ?? 0)
      : 0);
  expose("GetVehiclePedIsIn", (ped: unknown) =>
    typeof ped === "number" && server.entityExists(ped) ? (server.getVehiclePedIsIn(ped) ?? 0) : 0);

  expose("GetAllVehicles", () => Array.from(server.getEntities({ types: ["vehicle"] })));

  expose("GiveWeaponToPed", (ped: unknown, weapon: unknown, ammo: unknown) => {
    const rec = recordOf(ped);
    const hash = toHash(weapon);
    if (rec === null || hash === null || typeof ped !== "number") return;
    submit(ped, rec, { op: "weapon", hash, ammo: integerOf(ammo) ?? 0 });
  });

  expose("RemoveAllPedWeapons", (ped: unknown) => {
    const rec = recordOf(ped);
    if (rec === null || typeof ped !== "number") return;
    submit(ped, rec, { op: "clearWeapons" });
  });

  expose("SetPedArmour", (ped: unknown, amount: unknown) => {
    const rec = recordOf(ped);
    if (rec === null || typeof ped !== "number") return;
    rec.armour = num(amount);
    submit(ped, rec, { op: "armour", value: rec.armour });
  });

  expose("SetEntityHealth", (entity: unknown, health: unknown) => {
    const rec = recordOf(entity);
    if (rec === null || typeof entity !== "number") return;
    rec.health = num(health);
    submit(entity, rec, { op: "health", value: rec.health });
  });

  expose("SetPlayerModel", (src: unknown, model: unknown) => {
    const id = toPlayerId(src);
    const hash = toHash(model);
    if (id === null || hash === null) return;
    send(id, 0, [{ op: "playerModel", model: hash }]);
  });

  expose("SetEntityRoutingBucket", (entity: number, bucket: number) => void server.setEntityDimension(entity, bucket));
  expose("GetEntityRoutingBucket", (entity: number) => server.getEntityDimension(entity) ?? 0);
  expose("GetEntityModel", (entity: number) => server.getEntityModel(entity) ?? 0);
  expose("GetEntityType", (entity: number) => {
    const kind = server.entityExists(entity) ? server.getEntityType(entity) : null;
    return (kind === null ? undefined : TYPE_IDS[kind]) ?? 0;
  });
  expose("NetworkGetEntityOwner", (entity: number) => server.getEntityOwner(entity) ?? -1);

  // Reads come from the owner client. A synchronous getter cannot wait for it, so it returns the last value the shim
  // knows (set through a setter or read earlier) and refreshes that value in the background; the Async twin of each
  // getter resolves with the fresh value, or the last known one when the entity has no owner or the owner cannot answer.
  const ask = async (netId: number, field: QueryField): Promise<unknown> => {
    const owner = server.getEntityOwner(netId);
    if (owner === null) return undefined;
    try {
      return await server.callClient(owner, QUERY, netId, field);
    } catch {
      return undefined;
    }
  };

  const absorb = (rec: EntityRecord, field: QueryField, value: unknown): void => {
    if (field === "heading" && typeof value === "number") rec.heading = value;
    else if (field === "health" && typeof value === "number") rec.health = value;
    else if (field === "armour" && typeof value === "number") rec.armour = value;
    else if (field === "plate" && typeof value === "string") rec.plate = value;
    else if (field === "velocity" && isVec3Like(value)) rec.velocity = { x: value.x, y: value.y, z: value.z };
  };

  const refresh = async (netId: number, rec: EntityRecord, field: QueryField): Promise<void> => {
    absorb(rec, field, await ask(netId, field));
  };

  const refreshSoon = (netId: number, rec: EntityRecord, field: QueryField): void => {
    const key = `${netId}:${field}`;
    const now = host.getTickCount();
    const last = cacheStamp.get(key);
    if (last !== undefined && now - last < REFRESH_MS) return;
    cacheStamp.set(key, now);
    if (cacheStamp.size > 1024) cacheStamp.clear();
    void refresh(netId, rec, field);
  };

  const defineGetter = <T>(name: string, field: QueryField, fallback: T, read: (rec: EntityRecord) => T): void => {
    expose(name, (entity: unknown): T => {
      const rec = recordOf(entity);
      if (rec === null || typeof entity !== "number") return fallback;
      refreshSoon(entity, rec, field);
      return read(rec);
    });
    expose(`${name}Async`, async (entity: unknown): Promise<T> => {
      const rec = recordOf(entity);
      if (rec === null || typeof entity !== "number") return fallback;
      await refresh(entity, rec, field);
      return read(rec);
    });
  };

  defineGetter("GetEntityHeading", "heading", 0, (rec) => rec.heading ?? 0);
  defineGetter("GetEntityHealth", "health", 0, (rec) => rec.health ?? 0);
  defineGetter("GetPedArmour", "armour", 0, (rec) => Math.floor(rec.armour ?? 0));
  defineGetter("GetVehicleNumberPlateText", "plate", "", (rec) => rec.plate ?? "");
  defineGetter<number[]>("GetEntityVelocity", "velocity", [0, 0, 0], (rec) =>
    rec.velocity === undefined ? [0, 0, 0] : [rec.velocity.x, rec.velocity.y, rec.velocity.z]);

  host.on("entityOwnerChange", (netId, _old, newOwner) => {
    if (typeof netId !== "number") return;
    const rec = records.get(netId);
    if (rec === undefined) return;
    if (!server.entityExists(netId)) {
      records.delete(netId);
      return;
    }
    if (typeof newOwner === "number") flush(netId, rec, newOwner);
  });

  host.on("resourceStop", (name) => {
    if (name === resource) records.clear();
  });
}

function readOp(value: unknown): EntityOp | null {
  if (!isRecord(value) || !isOpName(value["op"])) return null;
  const op: EntityOp = { op: value["op"] };
  if (typeof value["plate"] === "string") op.plate = value["plate"];
  if (typeof value["frozen"] === "boolean") op.frozen = value["frozen"];
  for (const key of ["locks", "x", "y", "z", "h", "value", "vehicle", "seat", "hash", "component", "ammo", "model"] as const) {
    const field = value[key];
    if (typeof field === "number") op[key] = field;
  }
  return op;
}

function installClientEntities(client: LsmpClient): void {
  const handleOf = (netId: number): number | null => {
    const handle = client.getEntityFromNetId(netId);
    return typeof handle === "number" && handle !== 0 ? handle : null;
  };
  const owns = (netId: number): boolean => client.getEntityOwner(netId) === client.getLocalPlayer();

  const apply = async (handle: number, op: EntityOp): Promise<void> => {
    switch (op.op) {
      case "state":
        if (op.plate !== undefined) native("setVehicleNumberPlateText")(handle, op.plate);
        if (op.locks !== undefined) native("setVehicleDoorsLocked")(handle, op.locks);
        if (op.frozen !== undefined) native("freezeEntityPosition")(handle, op.frozen);
        return;
      case "coords":
        native("setEntityCoords")(handle, op.x, op.y, op.z, false, false, false, false);
        return;
      case "heading":
        native("setEntityHeading")(handle, op.h);
        return;
      case "velocity":
        native("setEntityVelocity")(handle, op.x, op.y, op.z);
        return;
      case "warp": {
        let vehicle: number | null = null;
        for (let i = 0; i < RETRIES && vehicle === null; i++) {
          vehicle = op.vehicle === undefined ? null : handleOf(op.vehicle);
          if (vehicle === null) await client.wait(RETRY_MS);
        }
        if (vehicle === null) throw new Error(`vehicle ${String(op.vehicle)} is not streamed in`);
        native("setPedIntoVehicle")(handle, vehicle, op.seat);
        return;
      }
      case "weapon":
        native("giveWeaponToPed")(handle, op.hash, op.ammo, false, true);
        return;
      case "clearWeapons":
        native("removeAllPedWeapons")(handle, true);
        return;
      case "removeWeapon":
        native("removeWeaponFromPed")(handle, op.hash);
        return;
      case "component":
        native("giveWeaponComponentToPed")(handle, op.hash, op.component);
        return;
      case "ammo":
        native("setPedAmmo")(handle, op.hash, op.ammo);
        return;
      case "armour":
        native("setPedArmour")(handle, Math.floor(op.value ?? 0));
        return;
      case "health":
        native("setEntityHealth")(handle, Math.floor(op.value ?? 0));
        return;
      case "playerModel":
        return;
    }
  };

  const applySafe = async (handle: number, op: EntityOp): Promise<void> => {
    try {
      await apply(handle, op);
    } catch (error) {
      host.warn(`[fxcompat] entity op ${op.op} failed: ${String(error)}`);
    }
  };

  const applyPlayerModel = async (model: number): Promise<void> => {
    try {
      native("requestModel")(model);
      let waited = 0;
      while (native("hasModelLoaded")(model) !== true && waited < 5000) {
        await client.wait(50);
        waited += 50;
      }
      native("setPlayerModel")(native("playerId")(), model);
      native("setModelAsNoLongerNeeded")(model);
    } catch (error) {
      host.warn(`[fxcompat] SetPlayerModel failed: ${String(error)}`);
    }
  };

  const run = async (netId: number, ops: EntityOp[]): Promise<void> => {
    for (let i = 0; i < RETRIES; i++) {
      if (owns(netId)) {
        const handle = handleOf(netId);
        if (handle !== null) {
          for (const op of ops) await applySafe(handle, op);
          return;
        }
      }
      await client.wait(RETRY_MS);
    }
  };

  client.onServer(ENT_EVENT, (raw) => {
    const msg = decode(raw);
    if (!isRecord(msg) || typeof msg["netId"] !== "number" || !Array.isArray(msg["ops"])) return;
    const ops: EntityOp[] = [];
    for (const entry of msg["ops"]) {
      const op = readOp(entry);
      if (op !== null) ops.push(op);
    }
    if (msg["netId"] === 0) {
      for (const op of ops) if (op.op === "playerModel" && op.model !== undefined) void applyPlayerModel(op.model);
      return;
    }
    void run(msg["netId"], ops);
  });

  const read = (field: QueryField, handle: number): unknown => {
    switch (field) {
      case "heading":
        return native("getEntityHeading")(handle);
      case "health":
        return native("getEntityHealth")(handle);
      case "plate":
        return native("getVehicleNumberPlateText")(handle);
      case "armour":
        return native("getPedArmour")(handle);
      case "velocity": {
        const v = native("getEntityVelocity")(handle);
        if (isVec3Like(v)) return { x: v.x, y: v.y, z: v.z };
        return Array.isArray(v) ? { x: v[0], y: v[1], z: v[2] } : null;
      }
    }
  };

  const isField = (value: unknown): value is QueryField =>
    value === "heading" || value === "health" || value === "plate" || value === "velocity" || value === "armour";

  try {
    client.onCall(QUERY, (netId, field) => {
      if (typeof netId !== "number" || !isField(field) || !owns(netId)) return null;
      const handle = handleOf(netId);
      if (handle === null) return null;
      try {
        return read(field, handle) ?? null;
      } catch {
        return null;
      }
    });
  } catch {
    // another language shim of the same resource already answers the entity queries
    warnOnce("entq", "entity queries are already handled by another shim of this resource");
  }
}

export function installEntities(): void {
  if (serverHost !== null) installServerEntities(serverHost);
  else if (clientHost !== null && config.applyEntities !== false) installClientEntities(clientHost);
}
