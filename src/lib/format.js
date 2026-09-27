import { fractionDigits } from "./decimal";
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

// Intl.NumberFormat formats a *string* as an exact decimal (ES2023), so no
// amount ever passes through a float here. A currency's/symbol's `scale`
// is the MINIMUM number of decimals shown: every stored digit beyond it is
// displayed too, and nothing is ever rounded — a computed value (anything
// from divide(), or a Recharts float) must be rounded by the caller first
// (see CLAUDE.md's "Stock valuation" adaptive precision).
function padFraction(v, places) {
  if (places === 0) return v;
  const [whole, frac = ""] = v.split(".");
  return `${whole}.${frac.padEnd(places, "0")}`;
}
function fractionOptions(value, minPlaces) {
  return { minimumFractionDigits: minPlaces, maximumFractionDigits: Math.max(minPlaces, fractionDigits(value)) };
}
export function fmt(amount, currency) {
  const scale = scaleForCurrency(currency);
  const v = amount ?? "0";
  try {
    // Intl doesn't reject an unrecognized-but-well-formed currency code
    // (e.g. "XBT") — it would silently use its own default digits, so the
    // fraction digits are always set explicitly.
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, ...fractionOptions(v, scale) }).format(v);
  } catch (e) {
    return `${padFraction(v, scale)} ${currency}`;
  }
}
// Same amount as fmt(), without the currency code/symbol prefix — for a
// ledger's own per-entry rows and its "Opening balance" row, where the
// account's (or trading pair's) currency is already shown once in the
// header/column context, so repeating it on every row is just noise.
// Precision is maintained exactly like fmt() — only the currency prefix is dropped.
export function fmtPlain(amount, currency) {
  const v = amount ?? "0";
  return new Intl.NumberFormat("en-GB", fractionOptions(v, scaleForCurrency(currency))).format(v);
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
// The symbol's scale is the minimum for units; any stored fraction beyond it is shown.
// `symbolKeyString` is the composite key from lib/symbolKey.js's symbolKey(ticker,
// tradingCurrency) — not a bare ticker, since the same ticker can exist under
// multiple trading currencies, each with its own scale.
export function fmtUnits(n, symbolKeyString) {
  const v = n ?? "0";
  return new Intl.NumberFormat("en-GB", fractionOptions(v, scaleForSymbol(symbolKeyString))).format(v);
}

// Decimal-point alignment (see ui.jsx's <Amount>): a formatted amount split
// into its integer part (sign, currency symbol, thousands separators) and
// its fraction ("." + digits, or "" when there's none to show).
export function fmtParts(amount, code, kind = "plain") {
  const s = kind === "currency" ? fmt(amount, code) : kind === "units" ? fmtUnits(amount, code) : fmtPlain(amount, code);
  const i = s.search(/\.\d/);
  return i === -1 ? { int: s, frac: "" } : { int: s.slice(0, i), frac: s.slice(i) };
}
// The most fractional digits among `values`, never fewer than `minPlaces`.
export function maxPlaces(minPlaces, values) {
  let p = minPlaces;
  for (const v of values) if (v != null) p = Math.max(p, fractionDigits(v));
  return p;
}
// Widest fraction a column will display — each entry shows at least its
// own scale — so every cell's fraction span can be padded to the same width.
export function fracWidth(entries) {
  let w = 0;
  for (const { value, code, kind = "plain" } of entries) {
    if (value == null) continue;
    const scale = kind === "units" ? scaleForSymbol(code) : scaleForCurrency(code);
    w = Math.max(w, scale, fractionDigits(value));
  }
  return w;
}
