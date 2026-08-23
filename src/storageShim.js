// Polyfills the `window.storage` key-value API that the Ledger component
// expects (the same API available inside Claude.ai artifacts), backed by
// the browser's localStorage so data persists between visits when this
// app runs as a normal standalone site.
//
// Only installs itself if window.storage isn't already provided by the
// host environment, so this is safe to keep even if you later embed the
// app somewhere that supplies its own implementation.

const PREFIX = "ledger-storage:";

function keyFor(key, shared) {
  return PREFIX + (shared ? "shared:" : "personal:") + key;
}

if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key, shared = false) {
      const raw = localStorage.getItem(keyFor(key, shared));
      if (raw === null) {
        throw new Error(`Key not found: ${key}`);
      }
      return { key, value: raw, shared };
    },

    async set(key, value, shared = false) {
      localStorage.setItem(keyFor(key, shared), value);
      return { key, value, shared };
    },

    async delete(key, shared = false) {
      const k = keyFor(key, shared);
      const existed = localStorage.getItem(k) !== null;
      localStorage.removeItem(k);
      return { key, deleted: existed, shared };
    },

    async list(prefix = "", shared = false) {
      const base = PREFIX + (shared ? "shared:" : "personal:");
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(base + prefix)) keys.push(k.slice(base.length));
      }
      return { keys, prefix, shared };
    },
  };
}
