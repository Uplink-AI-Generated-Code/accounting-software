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
    // A handful of endpoints (the ledger batch write, symbol creation,
    // the database switcher) return a deliberate 400/409/503 with
    // {"error": "...", "reason"?: "..."} for an expected rejection rather
    // than a bug — surface the message when present so a caller can show
    // it directly, instead of always falling back to the generic
    // "<method> <path> failed: <status>". `reason` (when the backend
    // supplied one — see MigrationStatusListener) lets a caller branch on
    // a stable machine-readable value instead of matching message text.
    const body = await res.json().catch(() => null);
    const err = new Error(body?.error || `${options?.method || "GET"} ${path} failed: ${res.status}`);
    if (body?.reason) err.reason = body.reason;
    throw err;
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

export function patchSettings(partial) {
  return request("/api/settings", { method: "PATCH", ...jsonBody(partial) });
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
// App.jsx alongside the account list, not per-component.
export function getCurrencies() {
  return request("/api/currencies");
}
export function createCurrency(currency) {
  return request("/api/currencies", { method: "POST", ...jsonBody(currency) });
}
export function patchCurrency(code, patch) {
  return request(`/api/currencies/${encodeURIComponent(code)}`, { method: "PATCH", ...jsonBody(patch) });
}
export function deleteCurrency(code) {
  return request(`/api/currencies/${encodeURIComponent(code)}`, { method: "DELETE" });
}
export function getSymbols() {
  return request("/api/symbols");
}
// createSymbol() predates full admin CRUD — see SymbolController's
// docblock for why it exists on its own: a blank database has no symbols
// at all, so without it there'd be no way to create the very first
// investment account. patchSymbol()/deleteSymbol() key on the pair
// (ticker, tradingCurrency), not the ticker alone, since the same ticker
// can exist more than once now.
export function createSymbol(symbol) {
  return request("/api/symbols", { method: "POST", ...jsonBody(symbol) });
}
export function patchSymbol(ticker, tradingCurrency, patch) {
  return request(`/api/symbols/${encodeURIComponent(ticker)}/${encodeURIComponent(tradingCurrency)}`, { method: "PATCH", ...jsonBody(patch) });
}
export function deleteSymbol(ticker, tradingCurrency) {
  return request(`/api/symbols/${encodeURIComponent(ticker)}/${encodeURIComponent(tradingCurrency)}`, { method: "DELETE" });
}
export function getCounterparties() {
  return request("/api/counterparties");
}

// Line-level tags — see CLAUDE.md's "Tags" section. Deliberately narrow:
// most account-level reporting questions are already answered by the
// account-grouping tree (Counterparty/Subtype/Type); these three cover
// only the genuinely cross-cutting facts (which car, which trip, refund
// status, ...) grouping can't reach.
export function getTags(dimension) {
  const params = dimension ? `?dimension=${encodeURIComponent(dimension)}` : "";
  return request(`/api/tags${params}`);
}

// Every line carrying this exact tag, each with its account context — the
// drill-down behind a tag-totals figure.
export function getTaggedLines(dimension, value) {
  const params = new URLSearchParams({ dimension, value: value || "" });
  return request(`/api/lines?${params.toString()}`);
}

// Server-side SUM grouped by (value, currency). excludeTag is a single
// "Dimension:Value" filter (e.g. "Status:Refunded"), not a general query
// language. Never includes investment lines — see TagService's docblock.
export function getTagTotals(dimension, { excludeTag } = {}) {
  const params = new URLSearchParams({ dimension });
  if (excludeTag) params.set("excludeTag", excludeTag);
  return request(`/api/tag-totals?${params.toString()}`);
}

// The database switcher — see CLAUDE.md's "The active tax year" and
// backend/src/Controller/DatabaseController.php. `filename` is always a
// bare *.sqlite3 name under backend/databases/, never a path.
export function getDatabases() {
  return request("/api/databases");
}
export function setActiveDatabase(filename) {
  return request("/api/databases/active", { method: "POST", ...jsonBody({ filename }) });
}
export function createDatabase(startYear) {
  return request("/api/databases", { method: "POST", ...jsonBody({ startYear }) });
}
export function startNewTaxYear() {
  return request("/api/databases/new-year", { method: "POST" });
}
