// Typed client for the Symfony backend's discrete endpoints (see
// backend/src/Controller/ and CLAUDE.md's "Backend" section). Talks to
// relative /api/... paths, proxied to the backend by Vite's dev server
// (see vite.config.js) so there's no CORS setup needed.
//
// Every write here is a single, independently-atomic call, except
// applyTransactionOperations() — the one place several entities still
// need to change together (merging two entries, splitting a removed line
// off into its own record, reordering several same-date rows), so it
// takes an ordered list of operations the backend applies in one DB
// transaction.

async function request(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    throw new Error(`${options?.method || "GET"} ${path} failed: ${res.status}`);
  }
  return res.json();
}

function jsonBody(body) {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function getState() {
  return request("/api/state");
}

export function putAccount(account) {
  return request(`/api/accounts/${encodeURIComponent(account.id)}`, {
    method: "PUT",
    ...jsonBody(account),
  });
}

// Returns { transactions } — the fresh list, since deleting an account can
// also delete transactions that become fully empty as a result.
export function deleteAccount(id) {
  return request(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function putSettings(settings) {
  return request("/api/settings", { method: "PUT", ...jsonBody(settings) });
}

// operations: Array<{ op: "upsert", transaction: { id, lines } } | { op: "delete", id }>
// Returns { transactions } — the fresh list after applying every operation.
export function applyTransactionOperations(operations) {
  return request("/api/transactions/batch", { method: "POST", ...jsonBody({ operations }) });
}
