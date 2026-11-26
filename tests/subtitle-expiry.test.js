// Run: node --test tests/*.test.js
// Stored-subtitle expiry: the real src/background.js and functions extracted from src/content.js,
// run in a vm with a minimal chrome.* mock.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src");
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

function makeChrome(initial = {}) {
  const store = JSON.parse(JSON.stringify(initial));
  const listeners = { message: [], startup: [], installed: [] };
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      sendMessage: async () => ({ ok: true })
    },
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) return JSON.parse(JSON.stringify(store));
          const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out = {};
          for (const k of list) {
            if (k in store) out[k] = JSON.parse(JSON.stringify(store[k]));
            else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[k] = keys[k];
          }
          return out;
        },
        async set(obj) {
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
        },
        async remove(keys) {
          for (const k of [].concat(keys)) delete store[k];
        }
      }
    },
    tabs: { sendMessage: async () => ({ ok: true }) }
  };
  return { chrome, store, listeners };
}

function loadBackground(initial) {
  const env = makeChrome(initial);
  const ctx = vm.createContext({ chrome: env.chrome, fetch: async () => { throw new Error("no network"); }, AbortController, setTimeout, clearTimeout, console, URL });
  vm.runInContext(fs.readFileSync(path.join(SRC, "background.js"), "utf8"), ctx, { filename: "background.js" });
  return { ...env, ctx };
}

function extractFunction(source, name) {
  const start = source.search(new RegExp("(async )?function " + name + "\\("));
  if (start < 0) throw new Error("not found: " + name);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("unbalanced: " + name);
}

function loadContent(chrome, { waitMs = 3000, videoId = "vid1" } = {}) {
  const source = fs.readFileSync(path.join(SRC, "content.js"), "utf8");
  const ctx = vm.createContext({
    chrome,
    setTimeout,
    clearTimeout,
    Date,
    console,
    document: { getElementById: () => null, querySelector: () => null },
    getVideoId: () => videoId,
    extractTranslatedCues: (wf) => wf.cues.map((c) => ({ start: c.start, end: c.end, text: c.fa, orig: c.source })),
    injectOverlay: () => null,
    applySettings: () => {},
    setOverlayText: () => {},
    settings: { enabled: true },
    faCues: [],
    subsDir: "rtl",
    origLang: "en",
    userLang: "fa",
    flashUntil: 0
  });
  vm.runInContext("var SUBTITLE_PURGE_WAIT_MS = " + waitMs + "; var storedCuesGeneration = 0;\n" +
    ["requestSubtitlePurge", "loadStoredCues", "loadTranslatedJson", "clearSubs"].map((n) => extractFunction(source, n)).join("\n\n"), ctx);
  return ctx;
}

const subs = [{ start: 1, end: 2, text: "譯文", orig: "source" }];
const video = (id, meta, status) => ({
  ["cccraftSubs:" + id]: subs,
  ...(meta === undefined ? {} : { ["cccraftSubsMeta:" + id]: meta }),
  ...(status === undefined ? {} : { ["ccCraftTranslateStatus:" + id]: status })
});
const keysOf = (store, id) => ["cccraftSubs:", "cccraftSubsMeta:", "ccCraftTranslateStatus:"].filter((p) => p + id in store);

// ---------- background: purge rule ----------

test("subtitles older than 7 days are removed with their meta and status; newer ones and settings stay", async () => {
  const { ctx, store } = loadBackground({
    ...video("old", { dir: "ltr", srcLang: "en", saved_at: NOW - 8 * DAY }, { state: "done", updated_at: NOW - 8 * DAY }),
    ...video("edge", { dir: "ltr", saved_at: NOW - 7 * DAY }),
    ...video("fresh", { dir: "ltr", saved_at: NOW - 6 * DAY }, { state: "done", updated_at: NOW - 6 * DAY }),
    ccCraftApiSettings: { provider: "nvidia" },
    ccCraftSubtitleSettings: { enabled: true }
  });
  const result = await ctx.purgeExpiredSubtitles(NOW);
  assert.deepEqual(keysOf(store, "old"), []);
  assert.deepEqual(keysOf(store, "edge"), [], "exactly 7 days counts as expired");
  assert.deepEqual(keysOf(store, "fresh"), ["cccraftSubs:", "cccraftSubsMeta:", "ccCraftTranslateStatus:"]);
  assert.ok(store.ccCraftApiSettings && store.ccCraftSubtitleSettings);
  assert.equal(result.removed, 2);
});

