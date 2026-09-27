import { fmt, fmtUnits } from "./format";
import { neg, abs, add, sign, isZero, divide, isNegative, toNumber } from "./decimal";
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
    const natural = c.line.cashValue !== undefined ? neg(c.line.cashValue) : "0";
    return `${fmtUnits(c.line.amount, symbolKey(c.account.symbolTicker, c.account.symbolCurrency))} units · ${fmt(natural, c.line.cashCurrency)}`;
  }
  return fmt(c.line.amount, c.account.currency);
}
export function candidateIsNegative(c) {
  if (c.account.type === "investment") return isNegative(c.line.cashValue !== undefined ? neg(c.line.cashValue) : "0");
  return isNegative(c.line.amount);
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

// Display-only FX rate between two currencies' natural decimal values.
// Both sides are already real decimals (no per-currency scale to undo),
// so the ratio is one divide(); only the final significant-digit
// formatting goes through a Number — a renderer boundary, never stored.
function impliedRateStr(valueA, currencyA, valueB, currencyB) {
  if (isZero(valueA)) return null;
  const rate = abs(divide(valueB, valueA));
  // Significant figures stay informative at any magnitude (BTC/GBP), and
  // toLocaleString never drops into exponential notation.
  return toNumber(rate).toLocaleString("en-GB", { maximumSignificantDigits: 6, minimumSignificantDigits: 1 });
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
      if (!bv || bv.value === undefined || isZero(bv.value)) return null;
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
    byCur[x.currency] = add(byCur[x.currency] ?? "0", x.value);
  });
  const curs = Object.keys(byCur);

  if (curs.length === 1) {
    const diff = byCur[curs[0]];
    if (isZero(diff)) return { type: "balanced", message: "Balanced" };
    return { type: "unbalanced", message: `Off by ${fmt(abs(diff), curs[0])}` };
  }
  if (curs.length === 2 && enriched.length === 2) {
    const [a, b] = enriched;
    if (sign(a.value) !== sign(b.value)) {
      const rateStr = impliedRateStr(a.value, a.currency, b.value, b.currency);
      if (rateStr) return { type: "fx", message: `Exchange — implied rate 1 ${a.currency} = ${rateStr} ${b.currency}` };
    }
    return { type: "unbalanced", message: "Both legs move the same direction" };
  }
  const allZero = curs.every((c) => isZero(byCur[c]));
  if (allZero) return { type: "balanced", message: "Balanced within each currency" };
  return { type: "unbalanced", message: curs.map((c) => fmt(byCur[c], c)).join("  ·  ") + " left over" };
}
