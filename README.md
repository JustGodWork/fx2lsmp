# fx2lsmp

Run your FiveM resources on [LS:MP](https://lsmp.gg) with as few source changes as possible.

`fx2lsmp` converts a FiveM resource folder (`fxmanifest.lua`, CfxLua or JavaScript scripts, NUI page) into an LS:MP
resource (`manifest.json`, plain Lua 5.5, `webui` page) and vendors a runtime shim that recreates the FiveM API
(`Citizen`, events with `source`, exports, state bags, KVP, natives in PascalCase, NUI...) on top of `lsmp.*`.

> Status: proof of concept. The server side is verified on a real LS:MP server (0.6.8): converted resources start
> with no error, KVP persists, oxmysql runs against MariaDB, and ESX Legacy (`es_extended` 1.16.3) initialises. The
> client side (natives, NUI, key mappings) has only run against a simulated LS:MP so far.

## Quick start

Requirements: Node.js 24 and npm.

```sh
npm install
npm run fx2lsmp -- path/to/fivem/my_resource out/my_resource
```

Copy `out/my_resource` into the `resources/` folder of your LS:MP server and restart it (LS:MP has no `ensure` or
hot reload: resources load once, at server start).

```
converted 'my_resource' to out/my_resource (0 warnings)
```

Every warning names something the converter could not translate (a directive LS:MP has no equivalent for, a CfxLua
construct, a missing file). Read them before running the resource.

## Usage

```
fx2lsmp <fivemResourceDir> <outDir> [--cfg server.cfg] [--resources dir] [--keep-module-text]
```

| Option | Use |
| --- | --- |
| `--cfg server.cfg` | Your FiveM `server.cfg`, read for `set`, `setr` and `sets` convars so `GetConvar` keeps working. |
| `--resources dir` | Folder holding the other FiveM resources, needed when a manifest references `@other/file.lua`. |
| `--keep-module-text` | Also ship the source text of precompiled modules to clients (bigger package, see below). |

Converting a framework resource that imports from others:

```sh
npm run fx2lsmp -- fivem/resources/es_extended out/es_extended --cfg fivem/server.cfg --resources fivem/resources
```

## What the converter does

### 1. Manifest

`fxmanifest.lua` is executed in a Lua VM with every FiveM directive defined (plain, curried and table forms, and
`directive 'x' { ... }`), then written as `manifest.json`.

```lua
-- fxmanifest.lua (FiveM)
ui_page 'html/index.html'
files { 'html/index.html', 'html/style.css', 'html/script.js' }
shared_script 'config.lua'
client_script 'client.lua'
server_script 'server.lua'
```

```json
{
  "title": "hello",
  "shared_scripts": ["_fxcompat/config.lua", "_fxcompat/init.lua", "config.lua"],
  "client_scripts": ["client.lua"],
  "server_scripts": ["server.lua"],
  "webui": ["html"]
}
```

- The shim (`_fxcompat/init.lua`, or `init.js` for JavaScript resources) runs first on both sides.
- Lua scripts run from one generated loader per side (`_fxcompat/run_client.lua`, `_fxcompat/run_server.lua`), in manifest
  order: LS:MP starts the next file as soon as one suspends, FiveM does not.
- `ui_page` becomes a `webui` folder served at `rsc://<resource>/`.
- `data_file` lines become `data_files` entries; `dependency`/`dependencies` are kept.
- The resource name is lower-cased (LS:MP only accepts `[a-z0-9_-]`).
- Directives with no LS:MP meaning (`fx_version`, `game`, `lua54`, `loadscreen`, `provide`...) are dropped, with a
  warning when they matter.

### 2. CfxLua to Lua 5.5

LS:MP runs standard Lua 5.5. Every `.lua` file goes through a Lua-aware lexer (strings, long strings and comments are
never touched) that rewrites the CfxLua extensions:

```lua
-- input (CfxLua)                       -- output (Lua 5.5)
local model = `adder`                   local model = 3078201489
count += 1                              count = count + (1)
label ..= ' (' .. n .. ')'              label = label .. (' (' .. n .. ')')
local plate = vehicle?.plate            local plate = (vehicle or __fxc_nil).plate
for i = 1, #list do                     for i__fxc = 1, #list do local i = i__fxc;
  if skip(list[i]) then i = i + 1 end     if skip(list[i]) then i = i + 1 end
end                                     end
```

- Backtick hashes become their unsigned joaat value at build time.
- Compound assignments (`+= -= *= /= //= %= ^= ..= &= |= <<= >>=`) expand to plain assignments. The right side ends at
  the end of the statement on that line.
- Safe navigation (`a?.b`, `f(x)?.b`, `a?.[k]`) becomes a nil-safe index.
- A `for` loop variable assigned inside its body is copied, because Lua 5.5 makes loop variables read-only.
- Constructs that cannot be rewritten safely (`in` unpacking, set constructors `{ .a }`, C comments) are reported
  with file and line.

### 3. Runtime-loaded modules (`load`)

LS:MP refuses `load` and `loadstring` in every resource: only the bytecode of manifest scripts runs. Many FiveM
libraries read a file and `load` it at runtime (`LoadResourceFile` + `load`, `lib.require` patterns, ESX `esx_lib`).

The converter precompiles every Lua file a resource can read at runtime into a registry of functions, keyed by a hash
of the exact source text. The shim's `load` looks the chunk up in that registry and applies `env` when one is given,
so the library code runs unchanged.

- `_fxcompat/modules.lua` holds the modules clients receive, `_fxcompat/modules_server.lua` the server-only ones. A
  server-only file never reaches the client package.
- By default the client gets only the compiled registry, not the text of the module files
  (`es_extended`: 1.68 MB to 1.19 MB). Use `--keep-module-text` if a client script reads those files for another
  purpose than `load`.
- Arbitrary strings built at runtime cannot be loaded: `load` returns `nil` and an error for them.

### 4. Cross-resource imports

LS:MP has no `@resource/file` paths and copies values between resources. A script entry such as
`shared_script '@es_extended/imports.lua'` is resolved through `--resources`: the file, and the files of that
resource it loads at runtime, are copied under `_fxcompat/imports/<resource>/` and served to
`LoadResourceFile(resource, path)` from the copy. `@oxmysql/lib/MySQL.lua` is replaced by the bundled
[`compat/oxmysql`](compat/oxmysql) client library.

### 5. NUI

The `ui_page` folder is copied into the `webui` folder and every HTML file gets a prelude script first. The prelude
keeps FiveM page code working unchanged:

- `window.addEventListener("message", ...)` receives what the script sends with `SendNUIMessage`;
- `fetch("https://" + GetParentResourceName() + "/name", ...)` reaches the matching `RegisterNUICallback`;
- `GetParentResourceName()` returns the resource name.

On the script side, `SendNUIMessage`, `RegisterNUICallback`, `SetNuiFocus` and `SetNuiFocusKeepInput` drive one
LS:MP browser per resource.

### 6. Convars

`--cfg` splits convars the way FiveM does:

| Line | Goes to | Readable by |
| --- | --- | --- |
| `setr name value` | `_fxcompat/config.lua` (shared) | server and clients |
| `set` / `sets name value` | `_fxcompat/server_convars.json` (listed nowhere in the manifest) | server only |

Server convars never reach the client package: keep `mysql_connection_string`, license keys and webhooks as `set`.
The build warns when a `setr` name looks like a secret.

## Bundled compat resources

Convert them like any other resource and place them next to yours.

| Resource | Replaces | Note |
| --- | --- | --- |
| [`compat/oxmysql`](compat/oxmysql) | oxmysql | Runs over `lsmp.mysql`. Needs `"oxmysql": { "sandbox": false }` in the server's `resources.json`. |
| [`compat/spawnmanager`](compat/spawnmanager) | spawnmanager | LS:MP never spawns players by itself: without a spawn resource they stay on the loading screen. |

## What the runtime shim covers

Threads and timers, `promise` and `Citizen.Await`, local and net events with `source`, `TriggerClientEvent(-1)`,
exports (including callbacks and objects with methods, such as ESX `getSharedObject`), `GetInvokingResource`, state
bags, msgpack, KVP on both sides, commands, `RegisterKeyMapping` (polled game controls), PascalCase natives and
`Citizen.InvokeNative` (aliases generated by hash), player identifiers, routing buckets, `PerformHttpRequest`, and
server entity creation and writes (sent to the client that simulates the entity, since the LS:MP server has no entity
setters). Lua and JavaScript resources exchange events, exports and state bags both ways.

## Limits

Some FiveM behaviour cannot be recreated on LS:MP today:

- Resources start once with the server: no `ensure`, `restart`, `StartResource` or `StopResource` at runtime.
- Identifiers are `lsmp`, `ip`, `hwid` and `name`. The shim builds `license:<lsmpId>`, so databases keyed on FiveM
  licenses need a one-time identity migration. Guests have no account.
- Server entity writes and reads of health, heading or plate go through the owning client: they are asynchronous.
- `RegisterKeyMapping` works on game controls only: no arbitrary physical keys, no player rebinding.
- Exports are asynchronous under the hood and only work where the caller can wait (threads, handlers, file bodies).
- `GetPlayerPing` has no LS:MP equivalent (returns 1 for a connected player).
- 21 LS:MP natives currently ignore the handle they receive (`DeleteEntity`, `RemoveBlip`, the
  `Set*AsNoLongerNeeded` family...). The shim works around the common ones.

## Development

```sh
npm test               # vitest: unit suites and the simulated LS:MP harness (server and client Lua VMs)
npm run typecheck      # tsc
npm run lint:lua       # LuaLS check of the shim annotations
npm run lsmp:smoke     # converts the examples and runs them on a local LS:MP server for 25 s
```

| Path | Content |
| --- | --- |
| `tools/fx2lsmp/` | Converter: manifest, transpiler, module registry, imports, NUI staging |
| `shim/` | Lua runtime shim, `shim/js/` its JavaScript counterpart |
| `compat/` | Replacement resources (oxmysql, spawnmanager) |
| `examples/fivem/` | FiveM resources used as migration proofs (`hello` in Lua, `hello_js` in JavaScript) |
| `test/` | Test suites and the simulated LS:MP used by them |
| `probes/` | Small resources that measure LS:MP server behaviour |

`npm run lsmp:smoke` uses the LS:MP server in `C:/lsmp` (override with `LSMP_DIR`, run length with
`LSMP_SMOKE_MS`). `npm run alias` regenerates the native alias tables from the LS:MP natives catalogue
(`docs/raw/natives.json`, not tracked) and the FiveM native database of fx-oop.

## License

[MIT](LICENSE)
