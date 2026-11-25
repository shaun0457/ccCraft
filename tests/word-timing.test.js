// Word-timed segmentation: json3 word times in the parser, sentence-end splits in preprocessing.
// Run: node --test tests/
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const CP = require("../src/caption-preprocessing.js");
const { loadContentParsers } = require("./helpers/load-extension.js");

const parsers = loadContentParsers();
const plain = (v) => JSON.parse(JSON.stringify(v)); // vm realm -> this realm

function json3(events) {
  return JSON.stringify({ events });
}
const seg = (utf8, tOffsetMs) => (tOffsetMs === undefined ? { utf8 } : { utf8, tOffsetMs });

function cue(id, start, end, source, words) {
  const c = { id, start, end, start_time: "", end_time: "", source, fa: "" };
  if (words) c.words = words;
  return c;
}

function workfile(cues) {
  return {
    schema: "cccraft-subtitle-v1.1",
    video: { id: "vid", title: "t", url: "u", duration_seconds: 100 },
    source_track: { languageCode: "en", label: "English (auto-generated)", kind: "asr", vssId: "a.en", read_format: "json3" },
    generated_at: "2026-11-25T00:00:00.000Z",
    model_prompt: "p",
    cues
  };
}

// Context gets a fixed profile; reconstruction keeps every unit as its own group, text unchanged.
async function oneGroupPerLine(prompt) {
  if (prompt.startsWith("Read this automatic caption transcript")) {
    return JSON.stringify({ topic: "t", terms: [], proper_nouns: [], asr_confusions: [] });
  }
  const body = prompt.split("<transcript>\n")[1].split("\n</transcript>")[0];
  const groups = body.split("\n").map((l) => /^(\d+)\| (.*)$/.exec(l)).map((m) => ({ ids: [Number(m[1])], text: m[2], corrections: [] }));
  return JSON.stringify({ groups });
}

// ---------- parser ----------

test("parseJson3 keeps per-word times when the segments carry offsets", () => {
  const cues = plain(parsers.parseJson3(json3([
    { tStartMs: 21800, dDurationMs: 3000, segs: [seg("benefit"), seg(" from", 500), seg(" it.", 700), seg(" Let's", 1400), seg(" dive", 1600)] }
  ])));
  assert.equal(cues[0].source, "benefit from it. Let's dive");
  assert.deepEqual(cues[0].words, [["benefit", 21.8], ["from", 22.3], ["it.", 22.5], ["Let's", 23.2], ["dive", 23.4]]);
});

test("parseJson3 adds no words without offsets, with one segment, a bad offset or a text mismatch", () => {
  const cases = [
    [seg("hello"), seg(" world")], // no tOffsetMs at all
    [seg("hello world", 0)], // one segment
    [seg("hello"), seg(" world", -5)], // negative offset
    [seg("hello"), seg(" world", "x")], // not a number
    [seg("hel"), seg("lo", 300)] // joined words differ from the cue text ("hel lo" vs "hello")
  ];
  for (const segs of cases) {
    const cues = plain(parsers.parseJson3(json3([{ tStartMs: 1000, dDurationMs: 2000, segs }])));
    assert.equal(cues.length, 1);
    assert.equal(cues[0].words, undefined, JSON.stringify(segs));
  }
});

// ---------- word times ----------

test("wordTimesOf rejects times that do not increase, fall outside the cue, or text that differs", () => {
  const unit = (words, text = "a b. c") => ({ start: 10, end: 12, text, words });
  assert.deepEqual(CP.wordTimesOf(unit([["a", 10], ["b.", 10.5], ["c", 11]])), [["a", 10], ["b.", 10.5], ["c", 11]]);
  assert.equal(CP.wordTimesOf(unit([["a", 10], ["b.", 10], ["c", 11]])), null, "equal times");
  assert.equal(CP.wordTimesOf(unit([["a", 10], ["b.", 11], ["c", 10.5]])), null, "decreasing");
  assert.equal(CP.wordTimesOf(unit([["a", 9], ["b.", 10.5], ["c", 11]])), null, "before the cue");
  assert.equal(CP.wordTimesOf(unit([["a", 10], ["b.", 10.5], ["c", 12]])), null, "at the cue end");
  assert.equal(CP.wordTimesOf(unit([["a", 10], ["b.", 10.5], ["c", NaN]])), null, "not finite");
  assert.equal(CP.wordTimesOf(unit([["a", 10], ["b.", 10.5], ["d", 11]])), null, "text differs");
  assert.equal(CP.wordTimesOf(unit(null)), null);
  assert.equal(CP.wordTimesOf(unit("ab")), null);
});

