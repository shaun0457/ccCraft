// ccCraft - background service worker

// Chrome loads the preprocessing module here; Firefox loads it first via manifest "scripts".
if (typeof importScripts === "function" && !globalThis.CaptionPreprocessing) {
  importScripts("caption-preprocessing.js");
}

const CHUNK_SIZE = 50;
const RETRY_ROUNDS = 2;
const RETRY_CHUNK_SIZE = 20;

const PROVIDERS = {
  gemini: {
    name: "Google Gemini",
    defaultModel: "gemini-2.5-flash"
  },
  gpt: {
    name: "OpenAI GPT",
    defaultModel: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1"
  },
  nvidia: {
    name: "NVIDIA NIM",
    defaultModel: "meta/llama-3.3-70b-instruct",
    baseUrl: "https://integrate.api.nvidia.com/v1"
  },
  qwen: {
    name: "Alibaba Qwen",
    defaultModel: "qwen-plus",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
  }
};

const REQUEST_TIMEOUT_MS = 90000;
const PARALLEL_REQUESTS = 3;

function splitApiKeys(apiKey) {
  return String(apiKey || "")
    .split(/[\s,;]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function makeKeyRing(apiKey) {
  return {
    keys: splitApiKeys(apiKey),
    index: 0,
    current() {
      return this.keys[this.index % this.keys.length] || "";
    },
    rotate() {
      if (this.keys.length > 1) this.index++;
    }
  };
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("The request timed out (no response within 90 seconds).");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function statusKey(videoId) {
  return "ccCraftTranslateStatus:" + videoId;
}

async function setStatus(videoId, status) {
  await chrome.storage.local.set({
    [statusKey(videoId)]: { ...status, updated_at: Date.now() }
  });
}

function buildChunkPrompt(chunkCues, lang) {
  const langName = lang?.promptName || "Persian (Farsi)";
  const lines = chunkCues
    .map((cue) => cue.id + "| " + String(cue.source || "").replace(/\s+/g, " ").trim())
    .join("\n");

  return "You are a professional subtitle translator.\n" +
    "Below are numbered subtitle lines from a YouTube video.\n" +
    "Translate the text of each line into " + langName + ".\n\n" +
    "Rules:\n" +
    "1. Output ONLY the translated lines, one per line, in exactly this format:\n" +
    "id| translated text\n" +
    "2. Keep every id unchanged, keep the same order, and translate ALL " + chunkCues.length + " lines. Never merge, split, skip or add lines.\n" +
    "3. Write nothing else: no explanations, no JSON, no code fences.\n" +
    "4. Translations must be short, natural and suitable for on-screen subtitles.\n" +
    "5. If a sentence is incomplete, use the surrounding lines to produce an understandable translation.\n" +
    "6. For technical terms, translate naturally and keep the original term in parentheses when helpful.\n" +
    "7. If a line is only sound or music, write a short tag like \"[music]\" translated into " + langName + ".\n\n" +
    "Lines:\n" + lines;
}

async function callGemini(apiKey, model, prompt) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 8192
      }
    })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error("Gemini HTTP " + response.status + ": " + (data?.error?.message || "Unknown error"));
  }
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("");
  if (!text.trim()) throw new Error("Gemini returned an empty response.");
  return text;
}

// options is used only by caption preprocessing; translation calls pass none and send the same body as before.
async function callOpenAiCompatible(provider, apiKey, model, prompt, options = {}) {
  const config = PROVIDERS[provider];
  const body = {
    model,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? (provider === "nvidia" ? 4096 : 8192),
    messages: [
      {
        role: "system",
        content: options.system ??
          "You are a professional subtitle translator. Reply only with the translated numbered lines in the requested format, no explanations."
      },
      { role: "user", content: prompt }
    ],
    ...(options.extraBody || {})
  };
  const response = await fetchWithTimeout(config.baseUrl + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.error?.message || data?.detail || "Unknown error";
    throw new Error(config.name + " HTTP " + response.status + ": " + detail);
  }
  const text = data?.choices?.[0]?.message?.content || "";
  if (!text.trim()) throw new Error(config.name + " returned an empty response.");
  return text;
}

