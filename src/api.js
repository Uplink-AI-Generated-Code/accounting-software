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
// A "record" is `{ transactionId: string|null, lines: [...] }` — a
// standalone, unpaired entry (transactionId null) or a linked transaction
// (2+ lines). See lib/ledgerOperations.js for how a ledger edit becomes a
// list of operations for applyLedgerOperations() — the one write that
// still takes a list, since merging two entries, splitting a removed line
// off into its own record, and reordering several same-date rows all need
// several rows to change together atomically. Plain account/settings
// writes are single-resource.

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

// operations: see lib/ledgerOperations.js — an ordered list of
// upsertLine/deleteLine/upsertTransaction/deleteTransaction primitives,
// applied atomically.
export function applyLedgerOperations(operations) {
  return request("/api/ledger/batch", { method: "POST", ...jsonBody({ operations }) });
}

// mode: "mirrored" (default) or "direct" — see lib/matching.js's old
// getComparableAmount vs getDirectComparableAmount for what these meant
// client-side; the same distinction now lives in the backend's
// MatchingService. excludeAccountIds keeps a match from offering an
// account already in play in the current draft. A candidate is always a
// standalone line (a linked one is already matched), so results carry
// `lineId`, not a transaction id.
export function getMatchCandidates({ currency, amount, date, excludeAccountIds, mode = "mirrored" }) {
  const params = new URLSearchParams({ currency, amount: String(amount), date, mode });
  if (excludeAccountIds && excludeAccountIds.length) params.set("excludeAccountIds", excludeAccountIds.join(","));
  return request(`/api/match-candidates?${params.toString()}`);
}

// byKind/total only — the annual caps (isaRulesFor) and grouping accounts
// into products (isaProducts) stay client-side in lib/isa.js, since they're
// pure and already have everything they need from the account list.
export function getIsaAllowance(taxYearStart) {
  return request(`/api/isa-allowance?taxYearStart=${encodeURIComponent(taxYearStart)}`);
}

// Reference-data lists — currency/symbol/counterparty are lookup entities
// server-side now, not free text (see CLAUDE.md). Fetched once by
// App.jsx alongside the account list, not per-component. Read-only for
// now; a future admin area is where write endpoints would go.
export function getCurrencies() {
  return request("/api/currencies");
}
export function getSymbols() {
  return request("/api/symbols");
}
export function getCounterparties() {
  return request("/api/counterparties");
}
