// Run: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const KS = require("../popup/key-store.js");

// ---------- fakes ----------

function fakeStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    }
  };
}

function memoryStore(initial, { failGet = false, failSet = false } = {}) {
  let value = initial === undefined ? undefined : structuredClone(initial);
  return {
    get value() {
      return value;
    },
    async get() {
      if (failGet) throw new Error("boom");
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(v) {
      if (failSet) throw new Error("boom");
      value = structuredClone(v);
    }
  };
}

const { fakeIndexedDB } = require("./helpers/fake-indexeddb.js");

const KEY = KS.SETTINGS_KEY;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function makeStore(storage, secretStore, opts = {}) {
  return KS.createApiSettingsStore({ storage, secretStore, ...opts });
}

// ---------- load ----------

test("migrates keys from chrome.storage.local into the secret store and strips them", async () => {
  const storage = fakeStorage({
    [KEY]: { provider: "nvidia", targetLang: "zh-TW", models: { nvidia: "m" }, keys: { nvidia: "nvapi-1,nvapi-2", gemini: "" } }
  });
  const secretStore = memoryStore(undefined);
  const store = makeStore(storage, secretStore);
  const out = await store.load();
  assert.equal(out.secure, true);
  assert.equal(store.state, "secure");
  assert.deepEqual(out.keys, { nvidia: "nvapi-1,nvapi-2", gemini: "" });
  assert.deepEqual(secretStore.value, { nvidia: "nvapi-1,nvapi-2", gemini: "" });
  assert.deepEqual(storage.data[KEY], { provider: "nvidia", targetLang: "zh-TW", models: { nvidia: "m" } });
  assert.equal("keys" in out.settings, false);
  assert.doesNotMatch(JSON.stringify(storage.data), /nvapi/);
});

test("legacy keys win over an older stored copy, other providers kept", async () => {
  const storage = fakeStorage({ [KEY]: { keys: { nvidia: "new", gpt: "" } } });
  const secretStore = memoryStore({ nvidia: "old", gpt: "sk-old", gemini: "AIza-keep" });
  const out = await makeStore(storage, secretStore).load();
  assert.deepEqual(out.keys, { nvidia: "new", gpt: "", gemini: "AIza-keep" });
  assert.deepEqual(secretStore.value, out.keys);
  assert.equal("keys" in storage.data[KEY], false);
});

test("already migrated: reads keys from the secret store and does not write storage", async () => {
  const storage = fakeStorage({ [KEY]: { provider: "gpt" } });
  let writes = 0;
  const set = storage.set;
  storage.set = async (x) => {
    writes++;
    return set(x);
  };
  const out = await makeStore(storage, memoryStore({ gpt: "sk-1" })).load();
  assert.deepEqual(out, { settings: { provider: "gpt" }, keys: { gpt: "sk-1" }, secure: true });
  assert.equal(writes, 0);
});

test("nothing stored: empty settings and keys", async () => {
  const out = await makeStore(fakeStorage(), memoryStore(undefined)).load();
  assert.deepEqual(out, { settings: {}, keys: {}, secure: true });
});

test("malformed stored values are ignored", async () => {
  const out = await makeStore(fakeStorage({ [KEY]: { keys: ["x"], provider: "gpt" } }), memoryStore({ gpt: 5, nvidia: "ok" })).load();
  assert.deepEqual(out.keys, { nvidia: "ok" });
  assert.deepEqual((await makeStore(fakeStorage({ [KEY]: [1] }), memoryStore(undefined)).load()).settings, {});
  assert.deepEqual(KS.cleanKeys(null), {});
  assert.deepEqual(KS.cleanKeys({ a: "1", b: null, c: {} }), { a: "1" });
});

test("strip step failing after a successful migration does not fail load", async () => {
  const storage = fakeStorage({ [KEY]: { keys: { gpt: "sk-1" } } });
  storage.set = async () => {
    throw new Error("quota");
  };
  const secretStore = memoryStore(undefined);
  const out = await makeStore(storage, secretStore).load();
  assert.equal(out.secure, true);
  assert.deepEqual(secretStore.value, { gpt: "sk-1" });
});

// ---------- "keys unknown" mode: nothing may overwrite saved keys ----------

test("read failure, then saves: saved keys are never overwritten (review HIGH 1)", async () => {
  const storage = fakeStorage({ [KEY]: { provider: "gpt" } });
  const secretStore = memoryStore({ gpt: "sk-saved", nvidia: "nvapi-saved" }, { failGet: true });
  const store = makeStore(storage, secretStore);
  const out = await store.load();
  assert.equal(out.secure, false);
  assert.equal(store.state, "unknown");
  assert.deepEqual(out.keys, {});

  // The popup now holds empty keys; the user changes language, then types one key.
  const res1 = await store.save({ provider: "gpt", targetLang: "de", keys: { gpt: "", nvidia: "", gemini: "" } });
  const res2 = await store.save({ provider: "gpt", targetLang: "de", keys: { gpt: "sk-typed" } });
  assert.deepEqual(res1, { saved: true, secure: false });
  assert.deepEqual(res2, { saved: true, secure: false });
  assert.deepEqual(secretStore.value, { gpt: "sk-saved", nvidia: "nvapi-saved" });
  assert.deepEqual(storage.data[KEY], { provider: "gpt", targetLang: "de" }, "no keys written to storage.local");

  // Next popup, IndexedDB works again: the saved keys are still there.
  const next = await makeStore(storage, memoryStore(secretStore.value)).load();
  assert.deepEqual(next.keys, { gpt: "sk-saved", nvidia: "nvapi-saved" });
});

test("read failure with legacy keys: legacy field kept exactly as it was, nothing migrated", async () => {
  const legacy = { gpt: "sk-1", nvidia: "" };
  const storage = fakeStorage({ [KEY]: { provider: "gpt", keys: legacy } });
  const secretStore = memoryStore(undefined, { failGet: true });
  const store = makeStore(storage, secretStore);
  const out = await store.load();
  assert.deepEqual(out.keys, legacy);
  await store.save({ provider: "nvidia", keys: { gpt: "sk-CHANGED", nvidia: "nvapi-new" } });
  assert.deepEqual(storage.data[KEY], { provider: "nvidia", keys: legacy });
  assert.equal(secretStore.value, undefined);
});

test("migration write failure: unknown mode, storage.local not stripped", async () => {
  const storage = fakeStorage({ [KEY]: { keys: { gpt: "sk-1" } } });
  const store = makeStore(storage, memoryStore(undefined, { failSet: true }));
  const out = await store.load();
  assert.equal(out.secure, false);
  assert.equal(store.state, "unknown");
  assert.deepEqual(storage.data[KEY].keys, { gpt: "sk-1" });
});

test("private window: the secret store is not touched and legacy keys are not migrated", async () => {
  const storage = fakeStorage({ [KEY]: { keys: { gpt: "sk-1" } } });
  let touched = 0;
  const secretStore = {
    async get() {
      touched++;
    },
    async set() {
      touched++;
    }
  };
  const store = makeStore(storage, secretStore, { incognito: true });
  const out = await store.load();
  assert.equal(out.secure, false);
  assert.deepEqual(out.keys, { gpt: "sk-1" });
  await store.save({ keys: { gpt: "sk-2" } });
  assert.equal(touched, 0);
  assert.deepEqual(storage.data[KEY], { keys: { gpt: "sk-1" } });
});

// ---------- save ----------

test("save writes keys only to the secret store", async () => {
  const storage = fakeStorage();
  const secretStore = memoryStore(undefined);
  const store = makeStore(storage, secretStore);
  await store.load();
  const settings = { provider: "gpt", targetLang: "fa", keys: { gpt: "sk-1" } };
  assert.deepEqual(await store.save(settings), { saved: true, secure: true });
  assert.deepEqual(secretStore.value, { gpt: "sk-1" });
  assert.deepEqual(storage.data[KEY], { provider: "gpt", targetLang: "fa" });
  assert.equal(settings.keys.gpt, "sk-1", "caller's object is not mutated");
});

test("save before load finished is skipped (the popup still holds its empty defaults)", async () => {
  const storage = fakeStorage({ [KEY]: { provider: "gpt" } });
  const secretStore = memoryStore({ gpt: "sk-saved" });
  const store = makeStore(storage, secretStore);
  assert.deepEqual(await store.save({ provider: "gemini", keys: { gpt: "" } }), { saved: false, secure: false });
  assert.deepEqual(secretStore.value, { gpt: "sk-saved" });
  assert.deepEqual(storage.data[KEY], { provider: "gpt" });
});

test("save during the migration's strip step is skipped and cannot erase migrated keys", async () => {
  const storage = fakeStorage({ [KEY]: { provider: "gpt", keys: { gpt: "sk-legacy" } } });
  const realSet = storage.set;
  let releaseStrip;
  storage.set = (x) => new Promise((resolve) => (releaseStrip = () => resolve(realSet(x))));
  const secretStore = memoryStore(undefined);
  const store = makeStore(storage, secretStore);
  const loading = store.load();
  await tick();
  assert.equal(typeof releaseStrip, "function", "load is waiting on the strip write");
  storage.set = realSet;
  const early = await store.save({ provider: "gpt", keys: { gpt: "", nvidia: "" } });
  assert.deepEqual(early, { saved: false, secure: false });
  releaseStrip();
  const out = await loading;
  assert.deepEqual(out.keys, { gpt: "sk-legacy" });
  assert.deepEqual(secretStore.value, { gpt: "sk-legacy" });
});

test("popup appends the key warning to every status message", () => {
  const js = fs.readFileSync(path.join(__dirname, "..", "popup/popup.js"), "utf8");
  const code =
    js.slice(js.indexOf("let keyStoreUnsafe"), js.indexOf("\n}", js.indexOf("function setStatus")) + 2) +
    js.slice(js.indexOf("function warnKeyStore"), js.indexOf("// Saves run one at a time"));
  const classes = new Set();
  const statusEl = {
    textContent: "",
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) }
  };
  const ctx = { statusEl };
  ctx.globalThis = ctx;
  require("node:vm").createContext(ctx);
  require("node:vm").runInContext(fs.readFileSync(path.join(__dirname, "..", "src/i18n.js"), "utf8"), ctx);
  require("node:vm").runInContext(
    'function t(key, vars) { return CcCraftI18n.translate("en", key, vars); }\n' +
      code + "\nthis.setStatus = setStatus; this.warnKeyStore = warnKeyStore;",
    ctx
  );
  ctx.setStatus("Loading tracks...");
  assert.equal(statusEl.textContent, "Loading tracks...");
  ctx.warnKeyStore();
  assert.match(statusEl.textContent, /^Loading tracks\.\.\.\n\n⚠️ API keys can't be saved/);
  ctx.setStatus("This video has no extractable subtitles.", true);
  assert.match(statusEl.textContent, /^This video has no extractable subtitles\.\n\n⚠️ API keys/);
  ctx.setStatus("");
  assert.match(statusEl.textContent, /^⚠️ API keys/);
  assert.ok(classes.has("show") && classes.has("error"));
});