test("expiry counts from saving, not from viewing: a recently watched old translation is still removed", async () => {
  const { ctx, store } = loadBackground(video("watched", { dir: "ltr", saved_at: NOW - 8 * DAY }, { state: "done", updated_at: NOW - 1 * DAY }));
  await ctx.purgeExpiredSubtitles(NOW);
  assert.deepEqual(keysOf(store, "watched"), []);
});

test("legacy entries without saved_at are stamped once and expire 7 days later, keeping their meta", async () => {
  const { ctx, store } = loadBackground({
    ...video("legacy", { dir: "ltr", srcLang: "de" }),
    ...video("nometa")
  });
  const first = await ctx.purgeExpiredSubtitles(NOW);
  assert.equal(first.stamped, 2);
  assert.deepEqual(store["cccraftSubsMeta:legacy"], { dir: "ltr", srcLang: "de", saved_at: NOW });
  assert.deepEqual(store["cccraftSubsMeta:nometa"], { saved_at: NOW });
  assert.ok(store["cccraftSubs:legacy"] && store["cccraftSubs:nometa"]);

  await ctx.purgeExpiredSubtitles(NOW + 6 * DAY);
  assert.ok(store["cccraftSubs:legacy"]);
  await ctx.purgeExpiredSubtitles(NOW + 7 * DAY);
  assert.deepEqual(keysOf(store, "legacy"), []);
  assert.deepEqual(keysOf(store, "nometa"), []);
});

test("a saved_at far in the future (clock change) is stamped again instead of living forever", async () => {
  const { ctx, store } = loadBackground(video("future", { saved_at: NOW + 30 * DAY }));
  await ctx.purgeExpiredSubtitles(NOW);
  assert.equal(store["cccraftSubsMeta:future"].saved_at, NOW);
});

test("a status without subtitles expires 7 days after its last update", async () => {
  const { ctx, store } = loadBackground({
    "ccCraftTranslateStatus:failed": { state: "error", updated_at: NOW - 8 * DAY },
    "ccCraftTranslateStatus:recent": { state: "error", updated_at: NOW - 1 * DAY }
  });
  await ctx.purgeExpiredSubtitles(NOW);
  assert.equal("ccCraftTranslateStatus:failed" in store, false);
  assert.equal("ccCraftTranslateStatus:recent" in store, true);
});

test("a translation checkpoint expires 7 days after its last update, apart from the subtitles", async () => {
  const { ctx, store } = loadBackground({
    "ccCraftTranslateCheckpoint:stale": { v: 1, updated_at: NOW - 8 * DAY },
    "ccCraftTranslateCheckpoint:broken": { v: 1 },
    // Old subtitles of a video being translated again: they go, the fresh checkpoint stays.
    ...video("again", { saved_at: NOW - 8 * DAY }),
    "ccCraftTranslateCheckpoint:again": { v: 1, updated_at: NOW - 1 * DAY }
  });
  await ctx.purgeExpiredSubtitles(NOW);
  assert.equal("ccCraftTranslateCheckpoint:stale" in store, false);
  assert.equal("ccCraftTranslateCheckpoint:broken" in store, false);
  assert.deepEqual(keysOf(store, "again"), []);
  assert.equal("ccCraftTranslateCheckpoint:again" in store, true);
});

test("a checkpoint updated while the purge runs is kept", async () => {
  const { ctx, chrome, store } = loadBackground({ "ccCraftTranslateCheckpoint:live": { v: 1, updated_at: NOW - 8 * DAY } });
  const get = chrome.storage.local.get;
  let snapshots = 0;
  chrome.storage.local.get = async (keys) => {
    const out = await get(keys);
    if (keys === null && ++snapshots === 1) store["ccCraftTranslateCheckpoint:live"] = { v: 1, updated_at: NOW };
    return out;
  };
  await ctx.purgeExpiredSubtitles(NOW);
  assert.deepEqual(store["ccCraftTranslateCheckpoint:live"], { v: 1, updated_at: NOW });
});

