import { useMemo, useState } from "react";
import { C, ISA_KINDS } from "../lib/theme";
import { fmt, todayISO } from "../lib/format";
import { taxYearStartYearFor, taxYearBounds, isaRulesFor, isaProducts, computeIsaUsage } from "../lib/isa";

/* ---------------------------------------------------------
   ISA Allowance — how much of the current (or a nearby) UK tax year's
   allowance has been used, per ISA kind, against whichever rules apply
   to that tax year. The 2027/28 Cash ISA sub-cap appears automatically
   once that tax year is in view — nothing here needed manual updating.
--------------------------------------------------------- */
export function AllowanceView({ accounts, transactions, settings, onSaveSettings, onSelect }) {
  const currentStartYear = taxYearStartYearFor(todayISO());
  const [startYear, setStartYear] = useState(currentStartYear);

  const { label } = taxYearBounds(startYear);
  const rules = isaRulesFor(startYear, settings.over65);
  const usage = useMemo(() => computeIsaUsage(accounts, transactions, startYear), [accounts, transactions, startYear]);

  function Bar({ used, cap, color }) {
    const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
    return (
      <div style={{ height: 6, borderRadius: 3, background: C.paperDim, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, transition: "width 300ms ease" }} />
      </div>
    );
  }

  const products = useMemo(() => isaProducts(accounts), [accounts]);
  const productsByKind = {};
  products.forEach((p) => {
    productsByKind[p.kind] = productsByKind[p.kind] || [];
    productsByKind[p.kind].push(p);
  });

  return (
    <div>
      <div className="flex items-start justify-between mb-5">
        <div>
          <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>ISA Allowance</div>
          <h2 className="ll-serif" style={{ fontSize: 24, marginTop: 2 }}>Tax year {label}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setStartYear((y) => y - 1)} className="px-2.5 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13 }}>←</button>
          <button onClick={() => setStartYear(currentStartYear)} disabled={startYear === currentStartYear} className="px-3 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13, opacity: startYear === currentStartYear ? 0.4 : 1 }}>This year</button>
          <button onClick={() => setStartYear((y) => y + 1)} className="px-2.5 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13 }}>→</button>
        </div>
      </div>

      <label className="flex items-center gap-2 mb-6" style={{ fontSize: 13, color: C.inkSoft }}>
        <input type="checkbox" checked={!!settings.over65} onChange={(e) => onSaveSettings({ ...settings, over65: e.target.checked })} />
        I'm 65 or over (keeps the full £20,000 Cash ISA capacity once the lower cap applies)
      </label>

      <div className="p-4 rounded mb-4" style={{ background: C.card, border: `1px solid ${C.line}` }}>
        <div className="flex items-center justify-between mb-2">
          <div style={{ fontSize: 13, fontWeight: 600 }}>Overall</div>
          <div className="ll-mono" style={{ fontSize: 13 }}>{fmt(usage.total, "GBP")} <span style={{ color: C.inkFaint }}>of {fmt(rules.total, "GBP")}</span></div>
        </div>
        <Bar used={usage.total} cap={rules.total} color={usage.total > rules.total ? C.debit : C.gold} />
      </div>

      <div className="flex flex-col gap-3">
        {ISA_KINDS.map((k) => {
          const used = usage.byKind[k.key] || 0;
          const cap = rules.subCaps[k.key];
          const holders = productsByKind[k.key] || [];
          if (used === 0 && holders.length === 0) return null;
          return (
            <div key={k.key} className="p-4 rounded" style={{ background: C.card, border: `1px solid ${C.line}` }}>
              <div className="flex items-center justify-between mb-2">
                <div style={{ fontSize: 13, fontWeight: 600 }}>{k.label}</div>
                <div className="ll-mono" style={{ fontSize: 13 }}>
                  {fmt(used, "GBP")} {cap ? <span style={{ color: C.inkFaint }}>of {fmt(cap, "GBP")}</span> : <span style={{ color: C.inkFaint }}>· no sub-cap</span>}
                </div>
              </div>
              {cap && <Bar used={used} cap={cap} color={used > cap ? C.debit : C.goldDim} />}
              {holders.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {holders.map((p) => (
                    <button key={p.account.id} onClick={() => onSelect(p.account.id)} className="flex items-center gap-1.5" style={{ fontSize: 11.5, color: C.inkFaint, border: `1px solid ${C.line}`, borderRadius: 4, padding: "2px 6px" }}>
                      <span className="ll-mono">{p.account.name}</span>
                      {p.flexible && <span style={{ color: C.gold, fontWeight: 700, fontSize: 10 }}>FLEX</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 16, lineHeight: 1.5 }}>
        Counts new money entering an ISA from outside your ISAs this tax year — a transfer between two of your own ISAs, or moving cash within the same Stocks & Shares ISA, is never new money and never counts. Opening balances aren't included, though they still count as "older money" for the rule below. For a flexible ISA (marked FLEX above), a withdrawal is treated as this year's own money first — replaceable into any flexible ISA — then older money, which is only replaceable back into that same ISA, matching HMRC's actual ordering. Non-flexible ISAs get none of this: withdrawals never free up allowance.
      </p>
    </div>
  );
}
