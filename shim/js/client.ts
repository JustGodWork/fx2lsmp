import { NUI_CALLBACK_PREFIX, NUI_EVENT, isThenable, toJson } from "./protocol.ts";
import { AddEventHandler, dispatchLocal, hasHandlers } from "./events.ts";
import { clientHost, config, expose, logError, native, resource, toFiveM, toLsmp, warnOnce } from "./runtime.ts";

type Command = (source: number, args: string[], rawCommand: string) => unknown;
type Handler = (...args: unknown[]) => unknown;

interface RawNuiRequest {
  resource: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface RawNuiResponse {
  body?: string;
  status?: number;
  headers?: Record<string, string>;
}

const NUI_TIMEOUT_MS = 15000;
const MAX_SLOT = 63;

/** Game control ids (INPUT_*) of the keyboard keys FiveM key mappings usually use. */
const KEY_CONTROLS: Readonly<Record<string, number>> = {
  Q: 44, E: 38, R: 45, T: 245, Y: 246, U: 303, H: 74, F: 23, G: 47, K: 311, L: 182, Z: 20, X: 73, C: 26, V: 0, B: 29,
  N: 249, M: 244, TAB: 37, SPACE: 22, LSHIFT: 21, LCONTROL: 36, LMENU: 19, RETURN: 191, BACK: 177, UP: 172, DOWN: 173,
  LEFT: 174, RIGHT: 175, DELETE: 178, HOME: 212, PAGEUP: 10, PAGEDOWN: 11, F1: 288, F2: 289, F3: 170, F5: 166, F6: 167,
  F7: 168, F8: 169, F9: 56, F10: 57,
};

interface KeyMapping {
  control: number;
  press: string;
  release: string | null;
}

function installPlayers(client: LsmpClient): void {
  const playerId = native("playerId");
  const getPlayerPed = native("getPlayerPed");
  const fromServerId = (serverId: unknown): number => {
    const id = toLsmp(serverId);
    if (id === null) return -1;
    if (id === client.getLocalPlayer()) return Number(playerId());
    const ped = client.getPlayerPed(id);
    if (ped === null) return -1;
    for (let slot = 0; slot <= MAX_SLOT; slot++) if (getPlayerPed(slot) === ped) return slot;
    return -1;
  };
  expose("GetPlayerFromServerId", fromServerId);
  const serverIdOf = (slot: number): number => {
    if (slot === playerId()) return toFiveM(client.getLocalPlayer() ?? -1);
    const ped = getPlayerPed(slot);
    if (typeof ped !== "number" || ped === 0) return 0;
    const found = client.getPlayers().find((id) => client.getPlayerPed(id) === ped);
    return found === undefined ? 0 : toFiveM(found);
  };
  expose("GetPlayerServerId", serverIdOf);
  // the GTA network session is not LS:MP's: a slot is active when it maps to an LS:MP player
  const isActive = (slot: number): boolean =>
    slot === playerId() ? client.getLocalPlayer() !== null : serverIdOf(slot) !== 0;
  expose("NetworkIsPlayerActive", isActive);
  expose("NetworkIsPlayerConnected", isActive);
  expose("GetActivePlayers", () => client.getPlayers().map((id) => fromServerId(toFiveM(id))).filter((slot) => slot !== -1));
  const toNet = (handle: number): number => client.getNetIdFromEntity(handle) ?? 0;
  const toEntity = (netId: number): number => client.getEntityFromNetId(netId) ?? 0;
  expose("NetworkGetNetworkIdFromEntity", toNet);
  expose("NetworkGetEntityFromNetworkId", toEntity);
  for (const name of ["NetToEnt", "NetToVeh", "NetToPed", "NetToObj"]) expose(name, toEntity);
  for (const name of ["VehToNet", "PedToNet", "ObjToNet"]) expose(name, toNet);
}

let browser: LsmpBrowser | null = null;
const boundCallbacks = new Set<string>();
let focused = false;
let cursor = false;
let keepInput = false;

function runNuiCallback(name: string, data: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: unknown): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value === undefined ? null : toJson(value));
    };
    const timer = setTimeout(finish, NUI_TIMEOUT_MS);
    if (!hasHandlers(NUI_CALLBACK_PREFIX + name)) return finish(undefined);
    dispatchLocal(NUI_CALLBACK_PREFIX + name, null, [data, finish]);
  });
}

function nuiBrowser(client: LsmpClient): LsmpBrowser | null {
  if (browser === null || !browser.isValid()) {
    if (config.uiPage === undefined) {
      warnOnce("nui", "this resource has no ui_page: NUI calls are ignored");
      return null;
    }
    boundCallbacks.clear();
    browser = client.createBrowser(`rsc://${resource}/${config.uiPage}`, { visible: true, focus: false });
  }
  return browser;
}

