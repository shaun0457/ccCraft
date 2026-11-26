const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const trackSelect = $("trackSelect");
const fontSize = $("fontSize");
const bottom = $("bottom");
const enabled = $("enabled");
const modeInputs = {
  translation: $("modeTranslation"),
  bilingual: $("modeBilingual"),
  original: $("modeOriginal")
};
const subColor = $("subColor");
const languageLearning = $("languageLearning");

const providerSelect = $("providerSelect");
const apiKeyInput = $("apiKeyInput");
const modelSelect = $("modelSelect");
const fetchModelsBtn = $("fetchModels");
const autoTranslateBtn = $("autoTranslate");
const targetLangSelect = $("targetLangSelect");
const uiLanguageSelect = $("uiLanguageSelect");

// ---------- Interface language (strings in src/i18n.js) ----------

const UI_LANGUAGE_KEY = "ccCraftUiLanguage";
let uiLang = CcCraftI18n.uiLanguageOf(null, globalThis.navigator?.language);

function t(key, vars) {
  return CcCraftI18n.translate(uiLang, key, vars);
}

// Error text from the background, content script or YouTube page, in the interface language,
// with a likely cause and what to do (hints: false for text inside another sentence).
function errorText(raw, hints = true) {
  return CcCraftI18n.describeError(uiLang, raw, { hints });
}

// Re-labels the static popup text. Messages already in the status banner keep their language
// until the next message, except the key-storage warning, which is re-rendered.
function applyUiLanguage() {
  document.documentElement.lang = CcCraftI18n.htmlLangOf(uiLang);
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  uiLanguageSelect.value = uiLang;
}

async function loadUiLanguage() {
  const stored = await chrome.storage.local.get(UI_LANGUAGE_KEY);
  uiLang = CcCraftI18n.uiLanguageOf(stored[UI_LANGUAGE_KEY], globalThis.navigator?.language);
  applyUiLanguage();
}

uiLanguageSelect.addEventListener("change", async () => {
  uiLang = CcCraftI18n.uiLanguageOf(uiLanguageSelect.value, globalThis.navigator?.language);
  applyUiLanguage();
  populateModelMenu(providerSelect.value);
  setStatus(...lastStatus);
  // The content script listens for this key and switches its on-video hints.
  await chrome.storage.local.set({ [UI_LANGUAGE_KEY]: uiLang });
});

const DEFAULT_MODELS = {
  gemini: "gemini-2.5-flash",
  gpt: "gpt-4o-mini",
  nvidia: "meta/llama-3.3-70b-instruct",
  qwen: "qwen-plus"
};

const PROVIDER_NAMES = {
  gemini: "Google Gemini",
  gpt: "OpenAI GPT",
  nvidia: "NVIDIA NIM",
  qwen: "Alibaba Qwen"
};

function keyFamily(key) {
  if (key.startsWith("nvapi-")) return "nvidia";
  if (key.startsWith("AIza") || key.startsWith("AQ.")) return "gemini";
  // OpenAI and Qwen (DashScope) keys both start with sk-
  if (key.startsWith("sk-")) return "sk";
  return null;
}

const PROVIDER_KEY_FAMILIES = {
  gemini: ["gemini"],
  gpt: ["sk"],
  nvidia: ["nvidia"],
  qwen: ["sk"]
};

// Signature used to compare keys with each other: known family, or the leading prefix.
function keySignature(key) {
  const family = keyFamily(key);
  if (family) return family;

  const sep = key.search(/[-_.]/);
  if (sep > 0 && sep <= 8) return key.slice(0, sep + 1).toLowerCase();
  return key.slice(0, 3).toLowerCase();
}

function maskKey(key) {
  return key.length > 12 ? `${key.slice(0, 6)}\u2026${key.slice(-4)}` : `${key.slice(0, 4)}\u2026`;
}

