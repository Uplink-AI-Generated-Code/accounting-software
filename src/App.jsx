import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { Plus, Trash2, Check, X, Wallet, ArrowLeftRight, AlertTriangle, BookOpen, Pencil } from "lucide-react";

/* ---------------------------------------------------------
   Tokens
--------------------------------------------------------- */
const C = {
  paper: "#F6F2E8",
  paperDim: "#EDE7D6",
  card: "#FCFAF3",
  line: "#D9D0B8",
  lineSoft: "#E7E0CC",
  ink: "#22271F",
  inkSoft: "#6B6656",
  inkFaint: "#9A9480",
  gold: "#9C7A2E",
  goldDim: "#C8AD6C",
  debit: "#8A3B2B",
  debitBg: "#F3E1D8",
  credit: "#2E5F52",
  creditBg: "#DEE9E1",
};

const TYPES = [
  { key: "asset", label: "Assets" },
  { key: "liability", label: "Liabilities" },
  { key: "equity", label: "Equity" },
  { key: "income", label: "Income" },
  { key: "expense", label: "Expenses" },
];
// Used only to translate a plain "increase/decrease" entry into formal debit/credit
// for the balance-check hint — never shown to the user, never used for storage or display.
const CONTRA_TYPES = new Set(["liability", "equity", "income"]);

const CURRENCIES = ["GBP", "USD", "EUR", "JPY", "CHF", "CAD", "AUD"];

