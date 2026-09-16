import { useState } from "react";
import { Plus, Wallet, Search, X } from "lucide-react";
import { C } from "../lib/theme";
import { fmt } from "../lib/format";
import { buildNestedGroups, flattenGroupLeaves, leafMatchesQuery } from "../lib/grouping";
import { GroupLevelPicker } from "./GroupLevelPicker";
import { OverviewGroupTree } from "./OverviewGroupTree";
import { AccountRow } from "./AccountRow";
import { miniInput } from "./ui";

/* ---------------------------------------------------------
   Overview
--------------------------------------------------------- */
export function Overview({ accounts, symbols, settings, onSaveSettings, onSaveGrouping, onRemoveGrouping, onSelect, onNew }) {
  const [query, setQuery] = useState("");

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
      <div className="flex items-center justify-between mb-1">
        <h2 className="ll-serif" style={{ fontSize: 20 }}>Chart of accounts</h2>
        <div className="flex items-center gap-3">
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
          <span style={{ fontSize: 11.5, color: C.inkFaint }}>Group by</span>
          <GroupLevelPicker
            levels={groupLevels}
            onChange={(lv) => onSaveSettings({ ...settings, groupLevels: lv })}
            saved={settings.savedGroupings}
            onSave={onSaveGrouping}
            onRemove={onRemoveGrouping}
          />
        </div>
      </div>
      <p style={{ fontSize: 13, color: C.inkFaint, marginBottom: 20 }}>
        Combined balance by currency: {Object.entries(totalsByCurrency).map(([c, v]) => fmt(v, c)).join("  ·  ")}
      </p>

      {query.trim() ? (
        <OverviewSearchResults
          leaves={flattenGroupLeaves(buildNestedGroups(accounts, groupLevels, accounts, symbols)).filter((l) => leafMatchesQuery(l, query))}
          accounts={accounts}
          symbols={symbols}
          onSelect={onSelect}
        />
      ) : (
        <OverviewGroupTree groups={buildNestedGroups(accounts, groupLevels, accounts, symbols)} depth={0} accounts={accounts} symbols={symbols} onSelect={onSelect} />
      )}
    </div>
  );
}

// The flat equivalent of OverviewGroupTree, shown instead of the grouped
// grid while a search query is active — each matched account keeps its
// existing card, just ungrouped, plus a small breadcrumb of the grouping
// path it matched on (so a hit against an institution/subtype/currency
// name, not just the account's own name, is still legible).
function OverviewSearchResults({ leaves, accounts, symbols, onSelect }) {
  if (leaves.length === 0) {
    return <p style={{ fontSize: 13, color: C.inkFaint }}>No accounts match.</p>;
  }
  return (
    <div className="ll-rowlist flex flex-col" style={{ border: `1px solid ${C.line}`, borderRadius: 6, background: C.card }}>
      {leaves.map(({ account: a, path }) => (
        <AccountRow key={a.id} a={a} accounts={accounts} symbols={symbols} onSelect={onSelect} subtitle={path.join(" › ")} />
      ))}
    </div>
  );
}
