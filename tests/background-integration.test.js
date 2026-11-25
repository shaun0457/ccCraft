// Runs the real src/background.js (which importScripts the preprocessing module) with a mock fetch.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, workfileFromJson3 } = require("./helpers/load-extension.js");

const NEMOTRON = "nvidia/nemotron-3-ultra-550b-a55b";
const TRANSLATOR_SYSTEM = "You are a professional subtitle translator. Reply only with the translated numbered lines in the requested format, no explanations.";

function jsonResponse(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
const chat = (content) => jsonResponse(200, { choices: [{ message: { content } }] });

// Answers preprocessing requests by grouping lines in pairs, and translation requests line by line.
function makeFetch({ preprocessStatus = 200 } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body, auth: init.headers.Authorization });
    const user = body.messages[1].content;
    if (body.messages[0].content !== TRANSLATOR_SYSTEM) {
      if (preprocessStatus !== 200) return jsonResponse(preprocessStatus, { error: { message: "denied" } });
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
    return chat(ids.length ? ids.map((id) => id + "| 譯文" + id).join("\n") : "1| ok");
  };
  return { fetchImpl, requests };
}

const lang = { code: "zh-TW", promptName: "Traditional Chinese (Taiwan)", dir: "ltr" };
const isPreprocessRequest = (r) => r.body.messages[0].content !== TRANSLATOR_SYSTEM;

test("translation request body is byte-identical to the pre-change format when no options are passed", async () => {
  const { fetchImpl, requests } = makeFetch();
  const { ctx } = loadBackground({ fetchImpl });
  await ctx.callOpenAiCompatible("nvidia", "k", "m", "PROMPT");
  await ctx.callOpenAiCompatible("gpt", "k", "m", "PROMPT");
  const expected = (maxTokens) => JSON.stringify({
    model: "m",
    temperature: 0.2,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: TRANSLATOR_SYSTEM }, { role: "user", content: "PROMPT" }]
  });
  assert.equal(JSON.stringify(requests[0].body), expected(4096));
  assert.equal(JSON.stringify(requests[1].body), expected(8192));
});