test("splitAtSentenceEnds: pieces start at real word times; absorbed ids stay at their side", () => {
  const units = [{
    uid: 1, rawIds: [7, 8, 9], cueId: 8, start: 21.8, end: 25, rawText: "benefit from it. Let's dive in. First,",
    text: "benefit from it. Let's dive in. First,",
    words: [["benefit", 21.8], ["from", 22.3], ["it.", 22.5], ["Let's", 23.2], ["dive", 23.4], ["in.", 23.6], ["First,", 24.2]]
  }];
  const log = [];
  const out = CP.splitAtSentenceEnds(units, log);
  assert.deepEqual(out.map((u) => [u.uid, u.text, u.start, u.end, u.rawIds]), [
    [1, "benefit from it.", 21.8, 23.2, [7, 8]],
    [2, "Let's dive in.", 23.2, 24.2, [8]],
    [3, "First,", 24.2, 25, [8, 9]]
  ]);
  assert.deepEqual(log, [{ type: "cue_split_at_sentence_end", raw_id: 8, parts: 3 }]);
});

test("splitAtSentenceEnds leaves units alone without word times, with an end only at the last word, or a rolling prefix", () => {
  const raw = [
    cue(1, 0, 2, "one two."), // no words
    cue(2, 2, 4, "three four.", [["three", 2], ["four.", 3]]), // sentence end only at the end
    cue(3, 4, 6, "three four. five six", [["three", 4], ["four.", 4.5], ["five", 5], ["six", 5.5]]) // rolling prefix
  ];
  const { units, log } = CP.normalizeCues(raw, { ...CP.DEFAULTS, rollingPrefixMinWords: 2 });
  assert.equal(units[2].text, "five six", "rolling prefix removed");
  assert.equal(units[2].words, null, "no word times once the text was trimmed");
  const out = CP.splitAtSentenceEnds(units, log);
  assert.deepEqual(out.map((u) => u.text), ["one two.", "three four.", "five six"]);
  assert.equal(log.filter((x) => x.type === "cue_split_at_sentence_end").length, 0);
});

// ---------- end to end ----------

test("preprocessWorkfile splits a two-sentence line; raw ids stay covered in order, timing comes from words", async () => {
  const raw = workfile([
    cue(1, 20, 21.8, "and that is how you"),
    cue(2, 21.8, 25, "benefit from it. Let's dive in. First,",
      [["benefit", 21.8], ["from", 22.3], ["it.", 22.5], ["Let's", 23.2], ["dive", 23.4], ["in.", 23.6], ["First,", 24.2]]),
    cue(3, 25, 27, "open the settings page.")
  ]);
  const { workfile: out, report } = await CP.preprocessWorkfile(raw, { callModel: oneGroupPerLine });
  assert.equal(report.reason, "applied");
  assert.equal(report.cues_split, 1);
  assert.equal(out.caption_preprocessing.cues_split, 1);
  const lines = out.cues.map((c) => [c.source, c.start, c.end]);
  assert.ok(lines.some(([s, a]) => s.startsWith("Let's dive in.") && a === 23.2), JSON.stringify(lines));
  assert.ok(!out.cues.some((c) => c.source.includes("it. Let's")), "the two sentences are no longer in one cue");
  const ids = out.cues.flatMap((c) => c.source_ids).filter((id, i, a) => i === 0 || id !== a[i - 1]);
  assert.deepEqual(ids, [1, 2, 3]);
  const boundaries = new Set([20, 21.8, 25, 27, 22.3, 22.5, 23.2, 23.4, 23.6, 24.2]);
  for (const c of out.cues) assert.ok(boundaries.has(c.start) && boundaries.has(c.end), c.start + "-" + c.end);
  for (let i = 1; i < out.cues.length; i++) assert.ok(out.cues[i].start >= out.cues[i - 1].end);
  assert.deepEqual(out.caption_preprocessing.profile, { topic: "t", terms: [], proper_nouns: [] });
});

