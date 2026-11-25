// Subtitle display mode: translation only, translation + original, original only.
// Run: node --test tests/*.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { extractFunction, loadContentParsers } = require("./helpers/load-extension.js");
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
  // Before subtitleMode, word lookup showed the original line even with showOriginal off.
  assert.equal(subtitleModeOf({ showOriginal: false, languageLearning: true }), "bilingual");
  assert.equal(subtitleModeOf({ subtitleMode: "translation", languageLearning: true }), "translation");
});

test("each mode shows the right lines", () => {
  assert.deepEqual(plain(overlayLines(cue, { subtitleMode: "translation" })), { main: cue.text, orig: "", origOnly: false });
  assert.deepEqual(plain(overlayLines(cue, { subtitleMode: "bilingual" })), { main: cue.text, orig: cue.orig, origOnly: false });
  assert.deepEqual(plain(overlayLines(cue, { subtitleMode: "original" })), { main: "", orig: cue.orig, origOnly: true });
  assert.deepEqual(plain(overlayLines(null, { subtitleMode: "original" })), { main: "", orig: "", origOnly: false });
});

test("the selected mode wins over word lookup", () => {
  assert.deepEqual(plain(overlayLines(cue, { subtitleMode: "translation", languageLearning: true })), { main: cue.text, orig: "", origOnly: false });
  assert.deepEqual(plain(overlayLines(cue, { subtitleMode: "bilingual", languageLearning: true })), { main: cue.text, orig: cue.orig, origOnly: false });
  assert.deepEqual(plain(overlayLines(cue, { subtitleMode: "original", languageLearning: true })), { main: "", orig: cue.orig, origOnly: true });
});

test("original only falls back to the translation when a cue has no original text", () => {
  assert.deepEqual(plain(overlayLines({ text: "只有譯文", orig: "" }, { subtitleMode: "original" })), { main: "只有譯文", orig: "", origOnly: false });
});

test("a cue with no translation shows nothing outside original only, so YouTube's captions stay", () => {
  const untranslated = { text: "", orig: "Not translated yet." };
  const none = { main: "", orig: "", origOnly: false };
  assert.deepEqual(plain(overlayLines(untranslated, { subtitleMode: "translation" })), none);
  assert.deepEqual(plain(overlayLines(untranslated, { subtitleMode: "bilingual", languageLearning: true })), none);
  assert.deepEqual(plain(overlayLines(untranslated, { subtitleMode: "original" })), { main: "", orig: untranslated.orig, origOnly: true });
});

// ---------- render wiring (renderCue -> setOverlayText) on a fake DOM ----------

function node(tag) {
  const classes = new Set();
  const n = {
    tag,
    children: [],
    dataset: {},
    className: "",
    _text: "",
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      add(name) { classes.add(name); },
      contains(name) { return classes.has(name) || n.className.split(" ").includes(name); }
    },
    set textContent(v) { n._text = String(v); n.children = []; },
    get textContent() { return n._text + n.children.map((c) => c.textContent).join(""); },
    appendChild(c) { n.children.push(c); return c; },
    querySelector(sel) { return n.children.find((c) => c.className === sel.slice(1)) || null; }
  };
  return n;
}

function loadRenderer(settings) {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "content.js"), "utf8");
  const names = ["subtitleModeOf", "overlayLines", "setOverlayText", "renderOrigLine", "renderCue"];
  const ctx = vm.createContext({
    settings,
    attachLearningEvents() {},
    document: { createElement: node, createTextNode: (t) => { const n = node("#text"); n.textContent = t; return n; } }
  });
  vm.runInContext(names.map((n) => extractFunction(source, n)).join("\n\n"), ctx);
  return ctx.renderCue;
}

function shownLines(overlay) {
  const main = overlay.querySelector(".cccraft-main");
  const orig = overlay.querySelector(".cccraft-orig");
  return {
    main: main.classList.contains("hidden") ? null : main.textContent,
    orig: orig.classList.contains("hidden") ? null : orig.textContent
  };
}

test("original only puts the original line on the overlay, hides the main line and marks orig-only", () => {
  const renderCue = loadRenderer({ subtitleMode: "original", languageLearning: true });
  const overlay = node("div");
  assert.equal(renderCue(overlay, cue), true);
  assert.deepEqual(shownLines(overlay), { main: null, orig: cue.orig });
  assert.equal(overlay.classList.contains("orig-only"), true);
  assert.equal(overlay.classList.contains("empty"), false);
  // Word lookup splits the original line into hoverable words.
  assert.equal(overlay.querySelector(".cccraft-orig").children.filter((c) => c.className === "cccraft-word").length, 5);
});

test("bilingual and translation only render the right lines; the same overlay switches cleanly", () => {
  const settings = { subtitleMode: "bilingual", languageLearning: false };
  const renderCue = loadRenderer(settings);
  const overlay = node("div");
  assert.equal(renderCue(overlay, cue), true);
  assert.deepEqual(shownLines(overlay), { main: cue.text, orig: cue.orig });
  assert.equal(overlay.classList.contains("orig-only"), false);

  settings.subtitleMode = "translation";
  assert.equal(renderCue(overlay, cue), true);
  assert.deepEqual(shownLines(overlay), { main: cue.text, orig: null });

  settings.subtitleMode = "original";
  renderCue(overlay, cue);
  settings.subtitleMode = "bilingual";
  renderCue(overlay, cue);
  assert.equal(overlay.classList.contains("orig-only"), false);
  assert.deepEqual(shownLines(overlay), { main: cue.text, orig: cue.orig });
});

test("no cue, or an untranslated cue outside original only, hides the overlay", () => {
  const renderCue = loadRenderer({ subtitleMode: "bilingual" });
  const overlay = node("div");
  assert.equal(renderCue(overlay, null), false);
  assert.equal(overlay.classList.contains("empty"), true);
  assert.equal(renderCue(overlay, { text: "", orig: "Not translated yet." }), false);
  assert.equal(overlay.classList.contains("empty"), true);
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

test("popup selects translation + original for old settings that had word lookup on and Show original off", async () => {
  const p = loadPopup({ stored: { ccCraftSubtitleSettings: { showOriginal: false, languageLearning: true } } });
  await p.open();
  assert.equal(p.el("modeBilingual").checked, true);
  assert.equal(p.el("modeTranslation").checked, false);
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
