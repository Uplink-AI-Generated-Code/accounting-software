import { C, TYPES, ISA_KINDS } from "../lib/theme";
import { fmt, fmtUnits } from "../lib/format";

export function AccountCard({ a, accounts, balances, stockCostBasis, stockPortfolioValues, onSelect }) {
  return (
    <button onClick={() => onSelect(a.id)} className="text-left p-4 rounded" style={{ background: C.card, border: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>
        {TYPES.find((t) => t.key === a.type)?.label}{a.type === "investment" ? ` · ${a.symbol}` : ""}
        {a.isaKind ? ` · ${ISA_KINDS.find((k) => k.key === a.isaKind)?.label}` : ""}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, marginTop: 4 }}>{a.name}</div>
      {a.type === "isa-parent" ? (
        <div className="ll-mono" style={{ fontSize: 14, marginTop: 8, color: C.inkFaint }}>{accounts.filter((x) => x.isaParentId === a.id).length} subaccounts</div>
      ) : a.type === "investment" ? (
        <>
          <div className="ll-mono" style={{ fontSize: 16, marginTop: 8, color: C.ink }}>{fmtUnits(balances[a.id] || 0)} <span style={{ fontSize: 13, color: C.inkFaint }}>units</span></div>
          <div className="ll-mono" style={{ fontSize: 13, marginTop: 2, color: C.ink }}>{fmt((stockPortfolioValues && stockPortfolioValues[a.id]) || 0, a.currency)} <span style={{ color: C.inkFaint }}>worth</span></div>
          <div className="ll-mono" style={{ fontSize: 12, marginTop: 1, color: C.inkFaint }}>{fmt((stockCostBasis && stockCostBasis[a.id]) || 0, a.currency)} cost basis</div>
        </>
      ) : (
        <div className="ll-mono" style={{ fontSize: 18, marginTop: 8, color: (balances[a.id] || 0) < 0 ? C.debit : C.ink }}>{fmt(balances[a.id] || 0, a.currency)}</div>
      )}
    </button>
  );
}
