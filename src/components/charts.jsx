import { useMemo, useState } from "react";
import { LineChart, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { C } from "../lib/theme";
import { fmt, fmtUnits, fmtDateShort, todayISO, addYears } from "../lib/format";
import { CHART_INTERVALS, intervalRange, buildDailySeries } from "../lib/chartSeries";
import { taxYearBounds } from "../lib/isa";
import { buildCostBasisSeries, buildPortfolioValueSeries } from "../lib/stockMath";
import { miniInput } from "./ui";

// Seeds the custom date pair from this ledger's tax year the *first*
// time "Custom" is picked (customStart/customEnd both still empty) —
// gives the user a sensible starting point to tweak from instead of a
// blank field, without stomping on anything they've already typed if
// they switch away and back. A no-op for any other interval, or once
// either field has a value.
function selectIntervalWithCustomSeed(key, activeTaxYearStart, customStart, customEnd, setCustomStart, setCustomEnd) {
  if (key === "custom" && !customStart && !customEnd && activeTaxYearStart != null) {
    const { start, end } = taxYearBounds(activeTaxYearStart);
    const today = todayISO();
    setCustomStart(start);
    setCustomEnd(end < today ? end : today);
  }
}

/* ---------------------------------------------------------
   Charts — balance/units over a user-selectable interval, with an
   optional overlay of the same interval one year earlier. Defaults to
   this ledger's own tax year (see CLAUDE.md's "The active tax year")
   rather than a fixed lookback window, since that's the range someone
   doing their books actually cares about most of the time; "Custom"
   opens a plain from/to date pair for anything else.
--------------------------------------------------------- */
function IntervalControls({ interval, setInterval: setIntervalValue, compareYoY, setCompareYoY, customStart, setCustomStart, customEnd, setCustomEnd }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex rounded overflow-hidden" style={{ border: `1px solid ${C.line}` }}>
        {CHART_INTERVALS.map((o) => (
          <button
            key={o.key} type="button" onClick={() => setIntervalValue(o.key)}
            style={{ padding: "6px 10px", fontSize: 12, background: interval === o.key ? C.paperDim : "transparent", color: interval === o.key ? C.ink : C.inkFaint, fontWeight: interval === o.key ? 600 : 400 }}
          >
            {o.label}
          </button>
        ))}
      </div>
      {interval === "custom" && (
        <div className="flex items-center gap-1.5">
          <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} style={{ ...miniInput, width: 130, padding: "5px 6px" }} />
          <span style={{ color: C.inkFaint, fontSize: 12 }}>to</span>
          <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} style={{ ...miniInput, width: 130, padding: "5px 6px" }} />
        </div>
      )}
      <label className="flex items-center gap-1.5" style={{ fontSize: 12.5, color: C.inkSoft }}>
        <input type="checkbox" checked={compareYoY} onChange={(e) => setCompareYoY(e.target.checked)} />
        Compare to last year
      </label>
    </div>
  );
}

function ChartTooltip({ active, payload, formatValue, compareYoY }) {
  if (!active || !payload || !payload.length) return null;
  const cur = payload.find((p) => p.dataKey === "current");
  const prev = payload.find((p) => p.dataKey === "previous");
  if (!cur) return null;
  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 6, padding: "8px 10px", fontSize: 12.5 }}>
      <div><strong>{fmtDateShort(cur.payload.date)}</strong>: <span className="ll-mono">{formatValue(cur.value)}</span></div>
      {compareYoY && prev && prev.value !== undefined && (
        <div style={{ color: C.inkFaint, marginTop: 2 }}>{fmtDateShort(cur.payload.previousDate)}: <span className="ll-mono">{formatValue(prev.value)}</span></div>
      )}
    </div>
  );
}

function useChartSeries(opening, lines, interval, compareYoY, rangeCtx) {
  const earliest = lines.length ? lines[0].date : todayISO();
  const { start, end } = intervalRange(interval, { earliestISO: earliest, ...rangeCtx });
  const currentSeries = useMemo(() => buildDailySeries(opening, lines, start, end), [opening, lines, start, end]);
  const prevRange = compareYoY ? { start: addYears(start, -1), end: addYears(end, -1) } : null;
  const previousSeries = useMemo(() => (prevRange ? buildDailySeries(opening, lines, prevRange.start, prevRange.end) : null), [opening, lines, prevRange]);
  return useMemo(
    () =>
      currentSeries.map((p, i) => ({
        offset: i,
        date: p.date,
        current: p.value,
        previous: previousSeries && previousSeries[i] ? previousSeries[i].value : undefined,
        previousDate: previousSeries && previousSeries[i] ? previousSeries[i].date : undefined,
      })),
    [currentSeries, previousSeries]
  );
}

