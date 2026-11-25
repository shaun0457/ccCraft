const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const trackSelect = $("trackSelect");
const fontSize = $("fontSize");
const bottom = $("bottom");
const enabled = $("enabled");
const showOriginal = $("showOriginal");
const subColor = $("subColor");
const languageLearning = $("languageLearning");

const providerSelect = $("providerSelect");
const apiKeyInput = $("apiKeyInput");
const modelSelect = $("modelSelect");
const fetchModelsBtn = $("fetchModels");
const autoTranslateBtn = $("autoTranslate");
const targetLangSelect = $("targetLangSelect");

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

  if (!keys.length) return `Enter your ${PROVIDER_NAMES[provider]} API key first.`;

  const seen = new Set();

  for (const key of keys) {
    if (seen.has(key)) {
      return `Duplicate key ${maskKey(key)} \u2014 remove the repeated key.`;
    }
    seen.add(key);

    const family = keyFamily(key);

    if (family && !(PROVIDER_KEY_FAMILIES[provider] || []).includes(family)) {
      return `Key ${maskKey(key)} does not look like a ${PROVIDER_NAMES[provider]} key.`;
    }
  }

  const firstSig = keySignature(keys[0]);

  for (const key of keys.slice(1)) {
    if (keySignature(key) !== firstSig) {
      return `Keys ${maskKey(keys[0])} and ${maskKey(key)} do not look like keys from the same provider. All keys must belong to one provider.`;
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

// Set while API keys are not being saved (see popup/key-store.js); it is appended to every
// status message so other messages cannot hide it.
let keyStoreWarning = "";
let lastStatus = ["", false, false];

function setStatus(text, error = false, busy = false) {
  lastStatus = [text, error, busy];
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
    let text = `\n🧩 Automatic captions reconstructed before translation: ${pp.raw_cues} → ${pp.cues} lines`;
    if (pp.chunks_fallback) text += ` (${pp.chunks_fallback} of ${pp.chunks_total} parts kept as original)`;
    return text;
  }
  return `\n⚠️ Caption preprocessing failed, the original captions were translated instead (${(pp.warnings || []).join(", ") || pp.reason}).`;
}

function runningMessage(status, prefix) {
  if (status.phase === "preprocessing") {
    const part = status.chunksTotal ? ` (part ${status.chunksDone} of ${status.chunksTotal})` : "";
    return `⏳ Reconstructing automatic captions before translation${part}...\nYou can close this popup — translation continues in the background.`;
  }
  const percent = status.total ? Math.round((status.done / status.total) * 100) : 0;
  let text = `⏳ ${prefix} ${status.done} of ${status.total} lines translated (${percent}%)`;

  if (status.retryRound) {
    text += `\n🔁 Retry round ${status.retryRound} of 2 for ${status.missing} untranslated lines...`;
  }

  if (status.lastError) {
    text += `\n⚠️ Last error: ${status.lastError}`;
  }

  text += `\nYou can close this popup — translation continues in the background.`;
  return text;
}

function doneMessage(status) {
  let text = `✅ Translation finished — subtitles are live on the video.\nTranslated lines: ${status.count}`;

  if (status.untranslated) {
    text += `\n⚠️ ${status.untranslated} lines could not be translated even after retries (${status.firstError || "unknown error"}). Translate again or try another model.`;
  }

  text += preprocessingMessage(status.preprocessing);
  return text;
}

async function getActiveYoutubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes("youtube.com/watch")) {
    throw new Error("Open a YouTube video first.");
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
    throw new Error("The extension is not active on this page. Refresh the YouTube page and try again.");
  }
}

async function loadTracks({ quiet = false } = {}) {
  try {
    trackSelect.innerHTML = `<option value="">Loading...</option>`;
    const res = await sendToTab({ type: "GET_CAPTION_TRACKS" });

    if (!res?.ok) throw new Error(res?.error || "No subtitle tracks found.");

    trackSelect.innerHTML = "";

    if (!res.tracks.length) {
      trackSelect.innerHTML = `<option value="">No extractable subtitles</option>`;
      setStatus("This video has no extractable subtitles.", true);
      return;
    }

    for (const track of res.tracks) {
      const option = document.createElement("option");
      option.value = String(track.index);

      const kind = track.kind === "asr" ? "auto" : "manual";
      const label = track.label || track.languageCode || "Unknown";
      option.textContent = `${label} | ${track.languageCode || "?"} | ${kind}`;
      trackSelect.appendChild(option);
    }

    trackSelect.value = String(res.preferredIndex ?? 0);

    if (!quiet) {
      setStatus(`Tracks ready. Found: ${res.tracks.length}`);
    }
  } catch (err) {
    setStatus(err.message, true);
    trackSelect.innerHTML = `<option value="">Failed to read tracks</option>`;
  }
}