test("secret store write failure on save: no fallback to storage.local, old keys kept", async () => {
  const storage = fakeStorage();
  let fail = false;
  const inner = memoryStore({ gpt: "sk-old" });
  const secretStore = {
    get: () => inner.get(),
    set: (v) => (fail ? Promise.reject(new Error("boom")) : inner.set(v))
  };
  const store = makeStore(storage, secretStore);
  await store.load();
  fail = true;
  assert.deepEqual(await store.save({ provider: "gpt", keys: { gpt: "sk-new" } }), { saved: true, secure: false });
  assert.deepEqual(inner.value, { gpt: "sk-old" });
  assert.deepEqual(storage.data[KEY], { provider: "gpt" });
  assert.doesNotMatch(JSON.stringify(storage.data), /sk-/);
});

test("saves run one at a time in call order (review HIGH 2)", async () => {
  const log = [];
  const storage = fakeStorage();
  const realSet = storage.set;
  storage.set = async (x) => {
    log.push("storage:" + x[KEY].targetLang);
    return realSet(x);
  };
  const gates = [];
  const secretStore = {
    async get() {
      return {};
    },
    set(v) {
      log.push("idb-start:" + v.gpt);
      return new Promise((resolve) => gates.push(() => resolve(log.push("idb-end:" + v.gpt))));
    }
  };
  const store = makeStore(storage, secretStore);
  await store.load();
  const p1 = store.save({ targetLang: "a", keys: { gpt: "1" } });
  const p2 = store.save({ targetLang: "b", keys: { gpt: "2" } });
  await tick();
  assert.deepEqual(log, ["idb-start:1"], "second save waits for the first");
  gates.shift()();
  await p1;
  await tick();
  gates.shift()();
  await p2;
  assert.deepEqual(log, ["idb-start:1", "idb-end:1", "storage:a", "idb-start:2", "idb-end:2", "storage:b"]);
  assert.deepEqual(storage.data[KEY], { targetLang: "b" });
});