// Keys are checked against each other: they must all look like keys of the same provider.
// Unknown formats are accepted (the API call itself is the final validation).
function validateApiKeys(provider, apiKeyValue) {
  const keys = String(apiKeyValue || "")
    .split(/[\s,;]+/)
    .map((k) => k.trim())
    .filter(Boolean);

  if (!keys.length) return t("keyMissing", { provider: PROVIDER_NAMES[provider] });

  const seen = new Set();

  for (const key of keys) {
    if (seen.has(key)) {
      return t("keyDuplicate", { key: maskKey(key) });
    }
    seen.add(key);

    const family = keyFamily(key);

    if (family && !(PROVIDER_KEY_FAMILIES[provider] || []).includes(family)) {
      return t("keyWrongProvider", { key: maskKey(key), provider: PROVIDER_NAMES[provider] });
    }
  }

  const firstSig = keySignature(keys[0]);

  for (const key of keys.slice(1)) {
    if (keySignature(key) !== firstSig) {
      return t("keyMixedProviders", { first: maskKey(keys[0]), other: maskKey(key) });
    }
  }

  return null;
}

// Target languages. promptName is sent to the AI model, dir is the subtitle display direction.
const TARGET_LANGS = [
  { code: "fa", label: "فارسی", promptName: "Persian (Farsi)", dir: "rtl" },
  { code: "en", label: "English", promptName: "English", dir: "ltr" },
  { code: "ar", label: "العربية", promptName: "Arabic", dir: "rtl" },
  { code: "tr", label: "Türkçe", promptName: "Turkish", dir: "ltr" },
  { code: "de", label: "Deutsch", promptName: "German", dir: "ltr" },
  { code: "fr", label: "Français", promptName: "French", dir: "ltr" },
  { code: "es", label: "Español", promptName: "Spanish", dir: "ltr" },
  { code: "it", label: "Italiano", promptName: "Italian", dir: "ltr" },
  { code: "pt", label: "Português", promptName: "Portuguese", dir: "ltr" },
  { code: "ru", label: "Русский", promptName: "Russian", dir: "ltr" },
  { code: "uk", label: "Українська", promptName: "Ukrainian", dir: "ltr" },
  { code: "pl", label: "Polski", promptName: "Polish", dir: "ltr" },
  { code: "nl", label: "Nederlands", promptName: "Dutch", dir: "ltr" },
  { code: "sv", label: "Svenska", promptName: "Swedish", dir: "ltr" },
  { code: "no", label: "Norsk", promptName: "Norwegian", dir: "ltr" },
  { code: "da", label: "Dansk", promptName: "Danish", dir: "ltr" },
  { code: "fi", label: "Suomi", promptName: "Finnish", dir: "ltr" },
  { code: "el", label: "Ελληνικά", promptName: "Greek", dir: "ltr" },
  { code: "cs", label: "Čeština", promptName: "Czech", dir: "ltr" },
  { code: "ro", label: "Română", promptName: "Romanian", dir: "ltr" },
  { code: "hu", label: "Magyar", promptName: "Hungarian", dir: "ltr" },
  { code: "zh", label: "中文 (简体)", promptName: "Simplified Chinese", dir: "ltr" },
  { code: "zh-TW", label: "中文 (繁體)", promptName: "Traditional Chinese", dir: "ltr" },
  { code: "ja", label: "日本語", promptName: "Japanese", dir: "ltr" },
  { code: "ko", label: "한국어", promptName: "Korean", dir: "ltr" },
  { code: "hi", label: "हिन्दी", promptName: "Hindi", dir: "ltr" },
  { code: "bn", label: "বাংলা", promptName: "Bengali", dir: "ltr" },
  { code: "ta", label: "தமிழ்", promptName: "Tamil", dir: "ltr" },
  { code: "ur", label: "اردو", promptName: "Urdu", dir: "rtl" },
  { code: "ps", label: "پښتو", promptName: "Pashto", dir: "rtl" },
  { code: "ku", label: "کوردی", promptName: "Kurdish", dir: "rtl" },
  { code: "he", label: "עברית", promptName: "Hebrew", dir: "rtl" },
  { code: "az", label: "Azərbaycanca", promptName: "Azerbaijani", dir: "ltr" },
  { code: "hy", label: "Հայերեն", promptName: "Armenian", dir: "ltr" },
  { code: "ka", label: "ქართული", promptName: "Georgian", dir: "ltr" },
  { code: "id", label: "Bahasa Indonesia", promptName: "Indonesian", dir: "ltr" },
  { code: "ms", label: "Bahasa Melayu", promptName: "Malay", dir: "ltr" },
  { code: "vi", label: "Tiếng Việt", promptName: "Vietnamese", dir: "ltr" },
  { code: "th", label: "ไทย", promptName: "Thai", dir: "ltr" },
  { code: "sw", label: "Kiswahili", promptName: "Swahili", dir: "ltr" }
];