async function callProvider(provider, apiKey, model, prompt) {
  if (provider === "gemini") return callGemini(apiKey, model, prompt);
  if (provider === "gpt" || provider === "nvidia" || provider === "qwen") {
    return callOpenAiCompatible(provider, apiKey, model, prompt);
  }
  throw new Error("The selected provider is not supported.");
}

function parseTranslations(text) {
  let cleaned = String(text || "").trim();
  cleaned = cleaned.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  const list = [];
  const lineRe = /^\s*(\d+)\s*[|:.)\-]\s*(.*)$/;
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const match = lineRe.exec(rawLine);
    if (!match) continue;
    const fa = match[2].trim();
    if (!fa) continue;
    list.push({ id: Number(match[1]), fa });
  }
  if (!list.length) {
    throw new Error("The model response contained no numbered translation lines.");
  }
  return list;
}

// Fallback: if the model ignored the id| format but returned one translation per line,
// assign ids by position. Only used as a last resort.
function parseTranslationsPositional(text, expectedCount) {
  let cleaned = String(text || "").trim();
  cleaned = cleaned.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines.length < Math.ceil(expectedCount * 0.5)) return [];
  return lines.map((line, i) => ({ id: i + 1, fa: line }));
}

async function translateChunk(provider, keyRing, model, chunkCues, lang) {
  const prompt = buildChunkPrompt(chunkCues, lang);
  const attempts = Math.max(3, keyRing.keys.length);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const text = await callProvider(provider, keyRing.current(), model, prompt);
      try {
        return parseTranslations(text);
      } catch (parseErr) {
        const fallback = parseTranslationsPositional(text, chunkCues.length);
        if (fallback.length) return fallback;
        throw parseErr;
      }
    } catch (err) {
      lastError = err;
      keyRing.rotate();
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError;
}

// ---------- Caption preprocessing (automatic tracks + Nemotron only) ----------

// Opt-out: chrome.storage.local.set({ ccCraftCaptionPreprocessing: { enabled: false } })
const PREPROCESSING_SETTING_KEY = "ccCraftCaptionPreprocessing";

// Returns the workfile to translate: the reconstructed one, or the original on bypass/failure.
// Never throws.
async function preprocessForTranslation(workfile, { provider, apiKey, model, videoId }) {
  const CP = globalThis.CaptionPreprocessing;
  if (!CP) return { workfile, summary: null };
  try {
    const stored = await chrome.storage.local.get(PREPROCESSING_SETTING_KEY).catch(() => ({}));
    const enabled = stored?.[PREPROCESSING_SETTING_KEY]?.enabled !== false;
    if (!CP.shouldPreprocess({ workfile, provider, model, enabled }).run) return { workfile, summary: null };

    const keyRing = makeKeyRing(apiKey);
    const callModel = async (prompt, options) => {
      try {
        return await callOpenAiCompatible(provider, keyRing.current(), model, prompt, {
          ...options,
          // Nemotron reasoning tokens count against max_tokens; preprocessing needs the JSON only.
          extraBody: { chat_template_kwargs: { enable_thinking: false } }
        });
      } catch (err) {
        keyRing.rotate();
        throw err;
      }
    };
    const total = workfile.cues.length;
    await setStatus(videoId, { state: "running", phase: "preprocessing", done: 0, total });
    const { workfile: result, report } = await CP.preprocessWorkfile(workfile, {
      callModel,
      onProgress: (p) => setStatus(videoId, {
        state: "running",
        phase: "preprocessing",
        done: 0,
        total,
        chunksDone: p.chunksDone || 0,
        chunksTotal: p.chunksTotal || 0
      })
    });
    return { workfile: result, summary: CP.summarizeReport(report) };
  } catch (_) {
    return { workfile, summary: { applied: false, reason: "fallback_error", warnings: ["internal_error"] } };
  }
}

