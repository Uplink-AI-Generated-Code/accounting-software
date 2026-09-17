import { useState } from "react";
import { X, AlertTriangle, Plus } from "lucide-react";
import { C } from "../lib/theme";
import { fmt } from "../lib/format";

export function iconBtn(color) { return { padding: 6, borderRadius: 4, border: `1px solid ${C.line}`, color, background: C.card }; }
export const miniInput = { width: "100%", padding: "7px 8px", borderRadius: 4, border: `1px solid ${C.line}`, background: C.paper, fontSize: 13, color: C.ink, outline: "none" };
export const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 5, border: `1px solid ${C.line}`, background: C.paper, fontSize: 13.5, color: C.ink, outline: "none" };

export function Field({ label, children, style }) {
  return (
    <label style={{ display: "block", ...style }}>
      <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </label>
  );
}

// Shown on an account's own detail page (AccountLedger/StockLedger's
// header) when it has any imbalanced lines — see AccountRow.jsx/
// CLAUDE.md's "Matching and linking" for what `imbalancedLineCount`/
// `imbalanceIn`/`imbalanceOut` mean and why In/Out are kept as two
// separate sums instead of one net value. `currency` is the account's
// own currency for a cash account, or its Symbol's tradingCurrency for
// an investment account — callers already have that computed for their
// own balance display, so it's passed in rather than re-derived here.
export function ImbalanceBadge({ account, currency }) {
  if (!(account.imbalancedLineCount > 0)) return null;
  return (
    <span
      className="flex items-center gap-2"
      style={{ marginTop: 6, fontSize: 12.5, color: C.debit, background: C.debitBg, padding: "3px 8px", borderRadius: 4, width: "fit-content" }}
    >
      <AlertTriangle size={13} />
      {account.imbalancedLineCount} imbalanced line{1 === account.imbalancedLineCount ? "" : "s"}
      {account.imbalanceOut > 0 && <span>· Out {fmt(account.imbalanceOut, currency)}</span>}
      {account.imbalanceIn > 0 && <span>· In {fmt(account.imbalanceIn, currency)}</span>}
    </span>
  );
}

// Read-only chip display for a line's tags — see CLAUDE.md's "Tags"
// section. A bare (value-less) tag shows just its dimension; a "Car" tag
// with value "AB12CDE" shows "Car: AB12CDE".
export function TagChips({ tags }) {
  if (!tags || !tags.length) return null;
  return (
    <span className="flex flex-wrap items-center" style={{ gap: 4 }}>
      {tags.map((t, i) => (
        <span key={`${t.dimension}:${t.value}:${i}`} style={{ fontSize: 10, color: C.inkFaint, background: C.paperDim, border: `1px solid ${C.lineSoft}`, borderRadius: 3, padding: "1px 5px", whiteSpace: "nowrap" }}>
          {t.dimension}{t.value ? `: ${t.value}` : ""}
        </span>
      ))}
    </span>
  );
}

// Editable tag list for a line being edited — chips with a remove button,
// plus a small dimension/value add form. `knownTags` (the app-wide list
// from GET /api/tags) feeds the two datalists: existing dimensions first,
// then existing values once a dimension's chosen — the guardrail against
// "Refunded"/"refund" silently becoming two different tags (see
// CLAUDE.md). Value is optional — a bare tag like "Car" with no value is
// a legitimate flag, not an incomplete entry.
export function TagsEditor({ tags, onChange, knownTags = [] }) {
  const [dimension, setDimension] = useState("");
  const [value, setValue] = useState("");
  const knownDimensions = Array.from(new Set(knownTags.map((t) => t.dimension))).sort();
  const knownValues = Array.from(new Set(knownTags.filter((t) => t.dimension === dimension.trim()).map((t) => t.value).filter(Boolean))).sort();

  function add() {
    const d = dimension.trim();
    if (!d) return;
    const v = value.trim();
    if (!tags.some((t) => t.dimension === d && t.value === v)) onChange([...tags, { dimension: d, value: v }]);
    setDimension("");
    setValue("");
  }
  function remove(i) {
    onChange(tags.filter((_, idx) => idx !== i));
  }
  function onKeyDown(e) {
    if (e.key === "Enter") { e.preventDefault(); add(); }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {tags.length > 0 && (
        <div className="flex flex-wrap" style={{ gap: 4 }}>
          {tags.map((t, i) => (
            <span key={`${t.dimension}:${t.value}:${i}`} className="flex items-center" style={{ gap: 3, fontSize: 11.5, color: C.inkSoft, background: C.paperDim, border: `1px solid ${C.line}`, borderRadius: 4, padding: "2px 5px 2px 7px" }}>
              {t.dimension}{t.value ? `: ${t.value}` : ""}
              <button type="button" onClick={() => remove(i)} style={{ display: "flex", padding: 1 }}><X size={10} color={C.inkFaint} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex" style={{ gap: 5 }}>
        <input value={dimension} onChange={(e) => setDimension(e.target.value)} onKeyDown={onKeyDown} placeholder="Tag" style={{ ...miniInput, width: 100 }} list="ll-tag-dimensions" />
        <datalist id="ll-tag-dimensions">{knownDimensions.map((d) => <option key={d} value={d} />)}</datalist>
        <input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown} placeholder="Value (optional)" style={{ ...miniInput, width: 130 }} list="ll-tag-values" />
        <datalist id="ll-tag-values">{knownValues.map((v) => <option key={v} value={v} />)}</datalist>
        <button type="button" onClick={add} style={iconBtn(C.inkSoft)}><Plus size={12} /></button>
      </div>
    </div>
  );
}

export function ModalShell({ title, children, onCancel, wide }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ background: "rgba(34,39,31,0.35)", zIndex: 50 }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, padding: 22, width: wide ? 560 : 380, maxWidth: "92vw", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(34,39,31,0.25)" }}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="ll-serif" style={{ fontSize: 17 }}>{title}</h3>
          <button onClick={onCancel}><X size={16} color={C.inkFaint} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
