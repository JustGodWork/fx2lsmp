import { afterAll, beforeAll, expect, it } from "vitest";
import { World, nth } from "./harness.ts";
import type { JsVm } from "./js-vm.ts";

let world: World;
let client: JsVm;

beforeAll(async () => {
  world = await World.create({ luaMain: false, clients: 1, resource: "jsspawn" });
  const res = world.addJs("jsspawn");
  await world.loadJsShim(res);
  client = nth(res.clients, 0);
});
afterAll(() => world.close());

it("spawns through LS:MP on the first NetworkResurrectLocalPlayer, then resurrects", async () => {
  await client.eval("globalThis.RES = []; globalThis.networkResurrectLocalPlayer = (...a) => { RES.push(a); };");
  await client.eval("NetworkResurrectLocalPlayer(1, 2, 3, 90, 0, true)");
  expect(client.spawns).toEqual([{ x: 1, y: 2, z: 3, heading: 90 }]);
  await client.eval("NetworkResurrectLocalPlayer(4, 5, 6, 0, 0, true)");
  expect(client.spawns).toHaveLength(1);
  expect(await client.eval("return RES")).toEqual([[4, 5, 6, 0, 0, true]]);
});
