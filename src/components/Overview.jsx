import { useState } from "react";
import { Plus, Wallet, Search, X, AlertTriangle } from "lucide-react";
import { C } from "../lib/theme";
import { fmt } from "../lib/format";
import { buildNestedGroups, flattenAllAccounts, leafMatchesQuery } from "../lib/grouping";
import { GroupLevelPicker } from "./GroupLevelPicker";
import { OverviewGroupTree } from "./OverviewGroupTree";
import { miniInput } from "./ui";

/* ---------------------------------------------------------
   Overview
--------------------------------------------------------- */
export function Overview({ accounts, symbols, settings, onSaveSettings, onSaveGrouping, onRemoveGrouping, onSelect, onNew }) {
  const [query, setQuery] = useState("");
  const [imbalancedOnly, setImbalancedOnly] = useState(false);

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center" style={{ marginTop: 100, color: C.inkFaint }}>
        <Wallet size={32} color={C.goldDim} />
        <p className="ll-serif" style={{ fontSize: 18, marginTop: 12, color: C.ink }}>Your chart of accounts is empty</p>
        <p style={{ fontSize: 13, marginTop: 4 }}>Add an account — a bank account, a wallet, an expense category — to begin.</p>
        <button onClick={onNew} className="mt-4 flex items-center gap-1.5 px-3 py-1.5 rounded" style={{ background: C.ink, color: C.paper, fontSize: 13 }}>
          <Plus size={14} /> Add your first account
        </button>
      </div>
    );
  }
  const totalsByCurrency = {};
  accounts.filter((a) => a.type !== "investment" && a.type !== "isa-parent").forEach((a) => { totalsByCurrency[a.currency] = (totalsByCurrency[a.currency] || 0) + (a.balance || 0); });

  const groupLevels = settings.groupLevels || ["type"];

  return (
    <div>
      <div className="flex items-center justify-between mb-1 flex-wrap" style={{ rowGap: 8 }}>
        <h2 className="ll-serif" style={{ fontSize: 20 }}>Chart of accounts</h2>
        <div className="flex items-center gap-3 flex-wrap" style={{ rowGap: 6 }}>
          <div className="flex items-center gap-1.5" style={{ ...miniInput, width: 200, padding: "5px 8px" }}>
            <Search size={13} color={C.inkFaint} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search accounts…"
              style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 12.5, color: C.ink }}
            />
            {query && <button onClick={() => setQuery("")}><X size={12} color={C.inkFaint} /></button>}
          </div>
          {accounts.some((a) => a.imbalancedLineCount > 0) && (
            <label className="flex items-center gap-1.5" style={{ fontSize: 12, color: imbalancedOnly ? C.debit : C.inkSoft, cursor: "pointer" }}>
              <input type="checkbox" checked={imbalancedOnly} onChange={(e) => setImbalancedOnly(e.target.checked)} />
              <AlertTriangle size={12} />
              Imbalanced only ({accounts.filter((a) => a.imbalancedLineCount > 0).length})
            </label>
          )}
          <span style={{ fontSize: 11.5, color: C.inkFaint }}>Group by</span>
          <GroupLevelPicker
            levels={groupLevels}
            onChange={(lv) => onSaveSettings({ groupLevels: lv })}
            saved={settings.savedGroupings}
            onSave={onSaveGrouping}
            onRemove={onRemoveGrouping}
          />
        </div>
      </div>
      <p style={{ fontSize: 13, color: C.inkFaint, marginBottom: 20 }}>
        Combined balance by currency: {Object.entries(totalsByCurrency).map(([c, v]) => fmt(v, c)).join("  ·  ")}
      </p>

      {(() => {
        // Searching narrows *which* accounts show (matched against all
        // four dimensions, independent of the active grouping — see
        // CLAUDE.md), but keeps the same nested grouping layout rather
        // than flattening to a list: buildNestedGroups naturally drops
        // any group that ends up with no matching accounts in it. The
        // "imbalanced only" toggle narrows the same way, and combines
        // with an active search.
        let matched = query.trim()
          ? flattenAllAccounts(accounts, accounts, symbols).filter((l) => leafMatchesQuery(l, query)).map((l) => l.account)
          : accounts;
        if (imbalancedOnly) matched = matched.filter((a) => a.imbalancedLineCount > 0);
        if ((query.trim() || imbalancedOnly) && matched.length === 0) {
          return <p style={{ fontSize: 13, color: C.inkFaint }}>No accounts match.</p>;
        }
        return <OverviewGroupTree groups={buildNestedGroups(matched, groupLevels, accounts, symbols)} depth={0} accounts={accounts} symbols={symbols} onSelect={onSelect} groupLevels={groupLevels} />;
      })()}
    </div>
  );
}