function useCostBasisSeries(lines, interval, compareYoY, rangeCtx) {
  const earliest = lines.length ? lines[0].date : todayISO();
  const { start, end } = intervalRange(interval, { earliestISO: earliest, ...rangeCtx });
  const currentSeries = useMemo(() => buildCostBasisSeries(lines, start, end), [lines, start, end]);
  const prevRange = compareYoY ? { start: addYears(start, -1), end: addYears(end, -1) } : null;
  const previousSeries = useMemo(() => (prevRange ? buildCostBasisSeries(lines, prevRange.start, prevRange.end) : null), [lines, prevRange]);
  return useMemo(
    () =>
      currentSeries.map((p, i) => ({
        offset: i,
        date: p.date,
        current: p.value,
        previous: previousSeries && previousSeries[i] ? previousSeries[i].value : undefined,
        previousDate: previousSeries && previousSeries[i] ? previousSeries[i].date : undefined,
      })),
    [currentSeries, previousSeries]
  );
}

function usePortfolioValueSeries(lines, interval, compareYoY, rangeCtx) {
  const earliest = lines.length ? lines[0].date : todayISO();
  const { start, end } = intervalRange(interval, { earliestISO: earliest, ...rangeCtx });
  const currentSeries = useMemo(() => buildPortfolioValueSeries(lines, start, end), [lines, start, end]);
  const prevRange = compareYoY ? { start: addYears(start, -1), end: addYears(end, -1) } : null;
  const previousSeries = useMemo(() => (prevRange ? buildPortfolioValueSeries(lines, prevRange.start, prevRange.end) : null), [lines, prevRange]);
  return useMemo(
    () =>
      currentSeries.map((p, i) => ({
        offset: i,
        date: p.date,
        current: p.value,
        previous: previousSeries && previousSeries[i] ? previousSeries[i].value : undefined,
        previousDate: previousSeries && previousSeries[i] ? previousSeries[i].date : undefined,
      })),
    [currentSeries, previousSeries]
  );
}

export function BalanceChart({ account, transactions, activeTaxYearStart }) {
  const [interval, setInterval_] = useState("taxyear");
  const [compareYoY, setCompareYoY] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const lines = useMemo(
    () => transactions.map((t) => t.lines.find((l) => l.accountId === account.id)).filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    [transactions, account]
  );
  const rangeCtx = { taxYearStart: activeTaxYearStart, customStart, customEnd };
  const merged = useChartSeries(account.openingBalance || 0, lines, interval, compareYoY, rangeCtx);

  if (lines.length === 0) {
    return <div style={{ padding: "40px 0", textAlign: "center", color: C.inkFaint, fontSize: 13 }}>Not enough entries yet to chart.</div>;
  }

  return (
    <div>
      <div className="mb-4">
        <IntervalControls
          interval={interval}
          setInterval={(key) => { selectIntervalWithCustomSeed(key, activeTaxYearStart, customStart, customEnd, setCustomStart, setCustomEnd); setInterval_(key); }}
          compareYoY={compareYoY} setCompareYoY={setCompareYoY}
          customStart={customStart} setCustomStart={setCustomStart} customEnd={customEnd} setCustomEnd={setCustomEnd}
        />
      </div>
      <div style={{ height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={merged} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={C.lineSoft} vertical={false} />
            <XAxis dataKey="offset" tickFormatter={(o) => (merged[o] ? fmtDateShort(merged[o].date) : "")} tick={{ fontSize: 11, fill: C.inkFaint }} axisLine={{ stroke: C.line }} tickLine={false} minTickGap={40} />
            <YAxis tickFormatter={(v) => fmt(v, account.currency)} tick={{ fontSize: 11, fill: C.inkFaint }} axisLine={false} tickLine={false} width={80} />
            <Tooltip content={<ChartTooltip formatValue={(v) => fmt(v, account.currency)} compareYoY={compareYoY} />} />
            {compareYoY && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {compareYoY && <Line type="stepAfter" dataKey="previous" name="Same period last year" stroke={C.goldDim} strokeWidth={1.5} dot={false} isAnimationActive={false} />}
            <Line type="stepAfter" dataKey="current" name="Balance" stroke={C.gold} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function StockChartTooltip({ active, payload, account, tradingCurrency, compareYoY }) {
  if (!active || !payload || !payload.length) return null;
  const byKey = {};
  payload.forEach((p) => { byKey[p.dataKey] = p; });
  const date = payload[0].payload.date;
  const row = (color, label, val, fmtFn) =>
    val !== undefined && val !== null ? (
      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: "inline-block" }} />
        {label}: <span className="ll-mono">{fmtFn(val)}</span>
      </div>
    ) : null;
  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 6, padding: "8px 10px", fontSize: 12.5, lineHeight: 1.7 }}>
      <div style={{ fontWeight: 600, marginBottom: 3 }}>{fmtDateShort(date)}</div>
      {row(C.gold, "Units", byKey.units && byKey.units.value, (v) => `${fmtUnits(v, account.symbol)} ${account.symbol}`)}
      {row(C.credit, "Cost basis", byKey.cost && byKey.cost.value, (v) => fmt(v, tradingCurrency))}
      {row(C.plum, "Worth", byKey.value && byKey.value.value, (v) => fmt(v, tradingCurrency))}
      {compareYoY && (
        <div style={{ marginTop: 4, paddingTop: 4, borderTop: `1px solid ${C.lineSoft}`, color: C.inkFaint }}>
          {row(C.goldDim, "Units, last year", byKey.unitsPrev && byKey.unitsPrev.value, (v) => `${fmtUnits(v, account.symbol)} ${account.symbol}`)}
          {row(C.credit, "Cost, last year", byKey.costPrev && byKey.costPrev.value, (v) => fmt(v, tradingCurrency))}
          {row(C.plum, "Worth, last year", byKey.valuePrev && byKey.valuePrev.value, (v) => fmt(v, tradingCurrency))}
        </div>
      )}
    </div>
  );
}

