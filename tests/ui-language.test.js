// Interface language (English / 繁體中文): string tables, language choice, popup switch, on-video hints.
// Run: node --test tests/*.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { extractFunction } = require("./helpers/load-extension.js");
const { loadPopup, tick } = require("./helpers/load-popup.js");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
require("../src/i18n.js"); // defines globalThis.CcCraftI18n, as in the browser
const { STRINGS, uiLanguageOf, translate, htmlLangOf } = globalThis.CcCraftI18n;

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// ---------- string tables ----------

test("English and 繁體中文 have the same keys, no empty strings, and the same placeholders", () => {
  const en = Object.keys(STRINGS.en).sort();
  const zh = Object.keys(STRINGS["zh-TW"]).sort();
  assert.deepEqual(zh, en);
  for (const key of en) {
    assert.ok(STRINGS.en[key].trim() && STRINGS["zh-TW"][key].trim(), key);
    assert.deepEqual(placeholders(STRINGS["zh-TW"][key]), placeholders(STRINGS.en[key]), key);
  }
});

test("every key used by popup.html, popup.js and content.js exists", () => {
  const used = new Set();
  for (const m of read("popup/popup.html").matchAll(/data-i18n(?:-placeholder)?="(\w+)"/g)) used.add(m[1]);
  for (const m of read("popup/popup.js").matchAll(/\bt\("(\w+)"/g)) used.add(m[1]);
  for (const m of read("popup/popup.js").matchAll(/runningMessage\(status, "(\w+)"\)/g)) used.add(m[1]);
  for (const m of read("src/content.js").matchAll(/\buiText\("(\w+)"/g)) used.add(m[1]);
  assert.ok(used.size > 80, "found " + used.size + " keys");
  for (const key of used) assert.ok(Object.hasOwn(STRINGS.en, key), "missing key: " + key);
});

test("popup.js and the on-video hints have no hard-coded English messages left", () => {
  const popup = read("popup/popup.js");
  assert.doesNotMatch(popup, /setStatus\(["`][^"`]/, "setStatus with a literal");
  assert.doesNotMatch(popup, /new Error\(["`]/, "Error with a literal message");
  assert.doesNotMatch(popup, /<option[^>]*>[A-Z]/, "option markup with English text");
  const content = read("src/content.js");
  for (const english of ["Subtitles enabled", "click the word to hear it", '"Translation failed."']) {
    assert.ok(!content.includes(english), english);
  }
});

// ---------- language choice and lookup ----------

test("a saved choice wins; otherwise a Chinese browser gets 繁體中文 and anything else English", () => {
  assert.equal(uiLanguageOf("en", "zh-TW"), "en");
  assert.equal(uiLanguageOf("zh-TW", "en-US"), "zh-TW");
  for (const browser of ["zh-TW", "zh-HK", "zh-CN", "zh", "ZH-tw"]) assert.equal(uiLanguageOf(null, browser), "zh-TW", browser);
  for (const browser of ["en-US", "ja", "fr", "", undefined, "zhx"]) assert.equal(uiLanguageOf(undefined, browser), "en", String(browser));
  // A saved value that is not a supported language is ignored.
  assert.equal(uiLanguageOf("fr", "zh-TW"), "zh-TW");
  assert.equal(uiLanguageOf({}, "en"), "en");
  assert.equal(htmlLangOf("zh-TW"), "zh-Hant");
  assert.equal(htmlLangOf("en"), "en");
  assert.equal(htmlLangOf("xx"), "en");
});

test("translate fills placeholders, keeps a placeholder with no value, and falls back to English, then the key", () => {
  assert.equal(translate("zh-TW", "flashEnabled", { count: 412 }), "✓ 字幕已開啟（412 行）");
  assert.equal(translate("en", "flashEnabled", { count: 0 }), "✓ Subtitles enabled (0 lines)");
  assert.equal(translate("en", "keyMissing", {}), "Enter your {provider} API key first.");
  assert.equal(translate("en", "keyMissing", { provider: null }), "Enter your {provider} API key first.");
  assert.equal(translate("xx", "loading"), "Loading...");
  assert.equal(translate("zh-TW", "noSuchKey"), "noSuchKey");
  // A value that itself looks like a placeholder is inserted as text, not expanded again.
  assert.equal(translate("en", "autoFailed", { error: "{count}" }), "❌ Auto-translate failed:\n{count}");
});

// ---------- popup ----------

test("popup opens in 繁體中文 on a Chinese browser and in the saved language otherwise", async () => {
  const zh = loadPopup({ browserLanguage: "zh-TW" });
  await zh.open();
  assert.equal(zh.el("uiLanguageSelect").value, "zh-TW");
  assert.equal(zh.document.documentElement.lang, "zh-Hant");
  assert.equal(zh.text("stepTranslate"), "翻譯");
  assert.equal(zh.text("modeOriginal"), "只顯示原文");
  assert.equal(zh.placeholder("apiKeyPlaceholder"), "key1, key2, ...");

  const saved = loadPopup({ browserLanguage: "zh-TW", stored: { ccCraftUiLanguage: "en" } });
  await saved.open();
  assert.equal(saved.el("uiLanguageSelect").value, "en");
  assert.equal(saved.document.documentElement.lang, "en");
  assert.equal(saved.text("stepTranslate"), "Translate");
  assert.equal(saved.data.ccCraftUiLanguage, "en", "opening does not rewrite the choice");
});

test("switching the language saves it, relabels the popup and re-renders the key warning", async () => {
  const p = loadPopup({ browserLanguage: "en-US", incognito: true });
  await p.open();
  assert.match(p.el("status").textContent, /API keys can't be saved/);
  assert.equal(p.el("modelSelect").children.at(-1).textContent, "Enter your API key first");

  p.el("uiLanguageSelect").value = "zh-TW";
  await p.el("uiLanguageSelect").fire("change");
  assert.equal(p.data.ccCraftUiLanguage, "zh-TW");
  assert.equal(p.document.documentElement.lang, "zh-Hant");
  assert.equal(p.text("autoTranslate"), "翻譯並顯示字幕");
  assert.match(p.el("status").textContent, /這個視窗沒辦法儲存 API key/);
  assert.equal(p.el("modelSelect").children.at(-1).textContent, "請先輸入 API key");

  p.el("uiLanguageSelect").value = "en";
  await p.el("uiLanguageSelect").fire("change");
  assert.equal(p.data.ccCraftUiLanguage, "en");
  assert.equal(p.text("autoTranslate"), "Translate & show subtitles");
});

test("status messages follow the interface language", async () => {
  const p = loadPopup({ stored: { ccCraftUiLanguage: "zh-TW" } });
  await p.open();
  await p.el("fetchModels").fire("click");
  assert.equal(p.el("status").textContent, "請先輸入 Google Gemini 的 API key。");

  p.el("apiKeyInput").value = "AIzaOne, AIzaOne";
  await p.el("fetchModels").fire("click");
  assert.match(p.el("status").textContent, /重複了，請刪掉重複的那一個。$/);
});

// ---------- on-video hints (content.js) ----------

function loadContentText(browserLanguage) {
  const source = read("src/content.js");
  const ctx = vm.createContext({ navigator: { language: browserLanguage } });
  ctx.globalThis = ctx;
  vm.runInContext(read("src/i18n.js"), ctx);
  vm.runInContext('let uiLang = "en";\n' + ["uiText", "uiErrorText", "setUiLanguage"].map((n) => extractFunction(source, n)).join("\n\n"), ctx);
  return ctx;
}

test("on-video hints follow the browser language, then the saved choice", () => {
  const ctx = loadContentText("zh-TW");
  ctx.setUiLanguage(null);
  assert.equal(ctx.uiText("flashEnabled", { count: 3 }), "✓ 字幕已開啟（3 行）");
  assert.equal(ctx.uiText("wordHear"), "🔊 點單字聽發音");
  ctx.setUiLanguage("en");
  assert.equal(ctx.uiText("wordLookupFailed"), "Translation failed.");
  ctx.setUiLanguage("bogus");
  assert.equal(ctx.uiText("wordLookupFailed"), "翻譯失敗。");
});

test("the word-lookup tooltip shows a background error in the interface language, without hint lines", () => {
  const source = read("src/content.js");
  assert.match(source, /tip\.textContent = res\?\.error \? uiErrorText\(res\.error\) : uiText\("wordLookupFailed"\);/);
  const ctx = loadContentText("zh-TW");
  ctx.setUiLanguage(null);
  assert.equal(ctx.uiErrorText("Google Translate HTTP 429"), "Google 翻譯回傳 HTTP 429。");
  ctx.setUiLanguage("en");
  assert.equal(ctx.uiErrorText("Google Translate HTTP 429"), "Google Translate returned HTTP 429.");
});

test("content.js switches when the popup saves a new language", () => {
  const source = read("src/content.js");
  assert.match(source, /storage\.onChanged\?\.addListener\(\(changes, area\) => \{\s*if \(area === "local" && changes\.ccCraftUiLanguage\) setUiLanguage\(changes\.ccCraftUiLanguage\.newValue\);/);
  assert.match(extractFunction(source, "loadInitialSettings"), /ccCraftUiLanguage: null[\s\S]*setUiLanguage\(result\.ccCraftUiLanguage\)/);
});

// ---------- wiring ----------

test("i18n.js loads before the popup and content scripts; the manifest name and description are localized", () => {
  const html = read("popup/popup.html");
  const i18n = html.indexOf('src="../src/i18n.js"');
  assert.ok(i18n > 0 && i18n < html.indexOf('src="key-store.js"') && i18n < html.indexOf('src="popup.js"'));

  const manifest = JSON.parse(read("manifest.json"));
  const content = manifest.content_scripts.find((c) => c.js.includes("src/content.js"));
  assert.deepEqual(content.js, ["src/i18n.js", "src/content.js"]);
  assert.equal(manifest.default_locale, "en");
  assert.equal(manifest.name, "__MSG_extName__");
  assert.equal(manifest.description, "__MSG_extDescription__");
  for (const locale of ["en", "zh_TW"]) {
    const messages = JSON.parse(read("_locales/" + locale + "/messages.json"));
    assert.equal(messages.extName.message, "ccCraft", locale);
    assert.ok(messages.extDescription.message.length > 20 && messages.extDescription.message.length <= 132, locale);
  }
});
