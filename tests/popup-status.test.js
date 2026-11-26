// Runs the real popup/popup.js in a vm (fake DOM and chrome.*) against translate statuses written
// by the real src/background.js, so a renamed status or summary field breaks a test.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadBackground, workfileFromJson3 } = require("./helpers/load-extension.js");

const NEMOTRON = "nvidia/nemotron-3-ultra-550b-a55b";
const TRANSLATOR_SYSTEM = "You are a professional subtitle translator. Reply only with the translated numbered lines in the requested format, no explanations.";
const VIDEO = "fixture-video";
const lang = { code: "zh-TW", promptName: "Traditional Chinese (Taiwan)", dir: "ltr" };
const { fakeIndexedDB } = require("./helpers/fake-indexeddb.js");
const popupSrc = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.js"), "utf8");
// popup.html loads src/i18n.js and key-store.js before popup.js.
const i18nSrc = fs.readFileSync(path.join(__dirname, "..", "src", "i18n.js"), "utf8");
const keyStoreSrc = fs.readFileSync(path.join(__dirname, "..", "popup", "key-store.js"), "utf8");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const chat = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

function makeFetch({ preprocessStatus = 200 } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages[1].content;
    if (body.messages[0].content !== TRANSLATOR_SYSTEM) {
      if (preprocessStatus !== 200) return { ok: false, status: preprocessStatus, json: async () => ({}) };
      if (user.startsWith("Read this automatic caption transcript")) {
        return chat(JSON.stringify({ topic: "docs", terms: [], proper_nouns: [], asr_confusions: [] }));
      }
      const lines = user.split("<transcript>\n")[1].split("\n</transcript>")[0].split("\n")
        .map((l) => /^(\d+)\| (.*)$/.exec(l)).map((m) => ({ uid: Number(m[1]), text: m[2] }));
      const groups = [];
      for (let i = 0; i < lines.length; i += 2) {
        const pair = lines.slice(i, i + 2);
        groups.push({ ids: pair.map((l) => l.uid), text: pair.map((l) => l.text).join(" ") });
      }
      return chat(JSON.stringify({ groups }));
    }
    const ids = [...user.matchAll(/^(\d+)\| /gm)].map((m) => m[1]);
    return chat(ids.map((id) => id + "| 譯文" + id).join("\n"));
  };
}

// Runs a real translation and returns every status background.js wrote, in order.
async function runBackground({ kind = "asr", preprocessStatus = 200, tabResponses } = {}) {
  const raw = workfileFromJson3("auto-captions-technical.json3", kind);
  const { ctx, store, sentToTabs } = loadBackground({ fetchImpl: makeFetch({ preprocessStatus }), tabResponses });
  runBackground.sentToTabs = sentToTabs;
  const history = [];
  const local = ctx.chrome.storage.local;
  const set = local.set.bind(local);
  local.set = async (obj) => {
    const s = obj["ccCraftTranslateStatus:" + VIDEO];
    if (s) history.push(JSON.parse(JSON.stringify(s)));
    return set(obj);
  };
  await ctx.translateWorkfile({ workfile: raw, provider: "nvidia", apiKey: "nvapi-test", model: NEMOTRON, tabId: 1, lang });
  return { raw, history, final: store["ccCraftTranslateStatus:" + VIDEO] };
}

function fakeElement() {
  const classes = new Set();
  return {
    value: "",
    checked: false,
    disabled: false,
    textContent: "",
    innerHTML: "",
    files: [],
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    appendChild: (child) => child,
    addEventListener() {}
  };
}

