import { expose, guestLicense, host, serverHost, toFiveM, toLsmp, warnOnce } from "./runtime.ts";
import { isRecord } from "./protocol.ts";

type Command = (source: number, args: string[], rawCommand: string) => unknown;

const commandNames: string[] = [];

function playerOf(src: unknown): number | null {
  return toLsmp(src);
}

// FiveM still answers the identifier natives inside playerDropped; LS:MP 0.6.8 returns null there.
const lastIdentifiers = new Map<number, string[]>();
const IDENTIFIERS_KEPT_MS = 30000;

function identifiersOf(server: LsmpServer, src: unknown): string[] {
  const id = playerOf(src);
  const out: string[] = [];
  if (id === null) return out;
  const account = server.getPlayerLsmpId(id);
  const license = account !== null && account !== undefined ? `license:${String(account)}` : guestLicense(server.getPlayerIdentifier(id, "hwid"));
  const known = lastIdentifiers.get(id);
  if (license === null && known !== undefined) return [...known];
  if (license !== null) out.push(license);
  const ip = server.getPlayerIdentifier(id, "ip");
  if (ip !== null && ip !== undefined) out.push(`ip:${ip}`);
  const name = server.getPlayerName(id);
  if (name !== null && name !== undefined) out.push(`name:${name}`);
  if (license !== null) lastIdentifiers.set(id, [...out]);
  return out;
}

function toInteger(value: unknown): number {
  const n = Number(value);
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}

