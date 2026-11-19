---@meta

---@class LsmpBrowser
---@field id integer
---@field destroy fun(self: LsmpBrowser): boolean
---@field isValid fun(self: LsmpBrowser): boolean
---@field setUrl fun(self: LsmpBrowser, url: string): boolean
---@field setVisible fun(self: LsmpBrowser, visible: boolean): boolean
---@field setFocus fun(self: LsmpBrowser, focused: boolean, opts?: { cursor?: boolean, keepInput?: boolean }): boolean
---@field hasFocus fun(self: LsmpBrowser): boolean
---@field emit fun(self: LsmpBrowser, event: string, ...: any): boolean
---@field on fun(self: LsmpBrowser, event: string, fn: fun(...: any): any): fun(): boolean
---@field off fun(self: LsmpBrowser, event: string, fn: fun(...: any): any): boolean
---@field call fun(self: LsmpBrowser, event: string|{ name: string, timeoutMs: integer? }, ...: any): any, string?

---@class LsmpHttpResponse
---@field ok boolean
---@field status integer
---@field headers table<string, any>
---@field body string

---@class LsmpCommandOptions
---@field help string?
---@field permission (string|false)?
---@field restricted boolean?

---@class LsmpStorage
---@field get fun(key: string): any
---@field set fun(key: string, value: any): boolean
---@field delete fun(key: string): boolean
---@field keys fun(prefix?: string): string[]

---@class LsmpJson
---@field encode fun(value: any, opts?: { pretty?: boolean }): string
---@field decode fun(text: string): any, string?, { message: string }?

---@class LsmpPerms
---@field has fun(playerId: integer, permission: string): boolean

---@class LsmpHttp
---@field request fun(opts: table<string, any>, cb: fun(response: LsmpHttpResponse?, code: string?, details: any))

---@class LsmpMysqlPoolOptions
---@field host string?
---@field port integer?
---@field user string
---@field password string?
---@field database string?
---@field charset 'utf8mb4'|'utf8'|'latin1'|'binary'?
---@field connectionLimit integer?
---@field connectTimeoutMs integer?
---@field queryTimeoutMs integer?

---@class LsmpMysqlSummary
---@field affectedRows integer
---@field insertId integer
---@field warningCount integer

---@class LsmpMysqlError
---@field errno integer?
---@field sqlState string?
---@field message string?

---@alias LsmpMysqlRow table<string, any>
---@alias LsmpMysqlResult LsmpMysqlRow[]|LsmpMysqlSummary

---@class LsmpMysqlTx
---@field query fun(self: LsmpMysqlTx, sql: string, params?: any[]): LsmpMysqlResult?, string?, LsmpMysqlError?

---@class LsmpMysqlPool
---@field query fun(self: LsmpMysqlPool, sql: string, params?: any[], cb?: fun(result: LsmpMysqlResult?, err: string?, details: LsmpMysqlError?)): LsmpMysqlResult?, string?, LsmpMysqlError?
---@field transaction fun(self: LsmpMysqlPool, fn: (fun(tx: LsmpMysqlTx): any), cb?: fun(result: any, err: string?)): any, string?
---@field close fun(self: LsmpMysqlPool, cb?: fun(ok: boolean?, err: string?)): boolean?, string?

---@class LsmpMysql
---@field createPool fun(opts: LsmpMysqlPoolOptions): LsmpMysqlPool?, string?

---@class LsmpCreateEntityOptions
---@field heading number?
---@field owner integer?
---@field dimension integer?
---@field ownerPolicy string?
---@field lifePolicy string?