async function translateWorkfile({ workfile: originalWorkfile, provider, apiKey, model, tabId, lang }) {
  const videoId = originalWorkfile?.video?.id || "unknown-video";
  const { workfile, summary: preprocessing } = await preprocessForTranslation(originalWorkfile, {
    provider, apiKey, model, videoId
  });
  const cues = Array.isArray(workfile?.cues) ? workfile.cues : [];
  if (!cues.length) {
    await setStatus(videoId, { state: "error", error: "There are no subtitle lines to translate." });
    return;
  }
  const faById = new Map();
  const chunkErrors = [];
  let done = 0;
  const missingCues = () => cues.filter((cue) => !faById.get(Number(cue.id)));
  const keyRing = makeKeyRing(apiKey);
  const countTranslated = () => cues.length - missingCues().length;

  const translateBatch = async (batchCues, chunkSize, retryRound) => {
    const chunks = [];
    for (let i = 0; i < batchCues.length; i += chunkSize) {
      chunks.push(batchCues.slice(i, i + chunkSize));
    }
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        try {
          const translations = await translateChunk(provider, keyRing, model, chunk, lang);
          for (const item of translations) {
            const fa = String(item?.fa || "").trim();
            if (item && item.id != null && fa) {
              faById.set(Number(item.id), fa);
            }
          }
        } catch (chunkErr) {
          chunkErrors.push(chunkErr.message);
        }
        done = countTranslated();
        await setStatus(videoId, {
          state: "running",
          done,
          total: cues.length,
          retryRound: retryRound || 0,
          missing: retryRound ? missingCues().length : 0,
          lastError: chunkErrors[chunkErrors.length - 1] || null
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL_REQUESTS, chunks.length) }, () => worker())
    );
  };

  try {
    await setStatus(videoId, { state: "running", done: 0, total: cues.length });
    await translateBatch(cues, CHUNK_SIZE, 0);

    // If round 1 produced zero translations, the API is broken — show error now
    if (!faById.size) {
      const reason = chunkErrors[0] || "No translations were received from the model.";
      const manualHint =
        'The AI could not translate this video. Please translate it manually: open the "Manual translation" section, download the JSON or prompt, translate it yourself, then load the translated file back.';
      throw new Error(reason + "\n\n" + manualHint);
    }

    for (let round = 1; round <= RETRY_ROUNDS && missingCues().length; round++) {
      await translateBatch(missingCues(), RETRY_CHUNK_SIZE, round);
    }

    const untranslated = missingCues().length;
    if (untranslated > cues.length / 2) {
      const reason = chunkErrors[chunkErrors.length - 1] || "";
      const manualHint =
        'The AI could not translate this video. Please translate it manually: open the "Manual translation" section, download the JSON or prompt, translate it yourself, then load the translated file back.';
      throw new Error(
        untranslated + " of " + cues.length + " lines are still untranslated. " + manualHint +
        (reason ? "\n(" + reason + ")" : "")
      );
    }

    for (const cue of cues) {
      cue.fa = faById.get(Number(cue.id)) || cue.fa || "";
    }

    let res;
    try {
      res = await chrome.tabs.sendMessage(tabId, {
        type: "LOAD_TRANSLATED_JSON",
        workfile,
        subtitleDir: lang?.dir === "ltr" ? "ltr" : "rtl"
      });
    } catch (_) {
      throw new Error("The video tab is no longer available (closed or navigated away). Open the video and translate again.");
    }
    if (!res?.ok) {
      throw new Error(res?.error || "Failed to load the translated subtitles onto the video.");
    }
    await setStatus(videoId, {
      state: "done",
      done: cues.length,
      total: cues.length,
      count: res.count,
      untranslated,
      firstError: untranslated ? (chunkErrors[chunkErrors.length - 1] || null) : null,
      preprocessing
    });
  } catch (err) {
    await setStatus(videoId, {
      state: "error",
      done,
      total: cues.length,
      error: err.message,
      preprocessing
    });
  }
}

