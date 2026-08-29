import { todayISO, addDays, addMonths, addYears } from "./format";

export const CHART_INTERVALS = [
  { key: "30d", label: "30D" },
  { key: "3m", label: "3M" },
  { key: "6m", label: "6M" },
  { key: "1y", label: "1Y" },
  { key: "ytd", label: "YTD" },
  { key: "all", label: "All" },
];

export function intervalRange(key, earliestISO) {
  const today = todayISO();
  switch (key) {
    case "30d": return { start: addDays(today, -29), end: today };
    case "3m": return { start: addMonths(today, -3), end: today };
    case "6m": return { start: addMonths(today, -6), end: today };
    case "1y": return { start: addYears(today, -1), end: today };
    case "ytd": return { start: today.slice(0, 4) + "-01-01", end: today };
    case "all": return { start: earliestISO || today, end: today };
    default: return { start: addMonths(today, -3), end: today };
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
