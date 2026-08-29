import { Plus, Wallet } from "lucide-react";
import { C } from "../lib/theme";
import { fmt } from "../lib/format";
import { buildNestedGroups } from "../lib/grouping";
import { GroupLevelPicker } from "./GroupLevelPicker";
import { OverviewGroupTree } from "./OverviewGroupTree";

/* ---------------------------------------------------------
   Overview
--------------------------------------------------------- */
export function Overview({ accounts, settings, onSaveSettings, onSaveGrouping, onRemoveGrouping, onSelect, onNew }) {
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
        <div className="flex items-center gap-2">
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

      <OverviewGroupTree groups={buildNestedGroups(accounts, groupLevels, accounts)} depth={0} accounts={accounts} onSelect={onSelect} />
    </div>
  );
}
