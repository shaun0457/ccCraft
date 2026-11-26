// Run: node --test tests/*.test.js
// Error text from the background, content script and YouTube page, shown in the interface language
// with a likely cause and what to do (src/i18n.js describeError).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "src");
const ctx = vm.createContext({});
ctx.globalThis = ctx;
vm.runInContext(fs.readFileSync(path.join(SRC, "i18n.js"), "utf8"), ctx, { filename: "i18n.js" });
const { describeError, STRINGS } = ctx.CcCraftI18n;
const zh = (raw, options) => describeError("zh-TW", raw, options);
const en = (raw, options) => describeError("en", raw, options);

test("429 keeps the provider's text and says to try later or switch model", () => {
  const text = zh("OpenAI GPT HTTP 429: Rate limit reached for gpt-4o-mini");
  assert.equal(text,
    "OpenAI GPT 回傳 HTTP 429：Rate limit reached for gpt-4o-mini\n" +
    "💡 可能原因：短時間內請求太多次，或額度用完了\n" +
    "👉 怎麼處理：請稍後再試，或換其他模型試試。也可以填多把 key（用逗號隔開），一把忙碌時會自動換下一把。");
});

test("each HTTP status gets its own cause and fix", () => {
  const cases = [
    ["400", "請求格式不被接受"],
    ["401", "API key 錯誤"],
    ["403", "沒有使用這個模型的權限"],
    ["404", "找不到這個模型"],
    ["408", "太久沒回應"],
    ["413", "內容太大"],
    ["500", "伺服器暫時出問題"],
    ["503", "伺服器暫時出問題"],
    ["504", "太久沒回應"]
  ];
  for (const [status, cause] of cases) {
    const text = zh("NVIDIA NIM HTTP " + status + ": detail");
    assert.match(text, new RegExp("^NVIDIA NIM 回傳 HTTP " + status + "：detail\n💡 可能原因：.*" + cause), status);
    assert.match(text, /\n👉 怎麼處理：/, status);
  }
});

test("an HTTP status without a known cause is translated without hint lines", () => {
  assert.equal(zh("Alibaba Qwen HTTP 418: teapot"), "Alibaba Qwen 回傳 HTTP 418：teapot");
});

test("Gemini errors and the model-list errors are translated too", () => {
  assert.match(zh("Gemini HTTP 403: Unknown error (check your API key)"), /^Gemini 回傳 HTTP 403：Unknown error \(check your API key\)\n💡/);
  assert.equal(zh("No usable models were returned by NVIDIA NIM."), "NVIDIA NIM 沒有回傳可以用的模型。");
});

test("timeout, empty and unparsable replies get hints", () => {
  assert.match(zh("The request timed out (no response within 90 seconds)."), /^請求逾時（90 秒內沒有回應）。\n💡 可能原因：供應商太久沒回應/);
  assert.match(zh("Google Gemini returned an empty response."), /^Google Gemini 回傳了空白內容。\n💡 可能原因：模型回了空白內容/);
  assert.match(zh("The model response contained no numbered translation lines."), /^模型的回覆裡沒有編號的翻譯行。\n💡 可能原因：模型沒有照要求的格式回覆/);
});

test("the background's combined messages are translated piece by piece, with one hint", () => {
  const manual = 'The AI could not translate this video. Please translate it manually: open the "Manual translation" section, download the JSON or prompt, translate it yourself, then load the translated file back.';
  const first = zh("OpenAI GPT HTTP 401: Incorrect API key provided\n\n" + manual);
  assert.equal(first.split("💡").length, 2, "one cause line");
  assert.match(first, /^OpenAI GPT 回傳 HTTP 401：Incorrect API key provided\n\nAI 沒辦法翻譯這部影片，請改用手動翻譯：/);
  assert.match(first, /💡 可能原因：API key 錯誤、過期或被停用/);

  const later = zh("70 of 120 lines are still untranslated. " + manual + "\n(NVIDIA NIM HTTP 429: Too Many Requests)\nNVIDIA NIM HTTP 500: x");
  assert.match(later, /^120 行裡還有 70 行沒翻成。 AI 沒辦法翻譯這部影片/);
  assert.match(later, /\n\(NVIDIA NIM 回傳 HTTP 429：Too Many Requests\)\n/, "the closing parenthesis stays outside the detail");
  assert.match(later, /💡 可能原因：短時間內請求太多次/, "the first status decides the hint");
  assert.doesNotMatch(later, /伺服器暫時出問題/);
});

