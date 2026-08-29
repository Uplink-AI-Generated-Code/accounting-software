import { CONTRA_TYPES } from "./theme";
import { fmt, fmtUnits } from "./format";

// The single per-line value comparable against a given currency, wherever
// it's found: a plain amount in a matching-currency account, a currency
// exchange tag, or (for stock accounts) the cash side of a trade. This is
// what lets a cash entry and a stock trade — or two differently-tagged
// entries in general — recognise each other as a possible match. Checks
// investment accounts first: an investment account's own "amount" is
// units, not cash, so it must never fall through to the plain-currency
// branch just because its nominal trading currency happens to match.
export function getComparableAmount(line, acc, targetCurrency) {
  if (!acc) return undefined;
  if (acc.type === "investment") {
    return line.cashCurrency === targetCurrency ? line.cashValue : undefined;
  }
  if (acc.currency === targetCurrency) return line.amount;
  if (line.exchangeCurrency === targetCurrency) return line.exchangeAmount;
  return undefined;
}
// Like getComparableAmount, but returns the *natural* value — what would
// actually show as this line's own In/Out if you looked at it directly —
// rather than the self-referential mirror tag. Used when a search target
// is itself a plain, directly-typed amount (e.g. "In 14" meant to find an
// existing record that also literally reads "In 14"), where negating
// anything would be wrong for an ordinary account but a stock trade's
// cashValue still needs un-mirroring to mean the same thing.
export function getDirectComparableAmount(line, acc, targetCurrency) {
  if (!acc) return undefined;
  if (acc.type === "investment") {
    return line.cashCurrency === targetCurrency && line.cashValue !== undefined ? -line.cashValue : undefined;
  }
  if (acc.currency === targetCurrency) return line.amount;
  return undefined;
}
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
