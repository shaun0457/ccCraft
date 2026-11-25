/*
 * API key storage for the popup.
 *
 * Keys live in the extension origin's IndexedDB, which only extension pages (popup, background)
 * can open. chrome.storage.local is readable by the content script on every YouTube page, so
 * keys are no longer written there. Other API settings (provider, model, target language) stay
 * in chrome.storage.local under ccCraftApiSettings, without a `keys` field.
 *
 * Keys saved by older versions (ccCraftApiSettings.keys) are moved into IndexedDB when the
 * popup opens, then removed from chrome.storage.local.
 *
 * When the stored keys cannot be read (IndexedDB fails or takes longer than OP_TIMEOUT_MS, or
 * the popup runs in a Firefox private window, which may get a separate temporary database),
 * the popup is in "keys unknown" mode for that session: it never writes keys anywhere, so it
 * cannot overwrite the saved ones with empty values, and any legacy keys field in
 * chrome.storage.local is left exactly as it was. Keys entered in that mode are used for the
 * session only; the popup shows a warning.
 */
(function (root) {
  const SETTINGS_KEY = "ccCraftApiSettings";
  const DB_NAME = "ccCraftSecrets";
  const STORE = "kv";
  const RECORD = "apiKeys";
  const OP_TIMEOUT_MS = 3000;

  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("key store timeout")), ms);
      })
    ]).finally(() => clearTimeout(timer));
  }

  function createIdbStore(idb, { timeoutMs = OP_TIMEOUT_MS } = {}) {
    function open() {
      return new Promise((resolve, reject) => {
        if (!idb || typeof idb.open !== "function") {
          reject(new Error("indexedDB unavailable"));
          return;
        }
        let settled = false;
        const request = idb.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(STORE);
        };
        request.onsuccess = () => {
          if (settled) {
            // The caller already gave up (blocked); do not leak the connection.
            request.result.close();
            return;
          }
          settled = true;
          resolve(request.result);
        };
        request.onerror = () => {
          settled = true;
          reject(new Error("indexedDB open failed"));
        };
        request.onblocked = () => {
          settled = true;
          reject(new Error("indexedDB open blocked"));
        };
      });
    }

    function run(mode, operate) {
      const work = open().then(
        (db) =>
          new Promise((resolve, reject) => {
            let value;
            let tx;
            try {
              tx = db.transaction(STORE, mode);
              const request = operate(tx.objectStore(STORE));
              request.onsuccess = () => {
                value = request.result;
              };
            } catch (_) {
              db.close();
              reject(new Error("indexedDB transaction failed"));
              return;
            }
            tx.oncomplete = () => {
              db.close();
              resolve(value);
            };
            tx.onerror = () => {
              db.close();
              reject(new Error("indexedDB transaction failed"));
            };
            tx.onabort = () => {
              db.close();
              reject(new Error("indexedDB transaction aborted"));
            };
          })
      );
      // A timeout only stops waiting; IndexedDB runs transactions on one database in the order
      // they were created, so a late write cannot land after a later one.
      return withTimeout(work, timeoutMs);
    }

    return {
      get: () => run("readonly", (store) => store.get(RECORD)),
      set: (keys) => run("readwrite", (store) => store.put(keys, RECORD))
    };
  }

  function cleanKeys(keys) {
    const out = {};
    if (!keys || typeof keys !== "object" || Array.isArray(keys)) return out;
    for (const [provider, value] of Object.entries(keys)) {
      if (typeof value === "string") out[provider] = value;
    }
    return out;
  }

  function withoutKeys(settings) {
    const rest = { ...(settings || {}) };
    delete rest.keys;
    return rest;
  }

  /*
   * createApiSettingsStore({ storage, secretStore, incognito }) -> { load, save, state }
   *   load()          -> { settings, keys, secure }; `settings` never contains keys.
   *   save(settings)  -> { saved, secure }. `settings.keys` holds the keys. Saves run one at a
   *                      time in call order. A save before load() finished is skipped.
   *   secure === false means keys are not being saved this session ("keys unknown" mode or a
   *   failed write); the popup shows a warning.
   */
  function createApiSettingsStore({ storage, secretStore, incognito = false }) {
    let mode = null; // null = not loaded, "secure", "unknown"
    let legacyField; // raw ccCraftApiSettings.keys kept as-is in "unknown" mode
    let chain = Promise.resolve();

    async function load() {
      const result = await storage.get(SETTINGS_KEY);
      const raw = result?.[SETTINGS_KEY];
      const stored = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      const hasLegacy = Object.prototype.hasOwnProperty.call(stored, "keys");
      const legacy = cleanKeys(stored.keys);
      const settings = withoutKeys(stored);

      const unknown = () => {
        mode = "unknown";
        legacyField = hasLegacy ? stored.keys : undefined;
        return { settings, keys: legacy, secure: false };
      };

      if (incognito) return unknown();

      let saved;
      try {
        saved = cleanKeys(await secretStore.get());
      } catch (_) {
        return unknown();
      }

      if (!hasLegacy) {
        mode = "secure";
        return { settings, keys: saved, secure: true };
      }

      // Keys in storage.local come from an older version: they are newer than any copy here.
      const keys = { ...saved, ...legacy };
      try {
        await secretStore.set(keys);
      } catch (_) {
        return unknown();
      }
      try {
        await storage.set({ [SETTINGS_KEY]: settings });
      } catch (_) {
        // Keys are safe in IndexedDB; the legacy copy is removed by the next save.
      }
      // Only now: a save that arrives during the strip above still holds the popup's empty
      // defaults and must be skipped, not written over the keys just migrated.
      mode = "secure";
      return { settings, keys, secure: true };
    }

    async function saveNow(settings) {
      if (mode === null) return { saved: false, secure: false };
      const rest = withoutKeys(settings);

      if (mode === "unknown") {
        await storage.set({ [SETTINGS_KEY]: legacyField === undefined ? rest : { ...rest, keys: legacyField } });
        return { saved: true, secure: false };
      }

      let keysSaved = true;
      try {
        await secretStore.set(cleanKeys(settings?.keys));
      } catch (_) {
        keysSaved = false; // the previously saved keys stay in IndexedDB
      }
      await storage.set({ [SETTINGS_KEY]: rest });
      return { saved: true, secure: keysSaved };
    }

    function save(settings) {
      const run = chain.then(() => saveNow(settings));
      chain = run.catch(() => {});
      return run;
    }

    return {
      load,
      save,
      get state() {
        return mode;
      }
    };
  }

  const api = { createIdbStore, createApiSettingsStore, cleanKeys, SETTINGS_KEY, DB_NAME, STORE, RECORD, OP_TIMEOUT_MS };
  root.CcCraftKeyStore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