test("hints: false leaves out the cause lines", () => {
  assert.equal(zh("OpenAI GPT HTTP 429: slow down", { hints: false }), "OpenAI GPT 回傳 HTTP 429：slow down");
  assert.equal(zh("Google Translate HTTP 429", { hints: false }), "Google 翻譯回傳 HTTP 429。");
});

test("unknown or already translated text is shown unchanged", () => {
  assert.equal(zh("Something new went wrong"), "Something new went wrong");
  assert.equal(zh("請先取得模型清單並選一個模型。"), "請先取得模型清單並選一個模型。");
  assert.equal(zh(undefined), "");
  const once = zh("OpenAI GPT HTTP 429: x");
  assert.equal(zh(once, { hints: false }), once, "describing twice changes nothing");
});

test("a provider detail with $ signs or braces is kept literally", () => {
  assert.match(zh("OpenAI GPT HTTP 400: bad $& {detail} $1"), /^OpenAI GPT 回傳 HTTP 400：bad \$& \{detail\} \$1\n/);
});

test("English interface gets the same cause and fix lines", () => {
  assert.equal(en("OpenAI GPT HTTP 429: x"),
    "OpenAI GPT returned HTTP 429: x\n" +
    "💡 Likely cause: too many requests in a short time, or the quota is used up\n" +
    "👉 What to do: try again later, or try another model. You can also enter several keys (comma separated) so a busy one is skipped.");
});

test("every cause has a fix and both languages have every error string", () => {
  for (const lang of ["en", "zh-TW"]) {
    const keys = Object.keys(STRINGS[lang]).filter((k) => /^(err|cause|fix)/.test(k));
    for (const k of keys.filter((k) => k.startsWith("cause"))) assert.ok(STRINGS[lang]["fix" + k.slice(5)], lang + " " + k);
    const other = lang === "en" ? "zh-TW" : "en";
    for (const k of keys) assert.ok(STRINGS[other][k], other + " is missing " + k);
  }
});

// Guards against a new English sentence in the other scripts that nobody translated.
test("every fixed English error sentence in background, content and page scripts is translated", () => {
  const internal = new Set([
    // Parser reasons listed under "Could not read the subtitle text." as technical detail.
    "missing url", "empty response", "not json3", "json3 has no cues", "not xml", "xml has no cues",
    "vtt has no cues", "caption URL is not a YouTube timedtext URL"
  ]);
  const found = [];
  for (const file of ["background.js", "content.js", "inject-main.js"]) {
    const source = fs.readFileSync(path.join(SRC, file), "utf8");
    for (const m of source.matchAll(/(?:new Error\(|error: |reason = [^"\n]*\|\| |manualHint =\s*)\s*(["'])((?:\\.|(?!\1).)*?)\1\s*[)+,;\n]/g)) {
      const literal = m[2].replace(/\\"/g, '"').replace(/\\n/g, "\n");
      // Only whole sentences; a fragment joined with + (like "Gemini HTTP ") is covered by its own test above.
      if (!internal.has(literal) && /[a-z]{3}/.test(literal) && /[.)]$/.test(literal.trim())) found.push([file, literal]);
    }
  }
  assert.ok(found.length >= 12, "found " + found.length + " sentences");
  for (const [file, literal] of found) {
    const text = zh(literal, { hints: false });
    assert.notEqual(text, literal, file + ": " + literal);
    assert.doesNotMatch(text, /[A-Za-z]{4,} [a-z]{3,} [a-z]{3,}/, file + ": English left in " + JSON.stringify(text));
  }
});