test("preprocessWorkfile with splitAtSentenceEnds off keeps the line whole", async () => {
  const raw = workfile([
    cue(1, 21.8, 25, "benefit from it. Let's dive in.", [["benefit", 21.8], ["from", 22.3], ["it.", 22.5], ["Let's", 23.2], ["dive", 23.4], ["in.", 23.6]])
  ]);
  const { workfile: out, report } = await CP.preprocessWorkfile(raw, { callModel: oneGroupPerLine, config: { splitAtSentenceEnds: false } });
  assert.equal(report.cues_split, 0);
  assert.deepEqual(out.cues.map((c) => c.source_ids), [[1]]);
});

test("a fallback returns the original workfile: no profile, words kept as parsed", async () => {
  const raw = workfile([cue(1, 0, 3, "a b. c d", [["a", 0], ["b.", 1], ["c", 2], ["d", 2.5]])]);
  const { workfile: out, report } = await CP.preprocessWorkfile(raw, { callModel: async () => "not json" });
  assert.notEqual(report.reason, "applied");
  assert.equal(out.caption_preprocessing?.profile ?? null, null);
  assert.equal(out.cues.length, 1);
});

test("chunkSize counts raw cues: split pieces add no requests and stay in one chunk", async () => {
  const raw = workfile([1, 2, 3].map((id) => {
    const t = id * 10;
    return cue(id, t, t + 4, "one two. three four", [["one", t], ["two.", t + 1], ["three", t + 2], ["four", t + 3]]);
  }));
  const prompts = [];
  const callModel = async (prompt) => {
    prompts.push(prompt);
    return oneGroupPerLine(prompt);
  };
  const { workfile: out, report } = await CP.preprocessWorkfile(raw, { callModel, config: { chunkSize: 2 } });
  assert.equal(report.cues_split, 3);
  assert.equal(report.chunks_total, 2, "3 raw cues / 2 per chunk, not 6 pieces / 2");
  const chunkPrompts = prompts.filter((p) => !p.startsWith("Read this automatic caption transcript"));
  const lines = chunkPrompts.map((p) => p.split("<transcript>\n")[1].split("\n</transcript>")[0].split("\n").length);
  assert.deepEqual(lines, [4, 2]);
  assert.equal(out.cues.length, 6);
});

test("a model group is cut at sentence ends when both sides last long enough; a short sentence stays attached", async () => {
  const raw = workfile([
    cue(1, 0, 2, "So, why do we need this file?"),
    cue(2, 2, 4.5, "Let me quickly explain it."),
    cue(3, 4.5, 5, "Okay."),
    cue(4, 5, 7, "and then we start")
  ]);
  const oneGroup = async (prompt) => {
    if (prompt.startsWith("Read this automatic caption transcript")) return oneGroupPerLine(prompt);
    return JSON.stringify({ groups: [{ ids: [1, 2, 3, 4], text: "So, why do we need this file? Let me quickly explain it. Okay. And then we start", corrections: [] }] });
  };
  const { workfile: out } = await CP.preprocessWorkfile(raw, { callModel: oneGroup });
  assert.deepEqual(out.cues.map((c) => c.source_ids), [[1], [2, 3], [4]], "Okay. (0.5 s) is too short to stand alone and stays with the sentence before it");
  const { workfile: off } = await CP.preprocessWorkfile(raw, { callModel: oneGroup, config: { sentenceCutMinSeconds: 0 } });
  assert.deepEqual(off.cues.map((c) => c.source_ids), [[1, 2, 3, 4]]);
});
