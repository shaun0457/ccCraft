// Test helpers: run the real extension sources in Node without a browser.
// - loadContentParsers(): extracts the caption parser functions from src/content.js verbatim.
// - loadBackground(): runs src/background.js (and whatever it importScripts) in a vm context
//   with a minimal chrome.* mock and an injectable fetch.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "..", "src");

function extractFunction(source, name) {
  // Keeps a leading "async " so extracted async functions can still await.
  const start = source.search(new RegExp("(async )?function " + name + "\\("));
  if (start < 0) throw new Error("function not found in content.js: " + name);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces for " + name);
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " " };

function loadContentParsers() {
  const source = fs.readFileSync(path.join(SRC, "content.js"), "utf8");
  const names = ["decodeHtml", "cleanText", "secondsToTimestamp", "json3WordTimes", "parseJson3", "fixCueTiming", "exportableWorkfile", "subtitleModeOf", "overlayLines"];
  const documentStub = {
    createElement() {
      let value = "";
      return {
        set innerHTML(html) {
          value = String(html).replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]);
        },
        get value() {
          return value;
        }
      };
    }
  };
  const ctx = vm.createContext({ document: documentStub });
  vm.runInContext(names.map((n) => extractFunction(source, n)).join("\n\n"), ctx);
  return Object.fromEntries(names.map((n) => [n, ctx[n]]));
}

// browser "chrome": service worker, background.js pulls the module in with importScripts.
// browser "firefox": background page, no importScripts; manifest background.scripts load in order.
function loadBackground({ fetchImpl, storage = {}, tabResponses, browser = "chrome" } = {}) {
  const store = { ...storage };
  const sentToTabs = [];
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return key in store ? { [key]: store[key] } : {};
          return { ...store };
        },
        async set(obj) {
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
        },
        async remove(key) {
          delete store[key];
        }
      }
    },
    tabs: {
      async sendMessage(tabId, message) {
        sentToTabs.push({ tabId, message: JSON.parse(JSON.stringify(message)) });
        if (tabResponses) return tabResponses(message);
        return { ok: true, count: (message.workfile?.cues || []).length };
      }
    }
  };
  const ctx = vm.createContext({
    chrome,
    fetch: (...args) => fetchImpl(...args),
    AbortController,
    setTimeout,
    clearTimeout,
    console,
    URL,
    structuredClone
  });
  ctx.globalThis = ctx;
  if (browser === "firefox") {
    const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "..", "manifest.json"), "utf8"));
    for (const file of manifest.background.scripts) {
      vm.runInContext(fs.readFileSync(path.join(SRC, "..", file), "utf8"), ctx, { filename: file });
    }
  } else {
    ctx.importScripts = (...files) => {
      for (const file of files) {
        vm.runInContext(fs.readFileSync(path.join(SRC, file), "utf8"), ctx, { filename: file });
      }
    };
    vm.runInContext(fs.readFileSync(path.join(SRC, "background.js"), "utf8"), ctx, { filename: "background.js" });
  }
  return { ctx, store, sentToTabs };
}

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, "..", "fixtures", name), "utf8");
}

// Builds a workfile exactly like content.js buildWorkfile does, from a fixture caption file.
function workfileFromJson3(name, kind = "asr") {
  const parsers = loadContentParsers();
  const cues = parsers.fixCueTiming(parsers.parseJson3(readFixture(name)));
  return {
    schema: "cccraft-subtitle-v1.1",
    video: { id: "fixture-video", title: "Synthetic technical clip", url: "https://www.youtube.com/watch?v=fixture-video", duration_seconds: 60 },
    source_track: { languageCode: "en", label: "English (auto-generated)", kind, vssId: "a.en", read_format: "json3-player-url" },
    generated_at: "2026-11-25T00:00:00.000Z",
    model_prompt: "(omitted in fixture)",
    cues: JSON.parse(JSON.stringify(cues))
  };
}

module.exports = { extractFunction, loadContentParsers, loadBackground, readFixture, workfileFromJson3 };
