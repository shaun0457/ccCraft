# Word-timed segmentation and translator context

Follow-up to [the T1–T3 report](README.md). A real 27-minute clip (YouTube ASR json3, English) showed that
YouTube's automatic captions often already carry punctuation, and that the main readability problem is line
breaks by length: one raw line often holds the end of one sentence and the start of the next
(`benefit from it. Let's dive in. First,`). The T2 design could not split such a line because `parseJson3`
dropped the per-word offsets (`tOffsetMs`). json3 has them for 647 of the clip's 685 lines.

## Scope

- `parseJson3` keeps per-segment times as `cues[].words = [[text, seconds], ...]` (absolute, 3 decimals), only
  when the segments carry offsets and their joined text equals the cue text. XML/VTT cues get no `words`.
- Preprocessing splits a unit at a sentence end (`.`, `?`, `!`) inside it, using those times, before the
  model groups units. A split piece starts at the time of its first word; it ends where the next piece
  starts, or at the cue end. No time is invented.
- `chunkSize` counts raw cues: the pieces of a split cue count once and stay in one chunk, so splitting adds no
  reconstruction requests.
- After the model groups units, a group is cut after a unit that ends a sentence when the text since the last cut and
  the next sentence each last at least `sentenceCutMinSeconds` (1.2 s); a shorter sentence stays with the one before
  it. Reason: on the real clip the model merged most split pieces back together (run 2 below).
- The translator prompt gets the context profile (topic, terms, proper nouns) of a preprocessed workfile,
  and, when preprocessing ran (its gate selected a Nemotron model), translation requests send
  `chat_template_kwargs: {enable_thinking: false}`; all other translation requests keep the old body (Q1).
- Out of scope: splitting at commas; splitting cues without word times; splitting where the model adds a
  sentence end that the raw text lacks; other providers' request bodies; the overlay.
- Edge behaviour: a unit whose rolling prefix was removed keeps no word times (not split); word times that
  are not strictly increasing or fall outside the cue keep the unit whole; a split piece covers the same raw
  cue id as its siblings, so `source_ids` may repeat an id across consecutive output cues.

## LLM call design (rules/coding.md)

- Division of labour: the split points, times, ids, order, coverage, lengths and durations are computed by
  code. The model still only groups unit ids and restores punctuation; its output is checked exactly as
  before (id coverage, LCS alignment, correction limits). The profile passed to the translator is the
  sanitized profile (≤ 30 items per list, ≤ 80 chars each, topic ≤ 200 chars) and is marked reference-only.
- Failure detection: unchanged for preprocessing. Translation: unchanged (positional fallback, retries).
- On failure: unchanged; any preprocessing failure returns the original workfile, which has no profile, so
  the translator prompt is then byte-identical to before.
- Thresholds (checked by `tests/word-timing-eval.js` on the real clip, written before the run):
  - every output cue's start and end is a raw cue boundary or a raw word time: 100 %;
  - the output words equal the raw words except accepted corrections: 100 % (validated in code);
  - cues with a sentence end followed by more words ("two sentences in one cue"): ≤ 5 % in B,
    against the raw track as the baseline;
  - cues longer than 7 s: ≤ 2 %;
  - chunks that fell back to raw cues: ≤ 10 %.

## Data handling

The real clip is a third-party video. Its transcript stays in a local scratch folder and is not
committed; the repo keeps only synthetic fixtures and short excerpts in reports.

## Live runs (real clip, 685 raw cues, 34.6 % of them hold two sentences)

`node tests/word-timing-eval.js <clip.json3> --out <scratch dir>`, A = PR #3, B = this branch, same model.

| run | change | B two-sentence cues | B fallback chunks | note |
|---|---|---|---|---|
| 1 | split only | 7.0 % | 10/24 | 24 chunks ran out of the 180 s budget |
| 2 | + chunkSize counts raw cues | 23.4 % | 0/18 | the model merged split pieces back (A: 61.6 %) |
| 3 | + sentence cut in groups (1.2 s) | 6.6 % | 3/18 | NVIDIA HTTP 429 and timeouts |
| 4 | same as 3 | 2.9 % | 7/18 | NVIDIA HTTP 429 throughout; not valid |

Start/end from raw times stayed at 100 % and cues over 7 s at 0 % in every run. Run 2's side-by-side showed A's
translations shifted by one line in several places (the translation of the next line); B's were aligned. A clean run
of the final version has not happened yet: the free NVIDIA quota was exhausted by runs 3 and 4.
