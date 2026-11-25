# Caption preprocessing: before/after

- input: auto-captions-technical.json3 (27 raw cues, track kind asr)
- mode: MOCK (scripted replies from tests/fixtures/mock-nemotron-responses.json, not real model output)
- result: applied, 27 -> 16 cues, 3 corrections accepted, 1 changes reverted, 0 group texts rejected
- preprocessing requests: 2, runtime: n/a (mock)

## A: what the translator receives today

```
  0.12   2.39  1| so today I want to walk you through how
  2.39   4.10  2| we set up the project docs
  4.10   5.62  3| so if you look at the
  5.62   8.05  4| vision.md here and if you're going to
  8.05  10.40  5| build something with it you need to keep
 10.40  11.90  6| this file short
 11.90  14.30  7| the second file is the road map which
 14.30  16.60  8| lists the milestones for version 2.1
 16.60  18.70  9| and we keep it in the repo next to
 18.70  22.00  10| the readme
 22.00  26.20  11| [Music]
 26.20  28.50  12| >> quick question does that work with
 28.50  30.10  13| get hub actions
 30.10  32.60  14| >> yes it does you just add a workflow
 32.60  35.00  15| file under dot github slash workflows
 35.00  37.20  16| and it runs on every pull request
 37.20  39.10  17| you don't need to install anything
 39.10  41.00  18| else it's not that hard
 41.00  43.40  19| the first step is to run npm install
 43.40  45.60  20| then npm test and if the tests pass
 45.60  47.80  21| and pie test for the python part
 47.80  49.00  22| you can push
 49.00  51.60  23| no no no don't push to main directly
 51.60  53.90  24| open a pull request instead
 53.90  55.30  25| thank you
 55.30  57.00  26| thank you
 57.00  60.20  27| see you in the next video
```

## B: what the translator receives after preprocessing

```
  0.12   4.10  1| So today I want to walk you through how we set up the project docs.    <- raw 1,2
  4.10   8.05  2| So if you look at the vision.md here. And if you're going to    <- raw 3,4
  8.05  11.90  3| build something with it, you need to keep this file short.    <- raw 5,6
 11.90  16.60  4| The second file is the roadmap, which lists the milestones for version 2.1,    <- raw 7,8
 16.60  22.00  5| and we keep it in the repo next to the README.    <- raw 9,10
 22.00  26.20  6| [Music]    <- raw 11
 26.20  30.10  7| >> Quick question: does that work with GitHub Actions?    <- raw 12,13
 30.10  35.00  8| >> Yes, it does. You just add a workflow file under dot github slash workflows    <- raw 14,15
 35.00  37.20  9| and it runs on every pull request.    <- raw 16
 37.20  41.00  10| You don't need to install anything else. It's not that hard.    <- raw 17,18
 41.00  45.60  11| The first step is to run npm install, then npm test, and if the tests pass    <- raw 19,20
 45.60  49.00  12| and pytest for the Python part, you can push.    <- raw 21,22
 49.00  51.60  13| No, no, no, don't push to main directly.    <- raw 23
 51.60  53.90  14| Open a pull request instead.    <- raw 24
 53.90  57.00  15| Thank you. Thank you.    <- raw 25,26
 57.00  60.20  16| See you in the next video.    <- raw 27
```

## Corrections and rejections

- accepted, raw 7: "road map" -> "roadmap" (single word in software planning)
- accepted, raw 13: "get hub" -> "GitHub" (product name; GitHub is mentioned later)
- accepted, raw 21: "pie test" -> "pytest" (Python test runner)
- reverted in raw 15: correction_too_large, kept "dot github slash workflows" instead of ".github/workflows,"

Translations: live mode only (set NVIDIA_API_KEY).
