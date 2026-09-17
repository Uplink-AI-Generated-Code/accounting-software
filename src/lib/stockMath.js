import { divRoundHalfUp } from "./scale";

// Applies one line's effect to a running {units, cost} position using the
// average-cost method — shared by the chart series builder below, the
// current-total helper, and the ledger's own running-total column, so
// there's exactly one definition of "cost basis" across the whole app.
//
// All arithmetic here is exact integer arithmetic — no floats — mirrored
// exactly from the backend's LedgerStateService::applyCostBasisLine() so
// the two never disagree; see CLAUDE.md. `cost`/`cashValue` are
// currency-scale integers, `units`/`amount` are symbol-scale integers; a
// cross-multiply-then-divide (divRoundHalfUp) keeps every intermediate
// value an exact integer of the correct implied scale without this
// function ever needing to know either scale explicitly.
export function applyCostBasisLine(state, l) {
  if (l.amount > 0) {
    state.units += l.amount;
    state.cost += l.cashValue || 0;
  } else if (l.amount < 0) {
    const sold = Math.min(-l.amount, state.units);
    const costRemoved = state.units > 0 ? divRoundHalfUp(state.cost * sold, state.units) : 0;
    state.cost -= costRemoved;
    state.units -= sold;
    if (state.units === 0) {
      // Exact by construction once units is an integer — this only
      // absorbs ±1-minor-unit rounding dust left over from
      // divRoundHalfUp() above, not float fuzz.
      state.cost = 0;
    }
  }
}

// Cost basis of a stock position using the average-cost method: a buy
// adds its own cost; a sell removes a *proportional* share of the
// average cost so far (units sold × current average cost per unit), not
// the sale proceeds — so it always settles back to exactly £0 once every
// unit has been sold, rather than drifting negative on a profitable exit
// the way a plain running cash-flow total would.
//
// `opening` seeds the walk from an account's carried-forward position
// (Account.openingBalance/openingBalanceCashValue — see CLAUDE.md's "The
// active tax year"/app:new-year) instead of starting at zero, mirroring
// LedgerStateService::stockStatsFor()'s own seeding — otherwise this
// series would disagree with the account's own current-totals display.
export function buildCostBasisSeries(sortedLines, startISO, endISO, opening = {}) {
  const state = { units: opening.units || 0, cost: opening.cost || 0 };
  let idx = 0;
  while (idx < sortedLines.length && sortedLines[idx].date < startISO) {
    applyCostBasisLine(state, sortedLines[idx]);
    idx++;
  }
  const points = [];
  let cursor = new Date(startISO + "T00:00:00");
  const end = new Date(endISO + "T00:00:00");
  let safety = 0;
  while (cursor <= end && safety < 3660) {
    const iso = cursor.toISOString().slice(0, 10);
    while (idx < sortedLines.length && sortedLines[idx].date === iso) {
      applyCostBasisLine(state, sortedLines[idx]);
      idx++;
    }
    points.push({ date: iso, value: state.cost });
    cursor.setDate(cursor.getDate() + 1);
    safety++;
  }
  return points;
}

// A "mark to last trade" portfolio value: with no live price feed, the
// most recent trade's own price (its cash value ÷ its units) is the best
// available stand-in for a current price, applied to the *whole*
// remaining holding — not just the units in that trade. A trade with no
// recorded value doesn't move the price; it just carries the last known
// one forward.
//
// Keeps the last trade's raw cashValue/units pair rather than a
// pre-rounded price, and divides only once — see applyPortfolioValueLine
// below and buildPortfolioValueSeries's point-by-point call — to avoid
// compounding rounding error across many trades. Mirrors the backend's
// LedgerStateService::stockStatsFor()/applyPortfolioValueLine() exactly.
export function applyPortfolioValueLine(state, l) {
  state.units += l.amount || 0;
  if (l.amount && l.cashValue !== undefined) {
    state.lastCashValue = Math.abs(l.cashValue);
    state.lastUnits = Math.abs(l.amount);
  }
  state.value = state.lastUnits ? divRoundHalfUp(state.units * state.lastCashValue, state.lastUnits) : 0;
}
// `opening` is the same carried-forward seed buildCostBasisSeries() takes
// — until the first new trade re-marks it, the carried cost basis is the
// best available stand-in for "last known price" too.
export function buildPortfolioValueSeries(sortedLines, startISO, endISO, opening = {}) {
  const openingUnits = opening.units || 0;
  const openingCost = opening.cost || 0;
  const state = { units: openingUnits, lastCashValue: openingCost, lastUnits: openingUnits, value: openingUnits ? openingCost : 0 };
  let idx = 0;
  while (idx < sortedLines.length && sortedLines[idx].date < startISO) {
    applyPortfolioValueLine(state, sortedLines[idx]);
    idx++;
  }
  const points = [];
  let cursor = new Date(startISO + "T00:00:00");
  const end = new Date(endISO + "T00:00:00");
  let safety = 0;
  while (cursor <= end && safety < 3660) {
    const iso = cursor.toISOString().slice(0, 10);
    while (idx < sortedLines.length && sortedLines[idx].date === iso) {
      applyPortfolioValueLine(state, sortedLines[idx]);
      idx++;
    }
    points.push({ date: iso, value: state.value });
    cursor.setDate(cursor.getDate() + 1);
    safety++;
  }
  return points;
}
