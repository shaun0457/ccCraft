# Caption preprocessing (T1–T3 report)

The plan is in [DEVELOPMENT_PLAN.md](../../DEVELOPMENT_PLAN.md). This page covers what was built, how to use it and how it
was checked. Evidence: [live run](live-run-2026-11-25.md) (real Nemotron) and [mock run](mock-run.md) (scripted replies,
offline, reproducible).

## What it does

```
content.js buildWorkfile ──► popup ──► background.js translateWorkfile
                                          │
                                          ├─ preprocessForTranslation()      ← new, src/caption-preprocessing.js
                                          │    automatic track + NVIDIA Nemotron only, otherwise bypassed
                                          ▼
                                       existing chunking / prompt / retry ──► LOAD_TRANSLATED_JSON ──► overlay
```

Steps inside `preprocessWorkfile` (with `callModel` passed in; the module itself makes no network calls):

1. **Normalize** (deterministic). Collapses whitespace. Removes rolling-caption duplicates only when the cues are timing-adjacent
   and the duplicate is exact: either a short repeat (≤ 0.3 s) or a prefix of at least 3 words. Legitimate repetitions stay.
2. **Global context** (1 request). The whole transcript goes in when it is under 48,000 characters. Longer transcripts go in as 4
   evenly spaced excerpts of 12,000 characters, flagged `context_sampled`, so nothing is cut off without notice. The reply is a
   short profile: topic, terms, proper nouns, likely ASR confusions. If this request fails, reconstruction runs without it.
3. **Reconstruction** (1 request per 40 cues, 3 in parallel). Each request carries 3 read-only neighbour lines on each side
   and the shared profile. It returns `{groups:[{ids, text, corrections[]}]}`. The transcript is fenced as data, and the model
   produces no timestamps or translations.
4. **Deterministic validation and alignment**:
   - ids must cover the chunk completely and in order: none missing, duplicated, reordered or invented. Otherwise the chunk
     is retried once, then keeps its original cues.
   - The model's text is aligned to the raw words with one LCS per chunk. A difference is accepted only if it is a
     substitution listed in `corrections`, at most 3 words on each side, with the same negation and the same digits, and
     within 20% of the group's words. Every other difference is reverted to the raw words. The output's words are therefore
     always the raw words plus accepted corrections. A group with more than 34% unlisted changes keeps its raw text.
   - Words the model wrote into a neighbouring group are mapped back to their own cue, and the two groups are merged.
   - Before grouping, a cue with json3 word times is split after each inner sentence end, at the next word's real time
     ([word-timed-segmentation.md](word-timed-segmentation.md)); cues without word times are never split. Groups are cut at cue boundaries to respect
     a 7 s / 140-character limit, plus a hard break at any > 0.7 s gap, `>>` speaker change or `[sound]` tag. Cut points
     prefer sentence ends, then clause punctuation, then the most even split.
   - Each merged cue takes the first raw start and the last raw end. Ids are renumbered 1..n, and timestamps use the same
     format as `content.js`. The final check covers every raw id in order (a split cue's id may appear in consecutive
     output cues, and nowhere else), plus finite, ordered, non-overlapping times.
5. **Output**: the same `cccraft-subtitle-v1.1` workfile, as a clone. Two additive fields are added: `cues[].source_ids`
   (the raw mapping) and `caption_preprocessing` (corrections and reverted or rejected edits, for review).
   `extractTranslatedCues` ignores both; `buildChunkPrompt` reads only `caption_preprocessing.profile` (reference-only
   video context, see [word-timed-segmentation.md](word-timed-segmentation.md)). Any failure (timeout, HTTP error, invalid output, the 180 s
   budget used up) returns the **original workfile object** and shows a warning in the popup.

Untouched: chunking, retry, cache and storage, the overlay, manual import/export, other providers. (`parseJson3` later
gained `cues[].words`; manual export strips it, so exported files keep the old format.)
`callOpenAiCompatible` gained an optional `options` argument; without it the request body is byte-identical to the old
one (tested). Later change ([word-timed-segmentation.md](word-timed-segmentation.md)): the translation prompt gains a
"Video context" section when the workfile has a profile, and Nemotron translation requests turn thinking off.

