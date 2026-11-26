// Runs the real popup/key-store.js and popup/popup.js in a vm with a fake DOM, fake chrome.* APIs
// and a fake IndexedDB. The popup is driven through its own events (el(id).fire("change")).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { fakeIndexedDB } = require("./fake-indexeddb.js");

const root = path.join(__dirname, "..", "..");
const keyStoreSrc = fs.readFileSync(path.join(root, "popup/key-store.js"), "utf8");
const popupSrc = fs.readFileSync(path.join(root, "popup/popup.js"), "utf8");

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

module.exports = { loadPopup, tick };
