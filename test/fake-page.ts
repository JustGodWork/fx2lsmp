import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

type Listener = (...args: unknown[]) => unknown;

export interface PageBridge {
  emit(event: string, args: unknown[]): void;
  call(event: string, args: unknown[]): Promise<unknown>;
}

export class FakeElement {
  textContent = "";
  innerHTML = "";
  value = "";
  hidden = false;
  readonly style: Record<string, string> = {};
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string): void => void this.classes.add(name),
    remove: (name: string): void => void this.classes.delete(name),
    toggle: (name: string): void => void (this.classes.has(name) ? this.classes.delete(name) : this.classes.add(name)),
    contains: (name: string): boolean => this.classes.has(name),
  };
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, fn: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  appendChild(child: FakeElement): FakeElement {
    this.innerHTML += child.textContent;
    return child;
  }

  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type });
  }
}

class FakeDocument {
  readonly elements = new Map<string, FakeElement>();
  readonly body = new FakeElement();

  getElementById(id: string): FakeElement {
    let el = this.elements.get(id);
    if (el === undefined) {
      el = new FakeElement();
      this.elements.set(id, el);
    }
    return el;
  }

  querySelector(selector: string): FakeElement {
    return this.getElementById(selector);
  }

  createElement(): FakeElement {
    return new FakeElement();
  }

  addEventListener(type: string, fn: Listener): void {
    if (type === "DOMContentLoaded") fn();
  }
}

class FakeMessageEvent {
  readonly type: string;
  readonly data: unknown;
  constructor(type: string, init?: { data?: unknown }) {
    this.type = type;
    this.data = init?.data;
  }
}

/** localStorage backed by a shared map, so a second page (or a second world) sees what the first one wrote. */
export class FakeStorage {
  constructor(private readonly data: Map<string, string>) {}

  get length(): number {
    return this.data.size;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

export interface FetchRecord {
  url: string;
  init: { method?: string; body?: string } | undefined;
}

/** A browser page: runs the scripts of an html file in a node vm context with a fake window, document and lsmp. */
export class FakePage {
  readonly document = new FakeDocument();
  readonly messages: unknown[] = [];
  readonly passedThroughFetches: FetchRecord[] = [];
  private readonly scriptHandlers = new Map<string, Listener[]>();
  private readonly windowListeners = new Map<string, Listener[]>();
  private readonly context: object;

  constructor(
    readonly resource: string,
    private readonly bridge: PageBridge,
    webuiDir: string,
    htmlFile: string,
    storage: Map<string, string> = new Map(),
  ) {
    const sandbox: Record<string, unknown> = {};
    const lsmpObject = {
      resource,
      on: (event: string, fn: Listener): (() => boolean) => {
        this.scriptHandlers.set(event, [...(this.scriptHandlers.get(event) ?? []), fn]);
        return () => true;
      },
      emit: (event: string, ...args: unknown[]): void => this.bridge.emit(event, args),
      call: (event: string, ...args: unknown[]): Promise<unknown> => this.bridge.call(event, args),
    };
    sandbox["lsmp"] = lsmpObject;
    sandbox["localStorage"] = new FakeStorage(storage);
    sandbox["document"] = this.document;
    sandbox["window"] = sandbox;
    sandbox["console"] = console;
    sandbox["Response"] = Response;
    sandbox["MessageEvent"] = FakeMessageEvent;
    sandbox["addEventListener"] = (type: string, fn: Listener): void => {
      this.windowListeners.set(type, [...(this.windowListeners.get(type) ?? []), fn]);
    };
    sandbox["dispatchEvent"] = (event: FakeMessageEvent): boolean => {
      if (event.type === "message") this.messages.push(event.data);
      for (const fn of this.windowListeners.get(event.type) ?? []) fn(event);
      return true;
    };
    sandbox["fetch"] = (url: string, init?: FetchRecord["init"]): Promise<Response> => {
      this.passedThroughFetches.push({ url, init });
      return Promise.resolve(new Response("real", { status: 200 }));
    };
    this.context = createContext(sandbox);
    this.loadHtml(webuiDir, htmlFile);
  }

  private loadHtml(webuiDir: string, htmlFile: string): void {
    const html = readFileSync(join(webuiDir, htmlFile), "utf8");
    const tags = html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
    for (const tag of tags) {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag[1] ?? "");
      const code = src ? readFileSync(join(webuiDir, src[1] ?? "").replace(/\\/g, "/"), "utf8") : (tag[2] ?? "");
      this.run(code);
    }
  }

  run(code: string): unknown {
    return runInContext(code, this.context);
  }

  /** Answers a `browser:call`: handlers run in order until one returns a value, none means `no-handler`. */
  async invoke(event: string, args: unknown[]): Promise<unknown> {
    const handlers = this.scriptHandlers.get(event) ?? [];
    if (handlers.length === 0) throw Object.assign(new Error("no-handler"), { code: "no-handler" });
    for (const fn of handlers) {
      const value = await fn(...args);
      if (value !== undefined) return value;
    }
    return null;
  }

  /** Delivers an event from the client script to the page handlers (`browser:emit`). */
  receive(event: string, args: unknown[]): void {
    for (const fn of this.scriptHandlers.get(event) ?? []) fn(...args);
  }
}
