// Run: node --test tests/*.test.js
// Runs the real popup/key-store.js and popup/popup.js in a vm with a fake DOM, fake chrome.* APIs
// and a fake IndexedDB, and drives the popup through its own events.
const test = require("node:test");
const assert = require("node:assert/strict");
const { fakeIndexedDB } = require("./helpers/fake-indexeddb.js");
const { loadPopup, tick } = require("./helpers/load-popup.js");

const KS = require("../popup/key-store.js");

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

test("IndexedDB write fails on save: warning shown, saved keys kept, nothing in storage.local", async () => {
  // txMode "error" lets reads succeed and makes every write fail.
  const idb = fakeIndexedDB({ txMode: "error" });
  const p = loadPopup({ idb, stored: { ccCraftApiSettings: { provider: "gpt", modelLists: { gpt: ["m1"] } } } });
  await p.open();
  assert.doesNotMatch(p.el("status").textContent, WARNING, "load succeeded, no warning yet");
  p.el("targetLangSelect").value = "de";
  await p.el("targetLangSelect").fire("change");
  await tick();
  assert.match(p.el("status").textContent, WARNING);
  assert.equal(p.data.ccCraftApiSettings.targetLang, "de");
  assert.equal("keys" in p.data.ccCraftApiSettings, false);
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