test("a failed save does not block the next one", async () => {
  const storage = fakeStorage();
  let n = 0;
  const realSet = storage.set;
  storage.set = async (x) => {
    if (n++ === 0) throw new Error("quota");
    return realSet(x);
  };
  const store = makeStore(storage, memoryStore({}));
  await store.load();
  await assert.rejects(store.save({ targetLang: "a", keys: {} }), /quota/);
  assert.deepEqual(await store.save({ targetLang: "b", keys: {} }), { saved: true, secure: true });
  assert.deepEqual(storage.data[KEY], { targetLang: "b" });
});

test("save reads the settings object when it runs (latest state wins)", async () => {
  const storage = fakeStorage();
  const secretStore = memoryStore({});
  const store = makeStore(storage, secretStore);
  await store.load();
  const live = { targetLang: "a", keys: { gpt: "1" } };
  const p = store.save(live);
  live.targetLang = "b";
  live.keys.gpt = "2";
  await p;
  assert.deepEqual(storage.data[KEY], { targetLang: "b" });
  assert.deepEqual(secretStore.value, { gpt: "2" });
});

// ---------- createIdbStore against a fake IndexedDB ----------

test("IndexedDB adapter round-trips and closes every connection", async () => {
  const idb = fakeIndexedDB();
  const store = KS.createIdbStore(idb);
  assert.equal(await store.get(), undefined);
  await store.set({ gpt: "sk-1" });
  assert.deepEqual(await store.get(), { gpt: "sk-1" });
  assert.deepEqual([...idb.dbs.keys()], [KS.DB_NAME]);
  assert.equal(idb.stats.opened, 3);
  assert.equal(idb.stats.closed, 3);
});

