// Minimal stand-in for SiYuan's `globalThis.siyuan` kernel API (see
// siyuan/kernel/plugin/*.go), enough to drive kernel.js under goja-runner.
var __mock = { storage: new Map(), records: new Map(), workspaceFile: null, backups: new Map(), mtimes: new Map(), rpc: new Map(), broadcasts: [], logs: [], watched: [], clock: 0 };

(function () {
  function log(level) {
    return async function () {
      __mock.logs.push([level].concat(Array.prototype.slice.call(arguments)));
    };
  }
  function children(dir) {
    var prefix = dir === "." ? "" : dir.replace(/\/$/, "") + "/";
    var names = new Map();
    __mock.storage.forEach(function (_, key) {
      if (key.indexOf(prefix) !== 0) return;
      var rest = key.slice(prefix.length);
      var slash = rest.indexOf("/");
      names.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0);
    });
    return names;
  }

  globalThis.siyuan = {
    plugin: {
      name: "still",
      version: "0.1.0",
      displayName: "Still",
      platform: "darwin",
      i18n: { "push.title": "{name} renews {when}", "push.body": "{price} · Still using it?", "push.tomorrow": "tomorrow", "push.inDays": "in {n} days" },
      lifecycle: { onload: null, onrunning: null, onunload: null },
    },
    logger: { trace: log("trace"), debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    event: { handler: null, emit: async function () {} },
    storage: {
      get: async function (path) {
        if (!__mock.storage.has(path)) throw new Error("file does not exist: " + path);
        var text = __mock.storage.get(path);
        return { text: async () => text, json: async () => JSON.parse(text) };
      },
      put: async function (path, content) {
        if (typeof content !== "string") throw new TypeError("storage.put content must be a string");
        __mock.storage.set(path, content);
        __mock.mtimes.set(path, ++__mock.clock);
      },
      remove: async function (path) {
        __mock.storage.delete(path);
      },
      list: async function (dir) {
        var names = children(dir);
        if (names.size === 0) throw new Error("directory does not exist: " + dir);
        var out = [];
        names.forEach(function (isDir, name) {
          var full = dir === "." ? name : dir.replace(/\/$/, "") + "/" + name;
          out.push({ name: name, isDir: isDir, isSymlink: false, updated: __mock.mtimes.get(full) || 0 });
        });
        return out;
      },
      watcher: {
        add: async function (path) {
          if (path !== "." && children(path).size === 0) throw new Error("no such directory: " + path);
          __mock.watched.push(path);
        },
        remove: async function () {},
      },
    },
    rpc: {
      bind: async function (name, handler) {
        __mock.rpc.set(name, handler);
      },
      unbind: async function (name) {
        __mock.rpc.delete(name);
      },
      broadcast: async function (method, params) {
        __mock.broadcasts.push({ method: method, params: params });
      },
    },
    agent: {
      registerCapability: async function (name, config, handler) {
        __mock.capabilities = (__mock.capabilities || {});
        __mock.capabilities[name] = { config: config, handler: handler };
        return { id: name, name: "plugin__still__" + name, description: config.description, inputSchema: config.inputSchema };
      },
      unregisterCapability: async function () {},
    },
    client: {
      fetch: async function (path, init) {
        if (path === "/api/system/getConf") {
          var body = { code: 0, msg: "", data: { conf: { system: { id: "8d2f-ABC_123-device-xyz" } } } };
          return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
        }
        function reply(body) {
          return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
        }
        if (path === "/api/file/getFile") {
          var requested = JSON.parse(init.body).path;
          var text = __mock.backups.has(requested) ? __mock.backups.get(requested) : requested === "/conf/still/records-v1.json" ? __mock.workspaceFile
            : __mock.storage.get(requested.replace("/data/storage/petal/still/", ""));
          return text == null ? { ok: true, status: 202, json: async () => ({ code: 404 }) }
            : { ok: true, status: 200, text: async () => text };
        }
        if (path === "/api/file/readDir") {
          var dir = JSON.parse(init.body).path.replace("/data/storage/petal/still/", "");
          try { return reply({ code: 0, data: await siyuan.storage.list(dir) }); }
          catch (_) { return reply({ code: 404, data: null }); }
        }
        if (path === "/api/file/putFile") {
          var boundary = init.headers["Content-Type"].split("boundary=")[1];
          var parts = init.body.split("--" + boundary);
          var target = parts[1].split("\r\n\r\n")[1].trim();
          var content = parts[2].split("\r\n\r\n")[1].trim();
          if (target.indexOf("/data/storage/petal/still/") === 0) {
            __mock.storage.set(target.replace("/data/storage/petal/still/", ""), content);
          } else if (target === "/conf/still/before-settings-migration-v2.json") {
            __mock.backups.set(target, content);
          } else {
            if (target !== "/conf/still/records-v1.json") throw new Error("unexpected workspace write");
            __mock.workspaceFile = content;
            __mock.records = new Map(Object.entries(JSON.parse(content).files));
          }
          return reply({ code: 0 });
        }
        if (path === "/api/notebook/lsNotebooks") {
          return reply({ code: 0, data: { notebooks: [{ id: "20260101000000-nb00001", name: "Journal", closed: false }, { id: "x", name: "Closed", closed: true }] } });
        }
        if (path === "/api/block/appendDailyNoteBlock") {
          __mock.journal = (__mock.journal || []).concat([JSON.parse(init.body)]);
          return reply({ code: 0, data: [] });
        }
        if (path === "/api/network/forwardProxy") {
          var req = JSON.parse(init.body);
          __mock.proxied = (__mock.proxied || []).concat([req]);
          if (__mock.proxyFailure) return __mock.proxyFailure(req, reply);
          if (req.url.indexOf("fail.example") >= 0) return reply({ code: 0, data: { url: req.url, status: 500, body: "nope" } });
          var payload = { result: "success", base_code: "USD", rates: { USD: 1, CNY: 7.2, EUR: 0.9 } };
          var envelope = { code: 0, msg: "", data: { url: req.url, status: 200, body: JSON.stringify(payload), contentType: "application/json" } };
          return { ok: true, status: 200, json: async () => envelope, text: async () => JSON.stringify(envelope) };
        }
        throw new Error("unexpected fetch: " + path);
      },
    },
  };
})();
