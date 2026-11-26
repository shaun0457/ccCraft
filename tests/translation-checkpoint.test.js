// Run: node --test tests/*.test.js
// Translation checkpoint: the real src/background.js in a vm. A run that stops keeps its translated
// lines in chrome.storage.local, and the next Translate on the same video continues from them.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, workfileFromJson3 } = require("./helpers/load-extension.js");

// The retry pauses between attempts (400 ms × attempt) run at once; the 90 s request timeout stays.
function load(options) {
  const env = loadBackground(options);
  env.ctx.setTimeout = (fn, ms) => setTimeout(fn, ms >= 10000 ? ms : 0);
  return env;
}

const VIDEO = "ckpt-video";
const KEY = "ccCraftTranslateCheckpoint:" + VIDEO;
const STATUS = "ccCraftTranslateStatus:" + VIDEO;
const zhTW = { code: "zh-TW", promptName: "Traditional Chinese (Taiwan)", dir: "ltr" };
const ja = { code: "ja", promptName: "Japanese", dir: "ltr" };
const TRANSLATOR_SYSTEM = "You are a professional subtitle translator. Reply only with the translated numbered lines in the requested format, no explanations.";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const chat = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

function manualWorkfile(count = 120, { text = (i) => "line " + i } = {}) {
  const cues = [];
  for (let i = 1; i <= count; i++) cues.push({ id: i, start: i, end: i + 0.9, source: text(i), fa: "" });
  return {
    schema: "cccraft-subtitle-v1.1",
    video: { id: VIDEO, title: "Synthetic", url: "https://www.youtube.com/watch?v=" + VIDEO },
    source_track: { languageCode: "en", label: "English", kind: "manual", vssId: ".en" },
    cues
  };
}

