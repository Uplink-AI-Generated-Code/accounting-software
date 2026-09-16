import { C, TYPES, ISA_KINDS } from "../lib/theme";
import { fmt, fmtUnits } from "../lib/format";

// One line per account in the chart of accounts — replaces the earlier
// card grid (AccountCard) specifically to fit far more accounts in the
// same vertical space after importing a large chart (see CLAUDE.md's
// project history). Same three balance shapes as before (isa-parent's
// subaccount count, investment's units+value, everything else's plain
// balance), just laid out on one row instead of stacked across a card.
// `subtitle` is only passed by the search-results view — the matched
// group path (institution/subtype/currency/...), shown faint beneath the
// name since the search flattens away the grouping headers that would
// otherwise make that context visible.
export function AccountRow({ a, accounts, symbols, onSelect, subtitle }) {
  // Trading currency lives on the Symbol now, not the account — see
  // CLAUDE.md.
  const tradingCurrency = symbols.find((s) => s.ticker === a.symbol)?.tradingCurrency;
  return (
    <button
      onClick={() => onSelect(a.id)}
      className="ll-row w-full flex items-center justify-between text-left"
      style={{ padding: "7px 10px", borderBottom: `1px solid ${C.lineSoft}` }}
    >
      <span className="flex flex-col" style={{ minWidth: 0 }}>
        <span className="flex items-center gap-2" style={{ minWidth: 0 }}>
          <span style={{ fontSize: 10, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.6, whiteSpace: "nowrap", flexShrink: 0 }}>
            {TYPES.find((t) => t.key === a.type)?.label}{a.type === "investment" ? ` · ${a.symbol}` : ""}
          </span>
          <span style={{ fontSize: 13.5, fontWeight: 500, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
          {a.isaKind && (
            <span title={ISA_KINDS.find((k) => k.key === a.isaKind)?.label} style={{ fontSize: 9.5, fontWeight: 700, color: C.gold, border: `1px solid ${C.goldDim}`, borderRadius: 3, padding: "1px 3px", letterSpacing: 0.3, flexShrink: 0 }}>
              ISA
            </span>
          )}
        </span>
        {subtitle && <span style={{ fontSize: 10.5, color: C.inkFaint }}>{subtitle}</span>}
      </span>
      <span className="ll-mono flex items-center gap-2" style={{ fontSize: 12.5, flexShrink: 0, marginLeft: 12 }}>
        {a.type === "isa-parent" ? (
          <span style={{ color: C.inkFaint }}>{accounts.filter((x) => x.isaParentId === a.id).length} subaccounts</span>
        ) : a.type === "investment" ? (
          <>
            <span style={{ color: C.inkFaint }}>{fmtUnits(a.balance || 0, a.symbol)} units</span>
            <span style={{ color: C.ink, fontWeight: 600 }}>{fmt(a.portfolioValue || 0, tradingCurrency)}</span>
          </>
        ) : (
          <span style={{ color: (a.balance || 0) < 0 ? C.debit : C.ink, fontWeight: 600 }}>{fmt(a.balance || 0, a.currency)}</span>
        )}
      </span>
    </button>
  );
}
