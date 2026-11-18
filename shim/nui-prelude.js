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

  host.on("__fxnui", function (data) {
    window.dispatchEvent(new MessageEvent("message", { data: decode(data) }));
  });

  var realFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  var prefix = "https://" + host.resource + "/";

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
    var url = urlOf(input);
    if (url.indexOf(prefix) !== 0) {
      if (realFetch === null) return Promise.reject(new TypeError("fetch is not available"));
      return realFetch(input, init);
    }
    var name = decodeURIComponent(url.slice(prefix.length).split("?")[0]);
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
