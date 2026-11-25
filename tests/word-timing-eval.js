#!/usr/bin/env node
// A/B evaluation for word-timed segmentation on a real json3 caption file.
//
//   NVIDIA_API_KEY=nvapi-... node tests/word-timing-eval.js <file.json3> --out <dir> [--lang zh-TW] [--no-translate]
//
// A = caption preprocessing as in PR #3: no sentence-end split; translator prompt without video
//     context, Nemotron thinking left on (the request body the extension sent before this change).
// B = this branch: sentence-end split from word times; translator gets the profile, thinking off.
// Both use the real Nemotron model and the extension's own code (src/), same chunking (50 lines).
//
// The thresholds below were written down before the first run (docs/caption-preprocessing/
// word-timed-segmentation.md). The script checks them and exits 1 when one fails.
// The input transcript and all outputs stay in --out; nothing is written into the repo.
"use strict";

const fs = require("fs");
const path = require("path");
const CP = require("../src/caption-preprocessing.js");
const { loadBackground, loadContentParsers } = require("./helpers/load-extension.js");

const MODEL = process.env.CCCRAFT_MODEL || "nvidia/nemotron-3-ultra-550b-a55b";
const LANGS = {
  "zh-TW": { code: "zh-TW", promptName: "Traditional Chinese as used in Taiwan (繁體中文，台灣用語)", dir: "ltr" }
};
const THRESHOLDS = {
  boundariesFromRawTimes: 1.0, // share of B cue starts/ends that are raw cue boundaries or raw word times (>=)
  twoSentenceCues: 0.05, // share of B cues with a sentence end followed by more words (<=)
  longCues: 0.02, // share of B cues longer than 7 s (<=)
  fallbackChunks: 0.1 // share of B reconstruction chunks that fell back to raw cues (<=)
};
const TRANSLATE_CONCURRENCY = 3;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function loadRaw(file) {
  const p = loadContentParsers();
  const cues = JSON.parse(JSON.stringify(p.fixCueTiming(p.parseJson3(fs.readFileSync(file, "utf8")))));
  return {
    schema: "cccraft-subtitle-v1.1",
    video: { id: path.basename(file), title: path.basename(file), url: "", duration_seconds: 0 },
    source_track: { languageCode: "en", label: "auto", kind: "asr", vssId: "", read_format: "json3" },
    generated_at: new Date(0).toISOString(),
    model_prompt: "",
    cues
  };
}

const SENTENCE_THEN_MORE = /[.?!]["')\]]*\s+\S/;
const round3 = (x) => Math.round(Number(x) * 1000) / 1000;

function metrics(raw, out, report) {
  const times = new Set();
  for (const c of raw.cues) {
    times.add(round3(c.start));
    times.add(round3(c.end));
    for (const w of c.words || []) times.add(round3(w[1]));
  }
  const cues = out.cues;
  const ends = cues.flatMap((c) => [round3(c.start), round3(c.end)]);
  const normJoin = (list) => list.map((c) => c.source).join(" ").split(/\s+/).map(CP.normToken).filter(Boolean);
  const rawTokens = normJoin(raw.cues);
  const outTokens = normJoin(cues);
  return {
    cues: cues.length,
    boundariesFromRawTimes: ends.filter((t) => times.has(t)).length / Math.max(1, ends.length),
    // Accepted corrections may change words; without corrections the sequences must be equal.
    wordsEqual: report.corrections.length === 0 ? rawTokens.join(" ") === outTokens.join(" ") : null,
    corrections: report.corrections.length,
    twoSentenceCues: cues.filter((c) => SENTENCE_THEN_MORE.test(c.source)).length / Math.max(1, cues.length),
    longCues: cues.filter((c) => c.end - c.start > 7).length / Math.max(1, cues.length),
    fallbackChunks: report.chunks_total ? report.chunks_fallback / report.chunks_total : 0,
    chunks: report.chunks_fallback + "/" + report.chunks_total,
    split: report.cues_split,
    reason: report.reason,
    warnings: report.warnings.join(",") || "-",
    requests: report.requests,
    elapsedMs: report.elapsed_ms
  };
}

async function translateAll(bg, key, cues, lang, variant, context) {
  const ring = bg.makeKeyRing(key);
  const chunks = [];
  for (let i = 0; i < cues.length; i += 50) chunks.push(cues.slice(i, i + 50));
  const out = new Map();
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      try {
        let items;
        if (variant === "A") {
          // PR #3 translator: same prompt without context, request body without options.
          const prompt = bg.buildChunkPrompt(chunk, lang);
          items = bg.parseTranslations(await bg.callOpenAiCompatible("nvidia", ring.current(), MODEL, prompt));
        } else {
          items = await bg.translateChunk("nvidia", ring, MODEL, chunk, lang, context);
        }
        for (const t of items) out.set(Number(t.id), String(t.fa || "").trim());
      } catch (err) {
        failed++;
        console.error(variant + " chunk failed: " + String(err?.message || err).replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-***").slice(0, 120));
      }
    }
  };
  await Promise.all(Array.from({ length: TRANSLATE_CONCURRENCY }, worker));
  const missing = cues.filter((c) => !out.get(Number(c.id))).length;
  return { map: out, failed, missing };
}

