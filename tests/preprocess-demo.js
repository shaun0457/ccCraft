#!/usr/bin/env node
// Before/after comparison: A = original ccCraft input, B = same input after caption preprocessing.
//
//   node tests/preprocess-demo.js                         # bundled fixture, scripted mock replies (offline)
//   NVIDIA_API_KEY=nvapi-... node tests/preprocess-demo.js [file] [--lang zh-TW] [--out dir]
//       live: real Nemotron for preprocessing AND the existing translator for A and B
//       (same model, same target language, same chunking/prompt as the extension).
//
// [file] is a .json3 caption file or a workfile JSON saved with the popup's "Download JSON".
// Live mode sends the transcript to NVIDIA, exactly as the extension would.
"use strict";

const fs = require("fs");
const path = require("path");
const CP = require("../src/caption-preprocessing.js");
const { loadBackground, loadContentParsers } = require("./helpers/load-extension.js");

const MODEL = process.env.CCCRAFT_MODEL || "nvidia/nemotron-3-ultra-550b-a55b";
const LANGS = {
  "zh-TW": { code: "zh-TW", promptName: "Traditional Chinese as used in Taiwan (繁體中文，台灣用語)", dir: "ltr" }
};

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function loadWorkfile(file) {
  const text = fs.readFileSync(file, "utf8");
  const data = JSON.parse(text);
  if (Array.isArray(data.cues)) return data;
  const p = loadContentParsers();
  return {
    schema: "cccraft-subtitle-v1.1",
    video: { id: path.basename(file), title: path.basename(file), url: "", duration_seconds: 0 },
    source_track: { languageCode: "en", label: "auto", kind: "asr", vssId: "", read_format: "json3" },
    generated_at: new Date(0).toISOString(),
    model_prompt: "",
    cues: JSON.parse(JSON.stringify(p.fixCueTiming(p.parseJson3(text))))
  };
}

function mockCallModel(mockFile) {
  const mock = JSON.parse(fs.readFileSync(mockFile, "utf8"));
  let chunk = 0;
  return async (prompt) => (prompt.startsWith("Read this automatic caption transcript")
    ? JSON.stringify(mock.context)
    : JSON.stringify(mock.reconstruction[chunk++]));
}

function liveBackground(counter) {
  return loadBackground({
    fetchImpl: (url, init) => {
      counter.requests++;
      return fetch(url, init);
    }
  }).ctx;
}

async function translateAll(bg, key, cues, lang) {
  const out = new Map();
  const ring = bg.makeKeyRing(key);
  for (let i = 0; i < cues.length; i += 50) {
    const chunk = cues.slice(i, i + 50);
    for (const t of await bg.translateChunk("nvidia", ring, MODEL, chunk, lang)) out.set(Number(t.id), t.fa);
  }
  return out;
}

const fmt = (s) => s.toFixed(2).padStart(6);

