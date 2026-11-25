// Subtitle display mode: translation only, translation + original, original only.
// Run: node --test tests/*.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadContentParsers } = require("./helpers/load-extension.js");
const { loadPopup } = require("./helpers/load-popup.js");

const { subtitleModeOf, overlayLines } = loadContentParsers();
const plain = (v) => JSON.parse(JSON.stringify(v)); // vm realm -> this realm
const cue = { text: "我們通常可以發現這一點。", orig: "We can usually discover this." };

// ---------- overlay (src/content.js) ----------

test("settings saved before subtitleMode map showOriginal to a mode; unknown modes fall back the same way", () => {
  assert.equal(subtitleModeOf({ showOriginal: true }), "bilingual");
  assert.equal(subtitleModeOf({ showOriginal: false }), "translation");
  assert.equal(subtitleModeOf({}), "translation");
  assert.equal(subtitleModeOf(null), "translation");
  assert.equal(subtitleModeOf({ subtitleMode: "original", showOriginal: false }), "original");
  assert.equal(subtitleModeOf({ subtitleMode: "bogus", showOriginal: true }), "bilingual");
});

test("each mode shows the right lines", () => {
  assert.deepEqual(plain(overlayLines(cue, { subtitleMode: "translation" })), { main: cue.text, orig: "", origOnly: false });
  assert.deepEqual(plain(overlayLines(cue, { subtitleMode: "bilingual" })), { main: cue.text, orig: cue.orig, origOnly: false });
  assert.deepEqual(plain(overlayLines(cue, { subtitleMode: "original" })), { main: "", orig: cue.orig, origOnly: true });
  assert.deepEqual(plain(overlayLines(null, { subtitleMode: "original" })), { main: "", orig: "", origOnly: false });
});

test("word lookup in translation-only shows the original line too; original only keeps lookup on its line", () => {
  assert.deepEqual(plain(overlayLines(cue, { subtitleMode: "translation", languageLearning: true })), { main: cue.text, orig: cue.orig, origOnly: false });
  assert.deepEqual(plain(overlayLines(cue, { subtitleMode: "original", languageLearning: true })), { main: "", orig: cue.orig, origOnly: true });
});

test("original only falls back to the translation when a cue has no original text", () => {
  assert.deepEqual(plain(overlayLines({ text: "只有譯文", orig: "" }, { subtitleMode: "original" })), { main: "只有譯文", orig: "", origOnly: false });
});

// ---------- popup ----------

const settingsOf = (p) => p.data.ccCraftSubtitleSettings;

test("popup selects the mode that matches settings saved by an older version", async () => {
  for (const [stored, radio] of [[{ showOriginal: true }, "modeBilingual"], [{ showOriginal: false }, "modeTranslation"], [{ subtitleMode: "original" }, "modeOriginal"]]) {
    const p = loadPopup({ stored: { ccCraftSubtitleSettings: stored } });
    await p.open();
    for (const id of ["modeTranslation", "modeBilingual", "modeOriginal"]) {
      assert.equal(p.el(id).checked, id === radio, JSON.stringify(stored) + " " + id);
    }
  }
});

test("choosing original only saves subtitleMode and keeps showOriginal for older content scripts", async () => {
  const p = loadPopup({ stored: { ccCraftSubtitleSettings: { showOriginal: false } } });
  await p.open();
  p.el("modeTranslation").checked = false;
  p.el("modeOriginal").checked = true;
  await p.el("modeOriginal").fire("change");
  assert.equal(settingsOf(p).subtitleMode, "original");
  assert.equal(settingsOf(p).showOriginal, true);

  p.el("modeOriginal").checked = false;
  p.el("modeTranslation").checked = true;
  await p.el("modeTranslation").fire("change");
  assert.equal(settingsOf(p).subtitleMode, "translation");
  assert.equal(settingsOf(p).showOriginal, false);
});

test("turning on word lookup in translation only switches to translation + original; other modes stay", async () => {
  const p = loadPopup({ stored: { ccCraftSubtitleSettings: { subtitleMode: "translation" } } });
  await p.open();
  p.el("languageLearning").checked = true;
  await p.el("languageLearning").fire("change");
  assert.equal(p.el("modeBilingual").checked, true);
  assert.equal(settingsOf(p).subtitleMode, "bilingual");

  const q = loadPopup({ stored: { ccCraftSubtitleSettings: { subtitleMode: "original" } } });
  await q.open();
  q.el("languageLearning").checked = true;
  await q.el("languageLearning").fire("change");
  assert.equal(settingsOf(q).subtitleMode, "original");
  assert.equal(settingsOf(q).languageLearning, true);
});