function installNui(client: LsmpClient): void {
  const bind = (name: string): void => {
    const b = nuiBrowser(client);
    if (b === null || boundCallbacks.has(name)) return;
    boundCallbacks.add(name);
    b.on(name, (data) => runNuiCallback(name, data));
  };
  const registerType = (name: string): void => bind(name);
  expose("RegisterNuiCallbackType", registerType);
  const registerCallback = (name: string, fn: Handler): void => {
    AddEventHandler(NUI_CALLBACK_PREFIX + name, fn);
    bind(name);
  };
  expose("RegisterNUICallback", registerCallback);
  expose("RegisterNuiCallback", registerCallback);
  // the handler gets the page data as JSON text; the body of its answer is decoded before it reaches the page
  expose("RegisterRawNuiCallback", (name: string, fn: (request: RawNuiRequest, cb: (response?: RawNuiResponse) => void) => unknown) => {
    registerCallback(name, (data: unknown, cb: unknown) => {
      const reply = typeof cb === "function" ? (value?: unknown): unknown => Reflect.apply(cb, undefined, [value]) : (): void => {};
      fn({ resource, path: `/${name}`, method: "POST", headers: {}, body: JSON.stringify(data ?? null) }, (response) => {
        const body = response?.body;
        if (body === undefined) return void reply();
        try {
          reply(JSON.parse(body));
        } catch {
          reply(body);
        }
      });
    });
  });
  expose("SendNUIMessage", (data: unknown) => nuiBrowser(client)?.emit(NUI_EVENT, toJson(data)) ?? false);
  const applyFocus = (): void => {
    const b = nuiBrowser(client);
    if (b === null) return;
    if (focused) b.setFocus(true, { cursor: cursor || keepInput, keepInput });
    else b.setFocus(false);
  };
  expose("SetNuiFocus", (hasFocus: boolean, hasCursor: boolean) => {
    focused = hasFocus === true;
    cursor = hasCursor === true;
    applyFocus();
  });
  expose("SetNuiFocusKeepInput", (keep: boolean) => {
    keepInput = keep === true;
    if (focused) applyFocus();
  });
  expose("IsNuiFocused", () => focused);
  expose("SetTextChatEnabled", () => {});
  expose("IsAceAllowed", () => false);
}

function installCommands(client: LsmpClient): void {
  const commands = new Map<string, Command[]>();
  const names: string[] = [];
  const runLocal = (name: string, args: string[], rawCommand: string): boolean => {
    const list = commands.get(name.toLowerCase());
    if (list === undefined) return false;
    for (const handler of list) {
      try {
        const result = handler(0, args, rawCommand);
        if (isThenable(result)) Promise.resolve(result).catch((error: unknown) => logError(`command '${name}'`, error));
      } catch (error) {
        logError(`command '${name}'`, error);
      }
    }
    return true;
  };
  expose("RegisterCommand", (name: string, handler: Command) => {
    if (!names.includes(name)) names.push(name);
    const key = name.toLowerCase();
    const list = commands.get(key);
    if (list === undefined) commands.set(key, [handler]);
    else list.push(handler);
    // '+name' and '-name' are not valid LS:MP command names: only key mappings and ExecuteCommand reach them
    if (/^[\w.:-]+$/.test(name)) {
      client.registerCommand(name, undefined, (args, raw) => {
        const text = typeof raw === "string" && raw !== "" ? `${name} ${raw}` : name;
        return handler(0, Array.isArray(args) ? args.map(String) : [], text);
      });
    }
  });
  expose("GetRegisteredCommands", () => names.map((name) => ({ name })));
  expose("ExecuteCommand", (line: string) => {
    const match = /^\s*\/?(\S+)\s*(.*)$/.exec(line);
    if (match === null) return;
    const name = match[1] ?? "";
    const rest = match[2] ?? "";
    runLocal(name, rest.split(/\s+/).filter((w) => w !== ""), rest === "" ? name : `${name} ${rest}`);
  });
  const mappings: KeyMapping[] = [];
  let polling = false;
  const poll = (): void => {
    const pressed = native("isControlJustPressed");
    const released = native("isControlJustReleased");
    for (const m of mappings) {
      if (pressed(0, m.control) === true) runLocal(m.press, [], m.press);
      if (m.release !== null && released(0, m.control) === true) runLocal(m.release, [], m.release);
    }
  };
  expose("RegisterKeyMapping", (command: string, _description: string, device: string, key: string) => {
    if (device.toLowerCase() !== "keyboard") return warnOnce(`keymap:${device}`, `key mapping device '${device}' is not supported`);
    const control = KEY_CONTROLS[key.toUpperCase()];
    if (control === undefined) return warnOnce(`key:${key}`, `key '${key}' has no control id in the shim table: mapping ignored`);
    mappings.push({ control, press: command, release: command.startsWith("+") ? `-${command.slice(1)}` : null });
    if (!polling) {
      polling = true;
      client.onTick(poll);
    }
  });
}

export function installClient(): void {
  if (clientHost === null) return;
  installPlayers(clientHost);
  installNui(clientHost);
  installCommands(clientHost);
}
