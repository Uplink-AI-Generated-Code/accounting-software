// Typed client for the Symfony backend's discrete endpoints (see
// backend/src/Controller/ and CLAUDE.md's "Backend" section). Talks to
// relative /api/... paths, proxied to the backend by Vite's dev server
// (see vite.config.js) so there's no CORS setup needed.
//
// The app is a per-account editor, not a "load everything" app: getAccounts()
// is the one thing kept loaded app-wide (a lightweight list with computed
// balances, no line-level data — cheap even as the ledger grows), while
// getAccountLedger() is fetched per account view and discarded on
// navigating away. Matching (getMatchCandidates) and the ISA allowance
// engine (getIsaAllowance) both used to require the whole ledger loaded
// client-side to search/simulate over — they're real backend queries now.
//
// applyTransactionOperations() is the one write that still takes a list —
// merging two entries, splitting a removed line off into its own record,
// and reordering several same-date rows all need several rows to change
// together atomically. Plain account/settings writes are single-resource.

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

// The lightweight, app-wide account list — sidebar, Overview, account
// pickers. Each account carries its own balance and (for investment
// accounts) costBasis/portfolioValue, computed server-side.
export function getAccounts() {
  return request("/api/accounts");
}

export function putAccount(account) {
  return request(`/api/accounts/${encodeURIComponent(account.id)}`, {
    method: "PUT",
    ...jsonBody(account),
  });
}

export function deleteAccount(id) {
  return request(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Every transaction touching one account, complete with all of its lines
// — fetched when a ledger screen opens, discarded when it closes.
export function getAccountLedger(id) {
  return request(`/api/accounts/${encodeURIComponent(id)}/ledger`);
}

export function getSettings() {
  return request("/api/settings");
}

export function putSettings(settings) {
  return request("/api/settings", { method: "PUT", ...jsonBody(settings) });
}

// operations: Array<{ op: "upsert", transaction: { id, lines } } | { op: "delete", id }>
export function applyTransactionOperations(operations) {
  return request("/api/transactions/batch", { method: "POST", ...jsonBody({ operations }) });
}

// mode: "mirrored" (default) or "direct" — see lib/matching.js's old
// getComparableAmount vs getDirectComparableAmount for what these meant
// client-side; the same distinction now lives in the backend's
// MatchingService. excludeAccountIds keeps a match from offering an
// account already in play in the current draft.
export async function getMatchCandidates({ currency, amount, date, excludeTransactionId, excludeAccountIds, mode = "mirrored" }) {
  const params = new URLSearchParams({ currency, amount: String(amount), date, mode });
  if (excludeTransactionId) params.set("excludeTransactionId", excludeTransactionId);
  if (excludeAccountIds && excludeAccountIds.length) params.set("excludeAccountIds", excludeAccountIds.join(","));
  const results = await request(`/api/match-candidates?${params.toString()}`);
  // Reshaped to match how the UI already refers to a candidate
  // (c.txn.id / c.line / c.acc), so formatCandidateAmount/candidateIsNegative
  // and the selection handlers don't need to change.
  return results.map((r) => ({ txn: { id: r.transactionId }, line: r.line, acc: r.account }));
}

// byKind/total only — the annual caps (isaRulesFor) and grouping accounts
// into products (isaProducts) stay client-side in lib/isa.js, since they're
// pure and already have everything they need from the account list.
export function getIsaAllowance(taxYearStart) {
  return request(`/api/isa-allowance?taxYearStart=${encodeURIComponent(taxYearStart)}`);
}
