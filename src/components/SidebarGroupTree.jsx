import { AlertTriangle } from "lucide-react";
import { C, ISA_KINDS } from "../lib/theme";
import { fmt, displayAccountName } from "../lib/format";

// Renders nested groups in the sidebar — indented headers down to
// whichever level is a leaf, where actual clickable account rows appear.
export function SidebarGroupTree({ groups, depth, selectedId, onSelect, accountDisplay }) {
  return groups.map((g) => (
    <div key={g.key} className="mb-3" style={{ marginLeft: depth * 8 }}>
      <div style={{ fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: C.inkFaint, padding: "4px 8px" }}>{g.label}</div>
      {g.leaf ? (
        g.items.map((a) => {
          // See AccountRow.jsx for what these fields are and why
          // imbalanceIn/imbalanceOut are kept separate rather than netted.
          const imbalanced = (a.imbalancedLineCount || 0) > 0;
          const imbalanceCurrency = a.type === "investment" ? a.symbolCurrency : a.currency;
          const imbalanceTitle = imbalanced
            ? `${a.imbalancedLineCount} imbalanced line${a.imbalancedLineCount === 1 ? "" : "s"}`
              + (a.imbalanceOut > 0 ? ` — Out ${fmt(a.imbalanceOut, imbalanceCurrency)}` : "")
              + (a.imbalanceIn > 0 ? ` — In ${fmt(a.imbalanceIn, imbalanceCurrency)}` : "")
            : "";
          return (
            <button
              key={a.id}
              onClick={() => onSelect(a.id)}
              className="w-full text-left py-1.5 rounded flex items-center justify-between"
              style={{ paddingLeft: 6, paddingRight: 8, background: selectedId === a.id ? C.paperDim : "transparent", borderLeft: `3px solid ${imbalanced ? C.debit : "transparent"}` }}
            >
              <span style={{ fontSize: 13.5, color: C.ink, display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                {imbalanced && <AlertTriangle size={11} color={C.debit} title={imbalanceTitle} style={{ flexShrink: 0 }} />}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayAccountName(a)}</span>
                {a.isaKind && <span title={ISA_KINDS.find((k) => k.key === a.isaKind)?.label} style={{ fontSize: 9.5, fontWeight: 700, color: C.gold, border: `1px solid ${C.goldDim}`, borderRadius: 3, padding: "1px 3px", letterSpacing: 0.3, flexShrink: 0 }}>ISA</span>}
              </span>
              <span className="ll-mono" style={{ fontSize: a.type === "investment" ? 11 : 12, color: (a.balance || 0) < 0 ? C.debit : C.inkSoft, flexShrink: 0 }}>{accountDisplay(a)}</span>
            </button>
          );
        })
      ) : (
        <SidebarGroupTree groups={g.children} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} accountDisplay={accountDisplay} />
      )}
    </div>
  ));
}
