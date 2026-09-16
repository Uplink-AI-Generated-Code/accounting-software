import { X, AlertTriangle } from "lucide-react";
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
// `imbalanceValue` mean and why the value can legitimately read 0
// alongside a nonzero count. `currency` is the account's own currency for
// a cash account, or its Symbol's tradingCurrency for an investment
// account — callers already have that computed for their own balance
// display, so it's passed in rather than re-derived here.
export function ImbalanceBadge({ account, currency }) {
  if (!(account.imbalancedLineCount > 0)) return null;
  return (
    <span
      className="flex items-center gap-1.5"
      style={{ marginTop: 6, fontSize: 12.5, color: C.debit, background: C.debitBg, padding: "3px 8px", borderRadius: 4, width: "fit-content" }}
    >
      <AlertTriangle size={13} />
      {account.imbalancedLineCount} imbalanced line{1 === account.imbalancedLineCount ? "" : "s"} · off by {fmt(account.imbalanceValue || 0, currency)}
    </span>
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