// ---------- API settings & model menu ----------

// API keys are kept in the extension's IndexedDB (popup/key-store.js), not in
// chrome.storage.local, because the content script on every YouTube page can read the latter.
const apiSettingsStore = CcCraftKeyStore.createApiSettingsStore({
  storage: chrome.storage.local,
  secretStore: CcCraftKeyStore.createIdbStore(globalThis.indexedDB),
  incognito: Boolean(chrome.extension && chrome.extension.inIncognitoContext)
});
const KEY_STORE_WARNING =
  "⚠️ API keys can't be saved in this window (private window, or the browser blocked the extension's storage). " +
  "A key you enter now works until the popup closes; keys saved earlier are not changed.";
function warnKeyStore() {
  keyStoreWarning = KEY_STORE_WARNING;
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
    option.textContent = apiKeyInput.value.trim()
      ? "Click “Fetch model list”"
      : "Enter your API key first";
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
    if (!silent) setStatus(`Enter your ${PROVIDER_NAMES[provider]} API key first.`, true);
    return;
  }

  const keyError = validateApiKeys(provider, apiKey);

  if (keyError) {
    if (!silent) setStatus(keyError, true);
    return;
  }

  try {
    fetchModelsBtn.disabled = true;
    modelSelect.innerHTML = `<option value="">Fetching models...</option>`;

    if (!silent) {
      setStatus(`Detecting available ${PROVIDER_NAMES[provider]} models...`, false, true);
    }

    const res = await chrome.runtime.sendMessage({ type: "LIST_MODELS", provider, apiKey });

    if (!res?.ok) throw new Error(res?.error || "Failed to fetch the model list.");

    apiSettings.provider = provider;
    apiSettings.keys[provider] = apiKey;
    apiSettings.modelLists[provider] = res.models;
    populateModelMenu(provider);
    await persistApiSettings();

    if (!silent) {
      setStatus(`${res.models.length} ${PROVIDER_NAMES[provider]} models detected. Pick one from the menu.`);
    }
  } catch (err) {
    apiSettings.modelLists[provider] = [];
    populateModelMenu(provider);
    setStatus(err.message, true);
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
      setStatus(runningMessage(status, "Translating..."), false, true);
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
      setStatus(`❌ Auto-translate failed:\n${status.error}`, true);
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
        setStatus("⚠️ The previous translation was interrupted (the browser or extension probably restarted). Click Translate again.", true);
        return;
      }

      autoTranslateBtn.disabled = true;
      setStatus(runningMessage(status, "Translation running in the background..."), false, true);
      startPolling(videoId);
      return;
    }

    // Do not show stale results.
    if (ageMs > 30 * 60 * 1000) return;

    if (status.state === "error") {
      setStatus(`❌ The last auto-translate for this video failed:\n${status.error}`, true);
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
      throw new Error(`Enter your ${PROVIDER_NAMES[provider]} API key first.`);
    }

    if (!model) {
      throw new Error("Fetch the model list and pick a model first.");
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
    setStatus("⏳ Step 1 of 2: extracting subtitles from the player...", false, true);

    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: "GET_WORKFILE_JSON", trackIndex });
    } catch (_) {
      throw new Error("The extension is not active on this page. Refresh the YouTube page and try again.");
    }

    if (!res?.ok) throw new Error(res?.error || "Failed to extract subtitles.");

    const workfile = res.workfile;
    const lineCount = workfile.cues.length;

    // For very long videos, suggest manual translation before attempting AI
    if (lineCount > 200) {
      setStatus(
        `⚠️ This video has ${lineCount} subtitle lines. For videos this long, AI translation may be slow or fail.
You can translate manually: download the JSON or prompt from the "Manual translation" section, translate it yourself, then load it back.

Starting AI translation anyway...`,
        false,
        true
      );
    } else {
      setStatus(`⏳ Step 2 of 2: translating ${lineCount} lines to ${lang.label} with ${PROVIDER_NAMES[provider]} (${model})...`, false, true);
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

    if (!started?.ok) throw new Error("Could not start the background translation. Reload the extension in chrome://extensions once.");

    startPolling(workfile.video.id);
  } catch (err) {
    autoTranslateBtn.disabled = false;
    setStatus(err.message, true);
  }
});