function getSelectedLang() {
  return TARGET_LANGS.find((l) => l.code === targetLangSelect.value) || TARGET_LANGS[0];
}

function populateTargetLangs() {
  targetLangSelect.innerHTML = "";

  for (const lang of TARGET_LANGS) {
    const option = document.createElement("option");
    option.value = lang.code;
    option.textContent = `${lang.label} (${lang.code})`;
    targetLangSelect.appendChild(option);
  }

  targetLangSelect.value = apiSettings.targetLang || "fa";
  if (!targetLangSelect.value) targetLangSelect.value = "fa";
}

let apiSettings = {
  provider: "gemini",
  targetLang: "fa",
  models: { ...DEFAULT_MODELS },
  keys: { gemini: "", gpt: "", nvidia: "" },
  modelLists: { gemini: [], gpt: [], nvidia: [] }
};

// ---------- Status banner (top of the popup) ----------

// Set while API keys are not being saved (see popup/key-store.js); the warning is appended to
// every status message so other messages cannot hide it.
let keyStoreUnsafe = false;
let lastStatus = ["", false, false];

function setStatus(text, error = false, busy = false) {
  lastStatus = [text, error, busy];
  const keyStoreWarning = keyStoreUnsafe ? t("keyStoreWarning") : "";
  const full = [text, keyStoreWarning].filter(Boolean).join("\n\n");
  statusEl.textContent = full;
  statusEl.classList.toggle("show", Boolean(full));
  statusEl.classList.toggle("error", Boolean(error || (keyStoreWarning && !text)));
  statusEl.classList.toggle("ok", !error);
  statusEl.classList.toggle("busy", Boolean(busy));
}

function clearStatus() {
  setStatus("");
}

// Caption preprocessing summary (counts and codes only, set by background.js).
function preprocessingMessage(pp) {
  if (!pp) return "";
  if (pp.applied) {
    let text = "\n" + t("ppApplied", { raw: pp.raw_cues, cues: pp.cues });
    if (pp.chunks_fallback) text += t("ppFallbackParts", { fallback: pp.chunks_fallback, total: pp.chunks_total });
    return text;
  }
  return "\n" + t("ppFailed", { reason: (pp.warnings || []).join(", ") || pp.reason });
}

function runningMessage(status, prefixKey) {
  if (status.phase === "preprocessing") {
    const part = status.chunksTotal ? t("runPart", { done: status.chunksDone, total: status.chunksTotal }) : "";
    return t("runPreprocessing", { part }) + "\n" + t("runBackgroundNote");
  }
  const percent = status.total ? Math.round((status.done / status.total) * 100) : 0;
  let text = t("runProgress", { prefix: t(prefixKey), done: status.done, total: status.total, percent });

  if (status.resumedFrom) {
    text += "\n" + t("runResumed", { count: status.resumedFrom });
  }

  if (status.partialLines) {
    text += "\n" + t("runPartialShown", { count: status.partialLines });
  }

  if (status.retryRound) {
    text += "\n" + t("runRetry", { round: status.retryRound, missing: status.missing });
  }

  if (status.lastError) {
    text += "\n" + t("runLastError", { error: errorText(status.lastError) });
  }

  text += "\n" + t("runBackgroundNote");
  return text;
}

// After a stopped or failed run: the translated lines were saved and the next Translate continues.
// Partial subtitles shown while it ran stay on the video, so the popup says what is there.
function resumeHint(status) {
  const kept = status.partialLines ? "\n" + t("partialKept", { count: status.partialLines }) : "";
  return kept + (status.done > 0 && status.total ? "\n" + t("resumeHint", { done: status.done, total: status.total }) : "");
}

function doneMessage(status) {
  // shownOnVideo is false when the tab had moved to another video by the time translation finished.
  let text = t(status.shownOnVideo === false ? "doneElsewhere" : "done", { count: status.count });

  if (status.untranslated) {
    const short = status.firstError ? errorText(status.firstError, false) : t("unknownError");
    // The cause and what-to-do lines go under the sentence, not inside its parentheses.
    const hints = status.firstError ? errorText(status.firstError).slice(short.length) : "";
    text += "\n" + t("doneUntranslated", { count: status.untranslated, error: short }) + hints;
  }

  text += preprocessingMessage(status.preprocessing);
  return text;
}

