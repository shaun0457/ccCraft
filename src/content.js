const MAIN_REQ = "cccraft-req";
const MAIN_RES = "cccraft-res";

let faCues = [];
let settings = {
  fontSize: 24,
  bottom: 12,
  enabled: true,
  color: "#ffffff",
  showOriginal: false,
  languageLearning: false
};

let lastVideoId = null;
let subsDir = "rtl";
let flashUntil = 0;
let origLang = "en";
let userLang = "fa";
let hoverTimer = null;
let pausedByLearning = false;
let currentAudio = null;

function getVideoId() {
  const url = new URL(location.href);
  return url.searchParams.get("v") || "unknown-video";
}

function getWatchUrl() {
  const id = getVideoId();
  return id === "unknown-video" ? location.href : `https://www.youtube.com/watch?v=${id}`;
}

function getVideoTitle() {
  return (
    document.querySelector("h1 yt-formatted-string")?.textContent?.trim() ||
    document.querySelector("h1.title")?.textContent?.trim() ||
    document.title.replace(/\s*-\s*YouTube\s*$/i, "").trim() ||
    "youtube-video"
  );
}

function safeFilename(name) {
  return String(name || "youtube-video")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function getVideoDuration() {
  const video = document.querySelector("video");
  return video && Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : null;
}

function requestMain(type, payload = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const reqId = `cccraft_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    const onMessage = (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.channel !== MAIN_RES || data.reqId !== reqId) return;

      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(data);
    };

    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve({ ok: false, error: "Timed out talking to the YouTube page bridge. Refresh the page." });
    }, timeoutMs);

    window.addEventListener("message", onMessage);
    window.postMessage({ channel: MAIN_REQ, type, reqId, ...payload }, "*");
  });
}

function injectOverlay() {
  const player =
    document.querySelector(".html5-video-player") ||
    document.querySelector("#movie_player") ||
    document.querySelector("ytd-player");

  if (!player) return null;

  let overlay = document.getElementById("cccraft-subtitle-overlay");

  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "cccraft-subtitle-overlay";
    overlay.textContent = "";
    player.appendChild(overlay);
  }

  player.classList.toggle("cccraft-on", Boolean(settings.enabled && faCues.length));
  applySettings(settings);

  return overlay;
}

function setOverlayText(overlay, main, orig) {
  let mainEl = overlay.querySelector(".cccraft-main");
  let origEl = overlay.querySelector(".cccraft-orig");

  if (!mainEl || !origEl) {
    overlay.textContent = "";
    mainEl = document.createElement("div");
    mainEl.className = "cccraft-main";
    origEl = document.createElement("div");
    origEl.className = "cccraft-orig";
    overlay.appendChild(mainEl);
    overlay.appendChild(origEl);
    attachLearningEvents(origEl);
  }

  const mainText = main || "";

  if (mainEl.dataset.text !== mainText) {
    mainEl.dataset.text = mainText;
    mainEl.textContent = mainText;
  }

  const origText = orig || "";
  const origKey = (settings.languageLearning ? "1|" : "0|") + origText;

  if (origEl.dataset.key !== origKey) {
    origEl.dataset.key = origKey;
    renderOrigLine(origEl, origText);
  }

  origEl.classList.toggle("hidden", !origText);
}

function renderOrigLine(origEl, text) {
  origEl.textContent = "";

  if (!settings.languageLearning || !text) {
    origEl.textContent = text;
    return;
  }

  const tokens = text.split(/\s+/).filter(Boolean);

  tokens.forEach((token, index) => {
    const span = document.createElement("span");
    span.className = "cccraft-word";
    span.textContent = token;
    origEl.appendChild(span);

    if (index < tokens.length - 1) {
      origEl.appendChild(document.createTextNode(" "));
    }
  });
}

function cleanWord(token) {
  return String(token || "").replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
}

function getTooltipEl() {
  const player = document.querySelector(".html5-video-player") || document.querySelector("#movie_player");
  if (!player) return null;

  let tip = document.getElementById("cccraft-tooltip");

  if (!tip) {
    tip = document.createElement("div");
    tip.id = "cccraft-tooltip";
    tip.className = "hidden";
    player.appendChild(tip);
  }

  return tip;
}

function hideWordTooltip() {
  const tip = document.getElementById("cccraft-tooltip");
  if (tip) tip.classList.add("hidden");
}

async function showWordTooltip(span) {
  const word = cleanWord(span.textContent);
  if (!word) return;

  const tip = getTooltipEl();
  if (!tip) return;

  const playerRect = tip.parentElement.getBoundingClientRect();
  const rect = span.getBoundingClientRect();

  if (!rect.width && !rect.height) return;

  tip.textContent = "\u2026";
  tip.classList.remove("hidden");
  tip.style.left = `${rect.left + rect.width / 2 - playerRect.left}px`;
  tip.style.top = `${rect.top - playerRect.top - 8}px`;
  tip.dataset.word = word;

  let res = null;

  try {
    res = await chrome.runtime.sendMessage({ type: "TRANSLATE_WORD", word, from: origLang, to: userLang });
  } catch (_) {}

  if (tip.dataset.word !== word || tip.classList.contains("hidden")) return;

  if (!res?.ok) {
    tip.textContent = res?.error || "Translation failed.";
    return;
  }

  tip.textContent = "";

  const meaning = document.createElement("div");
  meaning.className = "meaning";
  meaning.setAttribute("dir", "auto");
  meaning.textContent = res.translation || "\u2014";
  tip.appendChild(meaning);

  if (Array.isArray(res.dict) && res.dict.length) {
    const alts = document.createElement("div");
    alts.className = "alts";
    alts.setAttribute("dir", "auto");
    alts.textContent = res.dict.join(" \u00b7 ");
    tip.appendChild(alts);
  }

  const say = document.createElement("div");
  say.className = "say";
  say.textContent = "\ud83d\udd0a click the word to hear it";
  tip.appendChild(say);
}

function speakFallback(word, lang) {
  try {
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = lang || "en";
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  } catch (_) {}
}

function playWordAudio(word, lang) {
  if (!word) return;

  const url =
    "https://" + "translate.google.com/translate_tts" +
    "?ie=UTF-8&client=tw-ob" +
    "&tl=" + encodeURIComponent(lang || "en") +
    "&q=" + encodeURIComponent(word);

  try {
    if (currentAudio) currentAudio.pause();
    currentAudio = new Audio(url);
    currentAudio.play().catch(() => speakFallback(word, lang));
  } catch (_) {
    speakFallback(word, lang);
  }
}

function attachLearningEvents(origEl) {
  origEl.addEventListener("mouseover", (event) => {
    if (!settings.languageLearning) return;

    const span = event.target.closest?.(".cccraft-word");
    if (!span) return;

    const video = document.querySelector("video");

    if (video && !video.paused) {
      video.pause();
      pausedByLearning = true;
    }

    clearTimeout(hoverTimer);
    hideWordTooltip();
    hoverTimer = setTimeout(() => showWordTooltip(span), 200);
  });

  origEl.addEventListener("mouseleave", () => {
    clearTimeout(hoverTimer);
    hideWordTooltip();

    const video = document.querySelector("video");

    if (pausedByLearning && video) {
      video.play().catch(() => {});
      pausedByLearning = false;
    }
  });

  origEl.addEventListener("click", (event) => {
    if (!settings.languageLearning) return;

    const span = event.target.closest?.(".cccraft-word");
    if (!span) return;

    event.preventDefault();
    event.stopPropagation();
    playWordAudio(cleanWord(span.textContent), origLang);
  });
}

function applySettings(nextSettings) {
  settings = {
    fontSize: Number(nextSettings?.fontSize ?? settings.fontSize ?? 24),
    bottom: Number(nextSettings?.bottom ?? settings.bottom ?? 12),
    enabled: Boolean(nextSettings?.enabled ?? settings.enabled),
    color: String(nextSettings?.color ?? settings.color ?? "#ffffff"),
    showOriginal: Boolean(nextSettings?.showOriginal ?? settings.showOriginal),
    languageLearning: Boolean(nextSettings?.languageLearning ?? settings.languageLearning)
  };

  const overlay = document.getElementById("cccraft-subtitle-overlay");
  const player = document.querySelector(".html5-video-player") || document.querySelector("#movie_player");

  if (overlay) {
    overlay.style.setProperty("--cccraft-font-size", `${settings.fontSize}px`);
    overlay.style.setProperty("--cccraft-color", settings.color);
    overlay.style.setProperty("--cccraft-bottom", `${settings.bottom}%`);
    overlay.style.direction = subsDir;
    overlay.classList.toggle("learning", Boolean(settings.languageLearning));
    if (!settings.languageLearning) hideWordTooltip();
    overlay.classList.toggle("hidden", !settings.enabled);
  }

  if (player && !settings.enabled) {
    // وقتی نمایش زیرنویس افزونه خاموش است، CC خود یوتیوب همیشه آزاد باشد
    player.classList.remove("cccraft-on");
  }
}

function findActiveCue(time) {
  let left = 0;
  let right = faCues.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const cue = faCues[mid];

    if (time < cue.start) right = mid - 1;
    else if (time > cue.end) left = mid + 1;
    else return cue;
  }

  return null;
}

function renderLoop() {
  try {
    const currentId = getVideoId();

    if (currentId !== lastVideoId) {
      lastVideoId = currentId;
      loadStoredCues().catch(console.warn);
    }

    const video = document.querySelector("video");
    const overlay = injectOverlay();

    if (video && overlay) {
      let showingText = false;

      if (Date.now() < flashUntil) {
        // در حال نمایش پیام تایید موقت، متن را بازنویسی نکن
        overlay.classList.remove("empty");
        showingText = true;
      } else if (!settings.enabled) {
        setOverlayText(overlay, "", "");
        overlay.classList.add("empty");
      } else {
        const cue = findActiveCue(video.currentTime);
        const text = cue ? cue.text : "";
        const orig = (settings.showOriginal || settings.languageLearning) && cue ? cue.orig || "" : "";
        setOverlayText(overlay, text, orig);
        // وقتی متنی نیست، کل باکس مخفی شود (نه فقط بکگراند خالی)
        overlay.classList.toggle("empty", !text);
        showingText = Boolean(text);
      }

      // CC خود یوتیوب فقط همان لحظه‌ای مخفی شود که زیرنویس ترجمه‌شده روی صفحه است
      const playerEl = document.querySelector(".html5-video-player") || document.querySelector("#movie_player");
      if (playerEl) playerEl.classList.toggle("cccraft-on", showingText);
    }
  } catch (err) {
    // خطای یک فریم نباید حلقه نمایش را برای همیشه متوقف کند
  }

  requestAnimationFrame(renderLoop);
}

renderLoop();

async function loadInitialSettings() {
  const result = await chrome.storage.local.get({
    ccCraftSubtitleSettings: settings
  });

  applySettings(result.ccCraftSubtitleSettings);
}

async function loadStoredCues() {
  const key = `cccraftSubs:${getVideoId()}`;
  const metaKey = `cccraftSubsMeta:${getVideoId()}`;
  const result = await chrome.storage.local.get([key, metaKey]);
  faCues = Array.isArray(result[key]) ? result[key] : [];
  subsDir = result[metaKey]?.dir === "ltr" ? "ltr" : "rtl";
  origLang = result[metaKey]?.srcLang || origLang;

  const api = await chrome.storage.local.get("ccCraftApiSettings");
  userLang = api?.ccCraftApiSettings?.targetLang || userLang;

  applySettings(settings);
}

loadInitialSettings().catch(console.warn);
loadStoredCues().catch(console.warn);

function decodeHtml(text) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

function cleanText(text) {
  return decodeHtml(String(text || ""))
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function secondsToTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds) * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function urlWithFormat(urlValue, fmt) {
  const url = new URL(urlValue);
  if (fmt) url.searchParams.set("fmt", fmt);
  return url.toString();
}

async function readCaptionText(url, fmt) {
  const finalUrl = fmt ? urlWithFormat(url, fmt) : url;

  const response = await fetch(finalUrl, {
    credentials: "include",
    cache: "no-store"
  });

  const text = await response.text();

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!text || !text.trim()) throw new Error("empty response");

  return text;
}

function parseJson3(text) {
  let data;

  try {
    data = JSON.parse(text);
  } catch (_) {
    throw new Error("not json3");
  }

  const events = Array.isArray(data.events) ? data.events : [];
  const cues = [];
  let id = 1;

  for (const event of events) {
    if (!event.segs || event.tStartMs == null) continue;

    const source = cleanText(event.segs.map((seg) => seg.utf8 || "").join(""));
    if (!source) continue;

    const start = Number((Number(event.tStartMs) / 1000).toFixed(3));
    let duration = 2.5;

    if (event.dDurationMs != null && Number(event.dDurationMs) > 0) {
      duration = Number(event.dDurationMs) / 1000;
    }

    const end = Number((start + duration).toFixed(3));

    cues.push({
      id: id++,
      start,
      end,
      start_time: secondsToTimestamp(start),
      end_time: secondsToTimestamp(end),
      source,
      fa: ""
    });
  }

  if (!cues.length) throw new Error("json3 has no cues");
  return cues;
}

function parseXml(text) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, "text/xml");

  if (xml.querySelector("parsererror")) throw new Error("not xml");

  const nodes = Array.from(xml.querySelectorAll("text, p"));
  const cues = [];
  let id = 1;

  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();
    const startRaw = node.getAttribute("start") ?? node.getAttribute("t");
    const durRaw = node.getAttribute("dur") ?? node.getAttribute("d");

    if (startRaw == null) continue;

    let start = Number(startRaw);
    let duration = durRaw == null ? 2.5 : Number(durRaw);

    if (tag === "p" || start > 100000) {
      start = start / 1000;
      duration = duration / 1000;
    }

    if (!Number.isFinite(start)) continue;
    if (!Number.isFinite(duration) || duration <= 0) duration = 2.5;

    const source = cleanText(node.textContent || "");
    if (!source) continue;

    const end = Number((start + duration).toFixed(3));
    start = Number(start.toFixed(3));

    cues.push({
      id: id++,
      start,
      end,
      start_time: secondsToTimestamp(start),
      end_time: secondsToTimestamp(end),
      source,
      fa: ""
    });
  }

  if (!cues.length) throw new Error("xml has no cues");
  return cues;
}

function parseVttTimestamp(value) {
  const s = String(value || "").trim();
  const parts = s.split(":");

  let h = 0;
  let m = 0;
  let sec = 0;

  if (parts.length === 3) {
    h = Number(parts[0]);
    m = Number(parts[1]);
    sec = Number(parts[2].replace(",", "."));
  } else if (parts.length === 2) {
    m = Number(parts[0]);
    sec = Number(parts[1].replace(",", "."));
  } else {
    return NaN;
  }

  return h * 3600 + m * 60 + sec;
}

function parseVtt(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const cues = [];
  let id = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.includes("-->")) continue;

    const [left, rightRaw] = line.split("-->");
    const right = rightRaw.trim().split(/\s+/)[0];

    const start = parseVttTimestamp(left);
    const end = parseVttTimestamp(right);

    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const body = [];
    i++;

    while (i < lines.length && lines[i].trim()) {
      const item = lines[i].trim();
      if (!/^\d+$/.test(item)) body.push(item);
      i++;
    }

    const source = cleanText(body.join(" "));
    if (!source) continue;

    cues.push({
      id: id++,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      start_time: secondsToTimestamp(start),
      end_time: secondsToTimestamp(end),
      source,
      fa: ""
    });
  }

  if (!cues.length) throw new Error("vtt has no cues");
  return cues;
}

function fixCueTiming(cues) {
  cues.sort((a, b) => a.start - b.start);

  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) {
      cues[i].end = Number(cues[i + 1].start.toFixed(3));
      cues[i].end_time = secondsToTimestamp(cues[i].end);
    }
  }

  return cues;
}

async function readCuesFromUrl(captured) {
  const attempts = [
    { format: "json3-player-url", url: captured.json3Url || captured.originalUrl, fmt: null, parse: parseJson3 },
    { format: "json3", url: captured.originalUrl, fmt: "json3", parse: parseJson3 },
    { format: "srv3", url: captured.originalUrl, fmt: "srv3", parse: parseXml },
    { format: "xml", url: captured.originalUrl, fmt: null, parse: parseXml },
    { format: "vtt", url: captured.originalUrl, fmt: "vtt", parse: parseVtt }
  ];

  const errors = [];

  for (const attempt of attempts) {
    try {
      if (!attempt.url) throw new Error("missing url");
      const text = await readCaptionText(attempt.url, attempt.fmt);
      const cues = attempt.parse(text);
      return {
        cues: fixCueTiming(cues),
        format: attempt.format
      };
    } catch (err) {
      errors.push(`${attempt.format}: ${err.message}`);
    }
  }

  throw new Error(
    "Could not read the subtitle text.\n" +
    errors.slice(0, 5).join("\n")
  );
}

function buildModelPrompt() {
  return `This is a YouTube timed-subtitle JSON file.

Translate the "source" text of every cue and write the translation into the "fa" field of the same cue.

Rules:
- Do not change ids or timings.
- Do not add or remove cues.
- Keep the JSON structure exactly the same.
- Return only the complete JSON, nothing else.

After translating, return the same complete JSON.`;
}

function buildWorkfile(captured, cueResult) {
  const track = captured.track || {};

  return {
    schema: "cccraft-subtitle-v1.1",
    video: {
      id: getVideoId(),
      title: getVideoTitle(),
      url: getWatchUrl(),
      duration_seconds: getVideoDuration()
    },
    source_track: {
      languageCode: track.languageCode || "",
      label: track.label || "",
      kind: track.kind || "manual",
      vssId: track.vssId || "",
      read_format: cueResult.format
    },
    generated_at: new Date().toISOString(),
    model_prompt: buildModelPrompt(),
    cues: cueResult.cues
  };
}

function downloadText(filename, text, type = "text/plain;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function makeWorkfile(trackIndex) {
  const captured = await requestMain("CAPTURE_CAPTION_URL", { trackIndex }, 16000);

  if (!captured?.ok) {
    throw new Error(captured?.error || "Could not get the caption URL from the YouTube player.");
  }

  const cueResult = await readCuesFromUrl(captured);
  return buildWorkfile(captured, cueResult);
}

async function downloadWorkfileJson(trackIndex) {
  const workfile = await makeWorkfile(trackIndex);
  const filename = `${safeFilename(workfile.video.title)}-${workfile.source_track.languageCode || "captions"}-to-fa.json`;

  downloadText(filename, JSON.stringify(workfile, null, 2), "application/json;charset=utf-8");

  return {
    ok: true,
    count: workfile.cues.length,
    language: workfile.source_track.languageCode,
    format: workfile.source_track.read_format
  };
}

async function downloadPromptTxt(trackIndex) {
  const workfile = await makeWorkfile(trackIndex);
  const filename = `${safeFilename(workfile.video.title)}-prompt.txt`;

  const text =
`${buildModelPrompt()}

--------------------
JSON زیرنویس:
--------------------

${JSON.stringify(workfile, null, 2)}
`;

  downloadText(filename, text, "text/plain;charset=utf-8");

  return {
    ok: true,
    count: workfile.cues.length,
    language: workfile.source_track.languageCode,
    format: workfile.source_track.read_format
  };
}

function extractTranslatedCues(workfile) {
  if (!workfile || !Array.isArray(workfile.cues)) {
    throw new Error("Invalid JSON file: no cues array found.");
  }

  const cues = [];

  for (const cue of workfile.cues) {
    const start = Number(cue.start);
    const end = Number(cue.end);
    const text = cleanText(cue.fa || "");
    const orig = cleanText(cue.source || "");

    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (!text) continue;

    cues.push({ start, end, text, orig });
  }

  cues.sort((a, b) => a.start - b.start);

  if (!cues.length) {
    throw new Error("No filled translation (fa) fields were found in the file.");
  }

  return cues;
}

async function loadTranslatedJson(workfile, dir) {
  const cues = extractTranslatedCues(workfile);

  faCues = cues;
  subsDir = dir === "ltr" ? "ltr" : "rtl";

  const key = `cccraftSubs:${getVideoId()}`;
  const metaKey = `cccraftSubsMeta:${getVideoId()}`;
  origLang = workfile?.source_track?.languageCode || origLang;

  const api = await chrome.storage.local.get("ccCraftApiSettings");
  userLang = api?.ccCraftApiSettings?.targetLang || userLang;

  await chrome.storage.local.set({ [key]: cues, [metaKey]: { dir: subsDir, srcLang: origLang } });

  // اگر نمایش زیرنویس خاموش بود، روشن کن تا کاربر فکر نکند زیرنویس نیامده
  if (!settings.enabled) {
    settings.enabled = true;
    await chrome.storage.local.set({ ccCraftSubtitleSettings: settings });
  }

  const overlay = injectOverlay();
  applySettings(settings);

  // پیام تایید را چند ثانیه روی خود ویدیو نشان بده تا معلوم شود overlay کار می‌کند
  if (overlay) {
    setOverlayText(overlay, `✓ Subtitles enabled (${cues.length} lines)`, "");
    flashUntil = Date.now() + 3000;
  }

  return {
    ok: true,
    count: cues.length
  };
}

async function clearSubs() {
  faCues = [];

  const key = `cccraftSubs:${getVideoId()}`;
  await chrome.storage.local.remove(key);

  const overlay = document.getElementById("cccraft-subtitle-overlay");
  if (overlay) setOverlayText(overlay, "", "");

  const player = document.querySelector(".html5-video-player") || document.querySelector("#movie_player");
  if (player) player.classList.remove("cccraft-on");

  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "GET_CAPTION_TRACKS") {
        const res = await requestMain("GET_TRACKS", {}, 12000);

        if (!res?.ok) {
          sendResponse({ ok: false, error: res?.error || "No subtitle tracks were found." });
          return;
        }

        sendResponse({
          ok: true,
          tracks: res.tracks || [],
          preferredIndex: res.preferredIndex ?? 0
        });
        return;
      }

      if (message.type === "GET_WORKFILE_JSON") {
        const workfile = await makeWorkfile(message.trackIndex);
        sendResponse({ ok: true, workfile });
        return;
      }

      if (message.type === "DOWNLOAD_WORKFILE_JSON") {
        sendResponse(await downloadWorkfileJson(message.trackIndex));
        return;
      }

      if (message.type === "DOWNLOAD_PROMPT_TXT") {
        sendResponse(await downloadPromptTxt(message.trackIndex));
        return;
      }

      if (message.type === "LOAD_TRANSLATED_JSON") {
        sendResponse(await loadTranslatedJson(message.workfile, message.subtitleDir));
        return;
      }

      if (message.type === "CLEAR_SUBS") {
        sendResponse(await clearSubs());
        return;
      }

      if (message.type === "APPLY_SETTINGS") {
        applySettings(message.settings);
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message." });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});
