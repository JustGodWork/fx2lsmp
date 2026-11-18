import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World } from "./harness.ts";

const NAMES = ["SetConvarReplicated", "SetConvarServerInfo", "SetMapName", "SetGameType", "SetEntityOrphanMode"];

describe("server convar and server info natives", () => {
  let world: World;
  beforeAll(async () => {
    world = await World.withShim({ clients: 1 });
  });
  afterAll(() => world.close());

  it("reads back a convar set at runtime on the server", async () => {
    expect(await world.server.eval("SetConvar('x', '1') return GetConvar('x', 'd')")).toBe("1");
  });

  it("exposes the server only natives without raising", async () => {
    for (const name of NAMES) {
      expect(await world.server.eval(`return type(${name})`)).toBe("function");
    }
    expect(
      await world.server.eval(`
        return pcall(function()
          SetConvarReplicated('r', '2') SetConvarServerInfo('i', '3') SetMapName('m') SetGameType('g') SetEntityOrphanMode(1, 2)
        end)
      `),
    ).toBe(true);
  });

  it("reports OneSync Infinity on both sides", async () => {
    expect(await world.server.eval("return GetConvar('onesync', 'off')")).toBe("on");
    expect(await world.clients[0]!.eval("return GetConvar('onesync', 'off')")).toBe("on");
    expect(await world.server.eval("SetConvar('onesync', 'legacy') return GetConvar('onesync', 'off')")).toBe("legacy");
  });

  it("leaves them undefined on the client", async () => {
    for (const name of NAMES) {
      expect(await world.clients[0]!.eval(`return type(${name})`)).toBe("nil");
    }
  });
});