// ---------- Model listing ----------

async function listGeminiModels(apiKey) {
  apiKey = splitApiKeys(apiKey)[0] || "";
  const url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200";
  const response = await fetch(url, {
    headers: { "x-goog-api-key": apiKey }
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error("Gemini HTTP " + response.status + ": " + (data?.error?.message || "Unknown error (check your API key)"));
  }
  const models = (data?.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => String(m.name || "").replace(/^models\//, ""))
    .filter(Boolean)
    .sort();
  if (!models.length) throw new Error("No usable models were returned by Gemini.");
  return models;
}

async function listOpenAiCompatibleModels(provider, apiKey) {
  apiKey = splitApiKeys(apiKey)[0] || "";
  const config = PROVIDERS[provider];
  const response = await fetch(config.baseUrl + "/models", {
    headers: { Authorization: "Bearer " + apiKey }
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.error?.message || data?.detail || "Unknown error (check your API key)";
    throw new Error(config.name + " HTTP " + response.status + ": " + detail);
  }
  let models = (data?.data || []).map((m) => String(m.id || "")).filter(Boolean);
  if (provider === "gpt") {
    models = models.filter(
      (id) =>
        /^(gpt-|o\d|chatgpt-)/.test(id) &&
        !/(embed|whisper|tts|audio|image|dall-e|moderation|realtime|transcribe|search|instruct)/i.test(id)
    );
  }
  models = [...new Set(models)].sort();
  if (!models.length) throw new Error("No usable models were returned by " + config.name + ".");
  return models;
}

async function listModels(provider, apiKey) {
  if (provider === "gemini") return listGeminiModels(apiKey);
  if (provider === "gpt" || provider === "nvidia" || provider === "qwen") {
    return listOpenAiCompatibleModels(provider, apiKey);
  }
  throw new Error("The selected provider is not supported.");
}

// ---------- Word lookup (language learning) ----------

const wordCache = new Map();

async function translateWord(word, from, to) {
  const cacheKey = from + ":" + to + ":" + String(word).toLowerCase();
  if (wordCache.has(cacheKey)) return wordCache.get(cacheKey);
  const url =
    "https://" + "translate.googleapis.com/translate_a/single" +
    "?client=gtx&dt=t&dt=bd&ie=UTF-8&oe=UTF-8" +
    "&sl=" + encodeURIComponent(from || "auto") +
    "&tl=" + encodeURIComponent(to || "en") +
    "&q=" + encodeURIComponent(word);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Google Translate HTTP " + response.status);
  }
  const data = await response.json();
  const translation = (Array.isArray(data?.[0]) ? data[0] : [])
    .map((seg) => seg?.[0] || "")
    .join("")
    .trim();
  const dict = [];
  if (Array.isArray(data?.[1])) {
    for (const entry of data[1]) {
      const pos = entry?.[0];
      const terms = Array.isArray(entry?.[1]) ? entry[1].slice(0, 3) : [];
      if (terms.length) dict.push((pos ? pos + ": " : "") + terms.join(", "));
    }
  }
  const result = { translation, dict: dict.slice(0, 3) };
  if (wordCache.size > 500) wordCache.clear();
  wordCache.set(cacheKey, result);
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TRANSLATE_WORD") {
    translateWord(message.word, message.from, message.to)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "LIST_MODELS") {
    listModels(message.provider, message.apiKey)
      .then((models) => sendResponse({ ok: true, models }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message?.type === "TRANSLATE_WORKFILE") {
    translateWorkfile(message).catch(console.warn);
    sendResponse({ ok: true, started: true });
    return;
  }
  if (message?.type === "GET_TRANSLATE_STATUS") {
    chrome.storage.local.get(statusKey(message.videoId)).then((result) => {
      sendResponse({ ok: true, status: result[statusKey(message.videoId)] || null });
    });
    return true;
  }
});