async function getActiveYoutubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes("youtube.com/watch")) {
    throw new Error(t("openYoutube"));
  }

  return tab;
}

function getVideoIdFromTab(tab) {
  try {
    return new URL(tab.url).searchParams.get("v");
  } catch (_) {
    return null;
  }
}

async function sendToTab(message) {
  const tab = await getActiveYoutubeTab();

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    throw new Error(t("notActive"));
  }
}

async function loadTracks({ quiet = false } = {}) {
  try {
    setPlaceholderOption(trackSelect, t("loading"));
    const res = await sendToTab({ type: "GET_CAPTION_TRACKS" });

    if (!res?.ok) throw new Error(res?.error || t("noTracksFound"));

    trackSelect.innerHTML = "";

    if (!res.tracks.length) {
      setPlaceholderOption(trackSelect, t("noExtractableOption"));
      setStatus(t("noExtractable"), true);
      return;
    }

    for (const track of res.tracks) {
      const option = document.createElement("option");
      option.value = String(track.index);

      const kind = track.kind === "asr" ? t("trackAuto") : t("trackManual");
      const label = track.label || track.languageCode || t("trackUnknown");
      option.textContent = `${label} | ${track.languageCode || "?"} | ${kind}`;
      trackSelect.appendChild(option);
    }

    trackSelect.value = String(res.preferredIndex ?? 0);

    if (!quiet) {
      setStatus(t("tracksReady", { count: res.tracks.length }));
    }
  } catch (err) {
    setStatus(errorText(err.message), true);
    setPlaceholderOption(trackSelect, t("tracksFailedOption"));
  }
}

// Replaces a menu's options with one empty-valued option (text set with textContent).
function setPlaceholderOption(select, text) {
  select.innerHTML = "";
  const option = document.createElement("option");
  option.value = "";
  option.textContent = text;
  select.appendChild(option);
}

// ---------- API settings & model menu ----------

// API keys are kept in the extension's IndexedDB (popup/key-store.js), not in
// chrome.storage.local, because the content script on every YouTube page can read the latter.
const apiSettingsStore = CcCraftKeyStore.createApiSettingsStore({
  storage: chrome.storage.local,
  secretStore: CcCraftKeyStore.createIdbStore(globalThis.indexedDB),
  incognito: Boolean(chrome.extension && chrome.extension.inIncognitoContext)
});
function warnKeyStore() {
  keyStoreUnsafe = true;
  setStatus(...lastStatus);
}

// Saves run one at a time inside apiSettingsStore; a save before loading finished is skipped.
async function persistApiSettings() {
  const result = await apiSettingsStore.save(apiSettings);
  if (result.saved && !result.secure) warnKeyStore();
}

function populateModelMenu(provider) {
  const models = apiSettings.modelLists[provider] || [];
  modelSelect.innerHTML = "";

  if (!models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = apiKeyInput.value.trim() ? t("modelFetchHint") : t("modelEnterKeyFirst");
    modelSelect.appendChild(option);
    return;
  }

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    modelSelect.appendChild(option);
  }

  const preferred = apiSettings.models[provider];

  if (preferred && models.includes(preferred)) {
    modelSelect.value = preferred;
  } else if (models.includes(DEFAULT_MODELS[provider])) {
    modelSelect.value = DEFAULT_MODELS[provider];
  } else {
    modelSelect.value = models[0];
  }

  apiSettings.models[provider] = modelSelect.value;
}

function syncProviderFields() {
  const provider = providerSelect.value;
  apiKeyInput.value = apiSettings.keys[provider] || "";
  populateModelMenu(provider);
}

async function loadApiSettings() {
  const loaded = await apiSettingsStore.load();
  const stored = loaded.settings;
  if (!loaded.secure) warnKeyStore();

  apiSettings = {
    provider: stored.provider || "gemini",
    targetLang: stored.targetLang || "fa",
    models: { ...DEFAULT_MODELS, ...(stored.models || {}) },
    keys: { gemini: "", gpt: "", nvidia: "", qwen: "", ...loaded.keys },
    modelLists: { gemini: [], gpt: [], nvidia: [], qwen: [], ...(stored.modelLists || {}) }
  };

  providerSelect.value = apiSettings.provider;
  populateTargetLangs();
  syncProviderFields();
}

