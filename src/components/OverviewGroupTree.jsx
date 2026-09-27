import { C } from "../lib/theme";
import { fmt, fracWidth } from "../lib/format";
import { subtotalsForItems } from "../lib/grouping";
import { AccountRow } from "./AccountRow";

// Renders nested groups on the Overview page — a subtotal line at every
// non-Type level, and a card grid once a branch reaches its leaf.
export function OverviewGroupTree({ groups, depth, accounts, symbols, onSelect, groupLevels }) {
  return groups.map((g) => {
    const sub = g.dim !== "type" ? subtotalsForItems(g.items) : null;
    return (
      <div key={g.key} className="mb-6" style={{ marginLeft: depth * 14 }}>
        <div className="flex items-baseline justify-between mb-2">
          <div style={{ fontSize: depth === 0 ? 12 : 11, fontWeight: 600, color: C.inkSoft, textTransform: "uppercase", letterSpacing: 0.6 }}>{g.label}</div>
          {sub && Object.keys(sub).length > 0 && (
            <div className="ll-mono" style={{ fontSize: 12, color: C.inkFaint }}>{Object.entries(sub).map(([c, v]) => fmt(v, c)).join("  ·  ")}</div>
          )}
        </div>
        {g.leaf ? (
          <div className="ll-rowlist flex flex-col" style={{ border: `1px solid ${C.line}`, borderRadius: 6, background: C.card }}>
            {(() => {
              const cashWidth = fracWidth(
                g.items
                  .filter((a) => a.type !== "investment" && a.type !== "investment-parent")
                  .map((a) => ({ value: a.balance ?? "0", code: a.currency, kind: "currency" }))
              );
              return g.items.map((a) => <AccountRow key={a.id} a={a} accounts={accounts} symbols={symbols} onSelect={onSelect} groupLevels={groupLevels} fracWidth={cashWidth} />);
            })()}
          </div>
        ) : (
          <OverviewGroupTree groups={g.children} depth={depth + 1} accounts={accounts} symbols={symbols} onSelect={onSelect} groupLevels={groupLevels} />
        )}
      </div>
    );
  });
}