function fmt(amount, currency) {
  const v = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(v);
  } catch (e) {
    return `${v.toFixed(2)} ${currency}`;
  }
}
function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}
function fmtDate(d) {
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function hasStorage() {
  return typeof window !== "undefined" && !!window.storage && typeof window.storage.get === "function" && typeof window.storage.set === "function";
}

/* ---------------------------------------------------------
   Balance hint for a set of lines.
   Each line.amount is a delta: positive = increase that account,
   negative = decrease it. This is never forced — it's informational,
   so half-entered records (e.g. from a bank statement) can be saved
   and reconciled later.
--------------------------------------------------------- */
function balanceHint(lines, accounts) {
  const valid = lines.filter((l) => l.accountId && Number.isFinite(l.amount) && l.amount !== 0);
  if (valid.length === 0) return { type: "empty", message: "" };
  if (valid.length === 1) return { type: "single", message: "Single-sided — not yet matched to another account" };

  const byCur = {};
  valid.forEach((l) => {
    const acc = accounts.find((a) => a.id === l.accountId);
    const cur = acc ? acc.currency : "???";
    const trueSigned = acc && CONTRA_TYPES.has(acc.type) ? -l.amount : l.amount;
    byCur[cur] = (byCur[cur] || 0) + trueSigned;
  });
  const curs = Object.keys(byCur);

  if (curs.length === 1) {
    const diff = byCur[curs[0]];
    if (Math.abs(diff) < 0.005) return { type: "balanced", message: "Balanced" };
    return { type: "unbalanced", message: `Off by ${fmt(Math.abs(diff), curs[0])}` };
  }
  if (curs.length === 2 && valid.length === 2) {
    const [a, b] = valid;
    const accA = accounts.find((x) => x.id === a.accountId);
    const accB = accounts.find((x) => x.id === b.accountId);
    if (Math.sign(a.amount) !== Math.sign(b.amount)) {
      const rate = Math.abs(b.amount / a.amount);
      return { type: "fx", message: `Exchange — implied rate 1 ${accA.currency} = ${rate.toFixed(4)} ${accB.currency}` };
    }
    return { type: "unbalanced", message: "Both legs move the same direction" };
  }
  const allZero = curs.every((c) => Math.abs(byCur[c]) < 0.005);
  if (allZero) return { type: "balanced", message: "Balanced within each currency" };
  return { type: "unbalanced", message: curs.map((c) => fmt(byCur[c], c)).join("  ·  ") + " left over" };
}

/* ---------------------------------------------------------
   App
--------------------------------------------------------- */
export default function App() {
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [storageOK, setStorageOK] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [accountForm, setAccountForm] = useState(null);
  const [splitForm, setSplitForm] = useState(null); // advanced multi-line editor
  const [error, setError] = useState("");

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
        }
      } catch (e) {
        /* no data saved yet */
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  async function persist(nextAccounts, nextTransactions) {
    setAccounts(nextAccounts);
    setTransactions(nextTransactions);
    if (!hasStorage()) return;
    try {
      await window.storage.set("ledger-data", JSON.stringify({ accounts: nextAccounts, transactions: nextTransactions }));
    } catch (e) {
      setStorageOK(false);
    }
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

  function saveAccount(data) {
    if (data.id) persist(accounts.map((a) => (a.id === data.id ? data : a)), transactions);
    else persist([...accounts, { ...data, id: uid() }], transactions);
    setAccountForm(null);
  }

  function deleteAccount(id) {
    const used = transactions.some((t) => t.lines.some((l) => l.accountId === id));
    if (used) {
      setError("Can't delete an account that has ledger entries. Delete its entries first.");
      return;
    }
    persist(accounts.filter((a) => a.id !== id), transactions);
    if (selectedId === id) setSelectedId(null);
    setAccountForm(null);
  }

  function saveTransaction(data) {
    if (data.id) persist(accounts, transactions.map((t) => (t.id === data.id ? { ...data } : t)));
    else persist(accounts, [...transactions, { ...data, id: uid() }]);
  }

  function deleteTransaction(id) {
    persist(accounts, transactions.filter((t) => t.id !== id));
    setSplitForm(null);
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
          <button onClick={() => setSelectedId(null)} className="w-full text-left px-2 py-1.5 rounded mb-3" style={{ background: selectedId === null ? C.paperDim : "transparent", fontSize: 13, fontWeight: 600, color: C.inkSoft }}>
            Overview
          </button>

          {loaded && accounts.length === 0 && (
            <p style={{ fontSize: 12.5, color: C.inkFaint, padding: "0 8px", lineHeight: 1.5 }}>No accounts yet. Add one to start keeping books.</p>
          )}

          {TYPES.map((t) => {
            const list = accounts.filter((a) => a.type === t.key);
            if (list.length === 0) return null;
            return (
              <div key={t.key} className="mb-3">
                <div style={{ fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: C.inkFaint, padding: "4px 8px" }}>{t.label}</div>
                {list.map((a) => (
                  <button key={a.id} onClick={() => setSelectedId(a.id)} className="w-full text-left px-2 py-1.5 rounded flex items-center justify-between" style={{ background: selectedId === a.id ? C.paperDim : "transparent" }}>
                    <span style={{ fontSize: 13.5, color: C.ink }}>{a.name}</span>
                    <span className="ll-mono" style={{ fontSize: 12, color: (balances[a.id] || 0) < 0 ? C.debit : C.inkSoft }}>{fmt(balances[a.id] || 0, a.currency)}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </aside>

        <main className="flex-1 p-6">
          {selected ? (
            <AccountLedger
              account={selected}
              accounts={accounts}
              transactions={transactions}
              balance={balances[selected.id] || 0}
              onEditAccount={() => setAccountForm(selected)}
              onSaveTxn={saveTransaction}
              onDeleteTxn={deleteTransaction}
              onOpenSplit={(t) => setSplitForm(t)}
              onNewSplit={() => setSplitForm({ presetAccountId: selected.id })}
            />
          ) : (
            <Overview accounts={accounts} balances={balances} onSelect={setSelectedId} onNew={() => setAccountForm({})} />
          )}
        </main>
      </div>

      {accountForm !== null && (
        <AccountFormModal initial={accountForm} onCancel={() => setAccountForm(null)} onSave={saveAccount} onDelete={accountForm.id ? () => deleteAccount(accountForm.id) : null} />
      )}

      {splitForm !== null && (
        <SplitFormModal
          initial={splitForm}
          accounts={accounts}
          onCancel={() => setSplitForm(null)}
          onSave={(d) => { saveTransaction(d); setSplitForm(null); }}
          onDelete={splitForm.id ? () => deleteTransaction(splitForm.id) : null}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------
   Overview
--------------------------------------------------------- */
function Overview({ accounts, balances, onSelect, onNew }) {
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
  accounts.forEach((a) => { totalsByCurrency[a.currency] = (totalsByCurrency[a.currency] || 0) + (balances[a.id] || 0); });

  return (
    <div>
      <h2 className="ll-serif" style={{ fontSize: 20, marginBottom: 4 }}>Chart of accounts</h2>
      <p style={{ fontSize: 13, color: C.inkFaint, marginBottom: 20 }}>
        Combined balance by currency: {Object.entries(totalsByCurrency).map(([c, v]) => fmt(v, c)).join("  ·  ")}
      </p>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
        {accounts.map((a) => (
          <button key={a.id} onClick={() => onSelect(a.id)} className="text-left p-4 rounded" style={{ background: C.card, border: `1px solid ${C.line}` }}>
            <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>{TYPES.find((t) => t.key === a.type)?.label}</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginTop: 4 }}>{a.name}</div>
            <div className="ll-mono" style={{ fontSize: 18, marginTop: 8, color: (balances[a.id] || 0) < 0 ? C.debit : C.ink }}>{fmt(balances[a.id] || 0, a.currency)}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------
   Account Ledger — inline add/edit, live FLIP reorder + autoscroll
--------------------------------------------------------- */
function blankDraft(presetOtherId) {
  return { mode: "new", txnId: null, date: todayISO(), description: "", otherAccountId: presetOtherId || "", isOut: false, amountStr: "", otherAmountStr: "" };
}

function AccountLedger({ account, accounts, transactions, balance, onEditAccount, onSaveTxn, onDeleteTxn, onOpenSplit, onNewSplit }) {
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState("");

  function draftToTxn(d, forcedId) {
    const mag = Math.abs(parseFloat(d.amountStr));
    const delta = isNaN(mag) ? 0 : d.isOut ? -mag : mag;
    const lines = [{ accountId: account.id, amount: delta }];
    if (d.otherAccountId) {
      const otherAcc = accounts.find((a) => a.id === d.otherAccountId);
      let otherAmt = -delta;
      if (otherAcc && otherAcc.currency !== account.currency && d.otherAmountStr !== "") {
        const parsed = parseFloat(d.otherAmountStr);
        if (!isNaN(parsed)) otherAmt = d.isOut ? Math.abs(parsed) : -Math.abs(parsed);
      }
      lines.push({ accountId: d.otherAccountId, amount: otherAmt });
    }
    return { id: forcedId || d.txnId, date: d.date || todayISO(), description: d.description, lines };
  }

  const editingKey = draft ? (draft.mode === "edit" ? draft.txnId : "DRAFT_NEW") : null;

  const effectiveTxns = useMemo(() => {
    let list = transactions;
    if (draft && draft.mode === "edit") list = list.map((t) => (t.id === draft.txnId ? draftToTxn(draft) : t));
    if (draft && draft.mode === "new") list = [...list, draftToTxn(draft, "DRAFT_NEW")];
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, draft, account, accounts]);

  const rows = useMemo(() => {
    const relevant = effectiveTxns.filter((t) => t.lines.some((l) => l.accountId === account.id));
    const sorted = [...relevant].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.id).localeCompare(String(b.id))));
    let running = account.openingBalance || 0;
    return sorted.map((t) => {
      const line = t.lines.find((l) => l.accountId === account.id);
      running += line.amount || 0;
      const others = t.lines.filter((l) => l.accountId !== account.id).map((l) => accounts.find((a) => a.id === l.accountId)).filter(Boolean);
      return { txn: t, line, running, others };
    });
  }, [effectiveTxns, account, accounts]);

  const rowRefs = useRef({});
  const prevTop = useRef({});

  useLayoutEffect(() => {
    const newTops = {};
    rows.forEach((r) => {
      const el = rowRefs.current[r.txn.id];
      if (el) newTops[r.txn.id] = el.getBoundingClientRect().top;
    });
    rows.forEach((r) => {
      const el = rowRefs.current[r.txn.id];
      const prev = prevTop.current[r.txn.id];
      const next = newTops[r.txn.id];
      if (el && prev !== undefined && next !== undefined && prev !== next) {
        const delta = prev - next;
        el.style.transition = "none";
        el.style.transform = `translateY(${delta}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)";
          el.style.transform = "translateY(0px)";
          if (r.txn.id === editingKey) {
            const rect = el.getBoundingClientRect();
            const outOfView = rect.top < 60 || rect.bottom > window.innerHeight - 20;
            if (outOfView) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        });
      }
    });
    prevTop.current = newTops;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => r.txn.id + "|" + r.txn.date).join(",")]);

  function startEdit(t) {
    if (t.lines.length > 2) { onOpenSplit(t); return; }
    const line = t.lines.find((l) => l.accountId === account.id);
    const other = t.lines.find((l) => l.accountId !== account.id);
    const otherAcc = other ? accounts.find((a) => a.id === other.accountId) : null;
    setDraft({
      mode: "edit",
      txnId: t.id,
      date: t.date,
      description: t.description || "",
      otherAccountId: other ? other.accountId : "",
      isOut: line.amount < 0,
      amountStr: String(Math.abs(line.amount)),
      otherAmountStr: other && otherAcc && otherAcc.currency !== account.currency ? String(Math.abs(other.amount)) : "",
    });
    setDraftError("");
  }

  function commit() {
    if (!draft) return;
    const mag = parseFloat(draft.amountStr);
    if (isNaN(mag) || mag === 0) { setDraftError("Enter an amount."); return; }
    const data = draftToTxn(draft, draft.mode === "edit" ? draft.txnId : undefined);
    onSaveTxn({ id: draft.mode === "edit" ? draft.txnId : undefined, date: data.date, description: data.description.trim(), lines: data.lines });
    setDraft(null);
    setDraftError("");
  }

  function cancel() {
    setDraft(null);
    setDraftError("");
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-5">
        <div>
          <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>{TYPES.find((t) => t.key === account.type)?.label} · {account.currency}</div>
          <h2 className="ll-serif" style={{ fontSize: 24, marginTop: 2 }}>{account.name}</h2>
          <div className="ll-mono" style={{ fontSize: 22, marginTop: 6, color: balance < 0 ? C.debit : C.ink }}>{fmt(balance, account.currency)}</div>
        </div>
        <div className="flex gap-2">
          <button onClick={onEditAccount} className="px-3 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13 }}>Edit account</button>
          <button onClick={onNewSplit} className="px-3 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13 }}>Split entry…</button>
          <button
            onClick={() => { setDraft(blankDraft()); setDraftError(""); }}
            disabled={!!draft}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded"
            style={{ background: draft ? C.inkFaint : C.ink, color: C.paper, fontSize: 13, cursor: draft ? "default" : "pointer" }}
          >
            <Plus size={14} /> Add entry
          </button>
        </div>
      </div>

      <div style={{ border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden", background: C.card }}>
        <div className="grid" style={{ gridTemplateColumns: "120px 1fr 170px 100px 100px 120px 60px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.6, color: C.inkFaint, padding: "10px 16px", borderBottom: `1px solid ${C.line}` }}>
          <div>Date</div><div>Description</div><div>Transfer</div><div className="text-right">Out</div><div className="text-right">In</div><div className="text-right">Balance</div><div />
        </div>

        {rows.length === 0 && !draft && <div style={{ padding: "24px 16px", fontSize: 13, color: C.inkFaint }}>No entries yet in this account.</div>}

        {rows.map((r) => {
          const isEditing = r.txn.id === editingKey;
          const out = r.line.amount < 0 ? -r.line.amount : 0;
          const inn = r.line.amount > 0 ? r.line.amount : 0;
          const hint = r.txn.lines.length !== 2 ? balanceHint(r.txn.lines, accounts) : null;

          if (isEditing) {
            const otherAcc = accounts.find((a) => a.id === draft.otherAccountId);
            const needsOtherAmount = otherAcc && otherAcc.currency !== account.currency;
            return (
              <div key={r.txn.id} ref={(el) => (rowRefs.current[r.txn.id] = el)} style={{ borderBottom: `1px solid ${C.lineSoft}`, background: C.paperDim, padding: "10px 16px" }}>
                <div className="grid items-center" style={{ gridTemplateColumns: "120px 1fr 170px 190px 120px 60px", gap: 8 }}>
                  <input type="date" autoFocus value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} style={miniInput} />
                  <input type="text" placeholder="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={miniInput} />
                  <select value={draft.otherAccountId} onChange={(e) => setDraft({ ...draft, otherAccountId: e.target.value })} style={miniInput}>
                    <option value="">— unmatched —</option>
                    {accounts.filter((a) => a.id !== account.id).map((a) => (
                      <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>
                    ))}
                  </select>
                  <div className="flex gap-1 items-center">
                    <div className="flex rounded overflow-hidden shrink-0" style={{ border: `1px solid ${C.line}` }}>
                      {[{ v: false, label: "In" }, { v: true, label: "Out" }].map((o) => (
                        <button key={o.label} type="button" onClick={() => setDraft({ ...draft, isOut: o.v })}
                          style={{ padding: "7px 9px", fontSize: 12, background: draft.isOut === o.v ? (o.v ? C.debitBg : C.creditBg) : "transparent", color: draft.isOut === o.v ? (o.v ? C.debit : C.credit) : C.inkFaint, fontWeight: draft.isOut === o.v ? 600 : 400 }}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                    <input type="number" step="0.0001" placeholder={account.currency} value={draft.amountStr} onChange={(e) => setDraft({ ...draft, amountStr: e.target.value })}
                      className="ll-mono" style={{ ...miniInput, width: 90 }}
                      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") cancel(); }} />
                  </div>
                  {needsOtherAmount ? (
                    <input type="number" step="0.0001" placeholder={otherAcc.currency} value={draft.otherAmountStr} onChange={(e) => setDraft({ ...draft, otherAmountStr: e.target.value })} className="ll-mono" style={miniInput} />
                  ) : <div />}
                  <div className="flex gap-1 justify-end">
                    <button onClick={commit} title="Save" style={iconBtn(C.credit)}><Check size={15} /></button>
                    <button onClick={cancel} title="Cancel" style={iconBtn(C.inkFaint)}><X size={15} /></button>
                  </div>
                </div>
                <div className="flex items-center justify-between mt-2">
                  <span style={{ fontSize: 12, color: draftError ? C.debit : C.inkFaint }}>
                    {draftError || (draft.otherAccountId ? "Two-account entry" : "Single-sided — can be matched to another account later")}
                  </span>
                  {draft.mode === "edit" && (
                    <button onClick={() => onDeleteTxn(draft.txnId)} className="flex items-center gap-1" style={{ fontSize: 12, color: C.debit }}><Trash2 size={12} /> Delete</button>
                  )}
                </div>
              </div>
            );
          }

          return (
            <div
              key={r.txn.id}
              ref={(el) => (rowRefs.current[r.txn.id] = el)}
              onClick={() => (draft ? null : startEdit(r.txn))}
              className="grid ll-row cursor-pointer"
              style={{ gridTemplateColumns: "120px 1fr 170px 100px 100px 120px 60px", fontSize: 13.5, padding: "10px 16px", borderBottom: `1px solid ${C.lineSoft}`, alignItems: "center" }}
            >
              <div style={{ color: C.inkSoft, fontSize: 12.5 }}>{fmtDate(r.txn.date)}</div>
              <div className="flex items-center gap-2">
                {r.txn.description || <span style={{ color: C.inkFaint }}>—</span>}
                {hint && hint.type !== "balanced" && hint.type !== "empty" && (
                  <span title={hint.message}><AlertTriangle size={12} color={C.gold} /></span>
                )}
              </div>
              <div style={{ color: C.inkFaint, fontSize: 12.5, display: "flex", alignItems: "center", gap: 4 }}>
                {r.others.length > 0 ? (<><ArrowLeftRight size={11} /> {r.others.map((a) => a.name).join(", ")}</>) : <span style={{ fontStyle: "italic" }}>unmatched</span>}
              </div>
              <div className="ll-mono text-right" style={{ color: out ? C.debit : C.inkFaint }}>{out ? fmt(out, account.currency) : "—"}</div>
              <div className="ll-mono text-right" style={{ color: inn ? C.credit : C.inkFaint }}>{inn ? fmt(inn, account.currency) : "—"}</div>
              <div className="ll-mono text-right" style={{ fontWeight: 600, color: r.running < 0 ? C.debit : C.ink }}>{fmt(r.running, account.currency)}</div>
              <div className="flex justify-end"><Pencil size={13} color={C.inkFaint} /></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const miniInput = { width: "100%", padding: "7px 8px", borderRadius: 4, border: `1px solid ${C.line}`, background: C.paper, fontSize: 13, color: C.ink, outline: "none" };
function iconBtn(color) { return { padding: 6, borderRadius: 4, border: `1px solid ${C.line}`, color, background: C.card }; }

/* ---------------------------------------------------------
   Account form modal
--------------------------------------------------------- */
function AccountFormModal({ initial, onCancel, onSave, onDelete }) {
  const [name, setName] = useState(initial.name || "");
  const [type, setType] = useState(initial.type || "asset");
  const [currency, setCurrency] = useState(initial.currency || "GBP");
  const [opening, setOpening] = useState(initial.openingBalance ? String(initial.openingBalance) : "0");

  function submit() {
    if (!name.trim()) return;
    onSave({ id: initial.id, name: name.trim(), type, currency, openingBalance: parseFloat(opening) || 0 });
  }

  return (
    <ModalShell onCancel={onCancel} title={initial.id ? "Edit account" : "New account"}>
      <div className="flex flex-col gap-3" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}>
        <Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} placeholder="e.g. Barclays Current Account" /></Field>
        <Field label="Type">
          <select value={type} onChange={(e) => setType(e.target.value)} style={inputStyle}>
            {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </Field>
        <Field label="Currency">
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="Opening balance"><input type="number" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} style={inputStyle} /></Field>
        <div className="flex justify-between items-center mt-2">
          {onDelete ? <button type="button" onClick={onDelete} className="flex items-center gap-1 text-sm" style={{ color: C.debit }}><Trash2 size={14} /> Delete</button> : <span />}
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded text-sm" style={{ border: `1px solid ${C.line}` }}>Cancel</button>
            <button type="button" onClick={submit} className="px-3 py-1.5 rounded text-sm" style={{ background: C.ink, color: C.paper }}>Save</button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

/* ---------------------------------------------------------
   Split (multi-account) entry modal — for entries touching
   more than two accounts. Balancing is a hint, never enforced.
--------------------------------------------------------- */
function SplitFormModal({ initial, accounts, onCancel, onSave, onDelete }) {
  const startingLines = initial.lines
    ? initial.lines.map((l) => ({ id: uid(), accountId: l.accountId, isOut: l.amount < 0, amountStr: String(Math.abs(l.amount)) }))
    : [
        { id: uid(), accountId: initial.presetAccountId || "", isOut: true, amountStr: "" },
        { id: uid(), accountId: "", isOut: false, amountStr: "" },
      ];
  const [date, setDate] = useState(initial.date || todayISO());
  const [description, setDescription] = useState(initial.description || "");
  const [lines, setLines] = useState(startingLines);

  const parsedLines = lines
    .filter((l) => l.accountId && l.amountStr !== "")
    .map((l) => ({ accountId: l.accountId, amount: l.isOut ? -Math.abs(parseFloat(l.amountStr)) : Math.abs(parseFloat(l.amountStr)) }));
  const hint = balanceHint(parsedLines, accounts);

  function updateLine(id, patch) { setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l))); }
  function addLine() { setLines((ls) => [...ls, { id: uid(), accountId: "", isOut: false, amountStr: "" }]); }
  function removeLine(id) { setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.id !== id) : ls)); }

  function submit() {
    if (parsedLines.length === 0) return;
    onSave({ id: initial.id, date, description: description.trim(), lines: parsedLines });
  }

  return (
    <ModalShell onCancel={onCancel} title={initial.id ? "Edit split entry" : "New split entry"} wide>
      <div className="flex flex-col gap-3" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}>
        <div className="flex gap-3">
          <Field label="Date" style={{ width: 170 }}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} /></Field>
          <Field label="Description" style={{ flex: 1 }}><input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} placeholder="What was this for?" /></Field>
        </div>
        <div style={{ borderTop: `1px solid ${C.lineSoft}`, paddingTop: 10 }}>
          {lines.map((l) => (
            <div key={l.id} className="flex gap-2 items-center mb-2">
              <select value={l.accountId} onChange={(e) => updateLine(l.id, { accountId: e.target.value })} style={{ ...inputStyle, flex: 1 }}>
                <option value="">Select account…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
              </select>
              <div className="flex rounded overflow-hidden" style={{ border: `1px solid ${C.line}` }}>
                {[{ v: false, label: "In" }, { v: true, label: "Out" }].map((o) => (
                  <button key={o.label} type="button" onClick={() => updateLine(l.id, { isOut: o.v })}
                    style={{ padding: "8px 10px", fontSize: 12.5, background: l.isOut === o.v ? (o.v ? C.debitBg : C.creditBg) : "transparent", color: l.isOut === o.v ? (o.v ? C.debit : C.credit) : C.inkFaint, fontWeight: l.isOut === o.v ? 600 : 400 }}>
                    {o.label}
                  </button>
                ))}
              </div>
              <input type="number" step="0.0001" value={l.amountStr} onChange={(e) => updateLine(l.id, { amountStr: e.target.value })} style={{ ...inputStyle, width: 130 }} className="ll-mono" />
              <button type="button" onClick={() => removeLine(l.id)} disabled={lines.length <= 1} style={{ opacity: lines.length <= 1 ? 0.3 : 1 }}><X size={16} color={C.inkFaint} /></button>
            </div>
          ))}
          <button type="button" onClick={addLine} className="flex items-center gap-1 text-sm mt-1" style={{ color: C.gold }}><Plus size={14} /> Add line</button>
        </div>
        {hint.message && (
          <div className="flex items-center gap-2 px-3 py-2 rounded" style={{ background: hint.type === "balanced" || hint.type === "fx" ? C.creditBg : C.paperDim, color: hint.type === "balanced" || hint.type === "fx" ? C.credit : C.inkSoft, fontSize: 12.5 }}>
            {hint.type === "balanced" || hint.type === "fx" ? <Check size={14} /> : <AlertTriangle size={14} />} {hint.message}
          </div>
        )}
        <div className="flex justify-between items-center mt-1">
          {onDelete ? <button type="button" onClick={onDelete} className="flex items-center gap-1 text-sm" style={{ color: C.debit }}><Trash2 size={14} /> Delete</button> : <span />}
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded text-sm" style={{ border: `1px solid ${C.line}` }}>Cancel</button>
            <button type="button" onClick={submit} className="px-3 py-1.5 rounded text-sm" style={{ background: C.ink, color: C.paper }}>Save entry</button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

/* ---------------------------------------------------------
   Shared UI bits
--------------------------------------------------------- */
const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 5, border: `1px solid ${C.line}`, background: C.paper, fontSize: 13.5, color: C.ink, outline: "none" };

function Field({ label, children, style }) {
  return (
    <label style={{ display: "block", ...style }}>
      <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {children}
    </label>
  );
}

function ModalShell({ title, children, onCancel, wide }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ background: "rgba(34,39,31,0.35)", zIndex: 50 }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, padding: 22, width: wide ? 560 : 380, maxWidth: "92vw", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 12px 40px rgba(34,39,31,0.25)" }}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="ll-serif" style={{ fontSize: 17 }}>{title}</h3>
          <button onClick={onCancel}><X size={16} color={C.inkFaint} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
