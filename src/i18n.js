// Interface strings for the popup and the on-video hints, in English and Traditional Chinese.
// Loaded by popup/popup.html and, before src/content.js, by the content script (manifest.json).
// Subtitle text, provider and model names, and error text from other parts of the extension
// are not translated here.
(function (root) {
  "use strict";

  const UI_LANGUAGES = [
    { code: "en", label: "English", htmlLang: "en" },
    { code: "zh-TW", label: "繁體中文", htmlLang: "zh-Hant" }
  ];

  const STRINGS = {
    en: {
      // popup.html
      sub: "AI-crafted subtitles for YouTube",
      uiLanguageLabel: "Language",
      stepTranslate: "Translate",
      targetLanguage: "Target language",
      aiProvider: "AI provider",
      apiKeyLabel: "API key(s) — add more than one, separated by commas, for automatic fallback",
      apiKeyPlaceholder: "key1, key2, ...",
      modelLabel: "Model",
      fetchModels: "Fetch model list",
      autoTranslate: "Translate & show subtitles",
      keyHint: "Your API key is stored only in your browser and sent directly to the selected provider.",
      stepAppearance: "Subtitle appearance",
      subColor: "Subtitle color",
      fontSizeLabel: "Font size:",
      bottomLabel: "Distance from bottom:",
      showSubtitles: "Show subtitles on the video",
      stepLearning: "Language learning",
      showOn: "Show on the video",
      modeTranslation: "Translation only",
      modeTranslationHint: "Only the translated line.",
      modeBilingual: "Translation + original",
      modeBilingualHint: "Translated line with the original under it.",
      modeOriginal: "Original only",
      modeOriginalHint: "The original line, full size. Hover a word for its meaning.",
      wordLookup: "Word lookup on the original subtitle",
      learningHint: "Hover a word in the original subtitle to see its meaning in your target language, and click the word to hear its pronunciation (powered by Google Translate). The video pauses while you hover.",
      tracksSummary: "Available subtitle tracks",
      sourceTrack: "Source track",
      loading: "Loading...",
      refreshTracks: "Refresh tracks",
      tracksHint: "The real caption URL is captured from the YouTube player itself, not from the raw baseUrl.",
      manualSummary: "Manual translation",
      downloadJson: "Download JSON for translation",
      downloadPrompt: "Download ready-made prompt",
      loadTranslated: "Load translated JSON onto the video",
      clearSubs: "Clear subtitles for this video",

      // popup.js
      keyMissing: "Enter your {provider} API key first.",
      keyDuplicate: "Duplicate key {key} — remove the repeated key.",
      keyWrongProvider: "Key {key} does not look like a {provider} key.",
      keyMixedProviders: "Keys {first} and {other} do not look like keys from the same provider. All keys must belong to one provider.",
      ppApplied: "🧩 Automatic captions reconstructed before translation: {raw} → {cues} lines",
      ppFallbackParts: " ({fallback} of {total} parts kept as original)",
      ppFailed: "⚠️ Caption preprocessing failed, the original captions were translated instead ({reason}).",
      runPreprocessing: "⏳ Reconstructing automatic captions before translation{part}...",
      runPart: " (part {done} of {total})",
      runProgress: "⏳ {prefix} {done} of {total} lines translated ({percent}%)",
      runRetry: "🔁 Retry round {round} of 2 for {missing} untranslated lines...",
      runLastError: "⚠️ Last error: {error}",
      runBackgroundNote: "You can close this popup — translation continues in the background.",
      prefixTranslating: "Translating...",
      prefixBackground: "Translation running in the background...",
      done: "✅ Translation finished — subtitles are live on the video.\nTranslated lines: {count}",
      doneElsewhere: "✅ Translation finished. You moved to another video meanwhile, so the subtitles were saved for the video you translated and show when you open it again.\nTranslated lines: {count}",
      doneUntranslated: "⚠️ {count} lines could not be translated even after retries ({error}). Translate again or try another model.",
      unknownError: "unknown error",
      openYoutube: "Open a YouTube video first.",
      notActive: "The extension is not active on this page. Refresh the YouTube page and try again.",
      noTracksFound: "No subtitle tracks found.",
      noExtractableOption: "No extractable subtitles",
      noExtractable: "This video has no extractable subtitles.",
      trackUnknown: "Unknown",
      trackAuto: "auto",
      trackManual: "manual",
      tracksReady: "Tracks ready. Found: {count}",
      tracksFailedOption: "Failed to read tracks",
      keyStoreWarning: "⚠️ API keys can't be saved in this window (private window, or the browser blocked the extension's storage). A key you enter now works until the popup closes; keys saved earlier are not changed.",
      modelEnterKeyFirst: "Enter your API key first",
      modelFetchHint: "Click “Fetch model list”",
      modelsFetching: "Fetching models...",
      modelsDetecting: "Detecting available {provider} models...",
      modelsFetchFailed: "Failed to fetch the model list.",
      modelsDetected: "{count} {provider} models detected. Pick one from the menu.",
      autoFailed: "❌ Auto-translate failed:\n{error}",
      interrupted: "⚠️ The previous translation was interrupted (the browser or extension probably restarted). Click Translate again.",
      lastFailed: "❌ The last auto-translate for this video failed:\n{error}",
      pickModel: "Fetch the model list and pick a model first.",
      step1: "⏳ Step 1 of 2: extracting subtitles from the player...",
      extractFailed: "Failed to extract subtitles.",
      longVideo: "⚠️ This video has {count} subtitle lines. For videos this long, AI translation may be slow or fail.\nYou can translate manually: download the JSON or prompt from the \"Manual translation\" section, translate it yourself, then load it back.\n\nStarting AI translation anyway...",
      step2: "⏳ Step 2 of 2: translating {count} lines to {lang} with {provider} ({model})...",
      startFailed: "Could not start the background translation. Reload the extension in chrome://extensions once.",
      capturingUrl: "⏳ Temporarily enabling captions and capturing the real URL...",
      exportFailed: "Export failed.",
      jsonDownloaded: "JSON downloaded.\nLines: {count}\nLanguage: {language}\nFormat: {format}",
      unknownLanguage: "unknown",
      buildingPrompt: "⏳ Building the ready-made prompt...",
      promptExportFailed: "Prompt export failed.",
      promptDownloaded: "Prompt TXT downloaded.\nLines: {count}\nFormat: {format}",
      chooseFile: "Choose the translated JSON file first.",
      fileEmpty: "The selected file is empty.",
      fileBadJson: "The JSON file is incomplete or corrupted. The model output must be valid JSON only.",
      loadingTranslated: "⏳ Loading translated subtitles...",
      loadFailed: "Loading failed.",
      liveOnVideo: "✅ Subtitles are live on the video.\nLines: {count}",
      clearFailed: "Clearing failed.",
      cleared: "Subtitles for this video were cleared.",

      // content.js (on the video)
      flashEnabled: "✓ Subtitles enabled ({count} lines)",
      wordLookupFailed: "Translation failed.",
      wordHear: "🔊 click the word to hear it"
    },

    "zh-TW": {
      sub: "用 AI 製作 YouTube 字幕",
      uiLanguageLabel: "介面語言",
      stepTranslate: "翻譯",
      targetLanguage: "目標語言",
      aiProvider: "AI 供應商",
      apiKeyLabel: "API key（可以填多個，用逗號隔開，一個失敗會自動換下一個）",
      apiKeyPlaceholder: "key1, key2, ...",
      modelLabel: "模型",
      fetchModels: "取得模型清單",
      autoTranslate: "翻譯並顯示字幕",
      keyHint: "API key 只存在你的瀏覽器裡，直接送到你選的供應商。",
      stepAppearance: "字幕外觀",
      subColor: "字幕顏色",
      fontSizeLabel: "字級：",
      bottomLabel: "離底部距離：",
      showSubtitles: "在影片上顯示字幕",
      stepLearning: "語言學習",
      showOn: "影片上顯示",
      modeTranslation: "只顯示譯文",
      modeTranslationHint: "只有翻譯那一行。",
      modeBilingual: "譯文＋原文",
      modeBilingualHint: "譯文下面加上原文。",
      modeOriginal: "只顯示原文",
      modeOriginalHint: "原文用主字幕的大小顯示。滑過單字看意思。",
      wordLookup: "在原文字幕上查單字",
      learningHint: "滑鼠移到原文字幕的單字上，會顯示它在目標語言的意思；點單字可以聽發音（由 Google 翻譯提供）。滑過單字時影片會暫停。",
      tracksSummary: "可用的字幕軌",
      sourceTrack: "來源字幕軌",
      loading: "載入中…",
      refreshTracks: "重新整理字幕軌",
      tracksHint: "字幕的實際網址是從 YouTube 播放器本身擷取的，不是用原始的 baseUrl。",
      manualSummary: "手動翻譯",
      downloadJson: "下載要翻譯的 JSON",
      downloadPrompt: "下載現成的 prompt",
      loadTranslated: "把翻好的 JSON 載入影片",
      clearSubs: "清除這部影片的字幕",

      keyMissing: "請先輸入 {provider} 的 API key。",
      keyDuplicate: "{key} 重複了，請刪掉重複的那一個。",
      keyWrongProvider: "{key} 看起來不是 {provider} 的 key。",
      keyMixedProviders: "{first} 和 {other} 看起來不是同一個供應商的 key。所有 key 都要屬於同一個供應商。",
      ppApplied: "🧩 翻譯前已重組自動字幕：{raw} → {cues} 行",
      ppFallbackParts: "（{total} 段中有 {fallback} 段保留原樣）",
      ppFailed: "⚠️ 字幕前處理失敗，改為直接翻譯原本的字幕（{reason}）。",
      runPreprocessing: "⏳ 翻譯前正在重組自動字幕{part}…",
      runPart: "（第 {done} 段，共 {total} 段）",
      runProgress: "⏳ {prefix}已翻譯 {done} / {total} 行（{percent}%）",
      runRetry: "🔁 第 {round} 輪重試（共 2 輪），還有 {missing} 行沒翻譯…",
      runLastError: "⚠️ 最近一次錯誤：{error}",
      runBackgroundNote: "可以關掉這個視窗，翻譯會在背景繼續。",
      prefixTranslating: "翻譯中…",
      prefixBackground: "正在背景翻譯…",
      done: "✅ 翻譯完成，字幕已顯示在影片上。\n已翻譯行數：{count}",
      doneElsewhere: "✅ 翻譯完成。你在翻譯時換到了別部影片，字幕存在原本翻譯的那部，回去就會顯示。\n已翻譯行數：{count}",
      doneUntranslated: "⚠️ 重試後仍有 {count} 行沒翻成（{error}）。請再翻一次，或換一個模型。",
      unknownError: "未知錯誤",
      openYoutube: "請先打開一部 YouTube 影片。",
      notActive: "這個頁面上的擴充功能還沒啟動。請重新整理 YouTube 頁面再試一次。",
      noTracksFound: "找不到字幕軌。",
      noExtractableOption: "沒有可擷取的字幕",
      noExtractable: "這部影片沒有可擷取的字幕。",
      trackUnknown: "未知",
      trackAuto: "自動",
      trackManual: "手動",
      tracksReady: "字幕軌已就緒，共 {count} 條。",
      tracksFailedOption: "讀取字幕軌失敗",
      keyStoreWarning: "⚠️ 這個視窗沒辦法儲存 API key（無痕視窗，或瀏覽器擋住了擴充功能的儲存空間）。現在輸入的 key 在關掉視窗前都能用；之前存的 key 不受影響。",
      modelEnterKeyFirst: "請先輸入 API key",
      modelFetchHint: "請按「取得模型清單」",
      modelsFetching: "正在取得模型…",
      modelsDetecting: "正在偵測 {provider} 可用的模型…",
      modelsFetchFailed: "取得模型清單失敗。",
      modelsDetected: "偵測到 {count} 個 {provider} 模型，請從選單選一個。",
      autoFailed: "❌ 自動翻譯失敗：\n{error}",
      interrupted: "⚠️ 上一次翻譯中斷了（可能是瀏覽器或擴充功能重新啟動）。請再按一次翻譯。",
      lastFailed: "❌ 這部影片上一次自動翻譯失敗：\n{error}",
      pickModel: "請先取得模型清單並選一個模型。",
      step1: "⏳ 第 1 步，共 2 步：正在從播放器擷取字幕…",
      extractFailed: "擷取字幕失敗。",
      longVideo: "⚠️ 這部影片有 {count} 行字幕。這麼長的影片，AI 翻譯可能很慢或失敗。\n你可以手動翻譯：從「手動翻譯」區塊下載 JSON 或 prompt，自己翻好再載入。\n\n仍然開始 AI 翻譯…",
      step2: "⏳ 第 2 步，共 2 步：用 {provider}（{model}）把 {count} 行翻成 {lang}…",
      startFailed: "無法開始背景翻譯。請到 chrome://extensions 重新載入擴充功能一次。",
      capturingUrl: "⏳ 暫時開啟字幕並擷取實際網址…",
      exportFailed: "匯出失敗。",
      jsonDownloaded: "已下載 JSON。\n行數：{count}\n語言：{language}\n格式：{format}",
      unknownLanguage: "未知",
      buildingPrompt: "⏳ 正在產生現成的 prompt…",
      promptExportFailed: "匯出 prompt 失敗。",
      promptDownloaded: "已下載 prompt TXT。\n行數：{count}\n格式：{format}",
      chooseFile: "請先選擇翻好的 JSON 檔。",
      fileEmpty: "選的檔案是空的。",
      fileBadJson: "這個 JSON 檔不完整或已損壞。模型輸出必須是有效的 JSON，不能有其他內容。",
      loadingTranslated: "⏳ 正在載入翻好的字幕…",
      loadFailed: "載入失敗。",
      liveOnVideo: "✅ 字幕已顯示在影片上。\n行數：{count}",
      clearFailed: "清除失敗。",
      cleared: "已清除這部影片的字幕。",

      flashEnabled: "✓ 字幕已開啟（{count} 行）",
      wordLookupFailed: "翻譯失敗。",
      wordHear: "🔊 點單字聽發音"
    }
  };

  // A saved choice wins; otherwise any Chinese browser language gets 繁體中文, everything else English.
  function uiLanguageOf(saved, browserLanguage) {
    if (STRINGS[saved]) return saved;
    return /^zh\b/i.test(String(browserLanguage || "")) ? "zh-TW" : "en";
  }

  function htmlLangOf(code) {
    return (UI_LANGUAGES.find((l) => l.code === code) || UI_LANGUAGES[0]).htmlLang;
  }

  // Looks up a string (falling back to English, then to the key) and fills {name} placeholders.
  // A placeholder without a value is left as written.
  function translate(lang, key, vars) {
    const table = STRINGS[lang] || STRINGS.en;
    const text = table[key] ?? STRINGS.en[key] ?? key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) && vars[name] != null ? String(vars[name]) : match
    );
  }

  root.CcCraftI18n = { UI_LANGUAGES, STRINGS, uiLanguageOf, htmlLangOf, translate };
})(globalThis);
