// Run: node --test tests/*.test.js
// While a translation runs, the background rewrites its status every 20 s, so the popup does not
// call a slow but live run "interrupted" (it does after 3 minutes without an update).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground } = require("./helpers/load-extension.js");

const VIDEO = "beat-video";
const STATUS = "ccCraftTranslateStatus:" + VIDEO;
const lang = { code: "zh-TW", promptName: "Traditional Chinese (Taiwan)", dir: "ltr" };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const chat = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

function workfile(count = 10) {
  const cues = [];
  for (let i = 1; i <= count; i++) cues.push({ id: i, start: i, end: i + 0.9, source: "line " + i, fa: "" });
  return { video: { id: VIDEO }, source_track: { languageCode: "en", kind: "manual", vssId: ".en" }, cues };
}

// A background whose only translation request waits until released, with a hand-driven interval.
function slowRun() {
  let release;
  const fetchImpl = (url, init) => {
    const user = JSON.parse(init.body).messages[1].content;
    const ids = [...user.matchAll(/^(\d+)\| /gm)].map((m) => m[1]);
    return new Promise((resolve) => { release = () => resolve(chat(ids.map((id) => id + "| 譯" + id).join("\n"))); });
  };
  const env = loadBackground({ fetchImpl });
  const intervals = [];
  env.ctx.setInterval = (fn, ms) => { const h = { fn, ms, cleared: false }; intervals.push(h); return h; };
  env.ctx.clearInterval = (h) => { if (h) h.cleared = true; };
  const beat = async () => {
    for (const h of intervals) if (!h.cleared) h.fn();
    await tick();
  };
  const run = env.ctx.translateWorkfile({ workfile: workfile(), provider: "gpt", apiKey: "k", model: "m", tabId: 1, lang });
  return { ...env, intervals, beat, run, release: () => release() };
}

test("a request that takes long still refreshes updated_at, keeping the same progress", async () => {
  const r = slowRun();
  try {
    for (let i = 0; i < 100 && !r.store[STATUS]; i++) await tick();
    const first = r.store[STATUS];
    assert.equal(first.state, "running");
    assert.equal(r.intervals.length, 1);
    assert.equal(r.intervals[0].ms, 20000);

    await tick(10);
    await r.beat();
    const second = r.store[STATUS];
    assert.ok(second.updated_at > first.updated_at, "updated_at moved on");
    const { updated_at: a, ...restFirst } = first;
    const { updated_at: b, ...restSecond } = second;
    assert.deepEqual(restSecond, restFirst, "nothing but the time changes");
  } finally {
    r.release();
    await r.run;
  }
});

test("the heartbeat stops when the run ends and never turns a finished status back to running", async () => {
  const r = slowRun();
  for (let i = 0; i < 100 && !r.store[STATUS]; i++) await tick();
  r.release();
  await r.run;
  assert.equal(r.store[STATUS].state, "done");
  assert.ok(r.intervals.every((h) => h.cleared), "interval cleared");
  for (const h of r.intervals) h.fn(); // a late tick that was already queued
  await tick();
  assert.equal(r.store[STATUS].state, "done");
});

test("a run that fails stops its heartbeat too", async () => {
  const env = loadBackground({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  const intervals = [];
  env.ctx.setInterval = (fn, ms) => { const h = { fn, cleared: false }; intervals.push(h); return h; };
  env.ctx.clearInterval = (h) => { h.cleared = true; };
  env.ctx.setTimeout = (fn, ms) => setTimeout(fn, ms >= 10000 ? ms : 0); // skip retry pauses
  await env.ctx.translateWorkfile({ workfile: workfile(), provider: "gpt", apiKey: "k", model: "m", tabId: 1, lang });
  assert.equal(env.store[STATUS].state, "error");
  assert.ok(intervals.length === 1 && intervals[0].cleared);
  intervals[0].fn();
  await tick();
  assert.equal(env.store[STATUS].state, "error");
});

test("a status write that fails inside the heartbeat does not break the run", async () => {
  const r = slowRun();
  try {
    for (let i = 0; i < 100 && !r.store[STATUS]; i++) await tick();
    const local = r.ctx.chrome.storage.local;
    const set = local.set;
    local.set = async () => { throw new Error("QUOTA_BYTES quota exceeded"); };
    await r.beat();
    local.set = set;
  } finally {
    r.release();
    await r.run;
  }
  assert.equal(r.store[STATUS].state, "done");
});

test("a run with no status of its own for 5 minutes is no longer kept alive", async () => {
  const r = slowRun();
  let now = Date.now();
  const RealDate = Date;
  r.ctx.Date = class extends RealDate { static now() { return now; } };
  try {
    for (let i = 0; i < 100 && !r.store[STATUS]; i++) await tick();

    now += 4 * 60 * 1000 + 59 * 1000; // 4:59 without progress: still alive
    await r.beat();
    assert.equal(r.store[STATUS].updated_at, now);

    now += 1000; // 5:00: the request is taken as stuck
    const before = r.store[STATUS].updated_at;
    await r.beat();
    now += 60 * 1000;
    await r.beat();
    assert.equal(r.store[STATUS].updated_at, before, "no more heartbeat writes");
  } finally {
    r.release();
    await r.run;
  }
  assert.equal(r.store[STATUS].state, "done", "a late answer still finishes the run");
});

test("after a stall the heartbeat resumes when the run reports progress", async () => {
  const VIDEO2 = "beat-resume";
  const KEY2 = "ccCraftTranslateStatus:" + VIDEO2;
  const env = loadBackground({ fetchImpl: async () => chat("") });
  const intervals = [];
  env.ctx.setInterval = (fn) => { const h = { fn, cleared: false }; intervals.push(h); return h; };
  env.ctx.clearInterval = (h) => { h.cleared = true; };
  let now = 1000000;
  const RealDate = Date;
  env.ctx.Date = class extends RealDate { static now() { return now; } };
  const stop = env.ctx.startStatusHeartbeat(VIDEO2);
  await env.ctx.setStatus(VIDEO2, { state: "running", done: 1, total: 9 });
  now += 6 * 60 * 1000;
  intervals[0].fn();
  await tick();
  assert.equal(env.store[KEY2].updated_at, 1000000, "stalled: no write");
  await env.ctx.setStatus(VIDEO2, { state: "running", done: 2, total: 9 });
  now += 20 * 1000;
  intervals[0].fn();
  await tick();
  assert.equal(env.store[KEY2].updated_at, now, "writes again after progress");
  assert.equal(env.store[KEY2].done, 2);
  stop();
  assert.ok(intervals[0].cleared);
});
