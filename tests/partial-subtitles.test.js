// Run: node --test tests/*.test.js
// Subtitles while translating: the real background sends partial subtitles at 30% of the lines,
// then every further 10%; the content script keeps untranslated lines as the original, and only
// the first update turns display on and flashes.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { loadBackground, extractFunction } = require("./helpers/load-extension.js");

const VIDEO = "partial-video";
const STATUS = "ccCraftTranslateStatus:" + VIDEO;
const lang = { code: "zh-TW", promptName: "Traditional Chinese (Taiwan)", dir: "ltr" };
const chat = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

function workfile(count) {
  const cues = [];
  for (let i = 1; i <= count; i++) cues.push({ id: i, start: i, end: i + 0.9, source: "line " + i, fa: "" });
  return { video: { id: VIDEO }, source_track: { languageCode: "en", kind: "manual", vssId: ".en" }, cues };
}

// Chunks answer one at a time in order, so progress goes up by one chunk (50 lines) per step.
function orderedFetch({ omit = new Set() } = {}) {
  let queue = Promise.resolve();
  return (url, init) => {
    const user = JSON.parse(init.body).messages[1].content;
    const ids = [...user.matchAll(/^(\d+)\| /gm)].map((m) => Number(m[1]));
    const answer = chat(ids.filter((id) => !omit.has(id)).map((id) => id + "| 譯" + id).join("\n"));
    queue = queue.then(() => new Promise((r) => setTimeout(r, 2)));
    return queue.then(() => answer);
  };
}

async function run(count, { tabResponses, omit } = {}) {
  const env = loadBackground({ fetchImpl: orderedFetch({ omit }), tabResponses });
  const history = [];
  const local = env.ctx.chrome.storage.local;
  const set = local.set.bind(local);
  local.set = async (obj) => {
    if (obj[STATUS]) history.push(JSON.parse(JSON.stringify(obj[STATUS])));
    return set(obj);
  };
  await env.ctx.translateWorkfile({ workfile: workfile(count), provider: "gpt", apiKey: "k", model: "m", tabId: 1, lang });
  const partials = env.sentToTabs.filter((s) => s.message.partial).map((s) => s.message);
  const finals = env.sentToTabs.filter((s) => !s.message.partial).map((s) => s.message);
  const filled = (m) => m.workfile.cues.filter((c) => c.fa).length;
  return { ...env, history, partials, finals, filled };
}

test("partial subtitles go to the tab at 30%, then at every further 10%, before the final load", async () => {
  const r = await run(1000); // 20 chunks of 50 lines: progress moves in 5% steps
  assert.deepEqual(r.partials.map(r.filled), [300, 400, 500, 600, 700, 800, 900]);
  assert.equal(r.finals.length, 1);
  assert.equal(r.filled(r.finals[0]), 1000);
  assert.equal(r.store[STATUS].state, "done");
});

test("only the first partial update may turn display on and flash; later ones and the final load are quiet", async () => {
  const r = await run(200); // 4 chunks: 25%, 50%, 75%, 100%
  assert.deepEqual(r.partials.map(r.filled), [100, 150]);
  assert.deepEqual(r.partials.map((m) => m.quiet), [false, true]);
  assert.equal(r.finals[0].quiet, true);
  const untranslated = r.partials[0].workfile.cues.find((c) => !c.fa);
  assert.equal(untranslated.source, "line " + untranslated.id, "untranslated lines are sent with their original");
});

test("a short run that reaches 100% in one step sends no partial update and flashes at the end", async () => {
  const r = await run(40);
  assert.equal(r.partials.length, 0);
  assert.equal(r.finals[0].quiet, false);
});

test("the running status says how many translated lines are on the video", async () => {
  const r = await run(200);
  const running = r.history.filter((s) => s.state === "running");
  assert.deepEqual([...new Set(running.map((s) => s.partialLines || 0))], [0, 100, 150]);
});

