// A Symbol's real identity is (ticker, tradingCurrency) now — the same
// ticker can exist more than once, one row per trading currency (see
// CLAUDE.md's "Amounts, currencies, and reference data"). This is the
// one place that encodes/decodes that pair as a single string, for
// spots that need exactly one value — a <select>'s value, the
// fmtUnits()/scale-cache lookup key (see lib/format.js). Never sent over
// the wire: the API always carries the two parts separately
// (symbolTicker/symbolCurrency on an Account, ticker/tradingCurrency on
// a Symbol) — this key is a client-side-only convenience.
export function symbolKey(ticker, tradingCurrency) {
  return `${ticker}:${tradingCurrency}`;
}
export function parseSymbolKey(key) {
  const i = key.indexOf(":");
  return { ticker: key.slice(0, i), tradingCurrency: key.slice(i + 1) };
}
