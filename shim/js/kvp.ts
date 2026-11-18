import { isRecord } from "./protocol.ts";
import { clientHost, config, expose, resource, warnOnce } from "./runtime.ts";

type Kind = "s" | "i" | "f";

interface Entry {
  t: Kind;
  v: string | number;
}

const CALL_TIMEOUT_MS = 3000;
const RETRY_MS = 250;
const MAX_ATTEMPTS = 20;

function toEntry(raw: unknown): Entry | null {
  if (!isRecord(raw)) return null;
  const { t, v } = raw;
  if (t === "s" && typeof v === "string") return { t, v };
  if ((t === "i" || t === "f") && typeof v === "number") return { t, v };
  return null;
}

function toInteger(value: unknown): number {
  const n = Number(value);
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}

function toFloat(value: unknown): number {
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

/** Same hidden page and storage keys as the Lua shim (shim/kvp.lua), so both languages read the same values. */
export function installKvp(): void {
  const client = clientHost;
  if (client === null) return;
  const cache = new Map<string, Entry>();
  // keys written or deleted before the page answered win over the loaded values
  const touched = new Set<string>();
  let ready = false;
  let page: LsmpBrowser | null = null;
  let resolveReady: () => void = () => {};
  const kvpReady = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const pageOrNull = (): LsmpBrowser | null => {
    if (page !== null && page.isValid()) return page;
    if (config.kvpPage === undefined) {
      warnOnce("kvp-page", "this resource was not built with the KVP page: client KVP lives in memory only");
      return null;
    }
    page = client.createBrowser(`rsc://${resource}/${config.kvpPage}`, { visible: false, focus: false });
    return page;
  };

  const load = async (attempt: number): Promise<void> => {
    const b = pageOrNull();
    if (b === null) return resolveReady();
    try {
      const entries = await b.call({ name: "kvp:all", timeoutMs: CALL_TIMEOUT_MS });
      if (isRecord(entries)) {
        for (const [key, raw] of Object.entries(entries)) {
          const entry = toEntry(raw);
          if (!touched.has(key) && entry !== null) cache.set(key, entry);
        }
      }
      ready = true;
      resolveReady();
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS) {
        warnOnce("kvp-load", `client KVP could not be loaded from the page: ${String(error)}`);
        return resolveReady();
      }
      setTimeout(() => void load(attempt + 1), RETRY_MS);
    }
  };

  // Getters are synchronous in FiveM JS: the page is read at start and the values are served from memory.
  const read = (key: string): Entry | undefined => {
    if (!ready) warnOnce("kvp-wait", "client KVP was read before the page answered: values may be missing (await fxcompat.kvpReady)");
    return cache.get(key);
  };
  const write = (event: string, ...args: unknown[]): void => {
    try {
      pageOrNull()?.emit(event, ...args);
    } catch (error) {
      warnOnce("kvp-emit", `client KVP write was not persisted: ${String(error)}`);
    }
  };
  const put = (key: string, t: Kind, v: string | number): void => {
    cache.set(key, { t, v });
    touched.add(key);
    write("kvp:set", key, t, v);
  };
  const remove = (key: string): void => {
    cache.delete(key);
    touched.add(key);
    write("kvp:del", key);
  };
  const setString = (key: string, value: unknown): void => put(key, "s", String(value));
  const setInt = (key: string, value: number): void => put(key, "i", Math.trunc(value));
  const setFloat = (key: string, value: number): void => put(key, "f", value);
  expose("SetResourceKvp", setString);
  expose("SetResourceKvpNoSync", setString);
  expose("SetResourceKvpInt", setInt);
  expose("SetResourceKvpIntNoSync", setInt);
  expose("SetResourceKvpFloat", setFloat);
  expose("SetResourceKvpFloatNoSync", setFloat);
  expose("FlushResourceKvp", () => {});
  expose("GetResourceKvpString", (key: string) => {
    const entry = read(key);
    return entry === undefined ? null : String(entry.v);
  });
  expose("GetResourceKvpInt", (key: string) => toInteger(read(key)?.v));
  expose("GetResourceKvpFloat", (key: string) => toFloat(read(key)?.v));
  expose("DeleteResourceKvp", remove);
  expose("DeleteResourceKvpNoSync", remove);
  const finds = new Map<number, { keys: string[]; index: number }>();
  let lastFind = 0;
  expose("StartFindKvp", (prefix: string) => {
    if (!ready) warnOnce("kvp-wait", "client KVP was read before the page answered: values may be missing (await fxcompat.kvpReady)");
    finds.set(++lastFind, { keys: [...cache.keys()].filter((k) => k.startsWith(prefix)).sort(), index: 0 });
    return lastFind;
  });
  expose("FindKvp", (handle: number) => {
    const find = finds.get(handle);
    return find === undefined ? null : (find.keys[find.index++] ?? null);
  });
  expose("EndFindKvp", (handle: number) => void finds.delete(handle));
  expose("fxcompat", { kvpReady });
  if (config.kvpPage !== undefined) void load(1);
  else resolveReady();
}
