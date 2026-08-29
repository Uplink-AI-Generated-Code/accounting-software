// Applies one line's effect to a running {units, cost} position using the
// average-cost method — shared by the chart series builder below, the
// current-total helper, and the ledger's own running-total column, so
// there's exactly one definition of "cost basis" across the whole app.
export function applyCostBasisLine(state, l) {
  if (l.amount > 0) {
    state.units += l.amount;
    state.cost += l.cashValue || 0;
  } else if (l.amount < 0) {
    const sold = Math.min(-l.amount, state.units);
    const avgCost = state.units > 0 ? state.cost / state.units : 0;
    state.cost -= avgCost * sold;
    state.units -= sold;
    if (state.units < 1e-9) { state.units = 0; state.cost = 0; }
  }
}

// Cost basis of a stock position using the average-cost method: a buy
// adds its own cost; a sell removes a *proportional* share of the
// average cost so far (units sold × current average cost per unit), not
// the sale proceeds — so it always settles back to exactly £0 once every
// unit has been sold, rather than drifting negative on a profitable exit
// the way a plain running cash-flow total would.
export function buildCostBasisSeries(sortedLines, startISO, endISO) {
  const state = { units: 0, cost: 0 };
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
export function applyPortfolioValueLine(state, l) {
  state.units += l.amount || 0;
  if (state.units < 1e-9) state.units = 0;
  if (l.amount && l.cashValue !== undefined) {
    const price = Math.abs(l.cashValue) / Math.abs(l.amount);
    if (Number.isFinite(price)) state.lastPrice = price;
  }
  state.value = state.units * (state.lastPrice || 0);
}
export function buildPortfolioValueSeries(sortedLines, startISO, endISO) {
  const state = { units: 0, lastPrice: 0, value: 0 };
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