async function fetchModels({ silent = false } = {}) {
  const provider = providerSelect.value;
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    if (!silent) setStatus(t("keyMissing", { provider: PROVIDER_NAMES[provider] }), true);
    return;
  }

  const keyError = validateApiKeys(provider, apiKey);

  if (keyError) {
    if (!silent) setStatus(keyError, true);
    return;
  }

  try {
    fetchModelsBtn.disabled = true;
    setPlaceholderOption(modelSelect, t("modelsFetching"));

    if (!silent) {
      setStatus(t("modelsDetecting", { provider: PROVIDER_NAMES[provider] }), false, true);
    }

    const res = await chrome.runtime.sendMessage({ type: "LIST_MODELS", provider, apiKey });

    if (!res?.ok) throw new Error(res?.error || t("modelsFetchFailed"));

    apiSettings.provider = provider;
    apiSettings.keys[provider] = apiKey;
    apiSettings.modelLists[provider] = res.models;
    populateModelMenu(provider);
    await persistApiSettings();

    if (!silent) {
      setStatus(t("modelsDetected", { count: res.models.length, provider: PROVIDER_NAMES[provider] }));
    }
  } catch (err) {
    apiSettings.modelLists[provider] = [];
    populateModelMenu(provider);
    setStatus(errorText(err.message), true);
  } finally {
    fetchModelsBtn.disabled = false;
  }
}

providerSelect.addEventListener("change", async () => {
  apiSettings.provider = providerSelect.value;
  syncProviderFields();
  await persistApiSettings();

  if (apiKeyInput.value.trim() && !(apiSettings.modelLists[providerSelect.value] || []).length) {
    await fetchModels({ silent: true });
  }
});

// After the API key is entered, models are detected automatically and shown in the menu.
apiKeyInput.addEventListener("change", async () => {
  const provider = providerSelect.value;
  apiSettings.keys[provider] = apiKeyInput.value.trim();
  apiSettings.modelLists[provider] = [];
  await persistApiSettings();
  await fetchModels();
});

modelSelect.addEventListener("change", async () => {
  const provider = providerSelect.value;
  if (modelSelect.value) {
    apiSettings.models[provider] = modelSelect.value;
    await persistApiSettings();
  }
});

fetchModelsBtn.addEventListener("click", () => fetchModels());

targetLangSelect.addEventListener("change", async () => {
  apiSettings.targetLang = targetLangSelect.value || "fa";
  await persistApiSettings();
});

// ---------- Auto translate ----------

let pollTimer = null;

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(videoId) {
  stopPolling();

  pollTimer = setInterval(async () => {
    let res = null;

    try {
      res = await chrome.runtime.sendMessage({ type: "GET_TRANSLATE_STATUS", videoId });
    } catch (_) {
      return;
    }

    const status = res?.status;
    if (!status) return;

    if (status.state === "running") {
      setStatus(runningMessage(status, "prefixTranslating"), false, true);
      return;
    }

    if (status.state === "done") {
      stopPolling();
      autoTranslateBtn.disabled = false;
      setStatus(doneMessage(status));
      return;
    }

    if (status.state === "error") {
      stopPolling();
      autoTranslateBtn.disabled = false;
      setStatus(t("autoFailed", { error: errorText(status.error) }) + resumeHint(status), true);
    }
  }, 800);
}

// If a translation for the current video is running/finished/failed, show it when the popup opens.
async function checkExistingTranslateStatus() {
  try {
    const tab = await getActiveYoutubeTab();
    const videoId = getVideoIdFromTab(tab);
    if (!videoId) return;

    const res = await chrome.runtime.sendMessage({ type: "GET_TRANSLATE_STATUS", videoId });
    const status = res?.status;
    if (!status) return;

    const ageMs = Date.now() - (status.updated_at || 0);

    if (status.state === "running") {
      // If it has not updated for a while, the process was interrupted (e.g. browser closed).
      if (ageMs > 3 * 60 * 1000) {
        setStatus(t("interrupted") + resumeHint(status), true);
        return;
      }

      autoTranslateBtn.disabled = true;
      setStatus(runningMessage(status, "prefixBackground"), false, true);
      startPolling(videoId);
      return;
    }

    // Do not show stale results.
    if (ageMs > 30 * 60 * 1000) return;

    if (status.state === "error") {
      setStatus(t("lastFailed", { error: errorText(status.error) }) + resumeHint(status), true);
    } else if (status.state === "done") {
      setStatus(doneMessage(status));
    }
  } catch (_) {
    // Not on a YouTube tab — nothing to do.
  }
}