test("IndexedDB adapter rejects on open error, blocked, missing API, tx throw, abort and error", async () => {
  for (const [opts, re] of [
    [{ openMode: "error" }, /open failed/],
    [{ openMode: "blocked" }, /blocked/],
    [{ txMode: "throw" }, /transaction failed/],
    [{ txMode: "abort" }, /aborted/],
    [{ txMode: "error" }, /transaction failed/]
  ]) {
    const idb = fakeIndexedDB(opts);
    const store = KS.createIdbStore(idb);
    await assert.rejects(opts.txMode === "error" ? store.set({ a: "1" }) : store.get(), re, JSON.stringify(opts));
    assert.equal(idb.stats.opened, idb.stats.closed, "connection closed: " + JSON.stringify(opts));
  }
  await assert.rejects(KS.createIdbStore(undefined).get(), /unavailable/);
});

test("IndexedDB adapter closes a connection that opens after it was reported blocked", async () => {
  let request;
  let closed = 0;
  const idb = {
    open() {
      request = {};
      setTimeout(() => {
        request.onblocked();
        request.result = { close: () => closed++ };
        request.onsuccess();
      }, 0);
      return request;
    }
  };
  await assert.rejects(KS.createIdbStore(idb).get(), /blocked/);
  await tick();
  assert.equal(closed, 1);
});

test("IndexedDB adapter times out when open never completes, and load goes to unknown mode", async () => {
  const idbStore = KS.createIdbStore(fakeIndexedDB({ openMode: "hang" }), { timeoutMs: 30 });
  const t0 = Date.now();
  await assert.rejects(idbStore.get(), /timeout/);
  assert.ok(Date.now() - t0 < 1000);
  const storage = fakeStorage({ [KEY]: { keys: { gpt: "sk-1" } } });
  const store = makeStore(storage, idbStore);
  const out = await store.load();
  assert.equal(out.secure, false);
  assert.equal(store.state, "unknown");
  assert.deepEqual(storage.data[KEY].keys, { gpt: "sk-1" });
});

// ---------- wiring ----------

test("popup loads key-store.js first and saves only through the settings store", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "popup/popup.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "popup/popup.js"), "utf8");
  const a = html.indexOf('src="key-store.js"');
  const b = html.indexOf('src="popup.js"');
  assert.ok(a > 0 && b > a);
  assert.doesNotMatch(js, /ccCraftApiSettings/, "popup.js does not read or write the settings key itself");
  assert.match(js, /apiSettingsStore\.save\(apiSettings\)/);
  assert.match(js, /apiSettingsStore\.load\(\)/);
  assert.match(js, /inIncognitoContext/);
  const content = fs.readFileSync(path.join(root, "src/content.js"), "utf8");
  assert.doesNotMatch(content, /\.keys\b/, "content script does not touch keys");
});
