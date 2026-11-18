import { describe, expect, it } from "vitest";
import { FakePage, type PageBridge } from "./fake-page.ts";
import { makeWebui } from "./webui.ts";

interface Call {
  event: string;
  args: unknown[];
}

function openPage(answer: (call: Call) => Promise<unknown>): { page: FakePage; calls: Call[]; emitted: Call[] } {
  const calls: Call[] = [];
  const emitted: Call[] = [];
  const bridge: PageBridge = {
    emit: (event, args) => void emitted.push({ event, args }),
    call: (event, args) => {
      const call = { event, args };
      calls.push(call);
      return answer(call);
    },
  };
  const dir = makeWebui("window.seen = [];\nwindow.addEventListener('message', function (e) { window.seen.push(e.data); });");
  return { page: new FakePage("myres", bridge, dir, "index.html"), calls, emitted };
}

describe("nui-prelude.js", () => {
  it("defines GetParentResourceName from lsmp.resource", () => {
    const { page } = openPage(() => Promise.resolve(null));
    expect(page.run("GetParentResourceName()")).toBe("myres");
  });

  it("defines window.invokeNative so pages know they run in the game", () => {
    const { page } = openPage(() => Promise.resolve(null));
    expect(page.run("typeof window.invokeNative")).toBe("function");
  });

  it("turns __fxnui into a window message event", () => {
    const { page } = openPage(() => Promise.resolve(null));
    page.receive("__fxnui", [{ type: "open", n: 1 }]);
    expect(page.messages).toEqual([{ type: "open", n: 1 }]);
    expect(page.run("window.seen.length")).toBe(1);
  });

  it("decodes the marker form of the payload codec", () => {
    const { page } = openPage(() => Promise.resolve(null));
    page.receive("__fxnui", [{ list: [{ __fx: "m", k: [5, "a"], v: [1, { __fx: "m", k: [1], v: ["x"] }] }] }]);
    expect(page.messages).toEqual([{ list: [{ "5": 1, a: { "1": "x" } }] }]);
  });

  it("routes https://<resource>/<name> to lsmp.call with the parsed body", async () => {
    const { page, calls } = openPage(() => Promise.resolve({ ok: true, list: [1, 2] }));
    const result = await page.run(
      "fetch('https://myres/save?x=1', { method: 'POST', body: JSON.stringify({ a: 1 }) }).then(function (r) { return r.json().then(function (j) { return [r.status, j]; }); })",
    );
    expect(calls).toEqual([{ event: "save", args: [{ a: 1 }] }]);
    expect(result).toEqual([200, { ok: true, list: [1, 2] }]);
  });

  it("sends an empty object for a missing or invalid body", async () => {
    const { page, calls } = openPage(() => Promise.resolve(null));
    await page.run("fetch('https://myres/a')");
    await page.run("fetch('https://myres/b', { method: 'POST', body: 'not json' })");
    expect(calls.map((c) => c.args[0])).toEqual([{}, {}]);
  });

  it("answers null as JSON null and maps failures to http statuses", async () => {
    const missing = openPage(() => Promise.reject(Object.assign(new Error("x"), { code: "no-handler" })));
    expect(await missing.page.run("fetch('https://myres/none').then(function (r) { return r.status })")).toBe(404);
    const broken = openPage(() => Promise.reject(Object.assign(new Error("x"), { code: "error" })));
    expect(await broken.page.run("fetch('https://myres/boom').then(function (r) { return r.status })")).toBe(500);
    const empty = openPage(() => Promise.resolve(undefined));
    expect(await empty.page.run("fetch('https://myres/n').then(function (r) { return r.json() })")).toBeNull();
  });

  it("passes every other url to the real fetch", async () => {
    const { page, calls } = openPage(() => Promise.resolve(null));
    await page.run("fetch('https://other.test/myres/x', { method: 'POST' })");
    await page.run("fetch('rsc://myres/data.json')");
    expect(calls).toEqual([]);
    expect(page.passedThroughFetches.map((f) => f.url)).toEqual(["https://other.test/myres/x", "rsc://myres/data.json"]);
  });
});