test("automatic track + Nemotron: reconstructed cues go to the existing translator and overlay", async () => {
  const raw = workfileFromJson3("auto-captions-technical.json3");
  const { fetchImpl, requests } = makeFetch();
  const { ctx, store, sentToTabs } = loadBackground({ fetchImpl });
  await ctx.translateWorkfile({ workfile: raw, provider: "nvidia", apiKey: "nvapi-test", model: NEMOTRON, tabId: 7, lang });

  const pre = requests.filter(isPreprocessRequest);
  assert.equal(pre.length, 2, "context + one reconstruction chunk");
  for (const r of pre) {
    assert.deepEqual(r.body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(r.body.model, NEMOTRON);
  }
  const translation = requests.filter((r) => !isPreprocessRequest(r));
  assert.ok(translation.length > 0);
  for (const r of translation) {
    assert.deepEqual(r.body.chat_template_kwargs, { enable_thinking: false }, "Nemotron translation runs without thinking");
    assert.equal(r.body.max_tokens, 4096);
    const prompt = r.body.messages[1].content;
    assert.match(prompt, /\nVideo context \(reference only[^\n]*\nTopic: docs\n\nLines:\n/, "profile reaches the translator");
    assert.doesNotMatch(prompt, /Terms:|Proper nouns:/, "empty lists are left out");
  }

  const loaded = sentToTabs[0].message;
  assert.equal(loaded.type, "LOAD_TRANSLATED_JSON");
  const cues = loaded.workfile.cues;
  assert.ok(cues.length < raw.cues.length, cues.length + " < " + raw.cues.length);
  assert.deepEqual(cues.flatMap((c) => c.source_ids), raw.cues.map((c) => c.id));
  assert.ok(cues.every((c) => c.fa === "譯文" + c.id));

  const status = store["ccCraftTranslateStatus:fixture-video"];
  assert.equal(status.state, "done");
  assert.equal(status.total, cues.length);
  assert.equal(status.preprocessing.applied, true);
  assert.equal(status.preprocessing.raw_cues, raw.cues.length);
  assert.doesNotMatch(JSON.stringify(status), /vision\.md|nvapi/);
});

test("Firefox: manifest background.scripts load the module without importScripts and preprocessing runs", async () => {
  const raw = workfileFromJson3("auto-captions-technical.json3");
  const { fetchImpl, requests } = makeFetch();
  const { ctx, sentToTabs } = loadBackground({ fetchImpl, browser: "firefox" });
  assert.equal(ctx.importScripts, undefined);
  assert.equal(typeof ctx.CaptionPreprocessing?.preprocessWorkfile, "function");
  await ctx.translateWorkfile({ workfile: raw, provider: "nvidia", apiKey: "k", model: NEMOTRON, tabId: 1, lang });
  assert.equal(requests.filter(isPreprocessRequest).length, 2);
  assert.ok(sentToTabs[0].message.workfile.caption_preprocessing);
});

for (const [name, opts] of [
  ["manual track", { kind: "manual" }],
  ["other provider", { provider: "gpt", model: "gpt-4o-mini" }],
  ["non-Nemotron NVIDIA model", { model: "meta/llama-3.3-70b-instruct" }],
  ["disabled by flag", { storage: { ccCraftCaptionPreprocessing: { enabled: false } } }]
]) {
  test("bypass (" + name + "): no preprocessing request, translator gets the original cues", async () => {
    const raw = workfileFromJson3("auto-captions-technical.json3", opts.kind || "asr");
    const { fetchImpl, requests } = makeFetch();
    const { ctx, store, sentToTabs } = loadBackground({ fetchImpl, storage: opts.storage });
    await ctx.translateWorkfile({
      workfile: raw, provider: opts.provider || "nvidia", apiKey: "k", model: opts.model || NEMOTRON, tabId: 1, lang
    });
    assert.equal(requests.filter(isPreprocessRequest).length, 0);
    const sent = sentToTabs[0].message.workfile;
    assert.deepEqual(sent.cues.map((c) => [c.id, c.start, c.end, c.source]), raw.cues.map((c) => [c.id, c.start, c.end, c.source]));
    assert.equal(sent.caption_preprocessing, undefined);
    const translation = requests.filter((r) => !isPreprocessRequest(r));
    const nemotron = (opts.provider || "nvidia") === "nvidia" && /nemotron/i.test(opts.model || NEMOTRON);
    for (const r of translation) {
      assert.doesNotMatch(r.body.messages[1].content, /Video context/, "no profile, no context section");
      assert.deepEqual(r.body.chat_template_kwargs, nemotron ? { enable_thinking: false } : undefined);
    }
    assert.equal(store["ccCraftTranslateStatus:fixture-video"].preprocessing, null);
  });
}

test("preprocessing API failure (no valid key): falls back, translation still runs, warning is visible", async () => {
  const raw = workfileFromJson3("auto-captions-technical.json3");
  const { fetchImpl, requests } = makeFetch({ preprocessStatus: 401 });
  const { ctx, store, sentToTabs } = loadBackground({ fetchImpl });
  await ctx.translateWorkfile({ workfile: raw, provider: "nvidia", apiKey: "nvapi-a,nvapi-b", model: NEMOTRON, tabId: 1, lang });
  const pre = requests.filter(isPreprocessRequest);
  assert.equal(pre.length, 4, "context and chunk, each with one retry");
  assert.deepEqual(pre.map((r) => r.auth), ["Bearer nvapi-a", "Bearer nvapi-b", "Bearer nvapi-a", "Bearer nvapi-b"], "keys rotate on failure");
  assert.equal(sentToTabs[0].message.workfile.cues.length, raw.cues.length);
  const status = store["ccCraftTranslateStatus:fixture-video"];
  assert.equal(status.state, "done");
  assert.equal(status.preprocessing.applied, false);
  assert.deepEqual(status.preprocessing.warnings, ["context_http_401", "chunk_http_401"]);
});

test("buildChunkPrompt: no or empty context leaves the prompt unchanged; context values are bounded", () => {
  const { ctx } = loadBackground({ fetchImpl: makeFetch().fetchImpl });
  const cues = [{ id: 1, source: "hello  world" }, { id: 2, source: "bye" }];
  const plain = ctx.buildChunkPrompt(cues, lang);
  assert.ok(plain.endsWith(" translated into Traditional Chinese (Taiwan).\n\nLines:\n1| hello world\n2| bye"));
  for (const empty of [null, undefined, {}, { topic: "  ", terms: [""], proper_nouns: "x" }, "text"]) {
    assert.equal(ctx.buildChunkPrompt(cues, lang, empty), plain);
  }
  const long = "x".repeat(500);
  const withCtx = ctx.buildChunkPrompt(cues, lang, {
    topic: "Hooks\nin  Claude", terms: Array.from({ length: 40 }, (_, i) => "t" + i), proper_nouns: [long]
  });
  assert.match(withCtx, /\nTopic: Hooks in Claude\nTerms: t0; [^\n]*t29\nProper nouns: x{200}\n\nLines:\n/);
  assert.doesNotMatch(withCtx, /t30/);
});