## Use, opt out, reload

- It runs automatically when the selected track is **auto-generated** (`kind: "asr"`), the provider is **NVIDIA NIM**, and the
  model name contains `nemotron` (for example `nvidia/nemotron-3-ultra-550b-a55b`). The popup shows "Reconstructing
  automatic captions…" and then "Automatic captions reconstructed before translation: N → M lines".
- Preprocessing requests send `chat_template_kwargs: {enable_thinking: false}`. Nemotron reasoning tokens count against
  `max_tokens`, and NVIDIA documents this switch for the model.
- **Opt out**: open the service worker console (`chrome://extensions` → ccCraft → "service worker") and run
  `chrome.storage.local.set({ ccCraftCaptionPreprocessing: { enabled: false } })`. To turn it back on, run
  `chrome.storage.local.remove("ccCraftCaptionPreprocessing")`.
- **Reload after updating**: `chrome://extensions` → ccCraft → reload (↻), then refresh the YouTube tab. In Firefox, reload the
  temporary add-on: `manifest.json` now lists `src/caption-preprocessing.js` before `src/background.js`.

## T1: boundary and baseline

- The integration anchors in the plan still match HEAD `93682b1`: `parseJson3` at content.js:467, `fixCueTiming` at
  content.js:626, `buildWorkfile` at content.js:684, `translateWorkfile` at background.js:216 and `callOpenAiCompatible` at
  background.js:125.
- The track kind reaches the workfile as `source_track.kind` (`"asr"` for automatic tracks, from inject-main.js:136).
- No real clip was exported: this session had no browser run of the extension. A sanitized synthetic clip in YouTube ASR
  json3 structure stands in for it: `tests/fixtures/auto-captions-technical.json3` (60 s, 27 lines, with per-word
  `tOffsetMs` segs, `aAppend` newline events and overlapping display durations). It was parsed with the real
  `parseJson3` and `fixCueTiming` extracted from content.js. Baseline output: `tests/fixtures/auto-captions-technical.baseline.json`.
- Findings that shaped the design:
  - `parseJson3` joins `segs` and drops `tOffsetMs`, so no word timing is available, and splitting a cue mid-text would mean
    making up timestamps. Chosen: cues stay whole, and no parser change. (Superseded: `parseJson3` now keeps the offsets
    as `cues[].words`, see [word-timed-segmentation.md](word-timed-segmentation.md).)
  - ASR json3 display durations overlap the next line, and `fixCueTiming` trims each end to the next start. **For json3,
    pauses do not show up as gaps.** The 0.7 s gap rule only applies to XML/VTT fallbacks. `[Music]` tags and `>>` still give
    hard breaks.

## T2: tests

`node --test tests/*.test.js`: **46 passed, 0 failed**. These tests use a mock model, need no key, and finish in under 1 s.
They cover a sentence split across cues (the plan's 101/102 example), two sentences inside one cue (not split, continuation
not invented), rolling duplicates, legitimate repetitions, technical identifiers and numbers, a long pause and a speaker
change, ambiguous ASR (accepted, unlisted, negating, too-large and too-many corrections), malformed, missing, duplicate,
reordered and invented model ids, invalid JSON then a valid retry, a single failing chunk, a timeout, the budget running
out, HTTP errors reduced to codes, a failed context request, sampling of long transcripts, prompt injection, immutable input
and the output contract. The integration tests run the real background.js in a vm, loading the module through the same
`importScripts` call. Firefox loading is also covered: the manifest's `background.scripts` are loaded in order with no
`importScripts`. They check that the translator request body is byte-identical, cover the bypass for manual tracks,
other providers, non-Nemotron models and the opt-out flag, and test fallback when the API rejects the key (keys rotate,
translation still runs, the warning is visible).

## T3: before/after (A = original ccCraft, B = with preprocessing)

