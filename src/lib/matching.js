import { CONTRA_TYPES } from "./theme";
import { fmt, fmtUnits } from "./format";

// getComparableAmount/getDirectComparableAmount — the mirrored-vs-natural
// sign logic used to search for a match — now live in the backend's
// MatchingService (see api.getMatchCandidates). This file keeps only what
// still runs client-side: formatting a candidate the API already found,
// and validating the balance of a draft's own lines (which only ever
// involves the handful of accounts already in that draft, not a search
// across the whole ledger).

// How a match candidate's own value should read in a suggestion list —
// an investment line's "amount" is units, so it needs its cash side
// (naturally signed) shown alongside, not just the raw unit count.
export function formatCandidateAmount(c) {
  if (c.acc.type === "investment") {
    const natural = c.line.cashValue !== undefined ? -c.line.cashValue : 0;
    return `${fmtUnits(c.line.amount)} units · ${fmt(natural, c.acc.currency)}`;
  }
  return fmt(c.line.amount, c.acc.currency);
}
export function candidateIsNegative(c) {
  if (c.acc.type === "investment") return (c.line.cashValue !== undefined ? -c.line.cashValue : 0) < 0;
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
  if (enriched.length === 1) return { type: "single", message: "Single-sided — not yet matched to another account" };

  const byCur = {};
  enriched.forEach((x) => {
    const trueSigned = x.acc && CONTRA_TYPES.has(x.acc.type) ? -x.value : x.value;
    byCur[x.currency] = (byCur[x.currency] || 0) + trueSigned;
  });
  const curs = Object.keys(byCur);

  if (curs.length === 1) {
    const diff = byCur[curs[0]];
    if (Math.abs(diff) < 0.005) return { type: "balanced", message: "Balanced" };
    return { type: "unbalanced", message: `Off by ${fmt(Math.abs(diff), curs[0])}` };
  }
  if (curs.length === 2 && enriched.length === 2) {
    const [a, b] = enriched;
    if (Math.sign(a.value) !== Math.sign(b.value)) {
      const rate = Math.abs(b.value / a.value);
      return { type: "fx", message: `Exchange — implied rate 1 ${a.currency} = ${rate.toFixed(4)} ${b.currency}` };
    }
    return { type: "unbalanced", message: "Both legs move the same direction" };
  }
  const allZero = curs.every((c) => Math.abs(byCur[c]) < 0.005);
  if (allZero) return { type: "balanced", message: "Balanced within each currency" };
  return { type: "unbalanced", message: curs.map((c) => fmt(byCur[c], c)).join("  ·  ") + " left over" };
}
