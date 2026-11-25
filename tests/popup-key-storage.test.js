// Run: node --test tests/*.test.js
// Runs the real popup/key-store.js and popup/popup.js in a vm with a fake DOM, fake chrome.* APIs
// and a fake IndexedDB, and drives the popup through its own events.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { fakeIndexedDB } = require("./helpers/fake-indexeddb.js");

const root = path.join(__dirname, "..");
const keyStoreSrc = fs.readFileSync(path.join(root, "popup/key-store.js"), "utf8");
const popupSrc = fs.readFileSync(path.join(root, "popup/popup.js"), "utf8");
const KS = require("../popup/key-store.js");

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function fakeElement(id) {
  const listeners = {};
  const classes = new Set();
  return {
    id,
    value: "",
    checked: false,
    textContent: "",
    innerHTML: "",
    children: [],
    files: [],
    classList: {
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    async fire(type) {
      await Promise.all((listeners[type] || []).map((fn) => fn({ target: this })));
    }
  };
}

function loadPopup({ stored = {}, idb = fakeIndexedDB(), incognito = false, models = ["model-a"] } = {}) {
  const elements = new Map();
  const docListeners = {};
  const data = structuredClone(stored);
  const messages = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement(id));
      return elements.get(id);
    },
    createElement: (tag) => fakeElement(tag),
    addEventListener(type, fn) {
      (docListeners[type] ||= []).push(fn);
    }
  };
  const storage = {
    async get(query) {
      if (typeof query === "string") return query in data ? { [query]: structuredClone(data[query]) } : {};
      const out = {};
      for (const [k, def] of Object.entries(query || {})) out[k] = k in data ? structuredClone(data[k]) : def;
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    }
  };
  const chrome = {
    storage: { local: storage },
    extension: { inIncognitoContext: incognito },
    tabs: { query: async () => [], sendMessage: async () => ({ ok: false }) },
    runtime: {
      async sendMessage(msg) {
        messages.push(msg);
        if (msg.type === "LIST_MODELS") return { ok: true, models };
        return { ok: false };
      }
    }
  };
  const ctx = { document, chrome, indexedDB: idb, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Promise };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(keyStoreSrc, ctx, { filename: "key-store.js" });
  vm.runInContext(popupSrc, ctx, { filename: "popup.js" });
  return {
    data,
    idb,
    messages,
    el: (id) => document.getElementById(id),
    async open() {
      await Promise.all((docListeners.DOMContentLoaded || []).map((fn) => fn()));
      await tick();
    }
  };
}

async function idbKeys(idb) {
  return KS.createIdbStore(idb).get();
}

const WARNING = /API keys can't be saved in this window/;

test("popup open migrates legacy keys, shows them, and strips them from chrome.storage.local", async () => {
  const p = loadPopup({
    stored: { ccCraftApiSettings: { provider: "gpt", targetLang: "de", keys: { gpt: "sk-legacy" }, modelLists: { gpt: ["m1"] } } }
  });
  await p.open();
  assert.equal(p.el("providerSelect").value, "gpt");
  assert.equal(p.el("apiKeyInput").value, "sk-legacy");
  assert.equal(p.el("targetLangSelect").value, "de");
  assert.equal("keys" in p.data.ccCraftApiSettings, false);
  assert.doesNotMatch(JSON.stringify(p.data), /sk-legacy/);
  assert.equal((await idbKeys(p.idb)).gpt, "sk-legacy");
  assert.doesNotMatch(p.el("status").textContent, WARNING);
});

test("typing a key saves it to IndexedDB only, and the next popup shows it", async () => {
  const idb = fakeIndexedDB();
  const p = loadPopup({ idb, stored: { ccCraftApiSettings: { provider: "nvidia" } } });
  await p.open();
  p.el("apiKeyInput").value = "nvapi-typed";
  await p.el("apiKeyInput").fire("change");
  await tick();
  const list = p.messages.find((m) => m.type === "LIST_MODELS");
  assert.equal(list.provider, "nvidia");
  assert.equal(list.apiKey, "nvapi-typed");
  assert.equal((await idbKeys(idb)).nvidia, "nvapi-typed");
  assert.doesNotMatch(JSON.stringify(p.data), /nvapi-typed/);
  assert.deepEqual(p.data.ccCraftApiSettings.modelLists.nvidia, ["model-a"]);

  const next = loadPopup({ idb, stored: p.data });
  await next.open();
  assert.equal(next.el("apiKeyInput").value, "nvapi-typed");
});

test("IndexedDB unavailable: warning shown, settings saved, no key written anywhere", async () => {
  const p = loadPopup({
    idb: fakeIndexedDB({ openMode: "error" }),
    stored: { ccCraftApiSettings: { provider: "gpt", targetLang: "fa" } }
  });
  await p.open();
  assert.match(p.el("status").textContent, WARNING);

  p.el("targetLangSelect").value = "de";
  await p.el("targetLangSelect").fire("change");
  p.el("apiKeyInput").value = "sk-typed";
  await p.el("apiKeyInput").fire("change");
  await tick();
  assert.equal(p.data.ccCraftApiSettings.targetLang, "de");
  assert.doesNotMatch(JSON.stringify(p.data), /sk-typed/);
  assert.equal("keys" in p.data.ccCraftApiSettings, false);
  assert.match(p.el("status").textContent, WARNING, "warning still visible after other status messages");
});

test("IndexedDB unavailable with legacy keys: they stay usable and untouched", async () => {
  const p = loadPopup({
    idb: fakeIndexedDB({ openMode: "error" }),
    stored: { ccCraftApiSettings: { provider: "gpt", keys: { gpt: "sk-legacy" }, modelLists: { gpt: ["m1"] } } }
  });
  await p.open();
  assert.equal(p.el("apiKeyInput").value, "sk-legacy");
  p.el("apiKeyInput").value = "sk-other";
  await p.el("apiKeyInput").fire("change");
  await tick();
  assert.deepEqual(p.data.ccCraftApiSettings.keys, { gpt: "sk-legacy" });
  assert.doesNotMatch(JSON.stringify(p.data), /sk-other/);
});

test("private window: IndexedDB is never opened and a warning is shown", async () => {
  const idb = fakeIndexedDB();
  const p = loadPopup({ idb, incognito: true, stored: { ccCraftApiSettings: { provider: "gpt", keys: { gpt: "sk-legacy" } } } });
  await p.open();
  assert.equal(idb.stats.opened, 0);
  assert.equal(p.el("apiKeyInput").value, "sk-legacy");
  assert.match(p.el("status").textContent, WARNING);
  assert.deepEqual(p.data.ccCraftApiSettings.keys, { gpt: "sk-legacy" });
});
