// Installs the `window.storage` key-value API the app expects — the same
// shape available inside Claude.ai artifacts: async get(key, shared),
// set(key, value, shared), delete(key, shared), list(prefix, shared).
// Only "ledger-data" (the key App.jsx reads/writes via persist()) is
// backed by the Symfony backend; everything else (today, just
// "ledger-selected-account", a per-browser UI convenience rather than
// ledger data) still goes to localStorage — no reason to round-trip that
// through the API.
//
// Talks to relative /api/... paths, proxied to the Symfony backend by
// Vite's dev server (see vite.config.js) so there's no CORS setup needed.

const PREFIX = "ledger-storage:";

function keyFor(key, shared) {
  return PREFIX + (shared ? "shared:" : "personal:") + key;
}

const localFallback = {
  get(key, shared) {
    const raw = localStorage.getItem(keyFor(key, shared));
    if (raw === null) {
      throw new Error(`Key not found: ${key}`);
    }
    return { key, value: raw, shared };
  },
  set(key, value, shared) {
    localStorage.setItem(keyFor(key, shared), value);
    return { key, value, shared };
  },
  delete(key, shared) {
    const k = keyFor(key, shared);
    const existed = localStorage.getItem(k) !== null;
    localStorage.removeItem(k);
    return { key, deleted: existed, shared };
  },
};

async function apiGetState() {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`GET /api/state failed: ${res.status}`);
  return res.json();
}

async function apiPutState(state) {
  const res = await fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error(`PUT /api/state failed: ${res.status}`);
  return res.json();
}

if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key, shared = false) {
      if (key === "ledger-data") {
        const state = await apiGetState();
        return { key, value: JSON.stringify(state), shared };
      }
      return localFallback.get(key, shared);
    },

    async set(key, value, shared = false) {
      if (key === "ledger-data") {
        await apiPutState(JSON.parse(value));
        return { key, value, shared };
      }
      return localFallback.set(key, value, shared);
    },

    async delete(key, shared = false) {
      return localFallback.delete(key, shared);
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