async function main() {
  const fixtureDir = path.join(__dirname, "fixtures");
  const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : path.join(fixtureDir, "auto-captions-technical.json3");
  const key = process.env.NVIDIA_API_KEY || "";
  const live = Boolean(key);
  const lang = LANGS[arg("--lang", "zh-TW")] || { code: arg("--lang"), promptName: arg("--lang"), dir: "ltr" };
  const outDir = arg("--out", null);
  const raw = loadWorkfile(file);

  const counter = { requests: 0 };
  let callModel;
  let bg;
  if (live) {
    bg = liveBackground(counter);
    callModel = (prompt, options) => bg.callOpenAiCompatible("nvidia", key, MODEL, prompt, {
      ...options,
      extraBody: { chat_template_kwargs: { enable_thinking: false } }
    });
  } else {
    if (path.basename(file) !== "auto-captions-technical.json3") {
      throw new Error("Mock mode only has scripted replies for the bundled fixture. Set NVIDIA_API_KEY to run on other files.");
    }
    callModel = mockCallModel(path.join(fixtureDir, "mock-nemotron-responses.json"));
  }

  const t0 = Date.now();
  const { workfile: after, report } = await CP.preprocessWorkfile(raw, { callModel });
  const preprocessMs = Date.now() - t0;
  const preprocessRequests = live ? counter.requests : report.requests;

  const lines = [];
  const log = (s = "") => lines.push(s);
  log("# Caption preprocessing: before/after");
  log();
  log("- input: " + path.basename(file) + " (" + raw.cues.length + " raw cues, track kind " + raw.source_track.kind + ")");
  log("- mode: " + (live ? "LIVE " + MODEL : "MOCK (scripted replies from tests/fixtures/mock-nemotron-responses.json, not real model output)"));
  log("- result: " + report.reason + ", " + report.raw_cue_count + " -> " + report.cue_count + " cues, " +
    report.corrections.length + " corrections accepted, " + report.changes_reverted + " changes reverted, " + report.groups_text_rejected + " group texts rejected");
  log("- preprocessing requests: " + preprocessRequests + ", runtime: " + (live ? preprocessMs + " ms" : "n/a (mock)") +
    (report.warnings.length ? ", warnings: " + report.warnings.join(", ") : ""));
  log();
  log("## A: what the translator receives today");
  log();
  log("```");
  for (const c of raw.cues) log(fmt(c.start) + " " + fmt(c.end) + "  " + c.id + "| " + c.source);
  log("```");
  log();
  log("## B: what the translator receives after preprocessing");
  log();
  log("```");
  for (const c of after.cues) log(fmt(c.start) + " " + fmt(c.end) + "  " + c.id + "| " + c.source + "    <- raw " + (c.source_ids || [c.id]).join(","));
  log("```");
  log();
  if (report.corrections.length || report.rejections.length) {
    log("## Corrections and rejections");
    log();
    for (const c of report.corrections) log("- accepted, raw " + c.source_ids.join(",") + ": \"" + c.original + "\" -> \"" + c.replacement + "\" (" + c.reason + ")");
    for (const r of report.rejections) {
    log(r.kept === undefined
      ? "- rejected whole text for raw " + r.source_ids.join(",") + ": " + r.code + " (raw words kept, grouping kept); model wrote: \"" + r.model + "\""
      : "- reverted in raw " + r.source_ids.join(",") + ": " + r.code + ", kept \"" + r.kept + "\" instead of \"" + r.model + "\"");
  }
    log();
  }

  let translations = null;
  if (live) {
    const t1 = Date.now();
    const before = counter.requests;
    const trA = await translateAll(bg, key, raw.cues, lang);
    const trB = await translateAll(bg, key, after.cues, lang);
    translations = { A: Object.fromEntries(trA), B: Object.fromEntries(trB) };
    log("## Translations (" + lang.code + ", same model and translator for A and B)");
    log();
    log("translation requests: " + (counter.requests - before) + ", runtime: " + (Date.now() - t1) + " ms");
    log();
    for (const b of after.cues) {
      log("**B " + fmt(b.start).trim() + "-" + fmt(b.end).trim() + "** " + (trB.get(b.id) || "(missing)"));
      for (const a of raw.cues.filter((c) => (b.source_ids || []).includes(c.id))) {
        log("- A " + a.id + ": " + (trA.get(a.id) || "(missing)"));
      }
      log();
    }
  } else {
    log("Translations: live mode only (set NVIDIA_API_KEY).");
  }

  const text = lines.join("\n") + "\n";
  process.stdout.write(text);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "before-after.md"), text);
    fs.writeFileSync(path.join(outDir, "workfile-A.json"), JSON.stringify(raw, null, 2));
    fs.writeFileSync(path.join(outDir, "workfile-B.json"), JSON.stringify(after, null, 2));
    fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ report, translations }, null, 2));
  }
}

main().catch((err) => {
  console.error("demo failed: " + err.message);
  process.exit(1);
});
