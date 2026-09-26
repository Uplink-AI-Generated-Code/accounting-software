import { useEffect, useRef, useState } from "react";
import { Plus, AlertTriangle, BookOpen, X, Search } from "lucide-react";
import { C } from "./lib/theme";
import { uid, fmt, fmtUnits, setCurrencyScales, setSymbolScales, displayAccountName } from "./lib/format";
import { symbolKey } from "./lib/symbolKey";
import { buildNestedGroups, flattenAllAccounts, leafMatchesQuery } from "./lib/grouping";
import { taxYearBounds } from "./lib/isa";
import { accountIdFromHash, setHashForAccount } from "./lib/hash";
import * as api from "./api";
import { ModalShell, miniInput } from "./components/ui";
import { GroupLevelPicker } from "./components/GroupLevelPicker";
import { SidebarGroupTree } from "./components/SidebarGroupTree";
import { Overview } from "./components/Overview";
import { TagsView } from "./components/TagsView";
import { IsaParentView } from "./components/IsaParentView";
import { AllowanceView } from "./components/AllowanceView";
import { AccountLedger } from "./components/AccountLedger";
import { StockLedger } from "./components/StockLedger";
import { AccountFormModal } from "./components/AccountFormModal";
import { DatabaseSwitcher, DatabaseSwitcherBlocking } from "./components/DatabaseSwitcher";

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
  // Reference data — currency/symbol/counterparty are lookup entities
  // server-side (see CLAUDE.md), fetched once here alongside accounts and
  // passed down to AccountFormModal's pickers. currencies/symbols also
  // feed lib/format.js's setCurrencyScales()/setSymbolScales() so every
  // fmt()/fmtUnits() call anywhere in the app can convert a scaled
  // integer to a decimal without each one needing its own scale lookup.
  const [currencies, setCurrencies] = useState([]);
  const [symbols, setSymbols] = useState([]);
  const [counterparties, setCounterparties] = useState([]);
  // Every distinct tag in use, app-wide — feeds the tag editor's
  // autocomplete (existing dimensions, then existing values) wherever a
  // line is being edited. Small (personal-ledger scale), so a single
  // fetch alongside the other reference data is fine; re-fetched after
  // ledger writes the same way accounts/settings are, since a save can
  // introduce a brand-new tag. See CLAUDE.md's "Tags" section.
  const [knownTags, setKnownTags] = useState([]);
  const [settings, setSettings] = useState({ over65: false, groupLevels: ["type"], savedGroupings: [] });
  const [loaded, setLoaded] = useState(false);
  const [storageOK, setStorageOK] = useState(true);
  // Set only when the backend itself told us why (e.g. a database missing
  // a migration — see MigrationStatusListener) rather than a generic
  // network failure, so the banner below can show that specific reason
  // instead of always falling back to "check that the server is running".
  const [backendErrorReason, setBackendErrorReason] = useState("");
  // True specifically when the backend reported "no_active_database" —
  // see MigrationStatusListener — distinct from a generic backend
  // failure: this renders a full-screen, non-dismissible database picker
  // instead of the normal app shell (see the early return below), rather
  // than just a banner.
  const [noActiveDatabase, setNoActiveDatabase] = useState(false);
  const [selectedId, setSelectedIdRaw] = useState(null);
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [sidebarImbalancedOnly, setSidebarImbalancedOnly] = useState(false);
  const [showAllowance, setShowAllowance] = useState(false);
  const [showTags, setShowTags] = useState(false);
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
    setShowTags(false);
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
    attemptNavigation(() => { setSelectedIdRaw(null); setShowAllowance(true); setShowTags(false); });
  }
  function goToTags() {
    attemptNavigation(() => { setSelectedIdRaw(null); setShowAllowance(false); setShowTags(true); });
  }

  async function refreshAccounts() {
    const list = await api.getAccounts();
    setAccounts(list);
    return list;
  }

  useEffect(() => {
    (async () => {
      // Each of these is fetched independently — accounts failing (e.g. a
      // migration that hasn't been run against this database yet) must
      // not also blank out currencies/symbols/counterparties/tags, which
      // are unrelated endpoints that might otherwise have loaded fine.
      // This shipped as a real bug once: an accounts-only 500 silently
      // left the currency picker looking broken, when the actual problem
      // was one missing migration.
      const [accountsResult, cur, sym, cp, tags, s] = await Promise.all([
        refreshAccounts().catch((e) => {
          // A real network failure (server not running at all) rejects
          // fetch() itself with a TypeError before any response exists —
          // only trust e.message as a specific reason when it didn't.
          setBackendErrorReason(e instanceof TypeError ? "" : e.message);
          if (e && e.reason === "no_active_database") setNoActiveDatabase(true);
          return null;
        }),
        api.getCurrencies().catch(() => []),
        api.getSymbols().catch(() => []),
        api.getCounterparties().catch(() => []),
        api.getTags().catch(() => []),
        api.getSettings().catch(() => null),
      ]);
      setCurrencies(cur);
      setSymbols(sym);
      setCounterparties(cp);
      setKnownTags(tags);
      setCurrencyScales(cur);
      setSymbolScales(sym);
      if (s) {
        setSettings({ over65: false, groupLevels: ["type"], savedGroupings: [], ...s });
      }
      if (null === accountsResult) {
        // Can't reach the backend — start from an empty ledger rather than
        // leaving the app stuck loading; the banner below explains why.
        setStorageOK(false);
      }
      setLoaded(true);
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

  function saveSettings(partial) {
    // Optimistic: merge the partial into local state immediately (not a
    // blind replace — `partial` only carries the field(s) actually
    // changing, so replacing outright would wipe every other setting
    // from the UI until the next GET /api/settings).
    setSettings((prev) => ({ ...prev, ...partial }));
    api.patchSettings(partial).then(() => setStorageOK(true)).catch(() => setStorageOK(false));
  }

  function saveGroupingPreset(levels) {
    const already = (settings.savedGroupings || []).some((s) => JSON.stringify(s.levels) === JSON.stringify(levels));
    if (already) return;
    saveSettings({ savedGroupings: [...(settings.savedGroupings || []), { id: uid(), levels }] });
  }

  function removeGroupingPreset(id) {
    saveSettings({ savedGroupings: (settings.savedGroupings || []).filter((s) => s.id !== id) });
  }

  // Each investment account holds exactly one security, so its balance —
  // computed the same way as any other account's — already *is* the unit
  // count. Only the display differs: units and a symbol, not a currency.
  // An ISA wrapper holds no balance of its own — it's shown by how many
  // subaccounts it groups. balance/portfolioValue are computed server-side
  // now (see GET /api/accounts) rather than derived here.
  function accountDisplay(a) {
    if (a.type === "investment-parent") {
      const n = accounts.filter((x) => x.parentId === a.id).length;
      return `${n} subaccount${n === 1 ? "" : "s"}`;
    }
    const bal = a.balance || 0;
    if (a.type === "investment") {
      const tradingCurrency = a.symbolCurrency;
      return `${fmtUnits(bal, symbolKey(a.symbolTicker, a.symbolCurrency))} ${a.symbolTicker} · ${fmt(a.portfolioValue || 0, tradingCurrency)}`;
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
    const hasSubaccounts = accounts.some((a) => a.parentId === id);
    if (hasSubaccounts) {
      setError("Can't delete a wrapper account that still has subaccounts. Delete those first.");
      return;
    }
    const acc = accounts.find((a) => a.id === id);
    const entryCount = (acc && acc.entryCount) || 0;
    if (entryCount === 0) {
      performDeleteAccount(id);
      return;
    }
    setDeleteConfirm({ id, entryCount, name: acc ? displayAccountName(acc) : "" });
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
      .then(() => {
        setStorageOK(true);
        // This ledger's tax year (and how many lines fall outside it) is
        // never stored — always recomputed fresh from the actual line
        // dates (see LedgerStateService::determinedTaxYearStart()) — and
        // a save can shift either number (a new earliest date moves the
        // year; any save can change which existing lines now fall
        // outside it). Refetch settings after every write so the
        // header's badge stays accurate rather than only updating after
        // a full reload.
        api.getSettings().then((s) => setSettings((prev) => ({ ...prev, ...s }))).catch(() => {});
        // A save can introduce a brand-new tag — refetch so it's available
        // in the tag editor's autocomplete without a full page reload.
        api.getTags().then(setKnownTags).catch(() => {});
        return refreshAccounts();
      })
      .catch(() => setStorageOK(false));
  }

  const selected = accounts.find((a) => a.id === selectedId) || null;
  // This ledger's one UK tax year — see CLAUDE.md's "The active tax
  // year". Never set by hand: always derived server-side from the
  // earliest line date in the database (plus whatever's about to be
  // saved, for the live-write hard-block check) — there is deliberately
  // no "pick a year" control. `null` means nothing's been saved yet.
  const activeTaxYearStart = settings.activeTaxYearStart ?? null;
  // How many already-saved lines fall outside that derived year —
  // warning-only, never blocks (existing data is never rejected
  // retroactively, only flagged — see CLAUDE.md).
  const outOfTaxYearLineCount = settings.outOfTaxYearLineCount || 0;

  if (noActiveDatabase) {
    return <DatabaseSwitcherBlocking onSwitched={() => window.location.reload()} />;
  }

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
        <div className="flex items-center gap-3">
          <DatabaseSwitcher attemptNavigation={attemptNavigation} onSwitched={() => window.location.reload()} />
          {activeTaxYearStart != null && (
            <div
              className="flex items-center gap-2 rounded"
              style={{ border: `1px solid ${C.line}`, padding: "5px 10px" }}
              title="This ledger's one tax year — always derived from its earliest entry, never chosen by hand. New/edited entries outside it are rejected."
            >
              <span className="ll-mono" style={{ fontSize: 12.5, color: C.inkSoft }}>{taxYearBounds(activeTaxYearStart).label} tax year</span>
              {outOfTaxYearLineCount > 0 && (
                <span
                  className="flex items-center gap-1"
                  style={{ color: C.debit, fontSize: 11.5 }}
                  title={`${outOfTaxYearLineCount} already-saved line(s) fall outside this tax year — not blocked, just flagged.`}
                >
                  <AlertTriangle size={12} /> {outOfTaxYearLineCount} outside
                </span>
              )}
            </div>
          )}
          <button onClick={() => setAccountForm({})} className="flex items-center gap-1.5 px-3 py-1.5 rounded" style={{ background: C.ink, color: C.paper, fontSize: 13, fontWeight: 500 }}>
            <Plus size={14} /> New account
          </button>
        </div>
      </header>

      {!storageOK && (
        <div className="mx-6 mt-4 px-3 py-2 rounded flex items-center gap-2" style={{ background: C.paperDim, color: C.inkSoft, fontSize: 12.5 }}>
          <AlertTriangle size={14} color={C.gold} /> {backendErrorReason || "Can't reach the backend — check that the Symfony server is running. Changes won't be saved until it's back."}
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
          <button onClick={() => setSelectedId(null)} className="w-full text-left px-2 py-1.5 rounded mb-1" style={{ background: selectedId === null && !showAllowance && !showTags ? C.paperDim : "transparent", fontSize: 13, fontWeight: 600, color: C.inkSoft }}>
            Overview
          </button>
          <button
            onClick={goToAllowance}
            className="w-full text-left px-2 py-1.5 rounded mb-1"
            style={{ background: showAllowance ? C.paperDim : "transparent", fontSize: 13, fontWeight: 600, color: C.inkSoft }}
          >
            ISA Allowance
          </button>
          <button
            onClick={goToTags}
            className="w-full text-left px-2 py-1.5 rounded mb-3"
            style={{ background: showTags ? C.paperDim : "transparent", fontSize: 13, fontWeight: 600, color: C.inkSoft }}
          >
            Tags
          </button>

          <div className="mb-3">
            <GroupLevelPicker
              levels={(settings.groupLevels?.length ? settings.groupLevels : ["type"])}
              onChange={(lv) => saveSettings({ groupLevels: lv })}
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
                groups={buildNestedGroups(matched, (settings.groupLevels?.length ? settings.groupLevels : ["type"]), accounts, symbols)}
                depth={0}
                selectedId={selectedId}
                onSelect={setSelectedId}
                accountDisplay={accountDisplay}
              />
            );
          })()}
        </aside>


        <main className="flex-1 p-6" style={{ overflowY: "auto" }}>
          {showTags ? (
            <TagsView knownTags={knownTags} onSelect={setSelectedId} />
          ) : showAllowance ? (
            <AllowanceView accounts={accounts} settings={settings} onSaveSettings={saveSettings} onSelect={setSelectedId} activeTaxYearStart={activeTaxYearStart} />
          ) : selected ? (
            selected.type === "investment-parent" ? (
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
                groupLevels={(settings.groupLevels?.length ? settings.groupLevels : ["type"])}
                activeTaxYearStart={activeTaxYearStart}
                balance={selected.balance || 0}
                knownTags={knownTags}
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
                groupLevels={(settings.groupLevels?.length ? settings.groupLevels : ["type"])}
                activeTaxYearStart={activeTaxYearStart}
                balance={selected.balance || 0}
                knownTags={knownTags}
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
          counterparties={counterparties}
          onCancel={() => setAccountForm(null)}
          onSave={saveAccount}
          onDelete={accountForm.id ? () => requestDeleteAccount(accountForm.id) : null}
          onSymbolCreated={(symbol) => setSymbols((prev) => [...prev, symbol])}
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
