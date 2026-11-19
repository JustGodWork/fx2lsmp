(function () {
  "use strict";

  /** @type {{ resource: string, on: Function, call: Function }} */
  var host = typeof lsmp === "undefined" ? null : lsmp;
  if (host === null) return;

  var MARK = "__fx";

  /**
   * Inverse of the Lua payload codec, for messages that carry integer keys or mixed tables.
   * @param {unknown} value
   * @returns {unknown}
   */
  function decode(value) {
    if (Array.isArray(value)) return value.map(decode);
    if (value === null || typeof value !== "object") return value;
    var record = /** @type {Record<string, unknown>} */ (value);
    if (record[MARK] === "m" && Array.isArray(record.k) && Array.isArray(record.v)) {
      var out = {};
      for (var i = 0; i < record.k.length; i++) out[String(record.k[i])] = decode(record.v[i]);
      return out;
    }
    var copy = {};
    for (var key in record) {
      if (Object.prototype.hasOwnProperty.call(record, key)) copy[key] = decode(record[key]);
    }
    return copy;
  }

  window.GetParentResourceName = function () {
    return host.resource;
  };

  // FiveM pages test it to tell CEF from a plain browser, where many show demo data instead of waiting for messages.
  /**
   * @param {string} name
   * @returns {void}
   */
  window.invokeNative = function (name) {
    console.warn("invokeNative('" + String(name) + "') has no LS:MP equivalent: ignored");
  };

  host.on("__fxnui", function (data) {
    window.dispatchEvent(new MessageEvent("message", { data: decode(data) }));
  });

  var realFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  // Pages pick the scheme from location.protocol: a rsc:// page is not https:, so they fall back to http://.
  var prefixes = ["https://" + host.resource + "/", "http://" + host.resource + "/"];

  /**
   * @param {string} url
   * @returns {string | null}
   */
  function callbackPath(url) {
    for (var i = 0; i < prefixes.length; i++) {
      if (url.indexOf(prefixes[i]) === 0) return url.slice(prefixes[i].length);
    }
    return null;
  }

  /**
   * @param {unknown} input
   * @returns {string}
   */
  function urlOf(input) {
    if (typeof input === "string") return input;
    if (input && typeof input === "object") {
      var candidate = /** @type {{ url?: string, href?: string }} */ (input);
      return candidate.url || candidate.href || String(input);
    }
    return String(input);
  }

  /**
   * @param {unknown} body
   * @returns {unknown}
   */
  function parseBody(body) {
    if (typeof body !== "string" || body === "") return {};
    try {
      return JSON.parse(body);
    } catch (e) {
      return {};
    }
  }

  window.fetch = function (input, init) {
    var path = callbackPath(urlOf(input));
    if (path === null) {
      if (realFetch === null) return Promise.reject(new TypeError("fetch is not available"));
      return realFetch(input, init);
    }
    var name = decodeURIComponent(path.split("?")[0]);
    var data = parseBody(init && init.body);
    return host.call(name, data).then(
      function (answer) {
        var json = JSON.stringify(answer === undefined ? null : answer);
        return new Response(json, { status: 200, headers: { "Content-Type": "application/json" } });
      },
      function (error) {
        var status = error && error.code === "no-handler" ? 404 : 500;
        return new Response("", { status: status });
      },
    );
  };
})();
