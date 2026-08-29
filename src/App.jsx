import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, AlertTriangle, BookOpen, X } from "lucide-react";
import { C } from "./lib/theme";
import { uid, fmt, fmtUnits } from "./lib/format";
import { buildNestedGroups } from "./lib/grouping";
import { currentCostBasis, currentPortfolioValue } from "./lib/stockMath";
import { hasStorage, accountIdFromHash, setHashForAccount } from "./lib/hash";
import { ModalShell } from "./components/ui";
import { GroupLevelPicker } from "./components/GroupLevelPicker";
import { SidebarGroupTree } from "./components/SidebarGroupTree";
import { Overview } from "./components/Overview";
import { IsaParentView } from "./components/IsaParentView";
import { AllowanceView } from "./components/AllowanceView";
import { AccountLedger } from "./components/AccountLedger";
import { StockLedger } from "./components/StockLedger";
import { AccountFormModal } from "./components/AccountFormModal";

/* ---------------------------------------------------------
   App
--------------------------------------------------------- */
export default function App() {
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [settings, setSettings] = useState({ over65: false, groupLevels: ["type"], savedGroupings: [] });
  const [loaded, setLoaded] = useState(false);
  const [storageOK, setStorageOK] = useState(true);
  const [selectedId, setSelectedIdRaw] = useState(null);
  const [showAllowance, setShowAllowance] = useState(false);
  const [accountForm, setAccountForm] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { id, entryCount, name }
  const [error, setError] = useState("");
  const hashInitialized = useRef(false);
  const storedSelectedIdRef = useRef(null);

  // Whichever ledger is currently on screen registers itself here (see
  // AccountLedger/StockLedger) so navigation elsewhere in the app can
  // check "is there an unsaved edit in progress right now" without
  // lifting the draft itself up to this level.
  const ledgerGuardRef = useRef(null);
  const [pendingNav, setPendingNav] = useState(null); // { action } | null

  // Every navigation in the app funnels through here, so a mid-edit row
  // can't silently follow you to a different account: a clean draft is
  // just discarded, a dirty one prompts for what to do with it first.
  function attemptNavigation(action) {
    const guard = ledgerGuardRef.current;
    if (guard && guard.isDirty()) {
      setPendingNav({ action });
      return;
    }
    if (guard) guard.discard();
    action();
  }

  function resolvePendingNav(choice) {
    if (!pendingNav) return;
    const { action } = pendingNav;
    if (choice === "cancel") {
      setPendingNav(null);
      return;
    }
    if (choice === "discard") {
      const guard = ledgerGuardRef.current;
      if (guard) guard.discard();
      setPendingNav(null);
      action();
      return;
    }
    if (choice === "save") {
      const guard = ledgerGuardRef.current;
      const ok = guard ? guard.commit() : true;
      if (ok) {
        setPendingNav(null);
        action();
      }
      // If the save failed validation, the ledger's own inline error is
      // already showing — leave the prompt up rather than navigate away
      // from an entry that didn't actually save.
    }
  }

  // Selecting an account updates the URL and remembered storage together,
  // so a refresh (or a bookmark, or the back/forward buttons) lands back
  // on the same account instead of always resetting to the overview.
  function selectAccount(id) {
    setSelectedIdRaw(id);
    setShowAllowance(false);
    setHashForAccount(id);
    if (hasStorage()) {
      try {
        if (id) window.storage.set("ledger-selected-account", id, false);
        else window.storage.delete("ledger-selected-account", false);
      } catch (e) {
        /* non-fatal — selection just won't be remembered */
      }
    }
  }
  function setSelectedId(id) {
    attemptNavigation(() => selectAccount(id));
  }
  function goToAllowance() {
    attemptNavigation(() => { setSelectedIdRaw(null); setShowAllowance(true); });
  }

  useEffect(() => {
    (async () => {
      if (!hasStorage()) {
        setStorageOK(false);
        setLoaded(true);
        return;
      }
      try {
        const res = await window.storage.get("ledger-data", false);
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          setAccounts(parsed.accounts || []);
          setTransactions(parsed.transactions || []);
          if (parsed.settings) {
            const s = { over65: false, groupLevels: ["type"], savedGroupings: [], ...parsed.settings };
            // Migrate the old single-level "groupBy" setting if that's all a
            // previously-saved session has.
            if (parsed.settings.groupBy && !parsed.settings.groupLevels) s.groupLevels = [parsed.settings.groupBy];
            delete s.groupBy;
            setSettings(s);
          }
        }
      } catch (e) {
        /* no data saved yet */
      }
      try {
        const sel = await window.storage.get("ledger-selected-account", false);
        if (sel && sel.value) storedSelectedIdRef.current = sel.value;
      } catch (e) {
        /* nothing remembered yet */
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // Once accounts have loaded, resolve which account to land on. The URL
  // wins if it names a valid account (so bookmarks/shared links work);
  // otherwise fall back to whatever was last selected. Only runs once —
  // after that, navigation is driven by the app itself.
  useEffect(() => {
    if (!loaded || hashInitialized.current) return;
    hashInitialized.current = true;
    const hashId = accountIdFromHash();
    if (hashId && accounts.some((a) => a.id === hashId)) {
      setSelectedIdRaw(hashId);
    } else if (storedSelectedIdRef.current && accounts.some((a) => a.id === storedSelectedIdRef.current)) {
      setSelectedIdRaw(storedSelectedIdRef.current);
      setHashForAccount(storedSelectedIdRef.current);
    }
  }, [loaded, accounts]);

  // Browser back/forward: follow the hash rather than fight it.
  useEffect(() => {
    function onPopState() {
      const hashId = accountIdFromHash();
      setShowAllowance(false);
      setSelectedIdRaw(hashId && accounts.some((a) => a.id === hashId) ? hashId : null);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [accounts]);

  async function persist(nextAccounts, nextTransactions, nextSettings) {
    setAccounts(nextAccounts);
    setTransactions(nextTransactions);
    if (nextSettings) setSettings(nextSettings);
    if (!hasStorage()) return;
    try {
      await window.storage.set("ledger-data", JSON.stringify({ accounts: nextAccounts, transactions: nextTransactions, settings: nextSettings || settings }));
    } catch (e) {
      setStorageOK(false);
    }
  }

  function saveSettings(next) {
    persist(accounts, transactions, next);
  }

  function saveGroupingPreset(levels) {
    const already = (settings.savedGroupings || []).some((s) => JSON.stringify(s.levels) === JSON.stringify(levels));
    if (already) return;
    saveSettings({ ...settings, savedGroupings: [...(settings.savedGroupings || []), { id: uid(), levels }] });
  }

  function removeGroupingPreset(id) {
    saveSettings({ ...settings, savedGroupings: (settings.savedGroupings || []).filter((s) => s.id !== id) });
  }

  const balances = useMemo(() => {
    const map = {};
    accounts.forEach((a) => (map[a.id] = a.openingBalance || 0));
    transactions.forEach((t) =>
      t.lines.forEach((l) => {
        map[l.accountId] = (map[l.accountId] || 0) + l.amount;
      })
    );
    return map;
  }, [accounts, transactions]);

  // Current cost basis per stock account — what's actually tied up in it
  // right now, average-cost method — and a "mark to last trade" portfolio
  // value, using the most recent trade's own price applied to the whole
  // holding. Neither is a live market value (no price feed here); cost
  // basis is an honest "how much of your own money is in this," and
  // portfolio value is the closest stand-in for "what it's worth" that
  // can be derived purely from your own trading history.
  const stockCostBasis = useMemo(() => {
    const map = {};
    accounts.filter((a) => a.type === "investment").forEach((a) => {
      const lines = transactions
        .map((t) => t.lines.find((l) => l.accountId === a.id))
        .filter(Boolean)
        .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
      map[a.id] = currentCostBasis(lines);
    });
    return map;
  }, [accounts, transactions]);
  const stockPortfolioValues = useMemo(() => {
    const map = {};
    accounts.filter((a) => a.type === "investment").forEach((a) => {
      const lines = transactions
        .map((t) => t.lines.find((l) => l.accountId === a.id))
        .filter(Boolean)
        .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
      map[a.id] = currentPortfolioValue(lines);
    });
    return map;
  }, [accounts, transactions]);

  // Each investment account holds exactly one security, so its balance —
  // computed the same way as any other account's — already *is* the unit
  // count. Only the display differs: units and a symbol, not a currency.
  // An ISA wrapper holds no balance of its own — it's shown by how many
  // subaccounts it groups.
  function accountDisplay(a) {
    if (a.type === "isa-parent") {
      const n = accounts.filter((x) => x.isaParentId === a.id).length;
      return `${n} subaccount${n === 1 ? "" : "s"}`;
    }
    const bal = balances[a.id] || 0;
    return a.type === "investment" ? `${fmtUnits(bal)} ${a.symbol} · ${fmt(stockPortfolioValues[a.id] || 0, a.currency)}` : fmt(bal, a.currency);
  }

  function saveAccount(data) {
    if (data.id) persist(accounts.map((a) => (a.id === data.id ? data : a)), transactions);
    else persist([...accounts, { ...data, id: uid() }], transactions);
    setAccountForm(null);
  }

  function requestDeleteAccount(id) {
    const hasSubaccounts = accounts.some((a) => a.isaParentId === id);
    if (hasSubaccounts) {
      setError("Can't delete an ISA that still has subaccounts. Delete those first.");
      return;
    }
    const entryCount = transactions.filter((t) => t.lines.some((l) => l.accountId === id)).length;
    if (entryCount === 0) {
      performDeleteAccount(id);
      return;
    }
    const acc = accounts.find((a) => a.id === id);
    setDeleteConfirm({ id, entryCount, name: acc ? acc.name : "" });
  }

  // Removing an account never destroys the other side of a linked entry —
  // it just strips this account's own line out of each transaction
  // (deleting the transaction outright only if nothing else was on it),
  // same principle as Unlink and removing a split line elsewhere.
  function performDeleteAccount(id) {
    const nextTransactions = transactions
      .map((t) => {
        if (!t.lines.some((l) => l.accountId === id)) return t;
        const remaining = t.lines.filter((l) => l.accountId !== id);
        return remaining.length ? { ...t, lines: remaining } : null;
      })
      .filter(Boolean);
    persist(accounts.filter((a) => a.id !== id), nextTransactions);
    if (selectedId === id) setSelectedId(null);
    setAccountForm(null);
    setDeleteConfirm(null);
  }

  function saveTransaction(data, mergeDeleteId, insertExtras) {
    // All edits computed from the same snapshot of `transactions` in one
    // shot — doing this as separate calls would have each read the same
    // stale array and clobber one another.
    let next = transactions;
    if (mergeDeleteId) next = next.filter((t) => t.id !== mergeDeleteId);
    if (data.id) next = next.map((t) => (t.id === data.id ? { ...data } : t));
    else next = [...next, { ...data, id: uid() }];
    if (insertExtras && insertExtras.length) next = [...next, ...insertExtras.map((e) => ({ ...e, id: uid() }))];
    persist(accounts, next);
  }

  // Applies line changes to several transactions at once (e.g. re-stamping
  // a whole same-date group's order after a reorder) — one persist call,
  // so none of the updates can be lost to a stale read of `transactions`.
  function updateTransactions(updates) {
    const next = transactions.map((t) => {
      const u = updates.find((x) => x.id === t.id);
      return u ? { ...t, lines: u.lines } : t;
    });
    persist(accounts, next);
  }

  function deleteTransaction(id) {
    persist(accounts, transactions.filter((t) => t.id !== id));
  }

  const selected = accounts.find((a) => a.id === selectedId) || null;

  return (
    <div style={{ background: C.paper, color: C.ink, minHeight: "100%", fontFamily: "'Inter', sans-serif" }} className="w-full min-h-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .ll-serif { font-family: 'Fraunces', serif; }
        .ll-mono { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
        .ll-row:hover { background-color: ${C.paperDim}; }
        input, select { font-family: inherit; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: ${C.line}; border-radius: 4px; }
      `}</style>

      <header className="flex items-center justify-between px-6 py-4" style={{ borderBottom: `1px solid ${C.line}` }}>
        <div className="flex items-center gap-2">
          <BookOpen size={20} color={C.gold} />
          <h1 className="ll-serif" style={{ fontSize: 22, fontWeight: 600, letterSpacing: 0.2 }}>Ledger</h1>
          <span style={{ color: C.inkFaint, fontSize: 13, marginLeft: 6 }}>double-entry, kept simply</span>
        </div>
        <button onClick={() => setAccountForm({})} className="flex items-center gap-1.5 px-3 py-1.5 rounded" style={{ background: C.ink, color: C.paper, fontSize: 13, fontWeight: 500 }}>
          <Plus size={14} /> New account
        </button>
      </header>

      {!storageOK && (
        <div className="mx-6 mt-4 px-3 py-2 rounded flex items-center gap-2" style={{ background: C.paperDim, color: C.inkSoft, fontSize: 12.5 }}>
          <AlertTriangle size={14} color={C.gold} /> This preview can't save between sessions here — your work will stay only for this visit.
        </div>
      )}
      {error && (
        <div className="mx-6 mt-4 px-3 py-2 rounded flex items-center justify-between" style={{ background: C.debitBg, color: C.debit, fontSize: 13 }}>
          <span className="flex items-center gap-2"><AlertTriangle size={14} /> {error}</span>
          <button onClick={() => setError("")}><X size={14} /></button>
        </div>
      )}

      <div className="flex" style={{ minHeight: "calc(100vh - 73px)" }}>
        <aside className="shrink-0" style={{ width: 260, borderRight: `1px solid ${C.line}`, padding: "18px 12px" }}>
          <button onClick={() => setSelectedId(null)} className="w-full text-left px-2 py-1.5 rounded mb-1" style={{ background: selectedId === null && !showAllowance ? C.paperDim : "transparent", fontSize: 13, fontWeight: 600, color: C.inkSoft }}>
            Overview
          </button>
          <button
            onClick={goToAllowance}
            className="w-full text-left px-2 py-1.5 rounded mb-3"
            style={{ background: showAllowance ? C.paperDim : "transparent", fontSize: 13, fontWeight: 600, color: C.inkSoft }}
          >
            ISA Allowance
          </button>

          <div className="mb-3">
            <GroupLevelPicker
              levels={settings.groupLevels || ["type"]}
              onChange={(lv) => saveSettings({ ...settings, groupLevels: lv })}
              saved={settings.savedGroupings}
              onSave={saveGroupingPreset}
              onRemove={removeGroupingPreset}
            />
          </div>

          {loaded && accounts.length === 0 && (
            <p style={{ fontSize: 12.5, color: C.inkFaint, padding: "0 8px", lineHeight: 1.5 }}>No accounts yet. Add one to start keeping books.</p>
          )}

          <SidebarGroupTree
            groups={buildNestedGroups(accounts, settings.groupLevels || ["type"], accounts)}
            depth={0}
            selectedId={selectedId}
            onSelect={setSelectedId}
            balances={balances}
            accountDisplay={accountDisplay}
          />
        </aside>


        <main className="flex-1 p-6">
          {showAllowance ? (
            <AllowanceView accounts={accounts} transactions={transactions} settings={settings} onSaveSettings={saveSettings} onSelect={setSelectedId} />
          ) : selected ? (
            selected.type === "isa-parent" ? (
              <IsaParentView
                account={selected}
                accounts={accounts}
                balances={balances}
                stockPortfolioValues={stockPortfolioValues}
                onEditAccount={() => setAccountForm(selected)}
                onSelect={setSelectedId}
                onNewSubaccount={(kind) => setAccountForm({ isaParentPreset: selected.id, typePreset: kind })}
              />
            ) : selected.type === "investment" ? (
              <StockLedger
                account={selected}
                accounts={accounts}
                transactions={transactions}
                balance={balances[selected.id] || 0}
                onEditAccount={() => setAccountForm(selected)}
                onSaveTxn={saveTransaction}
                onDeleteTxn={deleteTransaction}
                onUpdateTxns={updateTransactions}
                guardRef={ledgerGuardRef}
              />
            ) : (
              <AccountLedger
                account={selected}
                accounts={accounts}
                transactions={transactions}
                balance={balances[selected.id] || 0}
                onEditAccount={() => setAccountForm(selected)}
                onSaveTxn={saveTransaction}
                onDeleteTxn={deleteTransaction}
                onUpdateTxns={updateTransactions}
                guardRef={ledgerGuardRef}
              />
            )
          ) : (
            <Overview accounts={accounts} balances={balances} stockCostBasis={stockCostBasis} stockPortfolioValues={stockPortfolioValues} settings={settings} onSaveSettings={saveSettings} onSaveGrouping={saveGroupingPreset} onRemoveGrouping={removeGroupingPreset} onSelect={setSelectedId} onNew={() => setAccountForm({})} />
          )}
        </main>
      </div>

      {accountForm !== null && (
        <AccountFormModal initial={accountForm} accounts={accounts} onCancel={() => setAccountForm(null)} onSave={saveAccount} onDelete={accountForm.id ? () => requestDeleteAccount(accountForm.id) : null} />
      )}

      {deleteConfirm && (
        <ModalShell onCancel={() => setDeleteConfirm(null)} title="Delete account">
          <p style={{ fontSize: 13.5, color: C.inkSoft, lineHeight: 1.5, marginBottom: 18 }}>
            <strong>{deleteConfirm.name}</strong> has {deleteConfirm.entryCount} ledger {deleteConfirm.entryCount === 1 ? "entry" : "entries"}. Deleting it removes those entries from this account. If any of them are linked to another account, that other side is kept as its own standalone entry — nothing else gets deleted.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setDeleteConfirm(null)} className="px-3 py-1.5 rounded text-sm" style={{ border: `1px solid ${C.line}` }}>Cancel</button>
            <button onClick={() => performDeleteAccount(deleteConfirm.id)} className="px-3 py-1.5 rounded text-sm" style={{ background: C.debit, color: C.paper }}>Delete account</button>
          </div>
        </ModalShell>
      )}

      {pendingNav && (
        <ModalShell onCancel={() => resolvePendingNav("cancel")} title="Unsaved entry">
          <p style={{ fontSize: 13.5, color: C.inkSoft, lineHeight: 1.5, marginBottom: 18 }}>
            You're still editing a row here. What would you like to do with it before moving on?
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => resolvePendingNav("cancel")} className="px-3 py-1.5 rounded text-sm" style={{ border: `1px solid ${C.line}` }}>Stay here</button>
            <button onClick={() => resolvePendingNav("discard")} className="px-3 py-1.5 rounded text-sm" style={{ border: `1px solid ${C.line}`, color: C.debit }}>Discard</button>
            <button onClick={() => resolvePendingNav("save")} className="px-3 py-1.5 rounded text-sm" style={{ background: C.ink, color: C.paper }}>Save</button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
