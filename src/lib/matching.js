import { fmt, fmtUnits, scaleForCurrency } from "./format";
import { fromMinorUnits } from "./scale";
import { symbolKey } from "./symbolKey";

// getComparableAmount/getDirectComparableAmount — the mirrored-vs-natural
// sign logic used to search for a match — now live in the backend's
// MatchingService (see api.getMatchCandidates). This file keeps only what
// still runs client-side: formatting a candidate the API already found,
// and validating the balance of a draft's own lines (which only ever
// involves the handful of accounts already in that draft, not a search
// across the whole ledger).

// How a match candidate's own value should read in a suggestion list — a
// candidate is { lineId, line, account } (see api.getMatchCandidates). An
// investment line's "amount" is units, so it needs its cash side
// (naturally signed) shown alongside, not just the raw unit count.
export function formatCandidateAmount(c) {
  if (c.account.type === "investment") {
    const natural = c.line.cashValue !== undefined ? -c.line.cashValue : 0;
    return `${fmtUnits(c.line.amount, symbolKey(c.account.symbolTicker, c.account.symbolCurrency))} units · ${fmt(natural, c.line.cashCurrency)}`;
  }
  return fmt(c.line.amount, c.account.currency);
}
export function candidateIsNegative(c) {
  if (c.account.type === "investment") return (c.line.cashValue !== undefined ? -c.line.cashValue : 0) < 0;
  return c.line.amount < 0;
}

// The value a line contributes to a balance check, in real cash terms.
// For an ordinary account this is just its amount in its own currency.
// For a stock account, the line's `amount` is a unit count, not cash —
// its contribution is the trade's cash side (cashValue/cashCurrency)
// instead, using the same self-referential sign convention as an
// exchange tag. A stock line with no cash info recorded (e.g. a bonus
// share issue) contributes nothing verifiable and is left out.
function lineBalanceValue(line, acc) {
  if (acc && acc.type === "investment") {
    if (line.cashValue !== undefined && line.cashCurrency) return { value: line.cashValue, currency: line.cashCurrency };
    return null;
  }
  return { value: line.amount, currency: acc ? acc.currency : "???" };
}

// A ratio between two different currencies' *natural* decimal values is
// legitimately a display-only float here — it's never persisted or
// round-tripped, just shown once as an FX rate, so this is exempt from
// the "no floats" rule the actual stored amounts follow. Each side's raw
// scaled integer must be converted through its OWN currency's scale
// first — dividing the raw integers directly would silently assume both
// sides share one scale, which is wrong the moment one leg is, say, BTC
// (scale 8) and the other GBP (scale 2): off by a factor of 10^6. Takes
// the magnitude of each side, so the caller doesn't need to reason about
// which sign convention (mirrored or natural) either side's raw value
// follows — only the ratio's size matters for display.
function impliedRateStr(valueA, currencyA, valueB, currencyB) {
  const realA = Number(fromMinorUnits(valueA, scaleForCurrency(currencyA)));
  const realB = Number(fromMinorUnits(valueB, scaleForCurrency(currencyB)));
  if (realA === 0) return null;
  const rate = Math.abs(realB / realA);
  // A fixed 4 decimal places reads fine for two similarly-scaled
  // currencies but silently rounds to a meaningless "0.0000" for a pair
  // as lopsided as BTC/GBP — significant figures stay informative at any
  // magnitude, and toLocaleString (unlike toPrecision) never drops into
  // exponential notation.
  return rate.toLocaleString("en-GB", { maximumSignificantDigits: 6, minimumSignificantDigits: 1 });
}

/* ---------------------------------------------------------
   Balance hint for a set of lines.
   Each line.amount is a delta: positive = increase that account,
   negative = decrease it. This is never forced — it's informational,
   so half-entered records (e.g. from a bank statement) can be saved
   and reconciled later.
--------------------------------------------------------- */
export function balanceHint(lines, accounts) {
  const enriched = lines
    .map((l) => {
      const acc = accounts.find((a) => a.id === l.accountId);
      if (!l.accountId) return null;
      const bv = lineBalanceValue(l, acc);
      if (!bv || !Number.isFinite(bv.value) || bv.value === 0) return null;
      return { line: l, acc, ...bv };
    })
    .filter(Boolean);

  if (enriched.length === 0) return { type: "empty", message: "" };
  if (enriched.length === 1) {
    // An unpaired line can still carry its own currency-exchange tag
    // (line.exchangeAmount/exchangeCurrency — see CLAUDE.md's "Data
    // model") recording what it was worth in another currency, even with
    // no second real ledger line to compare against — surface that rate
    // alongside the usual "not yet matched" wording, rather than instead
    // of it. This is deliberately its own type ("single-fx"), not "fx" —
    // unlike a genuinely linked two-line FX pair (which is done, needing
    // no more attention), this line is still unpaired and must keep the
    // same "still needs a match" highlight/icon a plain single-sided line
    // gets (see AccountLedger.jsx's `single` check).
    const x = enriched[0];
    const { line } = x;
    if (line.exchangeAmount !== undefined && line.exchangeCurrency && line.exchangeCurrency !== x.currency) {
      const rateStr = impliedRateStr(x.value, x.currency, line.exchangeAmount, line.exchangeCurrency);
      if (rateStr) {
        return { type: "single-fx", message: `Single-sided — not yet matched to another account (exchange tag: 1 ${x.currency} = ${rateStr} ${line.exchangeCurrency})` };
      }
    }
    return { type: "single", message: "Single-sided — not yet matched to another account" };
  }

  const byCur = {};
  enriched.forEach((x) => {
    byCur[x.currency] = (byCur[x.currency] || 0) + x.value;
  });
  const curs = Object.keys(byCur);

  if (curs.length === 1) {
    const diff = byCur[curs[0]];
    if (diff === 0) return { type: "balanced", message: "Balanced" };
    return { type: "unbalanced", message: `Off by ${fmt(Math.abs(diff), curs[0])}` };
  }
  if (curs.length === 2 && enriched.length === 2) {
    const [a, b] = enriched;
    if (Math.sign(a.value) !== Math.sign(b.value)) {
      const rateStr = impliedRateStr(a.value, a.currency, b.value, b.currency);
      if (rateStr) return { type: "fx", message: `Exchange — implied rate 1 ${a.currency} = ${rateStr} ${b.currency}` };
    }
    return { type: "unbalanced", message: "Both legs move the same direction" };
  }
  const allZero = curs.every((c) => byCur[c] === 0);
  if (allZero) return { type: "balanced", message: "Balanced within each currency" };
  return { type: "unbalanced", message: curs.map((c) => fmt(byCur[c], c)).join("  ·  ") + " left over" };
}
