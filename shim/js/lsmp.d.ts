type LsmpValue = unknown;

interface LsmpCallOptions {
  name: string;
  timeoutMs?: number;
}

interface LsmpError extends Error {
  code?: string;
}

interface LsmpBrowser {
  readonly id: number;
  destroy(): boolean;
  isValid(): boolean;
  setVisible(visible: boolean): boolean;
  setFocus(focused: boolean, opts?: { cursor?: boolean; keepInput?: boolean }): boolean;
  emit(event: string, ...args: LsmpValue[]): boolean;
  on(event: string, fn: (...args: LsmpValue[]) => unknown): () => boolean;
  off(event: string, fn: (...args: LsmpValue[]) => unknown): boolean;
  call(event: string | LsmpCallOptions, ...args: LsmpValue[]): Promise<LsmpValue>;
}

interface LsmpBrowserOptions {
  visible?: boolean;
  focus?: boolean;
  cursor?: boolean;
  keepInput?: boolean;
}

interface LsmpHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface LsmpHttpResponse {
  ok: boolean;
  status: number;
  headers?: Record<string, unknown>;
  body?: string;
}

interface LsmpCommandOptions {
  permission?: string | false;
  help?: string;
}

interface LsmpMysqlPoolOptions {
  host?: string;
  port?: number;
  user: string;
  password?: string;
  database?: string;
  charset?: "utf8mb4" | "utf8" | "latin1" | "binary";
  connectionLimit?: number;
  connectTimeoutMs?: number;
  queryTimeoutMs?: number;
}

interface LsmpMysqlSummary {
  affectedRows: number;
  insertId: number;
  warningCount: number;
}

type LsmpMysqlResult = Record<string, LsmpValue>[] | LsmpMysqlSummary;

interface LsmpMysqlTx {
  query(sql: string, params?: LsmpValue[]): Promise<LsmpMysqlResult>;
}

interface LsmpMysqlPool {
  query(sql: string, params?: LsmpValue[]): Promise<LsmpMysqlResult>;
  transaction(fn: (tx: LsmpMysqlTx) => unknown): Promise<LsmpValue>;
  close(): Promise<boolean>;
}

interface LsmpShared {
  getResourceName(): string;
  getResourceState(name: string): string | null;
  readResourceFile(path: string): string | null;
  hash(text: string): number;
  getTickCount(): number;
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  on(name: string, fn: (...args: LsmpValue[]) => unknown): () => boolean;
  emit(name: string, ...args: LsmpValue[]): void;
  onCall(name: string, fn: (...args: LsmpValue[]) => unknown): () => boolean;
  call(name: string | LsmpCallOptions, ...args: LsmpValue[]): Promise<LsmpValue>;
  wait(ms?: number): Promise<void>;
  getPlayers(): number[];
  getGlobalMeta(key: string): LsmpValue;
  getPlayerMeta(playerId: number, key: string): LsmpValue;
  getEntityMeta(netId: number, key: string): LsmpValue;
  setGlobalMeta(key: string, value: LsmpValue): boolean;
  setPlayerMeta(playerId: number, key: string, value: LsmpValue): boolean;
  setEntityMeta(netId: number, key: string, value: LsmpValue): boolean;
  getPlayerPed(playerId: number): number | null;
  registerCommand(name: string, opts: LsmpCommandOptions | undefined, fn: (...args: LsmpValue[]) => unknown): () => boolean;
  executeCommand(source: number | null, line: string): string;
  http: { request(opts: LsmpHttpRequest): Promise<LsmpHttpResponse> };
}

interface LsmpCreateEntityOptions {
  heading?: number;
  owner?: number;
  dimension?: number;
  lifePolicy?: "whileRelevant" | "keep" | "withCreator";
}

interface LsmpClient extends LsmpShared {
  getEntityOwner(netId: number): number | null;
  emitServer(name: string, ...args: LsmpValue[]): boolean;
  onServer(name: string, fn: (...args: LsmpValue[]) => unknown): () => boolean;
  getLocalPlayer(): number | null;
  spawn(position: { x: number; y: number; z: number }, opts?: { heading?: number; model?: number | string }): boolean;
  getNetIdFromEntity(handle: number): number | null;
  getEntityFromNetId(netId: number): number | null;
  onTick(fn: (dt: number) => unknown): () => boolean;
  createBrowser(url: string, opts?: LsmpBrowserOptions): LsmpBrowser | null;
}

interface LsmpServer extends LsmpShared {
  mysql: { createPool(opts: LsmpMysqlPoolOptions): LsmpMysqlPool | null };
  emitClient(target: number | number[], name: string, ...args: LsmpValue[]): boolean;
  emitAllClients(name: string, ...args: LsmpValue[]): number;
  onClient(name: string, fn: (source: number, ...args: LsmpValue[]) => unknown): () => boolean;
  getPlayerName(playerId: number): string | null;
  getPlayerLsmpId(playerId: number): number | string | null;
  getPlayerIdentifier(playerId: number, kind: string): string | null;
  kickPlayer(playerId: number, reason?: string): boolean;
  getPlayerDimension(playerId: number): number;
  setPlayerDimension(playerId: number, dimension: number): boolean;
  getEntityCoords(netId: number): { x: number; y: number; z: number } | null;
  entityExists(netId: number): boolean;
  createEntity(
    type: "vehicle" | "ped" | "object",
    model: number | string,
    position: { x: number; y: number; z: number },
    opts?: LsmpCreateEntityOptions,
  ): number | null;
  getLastError(): string | null;
  getEntityOwner(netId: number): number | null;
  getEntityModel(netId: number): number | null;
  getEntityType(netId: number): string | null;
  getPedInVehicleSeat(vehicle: number, seat: number): number | null;
  getVehiclePedIsIn(ped: number): number | null;
  getEntities(opts?: { types?: string[]; dimension?: number }): ArrayLike<number>;
  setEntityDimension(netId: number, dimension: number): boolean;
  getEntityDimension(netId: number): number | null;
  callClient(playerId: number, name: string | LsmpCallOptions, ...args: LsmpValue[]): Promise<LsmpValue>;
  deleteEntity(netId: number): boolean;
  perms: { has(playerId: number, permission: string): boolean };
  storage: {
    get(key: string): unknown;
    set(key: string, value: string | number): boolean;
    delete(key: string): boolean;
    keys(prefix?: string): string[];
  };
}

declare const lsmp: LsmpShared;

/** Build flag set by fx2lsmp: the native hash table is part of the bundle. */
declare const __FX_HASHES__: boolean;
