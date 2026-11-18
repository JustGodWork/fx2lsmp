import { resolve } from "node:path";
import { concatShim, renderConfig } from "./fx2lsmp/cli.ts";
import { World } from "../test/harness.ts";

const SHIM_DIR = resolve(import.meta.dirname, "../shim");
const RUNS = 7;
const ITERATIONS = 20000;

const BENCH = `
  local fxc = __fxc
  local prepare = fxc.prepareArgs or function(...) return fxc.encodeArgs(fxc.liftArgs(...)) end
  local small = { id = 1, name = 'x', ok = true }
  local nested = {}
  for i = 1, 50 do nested[i] = { id = i, label = 'item' .. i, tags = { 'a', 'b' }, pos = { x = 1.5, y = 2.5 } } end
  local dirty = { 10, 20, name = 'mixed', [5] = 'hole', [3.5] = 'f', flag = true }
  local withFn = { name = 'obj', count = 3, run = function() return 1 end, inner = { go = function() return 2 end, n = 1 } }
  local cases = { small = small, nested = nested, dirty = dirty, functions = withFn }
  local out = {}
  for name, payload in pairs(cases) do
    local samples = {}
    for run = 1, ${RUNS} do
      local t0 = os.clock()
      for _ = 1, ${ITERATIONS} do prepare(payload) end
      samples[run] = (os.clock() - t0) / ${ITERATIONS} * 1e6
    end
    table.sort(samples)
    out[name] = samples[(#samples + 1) // 2]
  end
  return out
`;

const world = await World.create({ resource: "bench", clients: 0, peers: true, luaMain: false });
const res = await world.addLua("bench");
const config = `${renderConfig(undefined, {})}\nFXCOMPAT_CONFIG.expose = true\n`;
res.server.load("config.lua", config);
res.server.load("init.lua", concatShim(SHIM_DIR));
await world.advance(30);
const result = await res.server.eval<Record<string, number>>(BENCH);
for (const [name, us] of Object.entries(result)) console.log(`${name.padEnd(10)} ${us.toFixed(2)} us/op`);
world.close();
