import { useEffect, useState } from "react";
import { C } from "../lib/theme";
import { fmt, fmtUnits, fmtDate, displayAccountName } from "../lib/format";
import { getTaggedLines } from "../api";
import { useTagTotals } from "./useTagTotals";
import { symbolKey } from "../lib/symbolKey";

/* ---------------------------------------------------------
   Tags — browsing/reporting for the cross-cutting facts that don't fit
   the account model (which car, which trip, refund status, ...). See
   CLAUDE.md's "Tags" section. Deliberately separate from Overview: most
   "how much did I spend/earn on X" questions are already answered by the
   account-grouping tree (Counterparty/Subtype/Type) — this view exists
   only for the genuinely cross-cutting remainder.
--------------------------------------------------------- */
export function TagsView({ knownTags, onSelect }) {
  const dimensions = Array.from(new Set(knownTags.map((t) => t.dimension))).sort();
  const [dimension, setDimension] = useState(dimensions[0] || "");
  useEffect(() => {
    if (!dimension && dimensions.length) setDimension(dimensions[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimensions.join("|")]);

  const { totals, loaded } = useTagTotals(dimension);

  const [drillValue, setDrillValue] = useState(null);
  const [lines, setLines] = useState([]);
  const [linesLoaded, setLinesLoaded] = useState(false);
  useEffect(() => {
    setDrillValue(null);
  }, [dimension]);
  useEffect(() => {
    if (drillValue === null) { setLines([]); return; }
    let cancelled = false;
    setLinesLoaded(false);
    getTaggedLines(dimension, drillValue)
      .then((data) => { if (!cancelled) setLines(data || []); })
      .catch(() => { if (!cancelled) setLines([]); })
      .finally(() => { if (!cancelled) setLinesLoaded(true); });
    return () => { cancelled = true; };
  }, [dimension, drillValue]);

  if (dimensions.length === 0) {
    return (
      <div>
        <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>Tags</div>
        <h2 className="ll-serif" style={{ fontSize: 24, marginTop: 2 }}>No tags yet</h2>
        <p style={{ fontSize: 13, color: C.inkFaint, marginTop: 8, maxWidth: 480, lineHeight: 1.5 }}>
          Tag a line from its own ledger (e.g. "Car", "Trip", "Status") for
          cross-cutting facts that don't fit an account's Type/Subtype/
          Counterparty — a report will show up here once one exists.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>Tags</div>
      <h2 className="ll-serif" style={{ fontSize: 24, marginTop: 2, marginBottom: 14 }}>{dimension || "Pick a dimension"}</h2>

      <div className="flex flex-wrap gap-1.5 mb-5">
        {dimensions.map((d) => (
          <button
            key={d}
            onClick={() => setDimension(d)}
            className="px-2.5 py-1.5 rounded"
            style={{ fontSize: 12.5, border: `1px solid ${C.line}`, background: d === dimension ? C.paperDim : C.card, fontWeight: d === dimension ? 600 : 400 }}
          >
            {d}
          </button>
        ))}
      </div>

      {!loaded && <div style={{ fontSize: 13, color: C.inkFaint }}>Loading…</div>}
      {loaded && totals.length === 0 && <div style={{ fontSize: 13, color: C.inkFaint }}>No totals for this dimension yet.</div>}

      <div className="flex flex-col gap-1.5">
        {totals.map((t) => (
          <div key={`${t.value}:${t.currency}`}>
            <button
              onClick={() => setDrillValue(drillValue === t.value ? null : t.value)}
              className="w-full flex items-center justify-between px-3 py-2.5 rounded text-left"
              style={{ background: drillValue === t.value ? C.paperDim : C.card, border: `1px solid ${C.line}` }}
            >
              <span style={{ fontSize: 13.5 }}>{t.value || <span style={{ fontStyle: "italic", color: C.inkFaint }}>(no value)</span>}</span>
              <span className="ll-mono" style={{ fontSize: 13.5, color: t.amount < 0 ? C.debit : C.ink }}>{fmt(t.amount, t.currency)}</span>
            </button>

            {drillValue === t.value && (
              <div className="mt-1.5 mb-1" style={{ paddingLeft: 12, borderLeft: `2px solid ${C.lineSoft}` }}>
                {!linesLoaded && <div style={{ fontSize: 12, color: C.inkFaint, padding: "4px 0" }}>Loading…</div>}
                {linesLoaded && lines.length === 0 && <div style={{ fontSize: 12, color: C.inkFaint, padding: "4px 0" }}>No lines found.</div>}
                {lines.map((l) => (
                  <button
                    key={l.lineId}
                    onClick={() => onSelect(l.account.id)}
                    className="w-full flex items-center justify-between px-2 py-1.5 rounded text-left"
                    style={{ fontSize: 12.5 }}
                  >
                    <span className="flex items-center gap-2" style={{ color: C.inkSoft, minWidth: 0 }}>
                      <span style={{ color: C.inkFaint, fontSize: 11.5 }}>{fmtDate(l.line.date)}</span>
                      <strong style={{ color: C.ink }}>{displayAccountName(l.account)}</strong>
                      {l.line.description && <span style={{ color: C.inkFaint }}>· {l.line.description}</span>}
                    </span>
                    <span className="ll-mono" style={{ color: l.line.amount < 0 ? C.debit : C.credit, flexShrink: 0 }}>
                      {l.account.type === "investment"
                        ? `${fmtUnits(l.line.amount, symbolKey(l.account.symbolTicker, l.account.symbolCurrency))} units`
                        : fmt(l.line.amount, l.account.currency)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
