import { config, side, warnOnce, type StubKind } from "./runtime.ts";

const DEFAULTS: Record<StubKind, () => unknown> = {
  bool: () => false,
  int: () => 0,
  float: () => 0,
  string: () => "",
  vector: () => [0, 0, 0],
  nil: () => undefined,
};

const RETURNS: Record<StubKind, string> = {
  bool: "false", int: "0", float: "0", string: "an empty string", vector: "a zero vector", nil: "undefined",
};

/** Natives the resource calls that LS:MP cannot provide: warn once and answer the typed default of the result. */
export function installStubs(): void {
  for (const [name, kind] of Object.entries(config.stubs[side])) {
    if (typeof Reflect.get(globalThis, name) === "function") continue;
    const message = `${name} has no LS:MP counterpart: the call does nothing and returns ${RETURNS[kind]}`;
    Object.defineProperty(globalThis, name, {
      value: (): unknown => {
        warnOnce(`stub:${name}`, message);
        return DEFAULTS[kind]();
      },
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }
}