autoTranslateBtn.addEventListener("click", async () => {
  try {
    const provider = providerSelect.value;
    const apiKey = apiKeyInput.value.trim();
    const model = modelSelect.value;

    if (!apiKey) {
      throw new Error(t("keyMissing", { provider: PROVIDER_NAMES[provider] }));
    }

    if (!model) {
      throw new Error(t("pickModel"));
    }

    const keyError = validateApiKeys(provider, apiKey);
    if (keyError) throw new Error(keyError);

    const lang = getSelectedLang();

    apiSettings.provider = provider;
    apiSettings.targetLang = lang.code;
    apiSettings.keys[provider] = apiKey;
    apiSettings.models[provider] = model;
    await persistApiSettings();

    const tab = await getActiveYoutubeTab();
    const trackIndex = Number(trackSelect.value || 0);

    autoTranslateBtn.disabled = true;
    setStatus(t("step1"), false, true);

    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: "GET_WORKFILE_JSON", trackIndex });
    } catch (_) {
      throw new Error(t("notActive"));
    }

    if (!res?.ok) throw new Error(res?.error || t("extractFailed"));

    const workfile = res.workfile;
    const lineCount = workfile.cues.length;

    // For very long videos, suggest manual translation before attempting AI
    if (lineCount > 200) {
      setStatus(t("longVideo", { count: lineCount }), false, true);
    } else {
      setStatus(t("step2", { count: lineCount, lang: lang.label, provider: PROVIDER_NAMES[provider], model }), false, true);
    }

    const started = await chrome.runtime.sendMessage({
      type: "TRANSLATE_WORKFILE",
      workfile,
      provider,
      apiKey,
      model,
      tabId: tab.id,
      lang: { code: lang.code, promptName: lang.promptName, dir: lang.dir }
    });

    if (!started?.ok) throw new Error(t("startFailed"));

    startPolling(workfile.video.id);
  } catch (err) {
    autoTranslateBtn.disabled = false;
    setStatus(errorText(err.message), true);
  }
});

// ---------- Subtitle appearance ----------

const DEFAULT_SUB_SETTINGS = {
  fontSize: 24,
  bottom: 12,
  enabled: true,
  color: "#ffffff",
  showOriginal: false,
  subtitleMode: "translation",
  languageLearning: false
};

// Same mapping as subtitleModeOf in src/content.js: settings saved before subtitleMode existed
// map to what they showed: the original line was on when showOriginal or word lookup was on.
function subtitleModeOf(s) {
  const mode = s?.subtitleMode;
  if (mode === "translation" || mode === "bilingual" || mode === "original") return mode;
  return s?.showOriginal || s?.languageLearning ? "bilingual" : "translation";
}

function selectedMode() {
  return Object.keys(modeInputs).find((m) => modeInputs[m].checked) || "translation";
}

function setMode(mode) {
  for (const [m, input] of Object.entries(modeInputs)) input.checked = m === mode;
}

async function loadSettings() {
  const result = await chrome.storage.local.get({
    ccCraftSubtitleSettings: DEFAULT_SUB_SETTINGS
  });

  const stored = result.ccCraftSubtitleSettings || {};
  const settings = { ...DEFAULT_SUB_SETTINGS, ...stored, subtitleMode: subtitleModeOf(stored) };
  fontSize.value = settings.fontSize;
  bottom.value = settings.bottom;
  enabled.checked = settings.enabled;
  subColor.value = settings.color;
  setMode(settings.subtitleMode);
  languageLearning.checked = settings.languageLearning;

  $("fontSizeValue").textContent = settings.fontSize;
  $("bottomValue").textContent = settings.bottom;

  await sendToTab({ type: "APPLY_SETTINGS", settings }).catch(() => {});
}