export function UnitsChart({ account, transactions, tradingCurrency, activeTaxYearStart }) {
  const [interval, setInterval_] = useState("taxyear");
  const [compareYoY, setCompareYoY] = useState(false);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  const rawLines = useMemo(
    () => transactions.map((t) => t.lines.find((l) => l.accountId === account.id)).filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    [transactions, account]
  );

  // All three share the same underlying lines, so they land on identical
  // date/offset grids and can be zipped together into one dataset below.
  const rangeCtx = { taxYearStart: activeTaxYearStart, customStart, customEnd };
  const unitsMerged = useChartSeries(account.openingBalance || 0, rawLines, interval, compareYoY, rangeCtx);
  const costMerged = useCostBasisSeries(rawLines, interval, compareYoY, rangeCtx);
  const valueMerged = usePortfolioValueSeries(rawLines, interval, compareYoY, rangeCtx);

  const merged = useMemo(
    () =>
      unitsMerged.map((p, i) => ({
        offset: p.offset,
        date: p.date,
        units: p.current,
        unitsPrev: p.previous,
        cost: costMerged[i] ? costMerged[i].current : undefined,
        costPrev: costMerged[i] ? costMerged[i].previous : undefined,
        value: valueMerged[i] ? valueMerged[i].current : undefined,
        valuePrev: valueMerged[i] ? valueMerged[i].previous : undefined,
      })),
    [unitsMerged, costMerged, valueMerged]
  );

  if (rawLines.length === 0) {
    return <div style={{ padding: "40px 0", textAlign: "center", color: C.inkFaint, fontSize: 13 }}>Not enough trades yet to chart.</div>;
  }

  return (
    <div>
      <div className="mb-4">
        <IntervalControls
          interval={interval}
          setInterval={(key) => { selectIntervalWithCustomSeed(key, activeTaxYearStart, customStart, customEnd, setCustomStart, setCustomEnd); setInterval_(key); }}
          compareYoY={compareYoY} setCompareYoY={setCompareYoY}
          customStart={customStart} setCustomStart={setCustomStart} customEnd={customEnd} setCustomEnd={setCustomEnd}
        />
      </div>
      <p style={{ fontSize: 11.5, color: C.inkFaint, marginTop: -8, marginBottom: 12 }}>
        Units held shown as bars (left axis); cost basis (solid line) and portfolio value (dotted line) share the right axis. Neither line is a live market value — cost basis is what you've actually put in (average cost), portfolio value marks your holding at your own most recent trade price. They start out equal on a fresh position, so the line style is what tells them apart where they sit on top of each other.
      </p>
      {/* One chart, not two — bars for units instead of a step line means
          a buy/sell's change in holdings reads as a change in bar height,
          not a competing vertical line on the same pixel as the cost/value
          lines' own jumps. A single chart also means one shared axis
          width, so there's nothing left to misalign. */}
      <div style={{ height: 340 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={merged} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={C.lineSoft} vertical={false} />
            <XAxis dataKey="offset" tickFormatter={(o) => (merged[o] ? fmtDateShort(merged[o].date) : "")} tick={{ fontSize: 11, fill: C.inkFaint }} axisLine={{ stroke: C.line }} tickLine={false} minTickGap={40} />
            <YAxis yAxisId="units" tickFormatter={(v) => fmtUnits(v, account.symbol)} tick={{ fontSize: 11, fill: C.gold }} axisLine={false} tickLine={false} width={55} />
            <YAxis yAxisId="money" orientation="right" tickFormatter={(v) => fmt(v, tradingCurrency)} tick={{ fontSize: 11, fill: C.inkFaint }} axisLine={false} tickLine={false} width={80} />
            <Tooltip content={<StockChartTooltip account={account} tradingCurrency={tradingCurrency} compareYoY={compareYoY} />} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {compareYoY && <Line yAxisId="units" type="stepAfter" dataKey="unitsPrev" name="Units (last year)" stroke={C.goldDim} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />}
            <Bar yAxisId="units" dataKey="units" name={`${account.symbol} units`} fill={C.gold} fillOpacity={0.3} isAnimationActive={false} />
            {compareYoY && <Line yAxisId="money" type="stepAfter" dataKey="costPrev" name="Cost basis (last year)" stroke={C.credit} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />}
            {compareYoY && <Line yAxisId="money" type="stepAfter" dataKey="valuePrev" name="Portfolio value (last year)" stroke={C.plum} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />}
            <Line yAxisId="money" type="stepAfter" dataKey="cost" name="Cost basis" stroke={C.credit} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
            <Line yAxisId="money" type="stepAfter" dataKey="value" name="Portfolio value" stroke={C.plum} strokeWidth={2} strokeDasharray="1 3" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