const fmtT = (s) => {
  const m = Math.floor(s / 60);
  return m + ":" + (s - m * 60).toFixed(1).padStart(4, "0");
};
const pct = (x) => (x * 100).toFixed(1) + " %";

async function main() {
  const file = process.argv[2];
  const outDir = arg("--out", null);
  const key = (process.env.NVIDIA_API_KEY || "").trim();
  if (!file || file.startsWith("--") || !outDir) throw new Error("usage: word-timing-eval.js <file.json3> --out <dir>");
  if (!key) throw new Error("NVIDIA_API_KEY is not set");
  const translate = !process.argv.includes("--no-translate");
  const lang = LANGS[arg("--lang", "zh-TW")];
  const raw = loadRaw(file);
  const bg = loadBackground({ fetchImpl: (url, init) => fetch(url, init) }).ctx;
  const callModel = (prompt, options) => bg.callOpenAiCompatible("nvidia", key, MODEL, prompt, {
    ...options,
    extraBody: { chat_template_kwargs: { enable_thinking: false } }
  });

  const runs = {};
  for (const variant of ["A", "B"]) {
    const config = { splitAtSentenceEnds: variant === "B" };
    console.error("preprocessing " + variant + " ...");
    const { workfile, report } = await CP.preprocessWorkfile(raw, { callModel, config });
    runs[variant] = { workfile, report, m: metrics(raw, workfile, report) };
  }
  const rawM = { cues: raw.cues.length, twoSentenceCues: raw.cues.filter((c) => SENTENCE_THEN_MORE.test(c.source)).length / raw.cues.length };

  if (translate) {
    for (const variant of ["A", "B"]) {
      console.error("translating " + variant + " ...");
      const t0 = Date.now();
      const context = runs[variant].workfile.caption_preprocessing?.profile || null;
      runs[variant].tr = await translateAll(bg, key, runs[variant].workfile.cues, lang, variant, context);
      runs[variant].tr.ms = Date.now() - t0;
    }
  }

  const B = runs.B.m;
  const checks = [
    ["B cue start/end = raw boundary or word time", B.boundariesFromRawTimes, ">=", THRESHOLDS.boundariesFromRawTimes],
    ["B words equal raw words (no corrections) or validated with corrections", B.wordsEqual === false ? 0 : 1, ">=", 1],
    ["B cues with two sentences", B.twoSentenceCues, "<=", THRESHOLDS.twoSentenceCues],
    ["B cues longer than 7 s", B.longCues, "<=", THRESHOLDS.longCues],
    ["B fallback chunks", B.fallbackChunks, "<=", THRESHOLDS.fallbackChunks]
  ].map(([name, value, op, limit]) => ({ name, value, op, limit, pass: op === ">=" ? value >= limit - 1e-9 : value <= limit + 1e-9 }));

  const L = [];
  L.push("# Word-timed segmentation A/B: " + path.basename(file));
  L.push("");
  L.push("model " + MODEL + ", raw cues " + raw.cues.length + " (two-sentence share " + pct(rawM.twoSentenceCues) + ")");
  L.push("");
  L.push("| metric | A (PR #3) | B (this branch) |");
  L.push("|---|---|---|");
  const row = (name, f) => L.push("| " + name + " | " + f(runs.A) + " | " + f(runs.B) + " |");
  row("result", (r) => r.m.reason + " (" + r.m.warnings + ")");
  row("cues", (r) => String(r.m.cues));
  row("raw cues split", (r) => String(r.m.split));
  row("two-sentence cues", (r) => pct(r.m.twoSentenceCues));
  row("cues > 7 s", (r) => pct(r.m.longCues));
  row("start/end from raw times", (r) => pct(r.m.boundariesFromRawTimes));
  row("words equal raw", (r) => (r.m.wordsEqual === null ? "n/a (" + r.m.corrections + " corrections)" : String(r.m.wordsEqual)));
  row("fallback chunks", (r) => r.m.chunks + " (" + pct(r.m.fallbackChunks) + ")");
  row("preprocessing requests / time", (r) => r.m.requests + " / " + (r.m.elapsedMs / 1000).toFixed(1) + " s");
  if (translate) {
    row("translation failed chunks / missing lines", (r) => r.tr.failed + " / " + r.tr.missing);
    row("translation time", (r) => (r.tr.ms / 1000).toFixed(1) + " s");
  }
  L.push("");
  L.push("## Threshold checks (B)");
  L.push("");
  for (const c of checks) L.push("- " + (c.pass ? "PASS" : "FAIL") + " " + c.name + ": " + (c.value <= 1 ? pct(c.value) : c.value) + " " + c.op + " " + pct(c.limit));
  L.push("");

  if (translate) {
    L.push("## Side by side (by time)");
    L.push("");
    L.push("| time | A source | A translation | B source | B translation |");
    L.push("|---|---|---|---|---|");
    const esc = (s) => String(s || "").replace(/\|/g, "\\|");
    const A = runs.A.workfile.cues;
    for (const b of runs.B.workfile.cues) {
      const overlapping = A.filter((a) => a.start < b.end && a.end > b.start);
      const first = overlapping[0];
      L.push("| " + fmtT(b.start) + "–" + fmtT(b.end) + " | " +
        esc(first ? overlapping.map((a) => a.source).join(" / ") : "") + " | " +
        esc(overlapping.map((a) => runs.A.tr.map.get(Number(a.id)) || "(missing)").join(" / ")) + " | " +
        esc(b.source) + " | " + esc(runs.B.tr.map.get(Number(b.id)) || "(missing)") + " |");
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "ab.md"), L.join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "ab.json"), JSON.stringify({
    metrics: { raw: rawM, A: runs.A.m, B: runs.B.m },
    checks,
    profile: runs.B.workfile.caption_preprocessing?.profile || null,
    A: { cues: runs.A.workfile.cues, translations: runs.A.tr ? Object.fromEntries(runs.A.tr.map) : null },
    B: { cues: runs.B.workfile.cues, translations: runs.B.tr ? Object.fromEntries(runs.B.tr.map) : null }
  }, null, 2));
  // stdout: metrics only, no transcript text
  process.stdout.write(L.slice(0, L.indexOf("## Side by side (by time)") > 0 ? L.indexOf("## Side by side (by time)") : L.length).join("\n") + "\n");
  if (checks.some((c) => !c.pass)) process.exit(1);
}

main().catch((err) => {
  console.error("eval failed: " + String(err?.message || err).replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-***"));
  process.exit(2);
});