async function saveAndApplySettings() {
  const settings = {
    fontSize: Number(fontSize.value),
    bottom: Number(bottom.value),
    enabled: Boolean(enabled.checked),
    color: subColor.value || "#ffffff",
    // showOriginal stays for older content scripts that do not know subtitleMode.
    showOriginal: selectedMode() !== "translation",
    subtitleMode: selectedMode(),
    languageLearning: Boolean(languageLearning.checked)
  };

  $("fontSizeValue").textContent = settings.fontSize;
  $("bottomValue").textContent = settings.bottom;

  await chrome.storage.local.set({ ccCraftSubtitleSettings: settings });
  await sendToTab({ type: "APPLY_SETTINGS", settings }).catch(() => {});
}

$("refreshTracks").addEventListener("click", () => loadTracks());

$("downloadJson").addEventListener("click", async () => {
  try {
    const trackIndex = Number(trackSelect.value || 0);
    setStatus(t("capturingUrl"), false, true);
    const res = await sendToTab({ type: "DOWNLOAD_WORKFILE_JSON", trackIndex });

    if (!res?.ok) throw new Error(res?.error || t("exportFailed"));
    setStatus(t("jsonDownloaded", { count: res.count, language: res.language || t("unknownLanguage"), format: res.format || "?" }));
  } catch (err) {
    setStatus(errorText(err.message), true);
  }
});

$("downloadPrompt").addEventListener("click", async () => {
  try {
    const trackIndex = Number(trackSelect.value || 0);
    setStatus(t("buildingPrompt"), false, true);
    const res = await sendToTab({ type: "DOWNLOAD_PROMPT_TXT", trackIndex });

    if (!res?.ok) throw new Error(res?.error || t("promptExportFailed"));
    setStatus(t("promptDownloaded", { count: res.count, format: res.format || "?" }));
  } catch (err) {
    setStatus(errorText(err.message), true);
  }
});

$("loadTranslated").addEventListener("click", async () => {
  try {
    const file = $("fileInput").files?.[0];
    if (!file) throw new Error(t("chooseFile"));

    const text = await file.text();

    if (!text.trim()) {
      throw new Error(t("fileEmpty"));
    }

    let workfile;
    try {
      workfile = JSON.parse(text);
    } catch (parseErr) {
      throw new Error(t("fileBadJson"));
    }

    const lang = getSelectedLang();

    apiSettings.targetLang = lang.code;
    await persistApiSettings();

    setStatus(t("loadingTranslated"), false, true);
    const res = await sendToTab({ type: "LOAD_TRANSLATED_JSON", workfile, subtitleDir: lang.dir });

    if (!res?.ok) throw new Error(res?.error || t("loadFailed"));
    setStatus(t("liveOnVideo", { count: res.count }));
  } catch (err) {
    setStatus(errorText(err.message), true);
  }
});

$("clearSubs").addEventListener("click", async () => {
  try {
    const res = await sendToTab({ type: "CLEAR_SUBS" });
    if (!res?.ok) throw new Error(res?.error || t("clearFailed"));
    setStatus(t("cleared"));
  } catch (err) {
    setStatus(errorText(err.message), true);
  }
});

fontSize.addEventListener("input", saveAndApplySettings);
bottom.addEventListener("input", saveAndApplySettings);
enabled.addEventListener("change", saveAndApplySettings);
subColor.addEventListener("input", saveAndApplySettings);
for (const input of Object.values(modeInputs)) input.addEventListener("change", saveAndApplySettings);
languageLearning.addEventListener("change", () => {
  // Word lookup works on the original line, so "Translation only" switches to both lines.
  if (languageLearning.checked && modeInputs.translation.checked) setMode("bilingual");
  saveAndApplySettings();
});

document.addEventListener("DOMContentLoaded", async () => {
  await loadUiLanguage();
  await loadApiSettings();
  await loadSettings();
  await loadTracks({ quiet: true });

  // Show any previous/ongoing translation status at the top.
  await checkExistingTranslateStatus();

  // If a key is stored but the model menu is still empty, detect models quietly.
  if (apiKeyInput.value.trim() && !(apiSettings.modelLists[providerSelect.value] || []).length) {
    fetchModels({ silent: true });
  }
});