// ---------- Subtitle appearance ----------

const DEFAULT_SUB_SETTINGS = {
  fontSize: 24,
  bottom: 12,
  enabled: true,
  color: "#ffffff",
  showOriginal: false,
  languageLearning: false
};

async function loadSettings() {
  const result = await chrome.storage.local.get({
    ccCraftSubtitleSettings: DEFAULT_SUB_SETTINGS
  });

  const settings = { ...DEFAULT_SUB_SETTINGS, ...(result.ccCraftSubtitleSettings || {}) };
  fontSize.value = settings.fontSize;
  bottom.value = settings.bottom;
  enabled.checked = settings.enabled;
  subColor.value = settings.color;
  showOriginal.checked = settings.showOriginal;
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
    showOriginal: Boolean(showOriginal.checked),
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
    setStatus("⏳ Temporarily enabling captions and capturing the real URL...", false, true);
    const res = await sendToTab({ type: "DOWNLOAD_WORKFILE_JSON", trackIndex });

    if (!res?.ok) throw new Error(res?.error || "Export failed.");
    setStatus(`JSON downloaded.\nLines: ${res.count}\nLanguage: ${res.language || "unknown"}\nFormat: ${res.format || "?"}`);
  } catch (err) {
    setStatus(err.message, true);
  }
});

$("downloadPrompt").addEventListener("click", async () => {
  try {
    const trackIndex = Number(trackSelect.value || 0);
    setStatus("⏳ Building the ready-made prompt...", false, true);
    const res = await sendToTab({ type: "DOWNLOAD_PROMPT_TXT", trackIndex });

    if (!res?.ok) throw new Error(res?.error || "Prompt export failed.");
    setStatus(`Prompt TXT downloaded.\nLines: ${res.count}\nFormat: ${res.format || "?"}`);
  } catch (err) {
    setStatus(err.message, true);
  }
});

$("loadTranslated").addEventListener("click", async () => {
  try {
    const file = $("fileInput").files?.[0];
    if (!file) throw new Error("Choose the translated JSON file first.");

    const text = await file.text();

    if (!text.trim()) {
      throw new Error("The selected file is empty.");
    }

    let workfile;
    try {
      workfile = JSON.parse(text);
    } catch (parseErr) {
      throw new Error("The JSON file is incomplete or corrupted. The model output must be valid JSON only.");
    }

    const lang = getSelectedLang();

    apiSettings.targetLang = lang.code;
    await persistApiSettings();

    setStatus("⏳ Loading translated subtitles...", false, true);
    const res = await sendToTab({ type: "LOAD_TRANSLATED_JSON", workfile, subtitleDir: lang.dir });

    if (!res?.ok) throw new Error(res?.error || "Loading failed.");
    setStatus(`✅ Subtitles are live on the video.\nLines: ${res.count}`);
  } catch (err) {
    setStatus(err.message, true);
  }
});

$("clearSubs").addEventListener("click", async () => {
  try {
    const res = await sendToTab({ type: "CLEAR_SUBS" });
    if (!res?.ok) throw new Error(res?.error || "Clearing failed.");
    setStatus("Subtitles for this video were cleared.");
  } catch (err) {
    setStatus(err.message, true);
  }
});

fontSize.addEventListener("input", saveAndApplySettings);
bottom.addEventListener("input", saveAndApplySettings);
enabled.addEventListener("change", saveAndApplySettings);
subColor.addEventListener("input", saveAndApplySettings);
showOriginal.addEventListener("change", saveAndApplySettings);
languageLearning.addEventListener("change", () => {
  if (languageLearning.checked) showOriginal.checked = true;
  saveAndApplySettings();
});

document.addEventListener("DOMContentLoaded", async () => {
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
