// Minimal async IndexedDB: enough for createIdbStore (open/upgrade, one store, get/put).
function fakeIndexedDB({ openMode = "ok", txMode = "ok" } = {}) {
  const dbs = new Map();
  const stats = { opened: 0, closed: 0 };
  const later = (fn) => setTimeout(fn, 0);
  return {
    stats,
    dbs,
    open(name) {
      const request = {};
      if (openMode === "hang") return request;
      later(() => {
        if (openMode === "error") return request.onerror && request.onerror();
        if (openMode === "blocked") return request.onblocked && request.onblocked();
        let stores = dbs.get(name);
        const fresh = !stores;
        if (fresh) dbs.set(name, (stores = new Map()));
        stats.opened++;
        const db = {
          createObjectStore(s) {
            stores.set(s, new Map());
          },
          close() {
            stats.closed++;
          },
          transaction(s, mode) {
            if (txMode === "throw") throw new Error("tx");
            const store = stores.get(s);
            const tx = {};
            tx.objectStore = () => ({
              get(k) {
                const r = {};
                later(() => {
                  r.result = structuredClone(store.get(k));
                  r.onsuccess && r.onsuccess();
                  later(() => (txMode === "abort" ? tx.onabort() : tx.oncomplete()));
                });
                return r;
              },
              put(v, k) {
                if (mode !== "readwrite") throw new Error("readonly");
                const r = {};
                later(() => {
                  if (txMode === "abort") return tx.onabort();
                  if (txMode === "error") return tx.onerror();
                  store.set(k, structuredClone(v));
                  r.onsuccess && r.onsuccess();
                  later(() => tx.oncomplete());
                });
                return r;
              }
            });
            return tx;
          }
        };
        request.result = db;
        if (fresh && request.onupgradeneeded) request.onupgradeneeded();
        request.onsuccess && request.onsuccess();
      });
      return request;
    }
  };
}

module.exports = { fakeIndexedDB };
