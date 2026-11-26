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
async function openPopup(status, { ageMs = 0, browserLanguage = "en-US" } = {}) {
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
      sendMessage: async (msg) => (msg.type === "GET_TRANSLATE_STATUS" ? { ok: true, status: { ...status, updated_at: Date.now() - ageMs } } : { ok: false })
    }
  };
  const ctx = {
    document,
    navigator: { language: browserLanguage },
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

// ---------- translation checkpoint ----------

const HINT = /💾 40 \/ 120 lines are saved\. Click “Translate & show subtitles” again to continue from there \(same target language\)\. To start over, clear this video's subtitles first\./;

test("a failed run with saved lines tells the user Translate continues from there", async () => {
  const text = await openPopup({ state: "error", done: 40, total: 120, error: "The video tab is no longer available." });
  assert.match(text, /^❌ The last auto-translate for this video failed:\nThe video tab is no longer available\.\n/);
  assert.match(text, HINT);
});

test("an interrupted run with saved lines shows the same hint", async () => {
  const text = await openPopup({ state: "running", done: 40, total: 120 }, { ageMs: 4 * 60 * 1000 });
  assert.match(text, /^⚠️ The previous translation was interrupted/);
  assert.match(text, HINT);
});

test("no hint when nothing was translated", async () => {
  const failed = await openPopup({ state: "error", done: 0, total: 120, error: "HTTP 401" });
  assert.doesNotMatch(failed, /💾/);
  const old = await openPopup({ state: "error", error: "There are no subtitle lines to translate." });
  assert.doesNotMatch(old, /💾|undefined/);
});

test("a continued run says how many lines were already translated", async () => {
  const text = await openPopup({ state: "running", done: 100, total: 120, resumedFrom: 100 });
  assert.match(text, /\n↪️ Continuing from the last run: 100 lines were already translated\./);
  const fresh = await openPopup({ state: "running", done: 10, total: 120, resumedFrom: 0 });
  assert.doesNotMatch(fresh, /Continuing/);
});

// ---------- error text in the interface language ----------

test("a real background 429 failure reads in Chinese with its cause and what to do", async () => {
  const raw = workfileFromJson3("auto-captions-technical.json3", "manual");
  const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "Rate limit reached" } }) });
  const { ctx, store } = loadBackground({ fetchImpl });
  ctx.setTimeout = (fn, ms) => setTimeout(fn, ms >= 10000 ? ms : 0); // skip the retry pauses
  await ctx.translateWorkfile({ workfile: raw, provider: "gpt", apiKey: "sk-test", model: "gpt-4o-mini", tabId: 1, lang });
  const status = store["ccCraftTranslateStatus:" + VIDEO];
  assert.equal(status.state, "error");
  assert.match(status.error, /^OpenAI GPT HTTP 429: Rate limit reached/, "the background still writes English");

  const text = await openPopup(status, { browserLanguage: "zh-TW" });
  assert.match(text, /^❌ 這部影片上一次自動翻譯失敗：\nOpenAI GPT 回傳 HTTP 429：Rate limit reached\n\nAI 沒辦法翻譯這部影片，請改用手動翻譯：/);
  assert.match(text, /\n💡 可能原因：短時間內請求太多次，或額度用完了\n👉 怎麼處理：請稍後再試，或換其他模型試試。/);
  assert.doesNotMatch(text, /The AI could not/);
});

test("a running status shows its last error translated; missing lines get the hint lines under the sentence", async () => {
  const running = await openPopup({ state: "running", done: 50, total: 120, lastError: "NVIDIA NIM HTTP 503: busy" }, { browserLanguage: "zh-TW" });
  assert.match(running, /⚠️ 最近一次錯誤：NVIDIA NIM 回傳 HTTP 503：busy\n💡 可能原因：供應商的伺服器暫時出問題/);
  const done = await openPopup({ state: "done", done: 120, total: 120, count: 120, untranslated: 3, firstError: "OpenAI GPT HTTP 429: slow down" }, { browserLanguage: "zh-TW" });
  assert.match(done, /重試後仍有 3 行沒翻成（OpenAI GPT 回傳 HTTP 429：slow down）。請再翻一次，或換一個模型。\n💡 可能原因：短時間內請求太多次，或額度用完了\n👉 怎麼處理：請稍後再試，或換其他模型試試。/);
  const unknown = await openPopup({ state: "done", done: 120, total: 120, count: 120, untranslated: 3, firstError: null }, { browserLanguage: "zh-TW" });
  assert.match(unknown, /重試後仍有 3 行沒翻成（未知錯誤）。/);
  assert.doesNotMatch(unknown, /💡/);
});