test("a partial update the tab cannot take does not stop the translation; the next one that reaches it is the first", async () => {
  let partialCalls = 0;
  const r = await run(200, {
    tabResponses: (m) => {
      if (m.partial && ++partialCalls === 1) throw new Error("Receiving end does not exist.");
      return { ok: true, count: m.workfile.cues.length };
    }
  });
  assert.equal(r.store[STATUS].state, "done");
  assert.deepEqual(r.partials.map((m) => m.quiet), [false, false], "the failed one did not count");
  assert.equal(r.finals[0].quiet, true);
});

test("partial updates for a video the tab left are saved there and not counted as shown", async () => {
  const r = await run(200, { tabResponses: (m) => ({ ok: true, count: m.workfile.cues.length, shown: false }) });
  const running = r.history.filter((s) => s.state === "running");
  assert.ok(running.every((s) => !s.partialLines));
});

// ---------- content script ----------

const source = fs.readFileSync(path.join(__dirname, "..", "src", "content.js"), "utf8");

function loadContent({ enabled = true } = {}) {
  const store = {};
  const overlay = { text: null };
  const ctx = vm.createContext({
    chrome: {
      storage: { local: { async get() { return {}; }, async set(obj) { Object.assign(store, JSON.parse(JSON.stringify(obj))); } } },
      runtime: { sendMessage: async () => ({ ok: true }) }
    },
    Date,
    overlay,
    getVideoId: () => VIDEO,
    decodeHtml: (s) => s,
    requestSubtitlePurge: () => {},
    injectOverlay: () => overlay,
    applySettings: () => {},
    setOverlayText: (o, main) => { o.text = main; },
    uiText: (key) => key,
    settings: { enabled },
    faCues: [],
    subsDir: "rtl",
    origLang: "en",
    userLang: "fa",
    flashUntil: 0
  });
  vm.runInContext("var storedCuesGeneration = 0;\n" +
    ["cleanText", "extractTranslatedCues", "loadTranslatedJson"].map((n) => extractFunction(source, n)).join("\n\n"), ctx);
  return { ctx, store, overlay };
}

const half = {
  video: { id: VIDEO },
  source_track: { languageCode: "en" },
  cues: [
    { start: 1, end: 2, fa: "譯1", source: "line 1" },
    { start: 3, end: 4, fa: "", source: "line 2" },
    { start: 5, end: 6, fa: "", source: "" }
  ]
};

test("partial subtitles keep untranslated lines with their original; a final load drops them as before", async () => {
  const partial = loadContent();
  await partial.ctx.loadTranslatedJson(half, "ltr", VIDEO, { partial: true });
  assert.deepEqual(partial.store["cccraftSubs:" + VIDEO].map((c) => [c.text, c.orig]), [["譯1", "line 1"], ["", "line 2"]]);

  const final = loadContent();
  await final.ctx.loadTranslatedJson(half, "ltr", VIDEO);
  assert.deepEqual(final.store["cccraftSubs:" + VIDEO].map((c) => c.text), ["譯1"]);
});

test("a quiet update neither flashes nor turns display back on", async () => {
  const quiet = loadContent({ enabled: false });
  await quiet.ctx.loadTranslatedJson(half, "ltr", VIDEO, { partial: true, quiet: true });
  assert.equal(vm.runInContext("settings.enabled", quiet.ctx), false);
  assert.equal(quiet.overlay.text, null);
  assert.equal(vm.runInContext("faCues.length", quiet.ctx), 2, "the subtitles are still updated");

  const first = loadContent({ enabled: false });
  await first.ctx.loadTranslatedJson(half, "ltr", VIDEO, { partial: true });
  assert.equal(vm.runInContext("settings.enabled", first.ctx), true);
  assert.equal(first.overlay.text, "flashEnabled");
});

test("the message handler passes partial and quiet through", () => {
  assert.match(source, /loadTranslatedJson\(message\.workfile, message\.subtitleDir, message\.videoId, \{\s*partial: message\.partial === true,\s*quiet: message\.quiet === true\s*\}\)/);
});
