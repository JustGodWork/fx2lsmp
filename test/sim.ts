export interface PlayerSpec {
  id: number;
  name: string;
  lsmpId: number | null;
  ip: string;
  hwid?: string;
}

/** One script environment of the simulated world: a Lua VM or a JS context, with the mock lsmp inside. */
export interface SimVm {
  readonly side: "server" | "client";
  readonly id: number | null;
  readonly key: number;
  readonly resource: string;
  readonly language: "lua" | "js";
  tick(ms: number): void;
  deliver(text: string): void;
  hasCall(name: string): boolean;
  addPlayer(spec: PlayerSpec): void;
  load(name: string, source: string): void;
  setFile(path: string, content: string): void;
  pageEmit(browser: number, event: string, args: unknown[]): void;
  pageCall(callId: number, browser: number, event: string, args: unknown[]): void;
  pageResult(id: number, json: string, err: string): void;
  logs(): string[];
  errors(): string[];
  close(): void;
}

export interface Bus {
  enqueue(origin: SimVm, text: string): void;
  advance(ms: number): Promise<void>;
}
