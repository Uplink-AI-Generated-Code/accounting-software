import { C, TYPES, ISA_KINDS } from "../lib/theme";
import { fmt, fmtUnits } from "../lib/format";

export function AccountCard({ a, accounts, symbols, onSelect }) {
  // Trading currency lives on the Symbol now, not the Account itself — see
  // CLAUDE.md.
  const tradingCurrency = symbols.find((s) => s.ticker === a.symbol)?.tradingCurrency;
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
          <div className="ll-mono" style={{ fontSize: 16, marginTop: 8, color: C.ink }}>{fmtUnits(a.balance || 0, a.symbol)} <span style={{ fontSize: 13, color: C.inkFaint }}>units</span></div>
          <div className="ll-mono" style={{ fontSize: 13, marginTop: 2, color: C.ink }}>{fmt(a.portfolioValue || 0, tradingCurrency)} <span style={{ color: C.inkFaint }}>worth</span></div>
          <div className="ll-mono" style={{ fontSize: 12, marginTop: 1, color: C.inkFaint }}>{fmt(a.costBasis || 0, tradingCurrency)} cost basis</div>
        </>
      ) : (
        <div className="ll-mono" style={{ fontSize: 18, marginTop: 8, color: (a.balance || 0) < 0 ? C.debit : C.ink }}>{fmt(a.balance || 0, a.currency)}</div>
      )}
    </button>
  );
}