---@class Lsmp
---@field null any
---@field emit fun(name: string, ...: any)
---@field on fun(name: string, fn: fun(...: any), filter?: table): fun(): boolean
---@field emitServer fun(name: string, ...: any): boolean
---@field onServer fun(name: string, fn: fun(...: any)): fun(): boolean
---@field emitClient fun(target: integer|integer[], name: string, ...: any): boolean
---@field emitAllClients fun(name: string, ...: any): integer
---@field onClient fun(name: string, fn: fun(source: integer, ...: any)): fun(): boolean
---@field onCall fun(name: string, fn: fun(...: any): any): fun(): boolean
---@field call fun(name: string|{ name: string, timeoutMs: integer? }, ...: any): any, string?, any
---@field wait fun(ms: integer)
---@field createThread fun(fn: fun(...: any), ...: any)
---@field onTick fun(fn: fun(dtMs: integer)): fun(): boolean
---@field log fun(...: any)
---@field warn fun(...: any)
---@field error fun(...: any)
---@field hash fun(text: string): integer
---@field getTickCount fun(): integer
---@field getResourceName fun(): string
---@field getResourceState fun(name: string): string?
---@field readResourceFile fun(path: string): string?
---@field registerCommand fun(name: string, optsOrFn: LsmpCommandOptions|function, fn?: function): fun(): boolean
---@field executeCommand fun(source: integer?, line: string): string
---@field getPlayers fun(): integer[]
---@field getPlayerName fun(playerId: integer): string?
---@field getPlayerLsmpId fun(playerId: integer): integer?
---@field getPlayerIdentifier fun(playerId: integer, kind: string): string?
---@field getPlayerPed fun(playerId: integer): integer?
---@field getPlayerDimension fun(playerId: integer): integer?
---@field setPlayerDimension fun(playerId: integer, dimension: integer): boolean
---@field kickPlayer fun(playerId: integer, reason?: string): boolean
---@field getLocalPlayer fun(): integer?
---@field getGlobalMeta fun(key: string): any
---@field getPlayerMeta fun(playerId: integer, key: string): any
---@field getEntityMeta fun(netId: integer, key: string): any
---@field setGlobalMeta fun(key: string, value: any): boolean, string?
---@field setPlayerMeta fun(playerId: integer, key: string, value: any): boolean, string?
---@field setEntityMeta fun(netId: integer, key: string, value: any): boolean, string?
---@field getEntityCoords fun(netId: integer): any
---@field entityExists fun(netId: integer): boolean
---@field deleteEntity fun(netId: integer): boolean, string?
---@field getEntityOwner fun(netId: integer): integer?
---@field getEntityFromNetId fun(netId: integer): integer?
---@field getEntityModel fun(netId: integer): integer?
---@field getEntityType fun(netId: integer): string?
---@field getEntities fun(opts?: { types?: string[], dimension?: integer }): integer[]
---@field getPedInVehicleSeat fun(vehicle: integer, seat: integer): integer?
---@field getVehiclePedIsIn fun(ped: integer): integer?
---@field getEntityDimension fun(netId: integer): integer?
---@field setEntityDimension fun(netId: integer, dimension: integer): boolean, string?
---@field createEntity fun(type: string, model: integer|string, position: { x: number, y: number, z: number }, opts?: LsmpCreateEntityOptions): integer?, string?
---@field callClient fun(playerId: integer, name: string, ...: any): any, string?
---@field getNetIdFromEntity fun(handle: integer): integer?
---@field createBrowser fun(url: string, opts?: table<string, any>): LsmpBrowser?
---@field spawn fun(position: any, opts?: { heading: number?, model: integer|string? }): boolean
---@field resurrect fun(position: any, opts?: { heading: number? }): boolean
---@field setAutoSpawn fun(enabled: boolean)
---@field setAutoSpawnHandler fun(fn: fun()?)
---@field closeLoadingScreen fun()
---@field storage LsmpStorage
---@field json LsmpJson
---@field perms LsmpPerms
---@field http LsmpHttp
---@field mysql LsmpMysql
lsmp = {}

---@param fn fun(...: any)
---@param ms? integer
---@return integer
function setTimeout(fn, ms) end

---@param id integer
function clearTimeout(id) end

---@param x? number
---@param y? number
---@param z? number
---@return any
function Vector3(x, y, z) end
