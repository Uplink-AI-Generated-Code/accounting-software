import { todayISO } from "./format";
import { taxYearBounds } from "./isa";

// Just these two: every fixed-lookback preset (30D/3M/6M/1Y/YTD/All) only
// ever means something relative to *today*, which makes it useless for
// looking at a past tax year's chart once the calendar's moved on — see
// CLAUDE.md's "The active tax year". "Custom" covers everything else.
export const CHART_INTERVALS = [
  { key: "taxyear", label: "Tax Year" },
  { key: "custom", label: "Custom" },
];

// `ctx.taxYearStart` is this ledger's one computed UK tax year (see
// CLAUDE.md's "The active tax year" — `App.jsx`'s `activeTaxYearStart`,
// threaded down through AccountLedger/StockLedger); `null` on a blank
// ledger falls back to `ctx.earliestISO`..today (there's no year to
// bound by yet). `ctx.customStart`/`ctx.customEnd` back the "Custom"
// range picker — charts.jsx seeds them from the tax year's own bounds
// the first time "Custom" is selected, so there's always a sensible
// starting point to tweak rather than a blank date field.
export function intervalRange(key, ctx = {}) {
  const { earliestISO, taxYearStart, customStart, customEnd } = ctx;
  const today = todayISO();
  switch (key) {
    case "taxyear": {
      if (taxYearStart == null) return { start: earliestISO || today, end: today };
      const { start, end } = taxYearBounds(taxYearStart);
      // Never chart into the future — a step series would just carry the
      // last known value flat across days that haven't happened yet.
      return { start, end: end < today ? end : today };
    }
    case "custom": return { start: customStart || earliestISO || today, end: customEnd || today };
    default: return { start: earliestISO || today, end: today };
  }
}

// Walks a sorted array of {date, amount} lines day by day across a range,
// carrying the running total forward — a step function sampled daily, so
// two different periods (e.g. this year vs last year) land on directly
// comparable, equal-length series for overlaying on one chart.
export function buildDailySeries(opening, sortedLines, startISO, endISO) {
  let value = opening;
  let idx = 0;
  while (idx < sortedLines.length && sortedLines[idx].date < startISO) {
    value += sortedLines[idx].amount || 0;
    idx++;
  }
  const points = [];
  let cursor = new Date(startISO + "T00:00:00");
  const end = new Date(endISO + "T00:00:00");
  let safety = 0;
  while (cursor <= end && safety < 3660) {
    const iso = cursor.toISOString().slice(0, 10);
    while (idx < sortedLines.length && sortedLines[idx].date === iso) {
      value += sortedLines[idx].amount || 0;
      idx++;
    }
    points.push({ date: iso, value });
    cursor.setDate(cursor.getDate() + 1);
    safety++;
  }
  return points;
}
