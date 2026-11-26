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
  assert.match(source, /loadTranslatedJson\(message\.workfile, message\.subtitleDir, message\.videoId, \{/);
});

// ---------- reading the captions (before translation starts) ----------

// makeWorkfile with a fake page bridge that behaves like src/inject-main.js: its `videoId` is the
// one it read when the click arrived, while the caption URL is whichever timedtext request the
// player makes afterwards, here for the video on screen by then. `moveTo` switches the page while
// the URL is captured; `captionUrl` overrides the URL.
function loadMakeWorkfile({ moveTo = null, moveWhileReading = null, pageVideo = "A", captionUrl = null } = {}) {
  const page = { video: pageVideo, titles: { A: "Video A", B: "Video B" } };
  const ctx = vm.createContext({
    page,
    URL,
    getVideoId: () => page.video,
    getVideoTitle: () => page.titles[page.video],
    getWatchUrl: () => "https://www.youtube.com/watch?v=" + page.video,
    getVideoDuration: () => 60,
    buildModelPrompt: () => "(prompt)",
    requestMain: async () => {
      const clicked = page.video;
      if (moveTo) page.video = moveTo;
      const url = captionUrl ?? "https://www.youtube.com/api/timedtext?v=" + page.video + "&lang=en&fmt=json3";
      return { ok: true, videoId: clicked, originalUrl: url, track: { languageCode: "en", vssId: ".en" } };
    },
    readCuesFromUrl: async () => {
      if (moveWhileReading) page.video = moveWhileReading;
      return { format: "json3", cues: [{ id: 1, start: 0, end: 1, source: "hi" }] };
    }
  });
  vm.runInContext(["captionUrlVideoId", "currentVideoInfo", "buildWorkfile", "makeWorkfile"].map((n) => extractFunction(source, n)).join("\n\n"), ctx);
  return ctx;
}

test("the workfile keeps the video that was on screen when Translate was clicked", async () => {
  const ctx = loadMakeWorkfile({ moveWhileReading: "B" });
  const workfile = await ctx.makeWorkfile(0);
  assert.equal(workfile.video.id, "A");
  assert.equal(workfile.video.title, "Video A");
  assert.equal(workfile.video.url, "https://www.youtube.com/watch?v=A");
});

test("a caption URL of another video is not used for the clicked one, although the bridge still reports the clicked video", async () => {
  const ctx = loadMakeWorkfile({ moveTo: "B" });
  await assert.rejects(ctx.makeWorkfile(0), /^Error: The video changed while its subtitles were being read\./);
});

test("nothing to compare: no v in the page URL (live replay) or in the caption URL", async () => {
  const live = loadMakeWorkfile({ pageVideo: "unknown-video", captionUrl: "https://www.youtube.com/api/timedtext?v=REALID&lang=en" });
  assert.equal((await live.makeWorkfile(0)).video.id, "unknown-video");
  const noV = loadMakeWorkfile({ captionUrl: "https://www.youtube.com/api/timedtext?lang=en" });
  assert.equal((await noV.makeWorkfile(0)).video.id, "A");
  const broken = loadMakeWorkfile({ captionUrl: "not a url" });
  assert.equal((await broken.makeWorkfile(0)).video.id, "A");
});

test("the video-changed error makeWorkfile throws reads in Chinese", async () => {
  const ctx = loadMakeWorkfile({ moveTo: "B" });
  const err = await ctx.makeWorkfile(0).catch((e) => e);
  const i18n = vm.createContext({});
  i18n.globalThis = i18n;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "i18n.js"), "utf8"), i18n);
  assert.equal(i18n.CcCraftI18n.describeError("zh-TW", err.message), "讀取字幕的時候影片換了。請回到你要的影片，再試一次。");
});