test("concurrent purge calls share one run", async () => {
  const { ctx, chrome } = loadBackground(video("a", { saved_at: NOW - 8 * DAY }));
  let reads = 0;
  const get = chrome.storage.local.get;
  chrome.storage.local.get = (keys) => {
    if (keys === null) reads++; // full snapshots only; each run also re-reads the affected keys
    return get(keys);
  };
  await Promise.all([ctx.purgeExpiredSubtitles(NOW), ctx.purgeExpiredSubtitles(NOW), ctx.purgeExpiredSubtitles(NOW)]);
  assert.equal(reads, 1);
  await ctx.purgeExpiredSubtitles(NOW);
  assert.equal(reads, 2, "a later call runs again");
});

test("browser startup, install/update and the content-script message all trigger the purge", async () => {
  for (const trigger of ["startup", "installed", "message"]) {
    const { store, listeners } = loadBackground(video("old", { saved_at: Date.now() - 8 * DAY }));
    if (trigger === "message") {
      const response = await new Promise((resolve) => {
        const handled = listeners.message.map((fn) => fn({ type: "PURGE_EXPIRED_SUBTITLES" }, {}, resolve));
        assert.ok(handled.includes(true), "keeps the channel open for the async response");
      });
      assert.equal(response.ok, true);
      assert.equal(response.removed, 1);
    } else {
      listeners[trigger].forEach((fn) => fn());
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(keysOf(store, "old"), [], trigger);
  }
});

// ---------- content script ----------

test("saving subtitles records saved_at and asks for a purge", async () => {
  const env = makeChrome({});
  const sent = [];
  env.chrome.runtime.sendMessage = async (m) => {
    sent.push(m.type);
    return { ok: true };
  };
  const ctx = loadContent(env.chrome);
  const before = Date.now();
  await ctx.loadTranslatedJson({ cues: [{ start: 1, end: 2, fa: "譯文", source: "s" }], source_track: { languageCode: "en" } }, "ltr");
  const meta = env.store["cccraftSubsMeta:vid1"];
  assert.ok(meta.saved_at >= before && meta.saved_at <= Date.now());
  assert.equal(meta.dir, "ltr");
  assert.deepEqual(sent, ["PURGE_EXPIRED_SUBTITLES"]);
});

test("clearing subtitles removes subtitles, meta, status and checkpoint of the video only", async () => {
  const env = makeChrome({
    ...video("vid1", { saved_at: NOW }, { state: "done" }),
    ...video("other", { saved_at: NOW }),
    "ccCraftTranslateCheckpoint:vid1": { v: 1, updated_at: NOW },
    "ccCraftTranslateCheckpoint:other": { v: 1, updated_at: NOW }
  });
  const ctx = loadContent(env.chrome);
  await ctx.clearSubs();
  assert.deepEqual(keysOf(env.store, "vid1"), []);
  assert.equal("ccCraftTranslateCheckpoint:vid1" in env.store, false, "the next Translate starts over");
  assert.deepEqual(keysOf(env.store, "other"), ["cccraftSubs:", "cccraftSubsMeta:"]);
  assert.equal("ccCraftTranslateCheckpoint:other" in env.store, true);
});

test("loading stored subtitles waits for the purge, so expired ones are not shown", async () => {
  const { ctx: bg, chrome, listeners } = loadBackground(video("vid1", { dir: "ltr", saved_at: Date.now() - 8 * DAY }));
  chrome.runtime.sendMessage = (m) => new Promise((resolve) => listeners.message.forEach((fn) => fn(m, {}, resolve)));
  const ctx = loadContent(chrome);
  await ctx.loadStoredCues();
  assert.equal(vm.runInContext("faCues.length", ctx), 0);
  assert.ok(bg);
});

test("a background that never answers delays loading only up to the wait limit", async () => {
  const env = makeChrome(video("vid1", { dir: "ltr", saved_at: Date.now() }));
  env.chrome.runtime.sendMessage = () => new Promise(() => {});
  const ctx = loadContent(env.chrome, { waitMs: 30 });
  const t0 = Date.now();
  await ctx.loadStoredCues();
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(vm.runInContext("faCues.length", ctx), 1);
});

test("a failing sendMessage (extension reloaded) does not break loading", async () => {
  const env = makeChrome(video("vid1", { dir: "ltr", saved_at: Date.now() }));
  env.chrome.runtime.sendMessage = () => {
    throw new Error("Extension context invalidated.");
  };
  const ctx = loadContent(env.chrome);
  await ctx.loadStoredCues();
  assert.equal(vm.runInContext("faCues.length", ctx), 1);
});

// ---------- review round 1: races ----------

// Runs `between` right after the purge took its full snapshot, like a save or clear in another tab.
function interleaveAfterSnapshot(chrome, between) {
  const get = chrome.storage.local.get;
  let done = false;
  chrome.storage.local.get = async (keys) => {
    const result = await get(keys);
    if (keys === null && !done) {
      done = true;
      await between();
    }
    return result;
  };
}

test("a save that lands after the purge snapshot is not deleted", async () => {
  const { ctx, chrome, store } = loadBackground(video("x", { dir: "ltr", saved_at: NOW - 8 * DAY }, { state: "done", updated_at: NOW - 8 * DAY }));
  interleaveAfterSnapshot(chrome, () => chrome.storage.local.set({
    "cccraftSubs:x": subs, "cccraftSubsMeta:x": { dir: "rtl", srcLang: "fa", saved_at: NOW }, "ccCraftTranslateStatus:x": { state: "done", updated_at: NOW }
  }));
  const result = await ctx.purgeExpiredSubtitles(NOW);
  assert.equal(result.removed, 0);
  assert.deepEqual(keysOf(store, "x"), ["cccraftSubs:", "cccraftSubsMeta:", "ccCraftTranslateStatus:"]);
});

test("a save after the snapshot is not overwritten by stamping a legacy entry", async () => {
  const { ctx, chrome, store } = loadBackground(video("legacy", { dir: "ltr", srcLang: "en" }));
  const fresh = { dir: "rtl", srcLang: "fa", saved_at: NOW - 1000 };
  interleaveAfterSnapshot(chrome, () => chrome.storage.local.set({ "cccraftSubsMeta:legacy": fresh }));
  await ctx.purgeExpiredSubtitles(NOW);
  assert.deepEqual(store["cccraftSubsMeta:legacy"], fresh);
});

test("a clear after the snapshot does not leave a stamped meta behind", async () => {
  const { ctx, chrome, store } = loadBackground(video("legacy", { dir: "ltr" }));
  interleaveAfterSnapshot(chrome, () => chrome.storage.local.remove(["cccraftSubs:legacy", "cccraftSubsMeta:legacy"]));
  await ctx.purgeExpiredSubtitles(NOW);
  assert.deepEqual(keysOf(store, "legacy"), []);
});

// Holds the content script's read of stored cues (array-key get) until release() is called,
// so a save or clear can run after the old data was read but before it is applied.
function holdStoredCuesRead(chrome) {
  const get = chrome.storage.local.get;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  chrome.storage.local.get = async (keys) => {
    const result = await get(keys);
    if (Array.isArray(keys)) await gate;
    return result;
  };
  return () => release();
}

test("a stored-cues load that read old data does not overwrite subtitles saved meanwhile", async () => {
  const env = makeChrome({});
  const release = holdStoredCuesRead(env.chrome);
  const ctx = loadContent(env.chrome);
  const pendingLoad = ctx.loadStoredCues(); // page load: reads "nothing stored"
  await new Promise((r) => setTimeout(r, 5));
  await ctx.loadTranslatedJson({ cues: [{ start: 1, end: 2, fa: "新", source: "s" }] }, "ltr");
  release();
  await pendingLoad;
  assert.equal(vm.runInContext("faCues.length", ctx), 1);
});

test("a stored-cues load that read old data does not bring back subtitles cleared meanwhile", async () => {
  const env = makeChrome(video("vid1", { dir: "ltr", saved_at: Date.now() }));
  const release = holdStoredCuesRead(env.chrome);
  const ctx = loadContent(env.chrome);
  const pendingLoad = ctx.loadStoredCues(); // reads the stored cues
  await new Promise((r) => setTimeout(r, 5));
  await ctx.clearSubs();
  release();
  await pendingLoad;
  assert.equal(vm.runInContext("faCues.length", ctx), 0);
});
