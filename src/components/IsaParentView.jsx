import { Plus } from "lucide-react";
import { C } from "../lib/theme";
import { fmt, fmtUnits } from "../lib/format";

/* ---------------------------------------------------------
   ISA parent (Stocks & Shares ISA wrapper) — holds no ledger of its own,
   just groups its cash and stock subaccounts.
--------------------------------------------------------- */
export function IsaParentView({ account, accounts, balances, stockPortfolioValues, onEditAccount, onSelect, onNewSubaccount }) {
  const subs = accounts.filter((a) => a.isaParentId === account.id);
  const cashSubs = subs.filter((a) => a.type === "asset");
  const stockSubs = subs.filter((a) => a.type === "investment");

  return (
    <div>
      <div className="flex items-start justify-between mb-5">
        <div>
          <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>Stocks & Shares ISA</div>
          <h2 className="ll-serif" style={{ fontSize: 24, marginTop: 2 }}>{account.name}</h2>
          <div style={{ fontSize: 13, color: C.inkFaint, marginTop: 6 }}>{subs.length} subaccount{subs.length === 1 ? "" : "s"}</div>
        </div>
        <button onClick={onEditAccount} className="px-3 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13 }}>Edit ISA</button>
      </div>

      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <div style={{ fontSize: 11, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.6 }}>Cash</div>
          <button onClick={() => onNewSubaccount("asset")} className="flex items-center gap-1" style={{ fontSize: 12.5, color: C.gold }}><Plus size={13} /> Add cash subaccount</button>
        </div>
        {cashSubs.length === 0 ? (
          <div style={{ fontSize: 13, color: C.inkFaint, padding: "8px 0" }}>No cash subaccounts yet.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {cashSubs.map((a) => (
              <button key={a.id} onClick={() => onSelect(a.id)} className="flex items-center justify-between px-3 py-2.5 rounded text-left" style={{ background: C.card, border: `1px solid ${C.line}` }}>
                <span style={{ fontSize: 13.5 }}>{a.name} <span style={{ color: C.inkFaint, fontSize: 12 }}>({a.currency})</span></span>
                <span className="ll-mono" style={{ fontSize: 13.5, color: (balances[a.id] || 0) < 0 ? C.debit : C.ink }}>{fmt(balances[a.id] || 0, a.currency)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div style={{ fontSize: 11, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.6 }}>Holdings</div>
          <button onClick={() => onNewSubaccount("investment")} className="flex items-center gap-1" style={{ fontSize: 12.5, color: C.gold }}><Plus size={13} /> Add stock subaccount</button>
        </div>
        {stockSubs.length === 0 ? (
          <div style={{ fontSize: 13, color: C.inkFaint, padding: "8px 0" }}>No stock subaccounts yet.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {stockSubs.map((a) => (
              <button key={a.id} onClick={() => onSelect(a.id)} className="flex items-center justify-between px-3 py-2.5 rounded text-left" style={{ background: C.card, border: `1px solid ${C.line}` }}>
                <span style={{ fontSize: 13.5 }}>{a.name} <span style={{ color: C.gold, fontSize: 12 }}>{a.symbol}</span></span>
                <span className="ll-mono" style={{ fontSize: 13.5 }}>{fmtUnits(balances[a.id] || 0)} units · {fmt((stockPortfolioValues && stockPortfolioValues[a.id]) || 0, a.currency)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
