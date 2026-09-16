import { useEffect, useRef, useState } from "react";
import { Plus, AlertTriangle, BookOpen, X, Search } from "lucide-react";
import { C } from "./lib/theme";
import { uid, fmt, fmtUnits, setCurrencyScales, setSymbolScales } from "./lib/format";
import { buildNestedGroups, flattenAllAccounts, leafMatchesQuery } from "./lib/grouping";
import { accountIdFromHash, setHashForAccount } from "./lib/hash";
import * as api from "./api";
import { ModalShell, miniInput } from "./components/ui";
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
  // The one thing kept loaded app-wide — a lightweight list, each account
  // carrying its own computed balance (and, for investment accounts, cost
  // basis / portfolio value). No line-level data lives here; that's
  // fetched per account view by AccountLedger/StockLedger and discarded
  // on navigating away — see CLAUDE.md's "Backend" section.
  const [accounts, setAccounts] = useState([]);
  // Reference data — currency/symbol/institution are lookup entities
  // server-side (see CLAUDE.md), fetched once here alongside accounts and
  // passed down to AccountFormModal's pickers. currencies/symbols also
  // feed lib/format.js's setCurrencyScales()/setSymbolScales() so every
  // fmt()/fmtUnits() call anywhere in the app can convert a scaled
  // integer to a decimal without each one needing its own scale lookup.
  const [currencies, setCurrencies] = useState([]);
  const [symbols, setSymbols] = useState([]);
  const [institutions, setInstitutions] = useState([]);
  const [settings, setSettings] = useState({ over65: false, groupLevels: ["type"], savedGroupings: [] });
  const [loaded, setLoaded] = useState(false);
  const [storageOK, setStorageOK] = useState(true);
  const [selectedId, setSelectedIdRaw] = useState(null);
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [sidebarImbalancedOnly, setSidebarImbalancedOnly] = useState(false);
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
  // on the same account instead of always resetting to the overview. This
  // is a per-browser convenience, not ledger data, so it stays in
  // localStorage rather than going through the backend.
  function selectAccount(id) {
    setSelectedIdRaw(id);
    setShowAllowance(false);
    setHashForAccount(id);
    try {
      if (id) localStorage.setItem("ledger-selected-account", id);
      else localStorage.removeItem("ledger-selected-account");
    } catch (e) {
      /* non-fatal — selection just won't be remembered */
    }
  }
  function setSelectedId(id) {
    attemptNavigation(() => selectAccount(id));
  }
  function goToAllowance() {
    attemptNavigation(() => { setSelectedIdRaw(null); setShowAllowance(true); });
  }

  async function refreshAccounts() {
    const list = await api.getAccounts();
    setAccounts(list);
    return list;
  }

  useEffect(() => {
    (async () => {
      try {
        await refreshAccounts();
        const [cur, sym, inst] = await Promise.all([
          api.getCurrencies().catch(() => []),
          api.getSymbols().catch(() => []),
          api.getInstitutions().catch(() => []),
        ]);
        setCurrencies(cur);
        setSymbols(sym);
        setInstitutions(inst);
        setCurrencyScales(cur);
        setSymbolScales(sym);
        const s = await api.getSettings().catch(() => null);
        if (s) {
          setSettings({ over65: false, groupLevels: ["type"], savedGroupings: [], ...s });
        }
      } catch (e) {
        // Can't reach the backend — start from an empty ledger rather than
        // leaving the app stuck loading; the banner below explains why.
        setStorageOK(false);
      } finally {
        setLoaded(true);
      }
      try {
        const sel = localStorage.getItem("ledger-selected-account");
        if (sel) storedSelectedIdRef.current = sel;
      } catch (e) {
        /* nothing remembered yet */
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

  function saveSettings(next) {
    // Optimistic: a flat replace with no cascading effect on accounts or
    // transactions, so there's nothing to reconcile once the request lands.
    setSettings(next);
    api.putSettings(next).then(() => setStorageOK(true)).catch(() => setStorageOK(false));
  }

  function saveGroupingPreset(levels) {
    const already = (settings.savedGroupings || []).some((s) => JSON.stringify(s.levels) === JSON.stringify(levels));
    if (already) return;
    saveSettings({ ...settings, savedGroupings: [...(settings.savedGroupings || []), { id: uid(), levels }] });
  }

  function removeGroupingPreset(id) {
    saveSettings({ ...settings, savedGroupings: (settings.savedGroupings || []).filter((s) => s.id !== id) });
  }

  // Each investment account holds exactly one security, so its balance —
  // computed the same way as any other account's — already *is* the unit
  // count. Only the display differs: units and a symbol, not a currency.
  // An ISA wrapper holds no balance of its own — it's shown by how many
  // subaccounts it groups. balance/portfolioValue are computed server-side
  // now (see GET /api/accounts) rather than derived here.
  function accountDisplay(a) {
    if (a.type === "isa-parent") {
      const n = accounts.filter((x) => x.isaParentId === a.id).length;
      return `${n} subaccount${n === 1 ? "" : "s"}`;
    }
    const bal = a.balance || 0;
    if (a.type === "investment") {
      const tradingCurrency = symbols.find((s) => s.ticker === a.symbol)?.tradingCurrency;
      return `${fmtUnits(bal, a.symbol)} ${a.symbol} · ${fmt(a.portfolioValue || 0, tradingCurrency)}`;
    }
    return fmt(bal, a.currency);
  }

  function saveAccount(data) {
    // Optimistic: a plain PUT/upsert with no cascading effect elsewhere,
    // so the account we already have locally is exactly what the server
    // will end up storing — no need to wait on the round trip to update
    // the UI. (balance/entryCount/costBasis/portfolioValue on a brand new
    // account are all correctly absent/zero until the next refresh.)
    const account = data.id ? data : { ...data, id: uid() };
    setAccounts((prev) => (prev.some((a) => a.id === account.id) ? prev.map((a) => (a.id === account.id ? { ...a, ...account } : a)) : [...prev, account]));
    setAccountForm(null);
    api.putAccount(account).then(() => { setStorageOK(true); refreshAccounts(); }).catch(() => setStorageOK(false));
  }

  function requestDeleteAccount(id) {
    const hasSubaccounts = accounts.some((a) => a.isaParentId === id);
    if (hasSubaccounts) {
      setError("Can't delete an ISA that still has subaccounts. Delete those first.");
      return;
    }
    const acc = accounts.find((a) => a.id === id);
    const entryCount = (acc && acc.entryCount) || 0;
    if (entryCount === 0) {
      performDeleteAccount(id);
      return;
    }
    setDeleteConfirm({ id, entryCount, name: acc ? acc.name : "" });
  }

  // Removing an account never destroys the other side of a linked entry —
  // the backend strips this account's own line out of each transaction
  // (deleting the transaction outright only if nothing else was on it),
  // same principle as Unlink and removing a split line elsewhere. Deleting
  // always navigates away from the account being viewed, so there's no
  // ledger screen left that needs patching — just refresh the account list.
  function performDeleteAccount(id) {
    api
      .deleteAccount(id)
      .then(() => { setStorageOK(true); return refreshAccounts(); })
      .catch(() => setStorageOK(false));
    if (selectedId === id) setSelectedId(null);
    setAccountForm(null);
    setDeleteConfirm(null);
  }

  // The one write path for everything a ledger screen does — a plain
  // save, a merge, a split-off, an unlink, a same-date reorder, a delete
  // — all arrive here as an already-built operations list (see
  // lib/ledgerOperations.js, used by AccountLedger/StockLedger, which own
  // the standalone-vs-linked transition logic since that's where the
  // record identity actually lives). Returns the refreshed account list's
  // promise so the calling ledger screen can chain its own re-fetch of
  // just-changed rows after this resolves.
  function saveLedgerOperations(operations) {
    return api
      .applyLedgerOperations(operations)
      .then(() => { setStorageOK(true); return refreshAccounts(); })
      .catch(() => setStorageOK(false));
  }

  const selected = accounts.find((a) => a.id === selectedId) || null;

  return (
    <div style={{ background: C.paper, color: C.ink, height: "100%", display: "flex", flexDirection: "column", fontFamily: "'Inter', sans-serif" }} className="w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .ll-serif { font-family: 'Fraunces', serif; }
        .ll-mono { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
        .ll-row:hover { background-color: ${C.paperDim}; }
        .ll-rowlist > button:last-child { border-bottom: none; }
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
          <AlertTriangle size={14} color={C.gold} /> Can't reach the backend — check that the Symfony server is running. Changes won't be saved until it's back.
        </div>
      )}
      {error && (
        <div className="mx-6 mt-4 px-3 py-2 rounded flex items-center justify-between" style={{ background: C.debitBg, color: C.debit, fontSize: 13 }}>
          <span className="flex items-center gap-2"><AlertTriangle size={14} /> {error}</span>
          <button onClick={() => setError("")}><X size={14} /></button>
        </div>
      )}

      <div className="flex" style={{ flex: 1, minHeight: 0 }}>
        <aside className="shrink-0" style={{ width: 260, borderRight: `1px solid ${C.line}`, padding: "18px 12px", overflowY: "auto" }}>
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

          {accounts.length > 0 && (
            <div className="flex items-center gap-1.5 mb-2" style={{ ...miniInput, padding: "5px 8px" }}>
              <Search size={13} color={C.inkFaint} />
              <input
                value={sidebarQuery}
                onChange={(e) => setSidebarQuery(e.target.value)}
                placeholder="Search accounts…"
                style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontSize: 12.5, color: C.ink }}
              />
              {sidebarQuery && <button onClick={() => setSidebarQuery("")}><X size={12} color={C.inkFaint} /></button>}
            </div>
          )}

          {accounts.some((a) => a.imbalancedLineCount > 0) && (
            <label className="flex items-center gap-1.5 mb-3" style={{ fontSize: 11.5, color: sidebarImbalancedOnly ? C.debit : C.inkSoft, padding: "0 2px", cursor: "pointer" }}>
              <input type="checkbox" checked={sidebarImbalancedOnly} onChange={(e) => setSidebarImbalancedOnly(e.target.checked)} />
              <AlertTriangle size={12} />
              Imbalanced only ({accounts.filter((a) => a.imbalancedLineCount > 0).length})
            </label>
          )}

          {loaded && accounts.length === 0 && (
            <p style={{ fontSize: 12.5, color: C.inkFaint, padding: "0 8px", lineHeight: 1.5 }}>No accounts yet. Add one to start keeping books.</p>
          )}

          {(() => {
            // Searching narrows *which* accounts show (matched against all
            // four dimensions, independent of the active grouping — see
            // CLAUDE.md), but keeps the same nested grouping layout rather
            // than flattening to a list: buildNestedGroups naturally drops
            // any group that ends up with no matching accounts in it. The
            // "imbalanced only" toggle narrows the same way, and combines
            // with an active search.
            let matched = sidebarQuery.trim()
              ? flattenAllAccounts(accounts, accounts, symbols).filter((l) => leafMatchesQuery(l, sidebarQuery)).map((l) => l.account)
              : accounts;
            if (sidebarImbalancedOnly) matched = matched.filter((a) => a.imbalancedLineCount > 0);
            if ((sidebarQuery.trim() || sidebarImbalancedOnly) && matched.length === 0) {
              return <p style={{ fontSize: 12.5, color: C.inkFaint, padding: "0 8px" }}>No accounts match.</p>;
            }
            return (
              <SidebarGroupTree
                groups={buildNestedGroups(matched, settings.groupLevels || ["type"], accounts, symbols)}
                depth={0}
                selectedId={selectedId}
                onSelect={setSelectedId}
                accountDisplay={accountDisplay}
              />
            );
          })()}
        </aside>


        <main className="flex-1 p-6" style={{ overflowY: "auto" }}>
          {showAllowance ? (
            <AllowanceView accounts={accounts} settings={settings} onSaveSettings={saveSettings} onSelect={setSelectedId} />
          ) : selected ? (
            selected.type === "isa-parent" ? (
              <IsaParentView
                account={selected}
                accounts={accounts}
                symbols={symbols}
                onEditAccount={() => setAccountForm(selected)}
                onSelect={setSelectedId}
                onNewSubaccount={(kind) => setAccountForm({ isaParentPreset: selected.id, typePreset: kind })}
              />
            ) : selected.type === "investment" ? (
              <StockLedger
                account={selected}
                accounts={accounts}
                symbols={symbols}
                currencies={currencies}
                groupLevels={settings.groupLevels || ["type"]}
                balance={selected.balance || 0}
                onEditAccount={() => setAccountForm(selected)}
                onLedgerOperations={saveLedgerOperations}
                guardRef={ledgerGuardRef}
              />
            ) : (
              <AccountLedger
                account={selected}
                accounts={accounts}
                symbols={symbols}
                currencies={currencies}
                groupLevels={settings.groupLevels || ["type"]}
                balance={selected.balance || 0}
                onEditAccount={() => setAccountForm(selected)}
                onLedgerOperations={saveLedgerOperations}
                guardRef={ledgerGuardRef}
              />
            )
          ) : (
            <Overview accounts={accounts} symbols={symbols} settings={settings} onSaveSettings={saveSettings} onSaveGrouping={saveGroupingPreset} onRemoveGrouping={removeGroupingPreset} onSelect={setSelectedId} onNew={() => setAccountForm({})} />
          )}
        </main>
      </div>

      {accountForm !== null && (
        <AccountFormModal
          initial={accountForm}
          accounts={accounts}
          currencies={currencies}
          symbols={symbols}
          institutions={institutions}
          onCancel={() => setAccountForm(null)}
          onSave={saveAccount}
          onDelete={accountForm.id ? () => requestDeleteAccount(accountForm.id) : null}
        />
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