function toFloat(value: unknown): number {
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

function installKvp(server: LsmpServer): void {
  const finds = new Map<number, { keys: string[]; index: number }>();
  let lastFind = 0;
  const setString = (key: string, value: unknown): void => void server.storage.set(key, String(value));
  const setInt = (key: string, value: number): void => void server.storage.set(key, Math.trunc(value));
  const setFloat = (key: string, value: number): void => void server.storage.set(key, value);
  expose("SetResourceKvp", setString);
  expose("SetResourceKvpNoSync", setString);
  expose("SetResourceKvpInt", setInt);
  expose("SetResourceKvpIntNoSync", setInt);
  expose("SetResourceKvpFloat", setFloat);
  expose("SetResourceKvpFloatNoSync", setFloat);
  expose("GetResourceKvpString", (key: string) => {
    const value = server.storage.get(key);
    return value === null || value === undefined ? null : String(value);
  });
  expose("GetResourceKvpInt", (key: string) => toInteger(server.storage.get(key)));
  expose("GetResourceKvpFloat", (key: string) => toFloat(server.storage.get(key)));
  expose("DeleteResourceKvp", (key: string) => void server.storage.delete(key));
  expose("DeleteResourceKvpNoSync", (key: string) => void server.storage.delete(key));
  expose("FlushResourceKvp", () => {});
  expose("StartFindKvp", (prefix: string) => {
    finds.set(++lastFind, { keys: server.storage.keys(prefix), index: 0 });
    return lastFind;
  });
  expose("FindKvp", (handle: number) => {
    const find = finds.get(handle);
    if (find === undefined) return null;
    return find.keys[find.index++] ?? null;
  });
  expose("EndFindKvp", (handle: number) => void finds.delete(handle));
}

function installPlayers(server: LsmpServer): void {
  const identifiers = (src: unknown): string[] => identifiersOf(server, src);
  expose("GetPlayers", () => server.getPlayers().map((id) => String(toFiveM(id))));
  expose("GetPlayerName", (src: unknown) => {
    const id = playerOf(src);
    return id === null ? null : server.getPlayerName(id);
  });
  expose("GetPlayerIdentifiers", identifiers);
  expose("GetPlayerIdentifierByType", (src: unknown, kind: string) =>
    identifiers(src).find((e) => e.startsWith(`${kind}:`)) ?? null);
  expose("GetNumPlayerIdentifiers", (src: unknown) => identifiers(src).length);
  expose("GetPlayerIdentifier", (src: unknown, index: number) => identifiers(src)[index] ?? null);
  expose("DropPlayer", (src: unknown, reason?: string) => {
    const id = playerOf(src);
    if (id !== null) server.kickPlayer(id, reason);
  });
  // LS:MP has no latency API: a connected player reports 1, a missing one 0, which is what callers test
  expose("GetPlayerPing", (src: unknown) => {
    warnOnce("ping", "GetPlayerPing: LS:MP has no latency API, a connected player always reports 1");
    const id = playerOf(src);
    return id !== null && server.getPlayerName(id) !== null ? 1 : 0;
  });
  const joinedAt = new Map<number, number>();
  host.on("playerJoin", (id) => {
    if (typeof id !== "number") return;
    joinedAt.set(id, host.getTickCount());
    identifiers(toFiveM(id));
  });
  host.on("playerLeave", (id) => {
    if (typeof id !== "number") return;
    joinedAt.delete(id);
    // kept a while: another resource's playerDropped handler reaches this one through an export after this dispatch
    const kept = lastIdentifiers.get(id);
    setTimeout(() => {
      if (lastIdentifiers.get(id) === kept) lastIdentifiers.delete(id);
    }, IDENTIFIERS_KEPT_MS);
  });
  // seconds since the join, counted from the first sighting for players present before the shim loaded
  expose("GetPlayerTimeOnline", (src: unknown) => {
    const id = playerOf(src);
    if (id === null || server.getPlayerName(id) === null) return 0;
    const now = host.getTickCount();
    const since = joinedAt.get(id) ?? now;
    joinedAt.set(id, since);
    return Math.floor((now - since) / 1000);
  });
  expose("StopResource", (name: unknown) => {
    warnOnce("stopresource", `StopResource(${String(name)}): LS:MP resources cannot be stopped at runtime, ignored`);
    return false;
  });
  expose("GetPlayerPed", (src: unknown) => {
    const id = playerOf(src);
    return id === null ? 0 : (server.getPlayerPed(id) ?? 0);
  });
  expose("GetPlayerRoutingBucket", (src: unknown) => {
    const id = playerOf(src);
    return id === null ? 0 : server.getPlayerDimension(id);
  });
  expose("SetPlayerRoutingBucket", (src: unknown, bucket: number) => {
    const id = playerOf(src);
    if (id !== null) server.setPlayerDimension(id, bucket);
  });
  expose("IsPlayerAceAllowed", (src: unknown, ace: string) => {
    const id = playerOf(src);
    return id !== null && server.perms.has(id, ace.toLowerCase()) === true;
  });
}

function installEntities(server: LsmpServer): void {
  expose("GetEntityCoords", (entity: number) => {
    const c = server.getEntityCoords(entity);
    return c === null ? [0, 0, 0] : [c.x, c.y, c.z];
  });
  expose("DoesEntityExist", (entity: number) => server.entityExists(entity));
  expose("NetworkGetNetworkIdFromEntity", (entity: number) => entity);
  expose("NetworkGetEntityFromNetworkId", (netId: number) => netId);
}

function installHttp(server: LsmpServer): void {
  expose(
    "PerformHttpRequest",
    (
      url: string,
      callback?: (status: number, body: string | null, headers: Record<string, unknown>, error: string | null) => void,
      method?: string,
      data?: string,
      headers?: Record<string, string>,
    ) => {
      const verb = (method ?? "GET").toUpperCase();
      const request: LsmpHttpRequest = { url, method: verb };
      if (headers !== undefined) request.headers = headers;
      if (data !== undefined && data !== "" && verb !== "GET" && verb !== "HEAD") request.body = data;
      server.http.request(request).then(
        (response) => callback?.(response.status, response.body ?? null, response.headers ?? {}, null),
        (error: unknown) => callback?.(0, null, {}, String(isRecord(error) ? error["code"] : error)),
      );
    },
  );
}

function installCommands(server: LsmpServer): void {
  expose("ExecuteCommand", (line: string) => void server.executeCommand(null, line));
  expose("GetRegisteredCommands", () => commandNames.map((name) => ({ name })));
  expose("RegisterCommand", (name: string, handler: Command, restricted?: boolean) => {
    if (!commandNames.includes(name)) commandNames.push(name);
    const opts: LsmpCommandOptions | undefined = restricted === true ? undefined : { permission: false };
    server.registerCommand(name, opts, (args, raw, src) => {
      const text = typeof raw === "string" && raw !== "" ? `${name} ${raw}` : name;
      const id = typeof src === "number" ? toFiveM(src) : 0;
      expose("source", id);
      return handler(id, Array.isArray(args) ? args.map(String) : [], text);
    });
  });
}

export function installServer(): void {
  if (serverHost === null) return;
  expose("GetGameTimer", () => host.getTickCount());
  installPlayers(serverHost);
  installEntities(serverHost);
  installKvp(serverHost);
  installHttp(serverHost);
  installCommands(serverHost);
}