// Opens the real popup on a YouTube tab whose translate status is `status`; returns the status text.
async function openPopup(status) {
  const elements = new Map();
  const onLoad = [];
  const intervals = [];
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    createElement: () => fakeElement(),
    querySelectorAll: () => [],
    documentElement: {},
    addEventListener: (type, fn) => type === "DOMContentLoaded" && onLoad.push(fn)
  };
  const chrome = {
    storage: {
      local: {
        async get(query) {
          return typeof query === "string" ? {} : { ...query };
        },
        async set() {}
      }
    },
    tabs: {
      query: async () => [{ id: 1, url: "https://www.youtube.com/watch?v=" + VIDEO }],
      sendMessage: async () => ({ ok: true, tracks: [], preferredIndex: 0 })
    },
    runtime: {
      sendMessage: async (msg) => (msg.type === "GET_TRANSLATE_STATUS" ? { ok: true, status: { ...status, updated_at: Date.now() } } : { ok: false })
    }
  };
  const ctx = {
    document,
    chrome,
    console,
    URL,
    Promise,
    indexedDB: fakeIndexedDB(),
    setTimeout,
    clearTimeout,
    setInterval: (fn) => intervals.push(fn),
    clearInterval() {}
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(i18nSrc, ctx, { filename: "i18n.js" });
  vm.runInContext(keyStoreSrc, ctx, { filename: "key-store.js" });
  vm.runInContext(popupSrc, ctx, { filename: "popup.js" });
  await Promise.all(onLoad.map((fn) => fn()));
  await tick();
  return document.getElementById("status").textContent;
}

test("popup shows the reconstruction summary from a real background run", async () => {
  const { raw, final } = await runBackground();
  assert.equal(final.state, "done");
  const text = await openPopup(final);
  const m = /Automatic captions reconstructed before translation: (\d+) → (\d+) lines/.exec(text);
  assert.ok(m, text);
  assert.equal(Number(m[1]), raw.cues.length);
  assert.ok(Number(m[2]) > 0 && Number(m[2]) < raw.cues.length);
  assert.doesNotMatch(text, /undefined|NaN/);
});

test("popup shows the preprocessing progress line while background is reconstructing", async () => {
  const { history } = await runBackground();
  const running = history.filter((s) => s.state === "running" && s.phase === "preprocessing");
  assert.ok(running.length >= 2, "background reports preprocessing progress");
  const withParts = running.find((s) => s.chunksTotal > 0);
  assert.ok(withParts, "a progress status carries chunk counts");
  const text = await openPopup(withParts);
  assert.match(text, /^⏳ Reconstructing automatic captions before translation \(part \d+ of \d+\)\.\.\./);
  assert.doesNotMatch(text, /undefined|NaN/);
  const first = await openPopup(running[0]);
  assert.match(first, /^⏳ Reconstructing automatic captions before translation\.\.\./);
});

test("popup shows the fallback warning with the error codes when preprocessing fails", async () => {
  const { final } = await runBackground({ preprocessStatus: 401 });
  const text = await openPopup(final);
  assert.match(text, /Caption preprocessing failed, the original captions were translated instead \(context_http_401, chunk_http_401\)/);
});

test("background sends the video id with the subtitles and records whether the tab showed them", async () => {
  const { raw, final } = await runBackground();
  const sent = runBackground.sentToTabs[0].message;
  assert.equal(sent.type, "LOAD_TRANSLATED_JSON");
  assert.equal(sent.videoId, raw.video.id);
  assert.equal(final.shownOnVideo, true);
  assert.match(await openPopup(final), /^✅ Translation finished — subtitles are live on the video\./);
});

test("popup says the subtitles were saved for the translated video when the tab had moved on", async () => {
  const { final } = await runBackground({ tabResponses: (m) => ({ ok: true, count: m.workfile.cues.length, shown: false }) });
  assert.equal(final.state, "done");
  assert.equal(final.shownOnVideo, false);
  const text = await openPopup(final);
  assert.match(text, /^✅ Translation finished\. You moved to another video meanwhile, so the subtitles were saved for the video you translated/);
  assert.doesNotMatch(text, /live on the video/);
});

test("a status written before shownOnVideo existed still reads as shown", async () => {
  const text = await openPopup({ state: "done", done: 3, total: 3, count: 3, untranslated: 0, preprocessing: null });
  assert.match(text, /^✅ Translation finished — subtitles are live on the video\.\nTranslated lines: 3/);
});

test("popup shows no preprocessing line when it was bypassed (manual track)", async () => {
  const { final } = await runBackground({ kind: "manual" });
  assert.equal(final.preprocessing, null);
  const text = await openPopup(final);
  assert.match(text, /translated/i);
  assert.doesNotMatch(text, /reconstruct|preprocessing/i);
});