The same clip, track, model (`nvidia/nemotron-3-ultra-550b-a55b`), target language (zh-TW) and translator code for A and B
(`tests/preprocess-demo.js` calls the extension's own `translateChunk`). Full output: [live-run-2026-11-25.md](live-run-2026-11-25.md).

| | A | B |
|---|---|---|
| Lines sent to the translator | 27 fragments | 12 cues, all 27 raw ids mapped |
| Preprocessing cost | – | 2 requests, 11.4 s (4 live runs: 11.4–12.7 s, always 2 requests) |
| Translation cost (this clip) | 1 request | 1 request |

Examples (live run 4, translations verbatim):

| Time | A (one line per raw cue) | B |
|---|---|---|
| 26.2–30.1 | `>> 快速提問：那能搭配` / `GitHub Actions 嗎` | `>> 快速提問：這能搭配 GitHub Actions 嗎？` |
| 16.6–22.0 | `我們把它放在 repo 裡，旁邊是` / `README` | `我們把它放在 repo 裡，就在 readme 旁邊。` |
| 47.8–53.9 | `你就可以推送` / `不不不，別直接推到 main` / `改開 pull request` | `可以推送。不、不、別直接推到 main。改開 pull request。` |
| 0.12–5.62 | `所以今天我想帶大家了解如何` / `我們如何設定專案文件` / `所以如果你看看` | `今天我要帶大家看看我們怎麼設定專案文件。如果你看這裡的` |

Ratings (0–5). These are my judgement on this synthetic clip, not measurements:

| | Readability | Semantic faithfulness | Terminology | Synchronization |
|---|---|---|---|---|
| A | 2 | 4 | 4 | 4 |
| B | 4 | 4 | 4 | 4 |

- Readability improved: complete sentences instead of dangling fragments like "旁邊是 / README".
- Faithfulness did not change. The existing translator already uses neighbouring lines (prompt rule 5), so A's meaning was
  mostly right. B still has one clause break that A also has ("如果你看這裡的 / vision.md"), because raw cue 4 holds both a
  sentence end and the next sentence's start and cannot be split without word timing.
- Terminology: the translator fixed "get hub"/"pie test" in A as well. B fixes them in the source text too, which matters for
  "show original" and word lookup.
- Synchronization: the cue boundaries are the original ones (no drift, no made-up times), but the cues are coarser (up to
  6.8 s), so text can appear before it is spoken.

The model's behaviour varies between runs (temperature 0.2): 4 live runs produced 14, 13, 13 and 12 cues. Seen in the live
runs and handled by the deterministic checks:

- the model moved words into a neighbouring group ("GitHub Actions?"): mapped back and merged;
- unlisted rewrites (".github/workflows"): reverted;
- groups that crossed a `>>` speaker change (live run 1): split there.

## Limitations and what was not verified

- **Not run**: a browser test in Chrome (seek, pause, gaps and boundaries on the real overlay) and a real 3–5 minute YouTube
  clip. Both need the unpacked extension in a browser, which this session could not drive. All results above come from the
  synthetic 60 s clip.
- No audio is used, so corrections are only "context-supported". The model may still accept a plausible wrong term if it
  lists it as a correction within the limits.
- Pauses inside json3 tracks are not detected (see T1), so a group can span a silence of up to the 7 s limit.
- The hosted endpoint's context and output limits are not documented. The model card lists 1M context (256K native), and
  this layer stays far below that (≤ 48k characters of context, `max_tokens` 8192).
- There is no cap on the number of reconstruction requests (one per 40 cues). For a very long video the 180 s budget bounds
  them: chunks still pending when the budget runs out keep their original cues, so a long video can be only partly
  reconstructed.
- Languages that don't separate words with spaces (for example Chinese or Japanese automatic captions) are not supported.
  The gate does not exclude them. Words are compared by whitespace, so such text is mostly kept as raw (no words lost), and
  grouped cues are joined with spaces. In other non-English automatic captions, punctuation outside the fixed set (`¿`,
  `¡`, `„`, `،`, `؟`, `--` used as a dash) is treated as an unlisted change and reverted. Such groups often keep their raw
  text, so reconstruction helps less there, though nothing is lost or reordered.
- The plan's known risk is unchanged and not addressed here: `parseTranslationsPositional` assigns ids by position. Fewer,
  longer cues are not claimed to fix it.
