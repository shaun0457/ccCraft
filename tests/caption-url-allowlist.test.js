// Run: node --test tests/*.test.js
// Loads the real functions from src/content.js and src/inject-main.js (by source extraction)
// and checks that only YouTube's own timedtext endpoint is fetched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const contentSrc = fs.readFileSync(path.join(root, "src/content.js"), "utf8");
const injectSrc = fs.readFileSync(path.join(root, "src/inject-main.js"), "utf8");

function slice(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `markers not found: ${startMarker}`);
  return src.slice(start, end);
}

function loadContent(fetchImpl) {
  const code =
    slice(contentSrc, "const CAPTION_HOSTS", "function parseJson3") +
    "\nthis.isAllowedCaptionUrl = isAllowedCaptionUrl; this.readCaptionText = readCaptionText;";
  const ctx = { URL, fetch: fetchImpl };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

function loadInject(origin = "https://www.youtube.com") {
  const code = slice(injectSrc, "function toTimedTextUrl", "function withFormat") + "\nthis.toTimedTextUrl = toTimedTextUrl;";
  const ctx = { URL, location: { origin } };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

const ALLOWED = [
  "https://www.youtube.com/api/timedtext?v=abc&lang=en",
  "https://m.youtube.com/api/timedtext?v=abc&fmt=json3",
  "https://youtube.com/api/timedtext?v=abc"
];

const REJECTED = [
  "https://evil.example/api/timedtext?v=abc",
  "https://evil.example/x/api/timedtext",
  "https://www.youtube.com.evil.example/api/timedtext",
  "https://evilyoutube.com/api/timedtext",
  "http://www.youtube.com/api/timedtext?v=abc",
  "https://www.youtube.com:8443/api/timedtext",
  "https://user:pw@www.youtube.com/api/timedtext",
  "https://www.youtube.com/api/timedtext/../../redirect?q=https://evil.example",
  "https://www.youtube.com/redirect?q=/api/timedtext",
  "https://www.youtube.com/api/timedtextx",
  "javascript:alert(1)//api/timedtext",
  "data:text/plain,/api/timedtext",
  "not a url",
  ""
];

test("content.js allows only YouTube timedtext URLs", () => {
  const { isAllowedCaptionUrl } = loadContent(() => assert.fail("no fetch"));
  for (const url of ALLOWED) assert.equal(isAllowedCaptionUrl(url), true, url);
  for (const url of REJECTED) assert.equal(isAllowedCaptionUrl(url), false, url);
});

test("readCaptionText refuses a foreign URL before fetching", async () => {
  let calls = 0;
  const { readCaptionText } = loadContent(async () => {
    calls++;
    return { ok: true, status: 200, text: async () => "x" };
  });
  for (const url of REJECTED.filter(Boolean)) {
    await assert.rejects(readCaptionText(url, null), /not a YouTube timedtext URL|Invalid URL/, url);
    await assert.rejects(readCaptionText(url, "vtt"), /not a YouTube timedtext URL|Invalid URL/, url);
  }
  assert.equal(calls, 0);
});

test("readCaptionText still fetches YouTube timedtext URLs with credentials and format", async () => {
  const seen = [];
  const { readCaptionText } = loadContent(async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, text: async () => "body" };
  });
  assert.equal(await readCaptionText(ALLOWED[0], "json3"), "body");
  assert.equal(await readCaptionText(ALLOWED[1], null), "body");
  assert.equal(seen.length, 2);
  assert.equal(new URL(seen[0].url).searchParams.get("fmt"), "json3");
  assert.equal(seen[0].init.credentials, "include");
});

test("inject-main.js toTimedTextUrl applies the same rule (relative URLs resolve against YouTube)", () => {
  const { toTimedTextUrl } = loadInject();
  for (const url of ALLOWED) assert.ok(toTimedTextUrl(url), url);
  assert.ok(toTimedTextUrl("/api/timedtext?v=abc"), "relative");
  for (const url of REJECTED.filter((u) => u && u !== "not a url")) assert.equal(toTimedTextUrl(url), null, url);
});
