import { AlertTriangle } from "lucide-react";
import { C, TYPES, ISA_KINDS } from "../lib/theme";
import { fmt, fmtUnits, displayAccountName } from "../lib/format";

// One line per account in the chart of accounts — replaces the earlier
// card grid (AccountCard) specifically to fit far more accounts in the
// same vertical space after importing a large chart (see CLAUDE.md's
// project history). Same three balance shapes as before (isa-parent's
// subaccount count, investment's units+value, everything else's plain
// balance), just laid out on one row instead of stacked across a card.
// `subtitle` is only passed by the search-results view — the matched
// group path (counterparty/subtype/currency/...), shown faint beneath the
// name since the search flattens away the grouping headers that would
// otherwise make that context visible.
export function AccountRow({ a, accounts, symbols, onSelect, subtitle, groupLevels = [] }) {
  // Trading currency lives on the Symbol now, not the account — see
  // CLAUDE.md.
  const tradingCurrency = symbols.find((s) => s.ticker === a.symbol)?.tradingCurrency;
  // Whichever of Type/Currency/Counterparty/Subtype the active grouping
  // (settings.groupLevels) doesn't already nest by — showing one that's
  // already the group header above would just repeat it on every row.
  // The investment account's own ticker isn't one of the four grouping
  // dimensions (currency there means *trading* currency, a separate
  // thing — see lib/grouping.js's bucketBy()), so it's always shown.
  const badgeParts = [
    !groupLevels.includes("type") && TYPES.find((t) => t.key === a.type)?.label,
    "investment" === a.type ? a.symbol : null,
    !groupLevels.includes("currency") && ("investment" === a.type ? tradingCurrency : a.currency),
    !groupLevels.includes("counterparty") && a.counterparty,
    !groupLevels.includes("subtype") && a.subtype,
  ].filter(Boolean);
  // `imbalancedLineCount`/`imbalanceIn`/`imbalanceOut` come from the
  // backend's GET /api/accounts
  // (LedgerStateService::imbalanceStatsByAccount()) — a global,
  // per-line-balance-check mirror of lib/matching.js's balanceHint(),
  // computed once server-side since it needs every account's own ledger,
  // not just this one. `imbalanceIn`/`imbalanceOut` are kept as two
  // separate non-negative sums rather than netted into one signed value,
  // specifically so two canceling unmatched lines (e.g. +50 and -50)
  // still show up as real, visible imbalance instead of disappearing
  // into an innocuous-looking 0 — see CLAUDE.md's "Matching and
  // linking".
  const imbalanced = (a.imbalancedLineCount || 0) > 0;
  const imbalanceCurrency = a.type === "investment" ? tradingCurrency : a.currency;
  return (
    <button
      onClick={() => onSelect(a.id)}
      className="ll-row w-full flex items-center justify-between text-left"
      style={{ padding: "7px 10px 7px 8px", borderBottom: `1px solid ${C.lineSoft}`, borderLeft: `3px solid ${imbalanced ? C.debit : "transparent"}` }}
    >
      <span className="flex flex-col" style={{ minWidth: 0 }}>
        <span className="flex items-center gap-2" style={{ minWidth: 0 }}>
          {badgeParts.length > 0 && (
            <span style={{ fontSize: 10, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.6, whiteSpace: "nowrap", flexShrink: 0 }}>
              {badgeParts.join(" · ")}
            </span>
          )}
          <span style={{ fontSize: 13.5, fontWeight: 500, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayAccountName(a)}</span>
          {a.isaKind && (
            <span title={ISA_KINDS.find((k) => k.key === a.isaKind)?.label} style={{ fontSize: 9.5, fontWeight: 700, color: C.gold, border: `1px solid ${C.goldDim}`, borderRadius: 3, padding: "1px 3px", letterSpacing: 0.3, flexShrink: 0 }}>
              ISA
            </span>
          )}
        </span>
        {subtitle && <span style={{ fontSize: 10.5, color: C.inkFaint }}>{subtitle}</span>}
      </span>
      <span className="ll-mono flex items-center gap-2" style={{ fontSize: 12.5, flexShrink: 0, marginLeft: 12 }}>
        {imbalanced && (
          <span
            title={`${a.imbalancedLineCount} imbalanced line${a.imbalancedLineCount === 1 ? "" : "s"}`}
            className="flex items-center gap-1.5"
            style={{ fontSize: 11 }}
          >
            <AlertTriangle size={11} color={C.debit} />
            {a.imbalanceOut > 0 && <span style={{ color: C.debit }}>Out {fmt(a.imbalanceOut, imbalanceCurrency)}</span>}
            {a.imbalanceIn > 0 && <span style={{ color: C.credit }}>In {fmt(a.imbalanceIn, imbalanceCurrency)}</span>}
            <span style={{ color: C.inkFaint }}>· {a.imbalancedLineCount}</span>
          </span>
        )}
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