// Answers every translation request with "<id>| 譯<id>", except ids in `omit` (left out of the reply)
// and the chunk holding `hangId` (never answers until released). Records the ids of each request.
function makeFetch({ omit = new Set(), hangId = null } = {}) {
  const requests = [];
  const preprocessRequests = [];
  let release = null;
  const fetchImpl = (url, init) => {
    const body = JSON.parse(init.body);
    const user = body.messages[1].content;
    if (body.messages[0].content !== TRANSLATOR_SYSTEM) {
      preprocessRequests.push(user);
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    }
    const ids = [...user.matchAll(/^(\d+)\| /gm)].map((m) => Number(m[1]));
    requests.push(ids);
    const reply = () => chat(ids.filter((id) => !omit.has(id)).map((id) => id + "| 譯" + id).join("\n"));
    if (hangId != null && ids.includes(hangId) && !release) {
      return new Promise((resolve) => { release = () => resolve(reply()); });
    }
    return Promise.resolve(reply());
  };
  return { fetchImpl, requests, preprocessRequests, release: () => release && release() };
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const tabGone = () => { throw new Error("Could not establish connection. Receiving end does not exist."); };

// First run: ids 101-120 are never translated and the tab is gone, so the run ends in an error
// with 100 lines saved. Returns the store it left behind.
async function interruptedRun({ lang = zhTW, provider = "gpt", model = "gpt-4o-mini" } = {}) {
  const f = makeFetch({ omit: new Set(range(101, 120)) });
  const { ctx, store } = load({ fetchImpl: f.fetchImpl, tabResponses: tabGone });
  await ctx.translateWorkfile({ workfile: manualWorkfile(), provider, apiKey: "sk-test", model, tabId: 1, lang });
  return { store, first: f };
}

async function secondRun(storage, { lang = zhTW, provider = "gpt", model = "gpt-4o-mini", workfile = manualWorkfile(), tabResponses } = {}) {
  const f = makeFetch();
  const env = load({ fetchImpl: f.fetchImpl, storage: JSON.parse(JSON.stringify(storage)), tabResponses });
  await env.ctx.translateWorkfile({ workfile, provider, apiKey: "sk-test", model, tabId: 1, lang });
  return { ...env, f };
}

test("a run that ends early keeps the translated lines; the status says how many", async () => {
  const { store } = await interruptedRun();
  assert.equal(store[STATUS].state, "error");
  assert.equal(store[STATUS].done, 100);
  const ckpt = store[KEY];
  assert.equal(ckpt.v, 1);
  assert.equal(ckpt.targetLang, "zh-TW");
  assert.equal(Object.keys(ckpt.translations).length, 100);
  assert.equal(ckpt.translations["7"], "譯7");
  assert.equal(ckpt.workfile.cues.length, 120);
  assert.ok(ckpt.workfile.cues.every((c) => !("fa" in c) && !("words" in c)), "no per-word times or old translations");
  assert.ok(Number.isFinite(ckpt.updated_at) && Number.isFinite(ckpt.saved_at));
});

test("progress is saved after every chunk, before the status, while the run is still going", async () => {
  const f = makeFetch({ hangId: 101 });
  const { ctx, store } = load({ fetchImpl: f.fetchImpl });
  const run = ctx.translateWorkfile({ workfile: manualWorkfile(), provider: "gpt", apiKey: "sk-test", model: "m", tabId: 1, lang: zhTW });
  try {
    for (let i = 0; i < 200 && Object.keys(store[KEY]?.translations || {}).length < 100; i++) await tick();
    assert.equal(Object.keys(store[KEY]?.translations || {}).length, 100, "two finished chunks are saved while the third hangs");
    assert.equal(store[STATUS].state, "running");
    assert.ok(store[STATUS].done <= Object.keys(store[KEY].translations).length, "the status never runs ahead of the checkpoint");

    // The worker is killed here: a new background with the same storage continues.
    const snapshot = JSON.parse(JSON.stringify(store));
    const next = await secondRun(snapshot);
    assert.deepEqual(next.f.requests, [range(101, 120)], "only the missing lines are sent");
    assert.equal(next.store[STATUS].state, "done");
  } finally {
    // The hanging request is answered so its 90 s timeout timer does not keep the test process open.
    f.release();
    await run;
  }
});

test("Translate again continues: only missing lines are requested, then the checkpoint is removed", async () => {
  const { store } = await interruptedRun();
  const { store: after, sentToTabs, f } = await secondRun(store);
  assert.deepEqual(f.requests, [range(101, 120)]);
  const sent = sentToTabs[0].message.workfile.cues;
  assert.equal(sent.length, 120);
  assert.equal(sent[0].fa, "譯1");
  assert.equal(sent[119].fa, "譯120");
  assert.equal(after[STATUS].state, "done");
  assert.equal(after[STATUS].untranslated, 0);
  assert.equal(KEY in after, false, "removed once the tab has the subtitles");
});

test("the running status of a continued run carries how many lines were already done", async () => {
  const { store } = await interruptedRun();
  const f = makeFetch();
  const env = load({ fetchImpl: f.fetchImpl, storage: JSON.parse(JSON.stringify(store)) });
  const history = [];
  const set = env.ctx.chrome.storage.local.set.bind(env.ctx.chrome.storage.local);
  env.ctx.chrome.storage.local.set = async (obj) => {
    if (obj[STATUS]) history.push(JSON.parse(JSON.stringify(obj[STATUS])));
    return set(obj);
  };
  await env.ctx.translateWorkfile({ workfile: manualWorkfile(), provider: "gpt", apiKey: "k", model: "m", tabId: 1, lang: zhTW });
  const running = history.filter((s) => s.state === "running");
  assert.equal(running[0].done, 100);
  assert.ok(running.every((s) => s.resumedFrom === 100));
});

test("another target language starts over and replaces the checkpoint", async () => {
  const { store } = await interruptedRun();
  const { f, store: after } = await secondRun(store, { lang: ja, tabResponses: tabGone });
  assert.equal(f.requests.flat().length, 120);
  assert.equal(after[KEY].targetLang, "ja");
});

test("another provider or model continues the same checkpoint", async () => {
  const { store } = await interruptedRun();
  const other = await secondRun(store, { provider: "qwen", model: "qwen-plus" });
  assert.deepEqual(other.f.requests, [range(101, 120)]);
  assert.equal(other.store[STATUS].state, "done");
});

test("changed source captions (another track or edited lines) start over", async () => {
  const { store } = await interruptedRun();
  const edited = manualWorkfile(120, { text: (i) => (i === 50 ? "edited line" : "line " + i) });
  const a = await secondRun(store, { workfile: edited });
  assert.equal(a.f.requests.flat().length, 120);

  const otherTrack = manualWorkfile();
  otherTrack.source_track = { ...otherTrack.source_track, vssId: ".de", languageCode: "de" };
  const b = await secondRun(store, { workfile: otherTrack });
  assert.equal(b.f.requests.flat().length, 120);
});

test("a malformed or old-version checkpoint is removed and the run starts over", async () => {
  const { store } = await interruptedRun();
  for (const broken of [{ ...store[KEY], v: 0 }, { ...store[KEY], workfile: { cues: [] } }, { ...store[KEY], translations: null }, "junk"]) {
    const { f, store: after } = await secondRun({ ...store, [KEY]: broken });
    assert.equal(f.requests.flat().length, 120);
    assert.equal(KEY in after, false);
  }
});

test("all lines translated but the tab was gone: the next Translate sends no request", async () => {
  const f = makeFetch();
  const { ctx, store } = load({ fetchImpl: f.fetchImpl, tabResponses: tabGone });
  await ctx.translateWorkfile({ workfile: manualWorkfile(), provider: "gpt", apiKey: "k", model: "m", tabId: 1, lang: zhTW });
  assert.equal(store[STATUS].state, "error");
  assert.equal(Object.keys(store[KEY].translations).length, 120);
  const next = await secondRun(store);
  assert.deepEqual(next.f.requests, []);
  assert.equal(next.store[STATUS].state, "done");
  assert.equal(next.sentToTabs[0].message.workfile.cues.length, 120);
});

test("a failed checkpoint write does not stop the translation", async () => {
  const f = makeFetch();
  const { ctx, store, sentToTabs } = load({ fetchImpl: f.fetchImpl });
  const local = ctx.chrome.storage.local;
  const set = local.set.bind(local);
  local.set = async (obj) => {
    if (KEY in obj) throw new Error("QUOTA_BYTES quota exceeded");
    return set(obj);
  };
  await ctx.translateWorkfile({ workfile: manualWorkfile(), provider: "gpt", apiKey: "k", model: "m", tabId: 1, lang: zhTW });
  assert.equal(store[STATUS].state, "done");
  assert.equal(sentToTabs.length, 1);
});

test("automatic captions: a continued run reuses the reconstructed captions without preprocessing again", async () => {
  const NEMOTRON = "nvidia/nemotron-3-ultra-550b-a55b";
  const raw = workfileFromJson3("auto-captions-technical.json3", "asr");
  const total = raw.cues.length;
  // Preprocessing fails here (HTTP 500) and falls back to the original captions; the fallback
  // summary is saved with the checkpoint.
  const first = makeFetch({ omit: new Set(range(Math.ceil(total / 2) + 1, total)) });
  const env1 = load({ fetchImpl: first.fetchImpl, tabResponses: tabGone });
  await env1.ctx.translateWorkfile({ workfile: raw, provider: "nvidia", apiKey: "nvapi-test", model: NEMOTRON, tabId: 1, lang: zhTW });
  assert.ok(first.preprocessRequests.length > 0, "first run preprocesses");
  const ckpt = env1.store["ccCraftTranslateCheckpoint:fixture-video"];
  assert.ok(ckpt, JSON.stringify(env1.store["ccCraftTranslateStatus:fixture-video"]));
  assert.ok(ckpt.preprocessing);

  const second = makeFetch();
  const env2 = load({ fetchImpl: second.fetchImpl, storage: JSON.parse(JSON.stringify(env1.store)) });
  await env2.ctx.translateWorkfile({ workfile: workfileFromJson3("auto-captions-technical.json3", "asr"), provider: "nvidia", apiKey: "nvapi-test", model: NEMOTRON, tabId: 1, lang: zhTW });
  assert.equal(second.preprocessRequests.length, 0, "no preprocessing on the continued run");
  assert.ok(second.requests.length > 0);
  const status = env2.store["ccCraftTranslateStatus:fixture-video"];
  assert.equal(status.state, "done");
  assert.deepEqual(status.preprocessing, ckpt.preprocessing, "the saved summary is reported again");
});
