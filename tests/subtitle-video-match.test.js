// Translated subtitles belong to the video they were made for. A background translation that finishes
// after the tab moved to another video (playlist autoplay, clicking a suggestion) must not land on the
// new video, and switching videos must not keep showing the previous video's subtitles.
// Run: node --test tests/*.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { extractFunction } = require("./helpers/load-extension.js");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "content.js"), "utf8");

function makeChrome(initial = {}) {
  const store = { ...initial };
  return {
    store,
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
          },
          async set(obj) {
            Object.assign(store, JSON.parse(JSON.stringify(obj)));
          }
        }
      },
      runtime: { sendMessage: async () => ({ ok: true }) }
    }
  };
}

// The page is on `pageVideo`; `page.video` can be changed to simulate YouTube navigation.
function loadContent(chrome, pageVideo) {
  const page = { video: pageVideo };
  const overlay = { text: null };
  const ctx = vm.createContext({
    chrome,
    Date,
    console,
    setTimeout,
    clearTimeout,
    page,
    overlay,
    getVideoId: () => page.video,
    extractTranslatedCues: (wf) => wf.cues.map((c) => ({ start: c.start, end: c.end, text: c.fa, orig: c.source })),
    requestSubtitlePurge: async () => {},
    injectOverlay: () => overlay,
    applySettings: () => {},
    setOverlayText: (o, main) => { o.text = main; },
    uiText: (key) => key,
    settings: { enabled: true },
    faCues: [],
    subsDir: "rtl",
    origLang: "en",
    userLang: "fa",
    flashUntil: 0
  });
  vm.runInContext("var storedCuesGeneration = 0; var lastVideoId = null;\n" +
    ["loadTranslatedJson", "loadStoredCues", "followVideoChange"].map((n) => extractFunction(source, n)).join("\n\n"), ctx);
  return ctx;
}

const workfile = (id, text) => ({ video: { id }, cues: [{ start: 1, end: 2, fa: text, source: "src " + text }], source_track: { languageCode: "en" } });
const shown = (ctx) => JSON.parse(JSON.stringify(vm.runInContext("faCues", ctx)));

test("a background translation for the video on screen is saved under it and shown", async () => {
  const env = makeChrome();
  const ctx = loadContent(env.chrome, "A");
  const res = await ctx.loadTranslatedJson(workfile("A", "譯文A"), "ltr", "A");
  assert.equal(res.ok, true);
  assert.equal(res.count, 1);
  assert.equal(res.shown, true);
  assert.equal(env.store["cccraftSubs:A"][0].text, "譯文A");
  assert.equal(shown(ctx)[0].text, "譯文A");
  assert.equal(ctx.overlay.text, "flashEnabled");
});

test("a background translation that finishes after the tab moved on is saved for its own video, not shown", async () => {
  const env = makeChrome({ "cccraftSubs:B": [{ start: 0, end: 1, text: "B 自己的字幕", orig: "b" }] });
  const ctx = loadContent(env.chrome, "B");
  await ctx.loadStoredCues();
  const res = await ctx.loadTranslatedJson(workfile("A", "譯文A"), "ltr", "A");
  assert.equal(res.ok, true);
  assert.equal(res.shown, false);
  assert.equal(env.store["cccraftSubs:A"][0].text, "譯文A", "kept for video A");
  assert.equal(env.store["cccraftSubsMeta:A"].dir, "ltr");
  assert.equal(env.store["cccraftSubs:B"][0].text, "B 自己的字幕", "video B's subtitles untouched");
  assert.equal(shown(ctx)[0].text, "B 自己的字幕", "video B keeps showing its own subtitles");
  assert.equal(ctx.overlay.text, null, "no 'subtitles enabled' flash on video B");

  // Going back to video A shows the translation.
  ctx.page.video = "A";
  await ctx.loadStoredCues();
  assert.equal(shown(ctx)[0].text, "譯文A");
});

test("a video with no translation shows nothing after the tab moved away from a translated one", async () => {
  const env = makeChrome();
  const ctx = loadContent(env.chrome, "B");
  await ctx.loadTranslatedJson(workfile("A", "譯文A"), "ltr", "A");
  assert.deepEqual(shown(ctx), []);
  assert.equal(env.store["cccraftSubs:B"], undefined);
});

test("a manually loaded file still goes onto the video on screen (no video id passed)", async () => {
  const env = makeChrome();
  const ctx = loadContent(env.chrome, "B");
  const res = await ctx.loadTranslatedJson(workfile("A", "手動"), "ltr");
  assert.equal(res.shown, true);
  assert.equal(env.store["cccraftSubs:B"][0].text, "手動");
  assert.equal(env.store["cccraftSubs:A"], undefined);
});

test("switching videos clears the previous video's subtitles at once, before the stored ones load", async () => {
  const env = makeChrome({ "cccraftSubs:A": [{ start: 0, end: 1, text: "A 的字幕", orig: "a" }] });
  const ctx = loadContent(env.chrome, "A");
  ctx.followVideoChange();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(shown(ctx)[0].text, "A 的字幕");

  ctx.page.video = "B";
  ctx.followVideoChange();
  assert.deepEqual(shown(ctx), [], "cleared synchronously, before storage answers");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(shown(ctx), []);

  // Same video again: nothing reloads or clears.
  vm.runInContext('faCues = [{ start: 0, end: 1, text: "keep", orig: "" }]', ctx);
  ctx.followVideoChange();
  assert.equal(shown(ctx)[0].text, "keep");
});

test("background.js tells the tab which video the translation is for", () => {
  const bg = fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8");
  assert.match(bg, /type: "LOAD_TRANSLATED_JSON",\s*videoId,/);
  assert.match(source, /loadTranslatedJson\(message\.workfile, message\.subtitleDir, message\.videoId\)/);
});
