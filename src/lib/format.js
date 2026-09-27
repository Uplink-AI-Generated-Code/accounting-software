import { round, fractionDigits } from "./decimal";
import { TYPES } from "./theme";
import { symbolKey } from "./symbolKey";

// Amounts are canonical decimal strings now (see CLAUDE.md/the decimals
// design doc), not scaled integers. fmt()/fmtUnits() need each currency's/
// symbol's own `scale` only to know how many places to *show* — the
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
export function scaleForCurrency(code) {
  return currencyScales[code] ?? 2;
}
export function scaleForSymbol(key) {
  return symbolScales[key] ?? 6;
}

// Intl.NumberFormat formats a *string* as an exact decimal (ES2023), so
// no amount ever passes through a float here. Phase 1: exactly `scale`
// places (phase 3 changes this to "at least").
function padFraction(v, places) {
  if (places === 0) return v;
  const [whole, frac = ""] = v.split(".");
  return `${whole}.${frac.padEnd(places, "0")}`;
}
export function fmt(amount, currency) {
  const scale = scaleForCurrency(currency);
  const v = round(amount ?? "0", scale);
  try {
    // Intl doesn't reject an unrecognized-but-well-formed currency code
    // (e.g. "BTC") — it would silently use its own default 2 digits, so
    // force this currency's registered scale instead.
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: scale, maximumFractionDigits: scale }).format(v);
  } catch (e) {
    return `${padFraction(v, scale)} ${currency}`;
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
  return new Intl.NumberFormat("en-GB", { minimumFractionDigits: scale, maximumFractionDigits: scale }).format(round(amount ?? "0", scale));
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
  return new Intl.NumberFormat("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: scale }).format(round(n ?? "0", scale));
}

// PHASE 1 ONLY — delete in phase 2 (docs/superpowers/specs/2026-09-27-
// arbitrary-precision-decimals-design.md). Storage is still scaled
// integers, so the backend 400s on a value deeper than its scale; this
// catches it before the save, so the edit isn't lost to a failed batch.
export function precisionError(lines, accounts) {
  for (const l of lines) {
    const acc = accounts.find((a) => a.id === l.accountId);
    if (!acc) continue;
    const amountScale = acc.type === "investment" ? scaleForSymbol(symbolKey(acc.symbolTicker, acc.symbolCurrency)) : scaleForCurrency(acc.currency);
    const checks = [
      [l.amount, amountScale],
      [l.cashValue, scaleForCurrency(l.cashCurrency)],
      [l.exchangeAmount, scaleForCurrency(l.exchangeCurrency)],
    ];
    for (const [value, scale] of checks) {
      if (value !== undefined && fractionDigits(value) > scale) {
        return `${displayAccountName(acc)}: ${value} has more than ${scale} decimal place${scale === 1 ? "" : "s"}.`;
      }
    }
  }
  return null;
}
