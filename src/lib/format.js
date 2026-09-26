import { fromMinorUnits } from "./scale";
import { TYPES } from "./theme";
import { symbolKey } from "./symbolKey";

// Amounts are scaled integers now (e.g. 2000 = £20.00 at GBP's scale of
// 2 — see CLAUDE.md), not floats. fmt()/fmtUnits() need each currency's/
// symbol's own `scale` to convert back to a decimal before display; the
// alternative — threading a `scale` argument through every single
// display call site across the app (AccountCard, Overview, charts, ...)
// — was rejected as needlessly invasive for what's fundamentally a
// lookup. Instead App.jsx calls setCurrencyScales()/setSymbolScales()
// once, right after fetching /api/currencies and /api/symbols, and every
// fmt(amount, currencyCode)/fmtUnits(n, symbolTicker) call site keeps
// working exactly as before.
let currencyScales = {};
let symbolScales = {};

export function setCurrencyScales(currencies) {
  currencyScales = Object.fromEntries((currencies || []).map((c) => [c.code, c.scale]));
}
export function setSymbolScales(symbols) {
  symbolScales = Object.fromEntries((symbols || []).map((s) => [symbolKey(s.ticker, s.tradingCurrency), s.scale]));
}
// Falls back to 2 (the common case) / 6 (matching the pre-existing
// fmtUnits display convention) if the registry hasn't loaded yet or the
// code/ticker is unrecognized — better a plausible guess for one frame
// than a crash.
function scaleForCurrency(code) {
  return currencyScales[code] ?? 2;
}
function scaleForSymbol(key) {
  return symbolScales[key] ?? 6;
}

export function fmt(amount, currency) {
  const scale = scaleForCurrency(currency);
  const v = Number.isFinite(amount) ? Number(fromMinorUnits(amount, scale) || "0") : 0;
  try {
    // Intl doesn't reject an unrecognized-but-well-formed currency code
    // (e.g. "BTC") — it silently formats it at its own default 2 fraction
    // digits instead, discarding the precision `v` was already correctly
    // computed at. minimumFractionDigits/maximumFractionDigits force it to
    // respect this currency's own registered scale instead of guessing.
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: scale, maximumFractionDigits: scale }).format(v);
  } catch (e) {
    return `${v.toFixed(scale)} ${currency}`;
  }
}
// Same amount as fmt(), without the currency code/symbol prefix — for a
// ledger's own per-entry rows and its "Opening balance" row, where the
// account's (or trading pair's) currency is already shown once in the
// header/column context, so repeating it on every row is just noise.
// Still fully scale-aware, exactly like fmt() — only the currency prefix
// itself is dropped, never the precision.
export function fmtPlain(amount, currency) {
  const scale = scaleForCurrency(currency);
  const v = Number.isFinite(amount) ? Number(fromMinorUnits(amount, scale) || "0") : 0;
  return v.toLocaleString("en-GB", { minimumFractionDigits: scale, maximumFractionDigits: scale });
}
// An account's `name` can be blank (see CLAUDE.md's "Account model") — a
// credit card or an income/expense account often has nothing to add
// beyond its own Subtype/Counterparty. Falls back to those, joined; if
// even those are both missing, falls back to the account's Type label
// rather than showing nothing. Computed for display only, never stored —
// doesn't resolve an ISA subaccount's *inherited* counterparty (see
// lib/grouping.js's counterpartyOf()), since a blank-named subaccount is
// an edge case the original motivating problem (Income/Expense, credit
// cards) doesn't actually hit.
export function displayAccountName(account) {
  if (account.name && account.name.trim()) return account.name;
  const parts = [account.subtype, account.counterparty].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return TYPES.find((t) => t.key === account.type)?.label || "Account";
}
export function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}
export function fmtDate(d) {
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
export function addDays(dateISO, days) {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
export function addMonths(dateISO, months) {
  const d = new Date(dateISO + "T00:00:00");
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}
export function addYears(dateISO, years) {
  const d = new Date(dateISO + "T00:00:00");
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}
export function fmtDateShort(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
// Trims trailing zeros but keeps up to the symbol's own scale of decimal
// places, for fractional share counts. `symbolKeyString` is the composite
// key from lib/symbolKey.js's symbolKey(ticker, tradingCurrency) — not a
// bare ticker, since the same ticker can now exist under more than one
// trading currency, each with its own scale.
export function fmtUnits(n, symbolKeyString) {
  const scale = scaleForSymbol(symbolKeyString);
  const v = Number.isFinite(n) ? Number(fromMinorUnits(n, scale) || "0") : 0;
  return v.toLocaleString("en-GB", { maximumFractionDigits: scale, minimumFractionDigits: 0 });
}
