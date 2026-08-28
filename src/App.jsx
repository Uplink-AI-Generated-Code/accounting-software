import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { Plus, Trash2, Check, X, Wallet, ArrowLeftRight, AlertTriangle, BookOpen, Pencil, Unlink2, TrendingUp, TableProperties } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

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
  { key: "investment", label: "Stocks & Shares" },
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
function daysDiff(a, b) {
  const t1 = new Date(a + "T00:00:00").getTime();
  const t2 = new Date(b + "T00:00:00").getTime();
  return Math.round((t2 - t1) / 86400000);
}
function addDays(dateISO, days) {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateISO, months) {
  const d = new Date(dateISO + "T00:00:00");
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}
function addYears(dateISO, years) {
  const d = new Date(dateISO + "T00:00:00");
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}
function fmtDateShort(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const CHART_INTERVALS = [
  { key: "30d", label: "30D" },
  { key: "3m", label: "3M" },
  { key: "6m", label: "6M" },
  { key: "1y", label: "1Y" },
  { key: "ytd", label: "YTD" },
  { key: "all", label: "All" },
];

function intervalRange(key, earliestISO) {
  const today = todayISO();
  switch (key) {
    case "30d": return { start: addDays(today, -29), end: today };
    case "3m": return { start: addMonths(today, -3), end: today };
    case "6m": return { start: addMonths(today, -6), end: today };
    case "1y": return { start: addYears(today, -1), end: today };
    case "ytd": return { start: today.slice(0, 4) + "-01-01", end: today };
    case "all": return { start: earliestISO || today, end: today };
    default: return { start: addMonths(today, -3), end: today };
  }
}

// Walks a sorted array of {date, amount} lines day by day across a range,
// carrying the running total forward — a step function sampled daily, so
// two different periods (e.g. this year vs last year) land on directly
// comparable, equal-length series for overlaying on one chart.
function buildDailySeries(opening, sortedLines, startISO, endISO) {
  let value = opening;
  let idx = 0;
  while (idx < sortedLines.length && sortedLines[idx].date < startISO) {
    value += sortedLines[idx].amount || 0;
    idx++;
  }
  const points = [];
  let cursor = new Date(startISO + "T00:00:00");
  const end = new Date(endISO + "T00:00:00");
  let safety = 0;
  while (cursor <= end && safety < 3660) {
    const iso = cursor.toISOString().slice(0, 10);
    while (idx < sortedLines.length && sortedLines[idx].date === iso) {
      value += sortedLines[idx].amount || 0;
      idx++;
    }
    points.push({ date: iso, value });
    cursor.setDate(cursor.getDate() + 1);
    safety++;
  }
  return points;
}

// Trims trailing zeros but keeps up to 6 decimal places, for fractional share counts.
function fmtUnits(n) {
  const v = Number.isFinite(n) ? n : 0;
  return v.toLocaleString("en-GB", { maximumFractionDigits: 6, minimumFractionDigits: 0 });
}
// The single per-line value comparable against a given currency, wherever
// it's found: a plain amount in a matching-currency account, a currency
// exchange tag, or (for stock accounts) the cash side of a trade. This is
// what lets a cash entry and a stock trade — or two differently-tagged
// entries in general — recognise each other as a possible match.
function getComparableAmount(line, acc, targetCurrency) {
  if (!acc) return undefined;
  if (acc.currency === targetCurrency) return line.amount;
  if (line.exchangeCurrency === targetCurrency) return line.exchangeAmount;
  if (acc.type === "investment" && line.cashCurrency === targetCurrency) return line.cashValue;
  return undefined;
}
function hasStorage() {
  return typeof window !== "undefined" && !!window.storage && typeof window.storage.get === "function" && typeof window.storage.set === "function";
}

// The value a line contributes to a balance check, in real cash terms.
// For an ordinary account this is just its amount in its own currency.
// For a stock account, the line's `amount` is a unit count, not cash —
// its contribution is the trade's cash side (cashValue/cashCurrency)
// instead, using the same self-referential sign convention as an
// exchange tag. A stock line with no cash info recorded (e.g. a bonus
// share issue) contributes nothing verifiable and is left out.
function lineBalanceValue(line, acc) {
  if (acc && acc.type === "investment") {
    if (line.cashValue !== undefined && line.cashCurrency) return { value: line.cashValue, currency: line.cashCurrency };
    return null;
  }
  return { value: line.amount, currency: acc ? acc.currency : "???" };
}

/* ---------------------------------------------------------
   Balance hint for a set of lines.
   Each line.amount is a delta: positive = increase that account,
   negative = decrease it. This is never forced — it's informational,
   so half-entered records (e.g. from a bank statement) can be saved
   and reconciled later.
--------------------------------------------------------- */
function balanceHint(lines, accounts) {
  const enriched = lines
    .map((l) => {
      const acc = accounts.find((a) => a.id === l.accountId);
      if (!l.accountId) return null;
      const bv = lineBalanceValue(l, acc);
      if (!bv || !Number.isFinite(bv.value) || bv.value === 0) return null;
      return { line: l, acc, ...bv };
    })
    .filter(Boolean);

  if (enriched.length === 0) return { type: "empty", message: "" };
  if (enriched.length === 1) return { type: "single", message: "Single-sided — not yet matched to another account" };

  const byCur = {};
  enriched.forEach((x) => {
    const trueSigned = x.acc && CONTRA_TYPES.has(x.acc.type) ? -x.value : x.value;
    byCur[x.currency] = (byCur[x.currency] || 0) + trueSigned;
  });
  const curs = Object.keys(byCur);

  if (curs.length === 1) {
    const diff = byCur[curs[0]];
    if (Math.abs(diff) < 0.005) return { type: "balanced", message: "Balanced" };
    return { type: "unbalanced", message: `Off by ${fmt(Math.abs(diff), curs[0])}` };
  }
  if (curs.length === 2 && enriched.length === 2) {
    const [a, b] = enriched;
    if (Math.sign(a.value) !== Math.sign(b.value)) {
      const rate = Math.abs(b.value / a.value);
      return { type: "fx", message: `Exchange — implied rate 1 ${a.currency} = ${rate.toFixed(4)} ${b.currency}` };
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

  // Each investment account holds exactly one security, so its balance —
  // computed the same way as any other account's — already *is* the unit
  // count. Only the display differs: units and a symbol, not a currency.
  function accountDisplay(a) {
    const bal = balances[a.id] || 0;
    return a.type === "investment" ? `${fmtUnits(bal)} ${a.symbol}` : fmt(bal, a.currency);
  }

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
                    <span className="ll-mono" style={{ fontSize: a.type === "investment" ? 11 : 12, color: (balances[a.id] || 0) < 0 ? C.debit : C.inkSoft }}>{accountDisplay(a)}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </aside>

        <main className="flex-1 p-6">
          {selected ? (
            selected.type === "investment" ? (
              <StockLedger
                account={selected}
                accounts={accounts}
                transactions={transactions}
                balance={balances[selected.id] || 0}
                onEditAccount={() => setAccountForm(selected)}
                onSaveTxn={saveTransaction}
                onDeleteTxn={deleteTransaction}
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
              />
            )
          ) : (
            <Overview accounts={accounts} balances={balances} onSelect={setSelectedId} onNew={() => setAccountForm({})} />
          )}
        </main>
      </div>

      {accountForm !== null && (
        <AccountFormModal initial={accountForm} onCancel={() => setAccountForm(null)} onSave={saveAccount} onDelete={accountForm.id ? () => deleteAccount(accountForm.id) : null} />
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
  accounts.filter((a) => a.type !== "investment").forEach((a) => { totalsByCurrency[a.currency] = (totalsByCurrency[a.currency] || 0) + (balances[a.id] || 0); });

  return (
    <div>
      <h2 className="ll-serif" style={{ fontSize: 20, marginBottom: 4 }}>Chart of accounts</h2>
      <p style={{ fontSize: 13, color: C.inkFaint, marginBottom: 20 }}>
        Combined balance by currency: {Object.entries(totalsByCurrency).map(([c, v]) => fmt(v, c)).join("  ·  ")}
      </p>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
        {accounts.map((a) => (
          <button key={a.id} onClick={() => onSelect(a.id)} className="text-left p-4 rounded" style={{ background: C.card, border: `1px solid ${C.line}` }}>
            <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>{TYPES.find((t) => t.key === a.type)?.label}{a.type === "investment" ? ` · ${a.symbol}` : ""}</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginTop: 4 }}>{a.name}</div>
            {a.type === "investment" ? (
              <div className="ll-mono" style={{ fontSize: 16, marginTop: 8, color: C.ink }}>{fmtUnits(balances[a.id] || 0)} <span style={{ fontSize: 13, color: C.inkFaint }}>units</span></div>
            ) : (
              <div className="ll-mono" style={{ fontSize: 18, marginTop: 8, color: (balances[a.id] || 0) < 0 ? C.debit : C.ink }}>{fmt(balances[a.id] || 0, a.currency)}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------
   Shared row-reorder animation, used by both the cash ledger and
   the stock ledger. Handles the FLIP slide for ordinary rows and the
   scroll-synced "ledger slides underneath" treatment for whichever
   row is being edited (or just finished being edited/cancelled).
--------------------------------------------------------- */
function useLedgerRowAnimation(rows, editingKey) {
  const rowRefs = useRef({});
  const prevTop = useRef({});
  const scrollAnimRef = useRef(null);
  const pendingSettleId = useRef(null);

  function absTop(el) {
    return el.getBoundingClientRect().top + window.scrollY;
  }

  function settleRowWithScroll(el, startTransform, duration = 320) {
    if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);

    el.style.transition = "none";
    el.style.transform = `translateY(${startTransform}px)`;
    void el.offsetHeight;
    el.style.transition = "transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)";
    el.style.transform = "translateY(0px)";

    const start = performance.now();
    let lastTop = absTop(el);

    function frame(now) {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const curTop = absTop(el);
      const drift = curTop - lastTop;
      if (Math.abs(drift) > 0.01) {
        window.scrollTo(0, Math.max(0, Math.min(maxScroll, window.scrollY + drift)));
      }
      lastTop = absTop(el);

      if (now - start < duration + 60) {
        scrollAnimRef.current = requestAnimationFrame(frame);
      } else {
        scrollAnimRef.current = null;
      }
    }
    scrollAnimRef.current = requestAnimationFrame(frame);
  }

  useLayoutEffect(() => {
    const newTops = {};
    rows.forEach((r) => {
      const el = rowRefs.current[r.txn.id];
      if (el) newTops[r.txn.id] = absTop(el);
    });
    rows.forEach((r) => {
      const el = rowRefs.current[r.txn.id];
      const prev = prevTop.current[r.txn.id];
      const next = newTops[r.txn.id];
      if (!el || prev === undefined || next === undefined || prev === next) return;

      if (r.txn.id === editingKey || r.txn.id === pendingSettleId.current) {
        settleRowWithScroll(el, prev - next);
      } else {
        const delta = prev - next;
        el.style.transition = "none";
        el.style.transform = `translateY(${delta}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1)";
          el.style.transform = "translateY(0px)";
        });
      }
    });
    prevTop.current = newTops;
    pendingSettleId.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => r.txn.id + "|" + r.line.date).join(",")]);

  useEffect(() => {
    return () => {
      if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current);
    };
  }, []);

  return { rowRefs, pendingSettleId };
}

/* ---------------------------------------------------------
   Charts — balance/units over a user-selectable interval, with an
   optional overlay of the same interval one year earlier.
--------------------------------------------------------- */
function IntervalControls({ interval, setInterval: setIntervalValue, compareYoY, setCompareYoY, disableCompare }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex rounded overflow-hidden" style={{ border: `1px solid ${C.line}` }}>
        {CHART_INTERVALS.map((o) => (
          <button
            key={o.key} type="button" onClick={() => setIntervalValue(o.key)}
            style={{ padding: "6px 10px", fontSize: 12, background: interval === o.key ? C.paperDim : "transparent", color: interval === o.key ? C.ink : C.inkFaint, fontWeight: interval === o.key ? 600 : 400 }}
          >
            {o.label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1.5" style={{ fontSize: 12.5, color: C.inkSoft, opacity: disableCompare ? 0.4 : 1 }}>
        <input type="checkbox" checked={compareYoY && !disableCompare} disabled={disableCompare} onChange={(e) => setCompareYoY(e.target.checked)} />
        Compare to last year
      </label>
    </div>
  );
}

function ChartTooltip({ active, payload, formatValue, compareYoY }) {
  if (!active || !payload || !payload.length) return null;
  const cur = payload.find((p) => p.dataKey === "current");
  const prev = payload.find((p) => p.dataKey === "previous");
  if (!cur) return null;
  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 6, padding: "8px 10px", fontSize: 12.5 }}>
      <div><strong>{fmtDateShort(cur.payload.date)}</strong>: <span className="ll-mono">{formatValue(cur.value)}</span></div>
      {compareYoY && prev && prev.value !== undefined && (
        <div style={{ color: C.inkFaint, marginTop: 2 }}>{fmtDateShort(cur.payload.previousDate)}: <span className="ll-mono">{formatValue(prev.value)}</span></div>
      )}
    </div>
  );
}

function useChartSeries(opening, lines, interval, compareYoY) {
  const earliest = lines.length ? lines[0].date : todayISO();
  const { start, end } = intervalRange(interval, earliest);
  const currentSeries = useMemo(() => buildDailySeries(opening, lines, start, end), [opening, lines, start, end]);
  const prevRange = compareYoY && interval !== "all" ? { start: addYears(start, -1), end: addYears(end, -1) } : null;
  const previousSeries = useMemo(() => (prevRange ? buildDailySeries(opening, lines, prevRange.start, prevRange.end) : null), [opening, lines, prevRange]);
  return useMemo(
    () =>
      currentSeries.map((p, i) => ({
        offset: i,
        date: p.date,
        current: p.value,
        previous: previousSeries && previousSeries[i] ? previousSeries[i].value : undefined,
        previousDate: previousSeries && previousSeries[i] ? previousSeries[i].date : undefined,
      })),
    [currentSeries, previousSeries]
  );
}

function BalanceChart({ account, transactions }) {
  const [interval, setInterval_] = useState("3m");
  const [compareYoY, setCompareYoY] = useState(false);

  const lines = useMemo(
    () => transactions.map((t) => t.lines.find((l) => l.accountId === account.id)).filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    [transactions, account]
  );
  const merged = useChartSeries(account.openingBalance || 0, lines, interval, compareYoY);

  if (lines.length === 0) {
    return <div style={{ padding: "40px 0", textAlign: "center", color: C.inkFaint, fontSize: 13 }}>Not enough entries yet to chart.</div>;
  }

  return (
    <div>
      <div className="mb-4"><IntervalControls interval={interval} setInterval={setInterval_} compareYoY={compareYoY} setCompareYoY={setCompareYoY} disableCompare={interval === "all"} /></div>
      <div style={{ height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={merged} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={C.lineSoft} vertical={false} />
            <XAxis dataKey="offset" tickFormatter={(o) => (merged[o] ? fmtDateShort(merged[o].date) : "")} tick={{ fontSize: 11, fill: C.inkFaint }} axisLine={{ stroke: C.line }} tickLine={false} minTickGap={40} />
            <YAxis tickFormatter={(v) => fmt(v, account.currency)} tick={{ fontSize: 11, fill: C.inkFaint }} axisLine={false} tickLine={false} width={80} />
            <Tooltip content={<ChartTooltip formatValue={(v) => fmt(v, account.currency)} compareYoY={compareYoY} />} />
            {compareYoY && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {compareYoY && <Line type="stepAfter" dataKey="previous" name="Same period last year" stroke={C.goldDim} strokeWidth={1.5} dot={false} isAnimationActive={false} />}
            <Line type="stepAfter" dataKey="current" name="Balance" stroke={C.gold} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function UnitsChart({ account, transactions }) {
  const [interval, setInterval_] = useState("3m");
  const [compareYoY, setCompareYoY] = useState(false);

  const lines = useMemo(
    () => transactions.map((t) => t.lines.find((l) => l.accountId === account.id)).filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    [transactions, account]
  );
  const merged = useChartSeries(account.openingBalance || 0, lines, interval, compareYoY);

  if (lines.length === 0) {
    return <div style={{ padding: "40px 0", textAlign: "center", color: C.inkFaint, fontSize: 13 }}>Not enough trades yet to chart.</div>;
  }

  return (
    <div>
      <div className="mb-4"><IntervalControls interval={interval} setInterval={setInterval_} compareYoY={compareYoY} setCompareYoY={setCompareYoY} disableCompare={interval === "all"} /></div>
      <div style={{ height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={merged} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={C.lineSoft} vertical={false} />
            <XAxis dataKey="offset" tickFormatter={(o) => (merged[o] ? fmtDateShort(merged[o].date) : "")} tick={{ fontSize: 11, fill: C.inkFaint }} axisLine={{ stroke: C.line }} tickLine={false} minTickGap={40} />
            <YAxis tickFormatter={(v) => fmtUnits(v)} tick={{ fontSize: 11, fill: C.inkFaint }} axisLine={false} tickLine={false} width={60} />
            <Tooltip content={<ChartTooltip formatValue={(v) => `${fmtUnits(v)} ${account.symbol}`} compareYoY={compareYoY} />} />
            {compareYoY && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {compareYoY && <Line type="stepAfter" dataKey="previous" name="Same period last year" stroke={C.goldDim} strokeWidth={1.5} dot={false} isAnimationActive={false} />}
            <Line type="stepAfter" dataKey="current" name={`${account.symbol} units`} stroke={C.gold} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------
   Account Ledger — inline add/edit, live FLIP reorder + autoscroll
--------------------------------------------------------- */
function blankOtherLine(accountId) {
  return {
    key: uid(),
    accountId: accountId || "",
    matchedTxnId: null,
    snapshot: null,
    // cash-account fields
    isOut: true,
    amountStr: "",
    // investment-account fields — symbol and currency come from the
    // account itself (one security per account), so only direction and
    // magnitude are ever entered here.
    unitsIsOut: false,
    unitsStr: "",
    cashIsOut: true,
    cashStr: "",
  };
}

function blankDraft(presetOtherId) {
  return {
    mode: "new",
    txnId: null,
    date: todayISO(),
    description: "",
    otherLines: presetOtherId ? [blankOtherLine(presetOtherId)] : [],
    splitOffLines: [],
    inAmountStr: "",
    outAmountStr: "",
    exchangeAmountStr: "",
    exchangeCurrency: "",
  };
}

function AccountLedger({ account, accounts, transactions, balance, onEditAccount, onSaveTxn, onDeleteTxn }) {
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState("");
  const [view, setView] = useState("ledger");

  // If both In and Out are filled, the saved line is their difference —
  // e.g. In 50 / Out 20 saves as an increase of 30.
  function draftDelta(d) {
    const inN = parseFloat(d.inAmountStr);
    const outN = parseFloat(d.outAmountStr);
    return (isNaN(inN) ? 0 : inN) - (isNaN(outN) ? 0 : outN);
  }

  // Resolves one "other account" row to the line that should actually be
  // saved. A matched candidate is reused exactly (amount, date, tags) —
  // an unchanged pre-existing line keeps its own date even if the amount
  // was corrected — anything else is a fresh leg dated like this entry.
  // Investment accounts resolve to a symbol/units/cashValue line, exactly
  // like an entry made directly in that stock account.
  function resolveOtherLine(d, ol) {
    if (ol.matchedTxnId) {
      const matchedTxn = transactions.find((t) => t.id === ol.matchedTxnId);
      const matchedLine = matchedTxn && matchedTxn.lines.find((l) => l.accountId === ol.accountId);
      if (matchedLine) return { ...matchedLine };
    }
    const olAcc = accounts.find((a) => a.id === ol.accountId);
    const unchanged = ol.snapshot && ol.snapshot.accountId === ol.accountId;

    if (olAcc && olAcc.type === "investment") {
      const unitsMag = Math.abs(parseFloat(ol.unitsStr));
      const units = isNaN(unitsMag) ? 0 : ol.unitsIsOut ? -unitsMag : unitsMag;
      const base = unchanged ? { ...ol.snapshot } : { accountId: ol.accountId, date: d.date || todayISO() };
      base.amount = units;
      const cashMag = Math.abs(parseFloat(ol.cashStr));
      if (ol.cashStr !== "" && !isNaN(cashMag)) {
        const cashNatural = ol.cashIsOut ? -cashMag : cashMag;
        base.cashValue = -cashNatural;
        base.cashCurrency = olAcc.currency;
      } else {
        delete base.cashValue;
        delete base.cashCurrency;
      }
      return base;
    }

    const mag = Math.abs(parseFloat(ol.amountStr));
    const amt = isNaN(mag) ? 0 : ol.isOut ? -mag : mag;
    if (unchanged) {
      return { ...ol.snapshot, amount: amt };
    }
    return { accountId: ol.accountId, amount: amt, date: d.date || todayISO() };
  }

  function draftToTxn(d, forcedId) {
    const delta = draftDelta(d);
    const line1 = { accountId: account.id, amount: delta, date: d.date || todayISO() };

    // The exchange tag is kept regardless of whether this leg is linked —
    // it's useful as a record of the rate at entry time even once a real
    // counterpart line exists, not just while still searching for one.
    if (d.exchangeCurrency && d.exchangeAmountStr !== "") {
      const exVal = parseFloat(d.exchangeAmountStr);
      if (!isNaN(exVal)) {
        line1.exchangeAmount = delta < 0 ? -Math.abs(exVal) : Math.abs(exVal);
        line1.exchangeCurrency = d.exchangeCurrency;
      }
    }

    const activeOtherLines = d.otherLines.filter((ol) => {
      if (!ol.accountId) return false;
      if (ol.matchedTxnId) return true;
      const olAcc = accounts.find((a) => a.id === ol.accountId);
      return olAcc && olAcc.type === "investment" ? ol.unitsStr !== "" : ol.amountStr !== "";
    });
    if (activeOtherLines.length === 0) {
      return { id: forcedId || d.txnId, description: d.description, lines: [line1] };
    }

    const lines = [line1, ...activeOtherLines.map((ol) => resolveOtherLine(d, ol))];
    return { id: forcedId || d.txnId, description: d.description, lines };
  }

  const editingKey = draft ? (draft.mode === "edit" ? draft.txnId : "DRAFT_NEW") : null;

  // Live balance status for the entry being edited — built from the exact
  // lines that would be saved (matched/preserved amounts included), so
  // the imbalance shown here always matches what a saved row would show.
  const draftHint = useMemo(() => {
    if (!draft || draftDelta(draft) === 0) return null;
    return balanceHint(draftToTxn(draft).lines, accounts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, accounts, transactions]);

  // Match candidates for the row currently being edited — only offered
  // before any other account has been added, since matching decides what
  // that first link should be. Search parameters depend on whether an
  // exchange tag is set:
  //   - no exchange tag: look for the opposite amount in another account
  //     that shares this account's currency
  //   - exchange tag set: look for the opposite of the *exchange* amount,
  //     in an account of the *exchange* currency
  // Either way: never the same account, and within 3 days either side.
  // Candidates are found via getComparableAmount, so this also picks up
  // the cash side of stock trades automatically.
  const matchCandidates = useMemo(() => {
    if (!draft || draft.otherLines.length > 0) return [];
    const delta = draftDelta(draft);
    if (delta === 0 || !draft.date) return [];

    let targetAmount = -delta;
    let targetCurrency = account.currency;
    if (draft.exchangeCurrency && draft.exchangeAmountStr !== "") {
      const exVal = parseFloat(draft.exchangeAmountStr);
      if (!isNaN(exVal)) {
        const exSigned = delta < 0 ? -Math.abs(exVal) : Math.abs(exVal);
        targetAmount = -exSigned;
        targetCurrency = draft.exchangeCurrency;
      }
    }

    return transactions
      .filter((t) => t.id !== draft.txnId && t.lines.length === 1)
      .map((t) => ({ txn: t, line: t.lines[0], acc: accounts.find((a) => a.id === t.lines[0].accountId) }))
      .filter((c) => c.acc && c.acc.id !== account.id)
      .map((c) => ({ ...c, comparable: getComparableAmount(c.line, c.acc, targetCurrency) }))
      .filter((c) => c.comparable !== undefined && Math.abs(c.comparable - targetAmount) < 0.005)
      .filter((c) => Math.abs(daysDiff(draft.date, c.line.date)) <= 3)
      .sort((a, b) => Math.abs(daysDiff(draft.date, a.line.date)) - Math.abs(daysDiff(draft.date, b.line.date)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, transactions, accounts, account]);

  const effectiveTxns = useMemo(() => {
    let list = transactions;
    if (draft && draft.mode === "edit") list = list.map((t) => (t.id === draft.txnId ? draftToTxn(draft) : t));
    if (draft && draft.mode === "new") list = [...list, draftToTxn(draft, "DRAFT_NEW")];
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, draft, account, accounts]);

  // Each row is sorted and balanced by *its own account's line's own
  // date* — different legs of a linked entry can carry different dates,
  // so the transaction itself no longer has one date to sort by.
  const rows = useMemo(() => {
    const relevant = effectiveTxns
      .filter((t) => t.lines.some((l) => l.accountId === account.id))
      .map((t) => ({ txn: t, line: t.lines.find((l) => l.accountId === account.id) }));
    const sorted = relevant.sort((a, b) => (a.line.date < b.line.date ? -1 : a.line.date > b.line.date ? 1 : String(a.txn.id).localeCompare(String(b.txn.id))));
    let running = account.openingBalance || 0;
    return sorted.map(({ txn: t, line }) => {
      running += line.amount || 0;
      const others = t.lines.filter((l) => l.accountId !== account.id).map((l) => accounts.find((a) => a.id === l.accountId)).filter(Boolean);
      return { txn: t, line, running, others };
    });
  }, [effectiveTxns, account, accounts]);

  const { rowRefs, pendingSettleId } = useLedgerRowAnimation(rows, editingKey);

  // Converts a resolved line (from a matched candidate, or a pre-existing
  // line on the entry being opened) into the editable "other account" row
  // shape — branching on account type since a stock line needs units/cash
  // fields instead of a plain amount (symbol and currency are implied by
  // the account itself).
  function otherLineFromLine(o, snapshot) {
    const oAcc = accounts.find((a) => a.id === o.accountId);
    const base = blankOtherLine(o.accountId);
    base.snapshot = snapshot || null;
    if (oAcc && oAcc.type === "investment") {
      const naturalCash = o.cashValue !== undefined ? -o.cashValue : 0;
      base.unitsIsOut = o.amount < 0;
      base.unitsStr = String(Math.abs(o.amount));
      base.cashIsOut = naturalCash < 0;
      base.cashStr = naturalCash !== 0 ? String(Math.abs(naturalCash)) : "";
    } else {
      base.isOut = o.amount < 0;
      base.amountStr = String(Math.abs(o.amount));
    }
    return base;
  }

  function startEdit(t) {
    const line = t.lines.find((l) => l.accountId === account.id);
    const others = t.lines.filter((l) => l.accountId !== account.id);
    setDraft({
      mode: "edit",
      txnId: t.id,
      originalTxn: t,
      date: line.date,
      description: t.description || "",
      inAmountStr: line.amount > 0 ? String(line.amount) : "",
      outAmountStr: line.amount < 0 ? String(-line.amount) : "",
      exchangeAmountStr: line.exchangeAmount !== undefined ? String(Math.abs(line.exchangeAmount)) : "",
      exchangeCurrency: line.exchangeCurrency ? line.exchangeCurrency : "",
      otherLines: others.map((o) => otherLineFromLine(o, o)),
      splitOffLines: [],
    });
    setDraftError("");
  }

  function selectMatch(candidate) {
    setDraft((d) => {
      if (!d) return d;
      const ol = otherLineFromLine(candidate.line, null);
      ol.matchedTxnId = candidate.txn.id;
      return { ...d, otherLines: [...d.otherLines, ol] };
    });
  }

  function addOtherLine() {
    setDraft((d) => {
      if (!d) return d;
      const delta = draftDelta(d);
      const isFirst = d.otherLines.length === 0;
      const ol = blankOtherLine("");
      if (isFirst && delta !== 0) { ol.isOut = delta > 0; ol.amountStr = String(Math.abs(delta)); }
      return { ...d, otherLines: [...d.otherLines, ol] };
    });
  }

  // Removing (or re-pointing) an other-account row never deletes a
  // pre-existing line's data — if it had one (a snapshot from when this
  // entry was opened), it's queued to be split off into its own
  // standalone record on save, same as the explicit Unlink action.
  function removeOtherLine(key) {
    setDraft((d) => {
      if (!d) return d;
      const ol = d.otherLines.find((x) => x.key === key);
      const rest = d.otherLines.filter((x) => x.key !== key);
      if (ol && ol.snapshot && ol.snapshot.accountId === ol.accountId && !ol.matchedTxnId) {
        return { ...d, otherLines: rest, splitOffLines: [...d.splitOffLines, ol.snapshot] };
      }
      return { ...d, otherLines: rest };
    });
  }

  function updateOtherLine(key, patch) {
    setDraft((d) => {
      if (!d) return d;
      let splitOffLines = d.splitOffLines;
      const otherLines = d.otherLines.map((ol) => {
        if (ol.key !== key) return ol;
        let next = { ...ol, ...patch, matchedTxnId: null };
        if ("accountId" in patch) {
          const stillSame = ol.snapshot && ol.snapshot.accountId === patch.accountId;
          if (ol.snapshot && !stillSame) {
            splitOffLines = [...splitOffLines, ol.snapshot];
            next.snapshot = null;
          }
          const newAcc = accounts.find((a) => a.id === patch.accountId);
          if (newAcc && newAcc.type === "investment" && !stillSame) {
            next = { ...next, unitsIsOut: false, unitsStr: "", cashIsOut: true, cashStr: "" };
          }
        }
        return next;
      });
      return { ...d, otherLines, splitOffLines };
    });
  }

  // Splits an already-linked entry back into separate, unlinked records —
  // the exact reverse of a match. No side's data (including its own date)
  // is touched; each just goes back to standing alone.
  function unlinkNow() {
    if (!draft || !draft.originalTxn || draft.originalTxn.lines.length < 2) return;
    const t = draft.originalTxn;
    const mine = t.lines.find((l) => l.accountId === account.id);
    const rest = t.lines.filter((l) => l.accountId !== account.id);
    onSaveTxn(
      { id: t.id, description: t.description, lines: [mine] },
      undefined,
      rest.map((l) => ({ description: t.description, lines: [l] }))
    );
    setDraft(null);
    setDraftError("");
  }

  function commit() {
    if (!draft) return;
    const delta = draftDelta(draft);
    if (delta === 0) { setDraftError("Enter an amount in In or Out."); return; }
    const data = draftToTxn(draft, draft.mode === "edit" ? draft.txnId : undefined);
    const matchedId = draft.otherLines.find((ol) => ol.matchedTxnId)?.matchedTxnId;
    const splitOffExtras = draft.splitOffLines.length
      ? draft.splitOffLines.map((sn) => ({ description: draft.originalTxn ? draft.originalTxn.description : draft.description, lines: [sn] }))
      : undefined;
    onSaveTxn(
      { id: draft.mode === "edit" ? draft.txnId : undefined, description: data.description.trim(), lines: data.lines },
      matchedId,
      splitOffExtras
    );
    setDraft(null);
    setDraftError("");
  }

  function cancel() {
    // The row is about to snap back to its original date/position — keep
    // following it with the same scroll-sync treatment it had while being
    // edited, even though `draft` (and so `editingKey`) is about to clear.
    if (draft && draft.mode === "edit") pendingSettleId.current = draft.txnId;
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
          <div className="flex rounded overflow-hidden" style={{ border: `1px solid ${C.line}` }}>
            <button onClick={() => setView("ledger")} title="Ledger" className="flex items-center gap-1.5 px-3" style={{ background: view === "ledger" ? C.paperDim : "transparent", color: view === "ledger" ? C.ink : C.inkFaint, fontSize: 13 }}>
              <TableProperties size={14} /> Ledger
            </button>
            <button onClick={() => setView("chart")} title="Chart" className="flex items-center gap-1.5 px-3" style={{ background: view === "chart" ? C.paperDim : "transparent", color: view === "chart" ? C.ink : C.inkFaint, fontSize: 13 }}>
              <TrendingUp size={14} /> Chart
            </button>
          </div>
          <button onClick={onEditAccount} className="px-3 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13 }}>Edit account</button>
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

      {view === "chart" ? (
        <BalanceChart account={account} transactions={transactions} />
      ) : (
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden", background: C.card }}>
        <div className="grid" style={{ gridTemplateColumns: "120px 1fr 170px 100px 100px 120px 60px", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.6, color: C.inkFaint, padding: "10px 16px", borderBottom: `1px solid ${C.line}` }}>
          <div>Date</div><div>Description</div><div>Transfer</div><div className="text-right">Out</div><div className="text-right">In</div><div className="text-right">Balance</div><div />
        </div>

        {rows.length === 0 && !draft && <div style={{ padding: "24px 16px", fontSize: 13, color: C.inkFaint }}>No entries yet in this account.</div>}

        {rows.map((r) => {
          const isEditing = r.txn.id === editingKey;
          const out = r.line.amount < 0 ? -r.line.amount : 0;
          const inn = r.line.amount > 0 ? r.line.amount : 0;
          const hint = balanceHint(r.txn.lines, accounts);
          const unbalanced = hint.type === "unbalanced";

          if (isEditing) {
            return (
              <div key={r.txn.id} ref={(el) => (rowRefs.current[r.txn.id] = el)} style={{ borderBottom: `1px solid ${C.lineSoft}`, background: C.paperDim, padding: "10px 16px" }}>
                <div className="grid items-center" style={{ gridTemplateColumns: "120px 1fr 170px 100px 100px 120px 60px", gap: 8 }}>
                  <input type="date" autoFocus value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} style={miniInput} />
                  <input type="text" placeholder="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={miniInput} />
                  <div style={{ fontSize: 12, color: C.inkFaint, fontStyle: draft.otherLines.length === 0 ? "italic" : "normal" }}>
                    {draft.otherLines.length === 0 ? "unmatched" : draft.otherLines.length === 1 ? "linked below" : `${draft.otherLines.length}-way split below`}
                  </div>
                  <input
                    type="number" step="0.0001" placeholder="Out" value={draft.outAmountStr}
                    onChange={(e) => setDraft({ ...draft, outAmountStr: e.target.value })}
                    className="ll-mono text-right" style={{ ...miniInput, color: C.debit }}
                    onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") cancel(); }}
                  />
                  <input
                    type="number" step="0.0001" placeholder="In" value={draft.inAmountStr}
                    onChange={(e) => setDraft({ ...draft, inAmountStr: e.target.value })}
                    className="ll-mono text-right" style={{ ...miniInput, color: C.credit }}
                    onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") cancel(); }}
                  />
                  <div className="ll-mono text-right" style={{ fontWeight: 600, fontSize: 13.5, color: r.running < 0 ? C.debit : C.ink }}>{fmt(r.running, account.currency)}</div>
                  <div className="flex gap-1 justify-end">
                    <button onClick={commit} title="Save" style={iconBtn(C.credit)}><Check size={15} /></button>
                    <button onClick={cancel} title="Cancel" style={iconBtn(C.inkFaint)}><X size={15} /></button>
                  </div>
                </div>

                {draft.otherLines.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1.5" style={{ paddingLeft: 128 }}>
                    {draft.otherLines.map((ol) => {
                      const olAcc = accounts.find((a) => a.id === ol.accountId);
                      const isStock = olAcc && olAcc.type === "investment";
                      return (
                        <div key={ol.key} className="flex items-center gap-2 flex-wrap">
                          <select value={ol.accountId} onChange={(e) => updateOtherLine(ol.key, { accountId: e.target.value })} style={{ ...miniInput, width: 190 }}>
                            <option value="">Select account…</option>
                            {accounts.filter((a) => a.id !== account.id).map((a) => (
                              <option key={a.id} value={a.id}>{a.name} ({a.type === "investment" ? a.symbol : a.currency})</option>
                            ))}
                          </select>

                          {isStock ? (
                            <>
                              <div className="flex rounded overflow-hidden shrink-0" style={{ border: `1px solid ${C.line}` }}>
                                {[{ v: false, label: "Units in" }, { v: true, label: "Units out" }].map((o) => (
                                  <button key={o.label} type="button" onClick={() => updateOtherLine(ol.key, { unitsIsOut: o.v })}
                                    style={{ padding: "6px 8px", fontSize: 11.5, background: ol.unitsIsOut === o.v ? (o.v ? C.debitBg : C.creditBg) : "transparent", color: ol.unitsIsOut === o.v ? (o.v ? C.debit : C.credit) : C.inkFaint, fontWeight: ol.unitsIsOut === o.v ? 600 : 400 }}>
                                    {o.label}
                                  </button>
                                ))}
                              </div>
                              <input
                                type="number" step="0.000001" placeholder="Units" value={ol.unitsStr}
                                onChange={(e) => updateOtherLine(ol.key, { unitsStr: e.target.value })}
                                className="ll-mono" style={{ ...miniInput, width: 80 }}
                              />
                              <div className="flex rounded overflow-hidden shrink-0" style={{ border: `1px solid ${C.line}` }}>
                                {[{ v: false, label: "Cost in" }, { v: true, label: "Cost out" }].map((o) => (
                                  <button key={o.label} type="button" onClick={() => updateOtherLine(ol.key, { cashIsOut: o.v })}
                                    style={{ padding: "6px 8px", fontSize: 11.5, background: ol.cashIsOut === o.v ? (o.v ? C.debitBg : C.creditBg) : "transparent", color: ol.cashIsOut === o.v ? (o.v ? C.debit : C.credit) : C.inkFaint, fontWeight: ol.cashIsOut === o.v ? 600 : 400 }}>
                                    {o.label}
                                  </button>
                                ))}
                              </div>
                              <input
                                type="number" step="0.01" placeholder="Cost" value={ol.cashStr}
                                onChange={(e) => updateOtherLine(ol.key, { cashStr: e.target.value })}
                                className="ll-mono" style={{ ...miniInput, width: 90 }}
                              />
                              <span className="ll-mono" style={{ fontSize: 12.5, color: C.inkFaint, padding: "0 4px" }}>{olAcc.currency}</span>
                            </>
                          ) : (
                            <>
                              <div className="flex rounded overflow-hidden shrink-0" style={{ border: `1px solid ${C.line}` }}>
                                {[{ v: false, label: "In" }, { v: true, label: "Out" }].map((o) => (
                                  <button key={o.label} type="button" onClick={() => updateOtherLine(ol.key, { isOut: o.v })}
                                    style={{ padding: "6px 9px", fontSize: 12, background: ol.isOut === o.v ? (o.v ? C.debitBg : C.creditBg) : "transparent", color: ol.isOut === o.v ? (o.v ? C.debit : C.credit) : C.inkFaint, fontWeight: ol.isOut === o.v ? 600 : 400 }}>
                                    {o.label}
                                  </button>
                                ))}
                              </div>
                              <input
                                type="number" step="0.0001" placeholder={olAcc ? olAcc.currency : "0.00"} value={ol.amountStr}
                                onChange={(e) => updateOtherLine(ol.key, { amountStr: e.target.value })}
                                className="ll-mono" style={{ ...miniInput, width: 100 }}
                              />
                            </>
                          )}

                          {ol.matchedTxnId && <span title="Matched — will merge into one entry on save"><Check size={14} color={C.credit} /></span>}
                          <button type="button" onClick={() => removeOtherLine(ol.key)} title="Remove this link"><X size={15} color={C.inkFaint} /></button>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="flex items-center gap-3 mt-2 flex-wrap" style={{ paddingLeft: 128 }}>
                  <button type="button" onClick={addOtherLine} className="flex items-center gap-1" style={{ fontSize: 12, color: C.gold }}>
                    <Plus size={12} /> {draft.otherLines.length === 0 ? "Link another account" : "Add split line"}
                  </button>
                </div>

                <div className="flex items-center gap-2 mt-2" style={{ paddingLeft: 128 }}>
                  <span style={{ fontSize: 12, color: C.inkFaint }}>Also known as</span>
                  <input
                    type="number" step="0.0001" placeholder="Amount"
                    value={draft.exchangeAmountStr}
                    onChange={(e) => setDraft({ ...draft, exchangeAmountStr: e.target.value })}
                    className="ll-mono" style={{ ...miniInput, width: 100 }}
                  />
                  <select
                    value={draft.exchangeCurrency}
                    onChange={(e) => setDraft({ ...draft, exchangeCurrency: e.target.value })}
                    style={{ ...miniInput, width: 90 }}
                  >
                    <option value="">currency…</option>
                    {CURRENCIES.filter((c) => c !== account.currency).map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <span style={{ fontSize: 11, color: C.inkFaint }}>
                    {draft.otherLines.length === 0 ? "for matching in another currency" : "kept for reference"}
                  </span>
                </div>

                {draft.otherLines.length === 0 && matchCandidates.length > 0 && (
                  <div className="mt-2" style={{ paddingLeft: 128 }}>
                    <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Possible matches</div>
                    <div className="flex flex-col gap-1">
                      {matchCandidates.map((c) => (
                        <button
                          key={c.txn.id}
                          type="button"
                          onClick={() => selectMatch(c)}
                          className="flex items-center justify-between px-2 py-1.5 rounded text-left"
                          style={{ border: `1px solid ${C.line}`, background: C.card }}
                        >
                          <span style={{ fontSize: 12.5 }}>
                            <strong>{c.acc.name}</strong> · {fmtDate(c.line.date)}{c.txn.description ? ` · ${c.txn.description}` : ""}
                          </span>
                          <span className="ll-mono" style={{ fontSize: 12.5, color: c.line.amount < 0 ? C.debit : C.credit }}>{fmt(c.line.amount, c.acc.currency)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {draft.splitOffLines.length > 0 && (
                  <div className="mt-2" style={{ paddingLeft: 128, fontSize: 11.5, color: C.inkFaint }}>
                    {draft.splitOffLines.length} removed line{draft.splitOffLines.length > 1 ? "s" : ""} will be saved as separate, unlinked entries — not deleted.
                  </div>
                )}

                <div className="flex items-center justify-between mt-2">
                  <span style={{ fontSize: 12, color: draftError ? C.debit : draftHint && draftHint.type === "unbalanced" ? C.debit : draftHint && (draftHint.type === "balanced" || draftHint.type === "fx") ? C.credit : C.inkFaint }}>
                    {draftError || (draftHint ? draftHint.message : "Enter an amount to see balance status") + (draft.inAmountStr && draft.outAmountStr ? " · saving the difference" : "")}
                  </span>
                  {draft.mode === "edit" && (
                    <div className="flex items-center gap-3">
                      {draft.originalTxn && draft.originalTxn.lines.length >= 2 && (
                        <button onClick={unlinkNow} title="Split back into separate, unlinked entries" className="flex items-center gap-1" style={{ fontSize: 12, color: C.gold }}><Unlink2 size={12} /> Unlink all</button>
                      )}
                      <button onClick={() => { onDeleteTxn(draft.txnId); setDraft(null); setDraftError(""); }} className="flex items-center gap-1" style={{ fontSize: 12, color: C.debit }}><Trash2 size={12} /> Delete</button>
                    </div>
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
              <div style={{ color: C.inkSoft, fontSize: 12.5 }}>{fmtDate(r.line.date)}</div>
              <div className="flex items-center gap-2">
                <span style={{ color: unbalanced ? C.debit : C.ink }}>{r.txn.description || <span style={{ color: C.inkFaint }}>—</span>}</span>
                {hint.type !== "balanced" && hint.type !== "empty" && (
                  <span title={hint.message}><AlertTriangle size={12} color={unbalanced ? C.debit : C.gold} /></span>
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
      )}
    </div>
  );
}

/* ---------------------------------------------------------
   Stock Ledger — one account, one security. Trades are units against a
   cash value; no price-per-unit field exists anywhere — it's always
   cashValue divided by units, computed on the fly, exactly like the FX
   rate in the cash ledger's currency exchange tag. Since the account has
   exactly one symbol and one trading currency (set at account creation),
   trades don't need to ask for either.
--------------------------------------------------------- */
function blankStockDraft(account) {
  return {
    mode: "new",
    txnId: null,
    date: todayISO(),
    description: "",
    otherAccountId: "",
    otherLineSnapshot: null,
    splitOffLines: [],
    matchedTxnId: null,
    unitsInStr: "",
    unitsOutStr: "",
    cashInStr: "",
    cashOutStr: "",
  };
}

function StockLedger({ account, accounts, transactions, balance, onEditAccount, onSaveTxn, onDeleteTxn }) {
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState("");
  const [view, setView] = useState("ledger");

  function unitsDeltaOf(d) {
    const i = parseFloat(d.unitsInStr);
    const o = parseFloat(d.unitsOutStr);
    return (isNaN(i) ? 0 : i) - (isNaN(o) ? 0 : o);
  }
  function cashDeltaOf(d) {
    const i = parseFloat(d.cashInStr);
    const o = parseFloat(d.cashOutStr);
    return (isNaN(i) ? 0 : i) - (isNaN(o) ? 0 : o);
  }

  // Clears anything tied to a previously-selected match — used whenever a
  // change to the draft (amount, account) would make that match stale.
  function clearMatch(d) {
    return { ...d, matchedTxnId: null, otherAccountId: "" };
  }

  // cashValue is stored as the *mirror* of the cash movement — same
  // sign convention as the currency-exchange tag — so that, uniformly
  // across the app, a match target is always "the negative of my own
  // tag". See getComparableAmount.
  function draftToTxn(d, forcedId) {
    const unitsDelta = unitsDeltaOf(d);
    const cashNatural = cashDeltaOf(d);
    const line1 = { accountId: account.id, amount: unitsDelta, date: d.date || todayISO() };
    if (d.cashInStr !== "" || d.cashOutStr !== "") {
      line1.cashValue = -cashNatural;
      line1.cashCurrency = account.currency;
    }
    const lines = [line1];
    if (d.otherAccountId) {
      let line2;
      if (d.matchedTxnId) {
        // Reuse the matched record's own line exactly — amount, its own
        // date, and any tags — rather than recomputing any of it.
        const matchedTxn = transactions.find((t) => t.id === d.matchedTxnId);
        const matchedLine = matchedTxn && matchedTxn.lines.find((l) => l.accountId === d.otherAccountId);
        line2 = matchedLine ? { ...matchedLine } : null;
      } else if (d.otherLineSnapshot && d.otherLineSnapshot.accountId === d.otherAccountId) {
        // Pairing unchanged since this trade was opened — leave the cash
        // leg, including its own date, exactly as it was.
        line2 = { ...d.otherLineSnapshot };
      } else {
        line2 = { accountId: d.otherAccountId, amount: cashNatural, date: d.date || todayISO() };
      }
      if (line2) lines.push(line2);
    }
    return { id: forcedId || d.txnId, description: d.description, lines };
  }

  const editingKey = draft ? (draft.mode === "edit" ? draft.txnId : "DRAFT_NEW") : null;

  // Search other (non-investment) accounts for the cash leg of this trade:
  // the opposite of what this line's cash tag says, in this account's
  // trading currency.
  const matchCandidates = useMemo(() => {
    if (!draft || draft.otherAccountId || draft.matchedTxnId) return [];
    if (unitsDeltaOf(draft) === 0 || !draft.date) return [];
    if (draft.cashInStr === "" && draft.cashOutStr === "") return [];
    const targetAmount = cashDeltaOf(draft); // = -cashValue, i.e. the real counterpart's own amount
    const targetCurrency = account.currency;

    return transactions
      .filter((t) => t.id !== draft.txnId && t.lines.length === 1)
      .map((t) => ({ txn: t, line: t.lines[0], acc: accounts.find((a) => a.id === t.lines[0].accountId) }))
      .filter((c) => c.acc && c.acc.id !== account.id)
      .map((c) => ({ ...c, comparable: getComparableAmount(c.line, c.acc, targetCurrency) }))
      .filter((c) => c.comparable !== undefined && Math.abs(c.comparable - targetAmount) < 0.005)
      .filter((c) => Math.abs(daysDiff(draft.date, c.line.date)) <= 3)
      .sort((a, b) => Math.abs(daysDiff(draft.date, a.line.date)) - Math.abs(daysDiff(draft.date, b.line.date)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, transactions, accounts, account]);

  const effectiveTxns = useMemo(() => {
    let list = transactions;
    if (draft && draft.mode === "edit") list = list.map((t) => (t.id === draft.txnId ? draftToTxn(draft) : t));
    if (draft && draft.mode === "new") list = [...list, draftToTxn(draft, "DRAFT_NEW")];
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, draft, account, accounts]);

  // One security per account, so a single running total — sorted and
  // balanced by this account's own line's own date, since the cash leg of
  // a trade can carry a different date.
  const rows = useMemo(() => {
    const relevant = effectiveTxns
      .filter((t) => t.lines.some((l) => l.accountId === account.id))
      .map((t) => ({ txn: t, line: t.lines.find((l) => l.accountId === account.id) }));
    const sorted = relevant.sort((a, b) => (a.line.date < b.line.date ? -1 : a.line.date > b.line.date ? 1 : String(a.txn.id).localeCompare(String(b.txn.id))));
    let running = account.openingBalance || 0;
    return sorted.map(({ txn: t, line }) => {
      running += line.amount || 0;
      const others = t.lines.filter((l) => l.accountId !== account.id).map((l) => accounts.find((a) => a.id === l.accountId)).filter(Boolean);
      return { txn: t, line, running, others };
    });
  }, [effectiveTxns, account, accounts]);

  const { rowRefs, pendingSettleId } = useLedgerRowAnimation(rows, editingKey);

  // Average buy price for the current holding — total spent on buys
  // divided by units bought. Doesn't adjust for sales, so it's a simple
  // "what you paid on average," not a precise post-sale cost basis.
  const avgCost = useMemo(() => {
    let spent = 0, unitsBought = 0;
    transactions.forEach((t) => {
      const line = t.lines.find((l) => l.accountId === account.id);
      if (line && line.amount > 0 && line.cashValue !== undefined) {
        spent += Math.abs(line.cashValue);
        unitsBought += line.amount;
      }
    });
    return unitsBought > 0 ? spent / unitsBought : null;
  }, [transactions, account]);

  function startEdit(t) {
    if (t.lines.length > 2) return;
    const line = t.lines.find((l) => l.accountId === account.id);
    const other = t.lines.find((l) => l.accountId !== account.id);
    const naturalCash = line.cashValue !== undefined ? -line.cashValue : 0;
    setDraft({
      mode: "edit",
      txnId: t.id,
      originalTxn: t,
      otherLineSnapshot: other || null,
      splitOffLines: [],
      date: line.date,
      description: t.description || "",
      otherAccountId: other ? other.accountId : "",
      matchedTxnId: null,
      unitsInStr: line.amount > 0 ? String(line.amount) : "",
      unitsOutStr: line.amount < 0 ? String(-line.amount) : "",
      cashInStr: naturalCash > 0 ? String(naturalCash) : "",
      cashOutStr: naturalCash < 0 ? String(-naturalCash) : "",
    });
    setDraftError("");
  }

  function selectMatch(candidate) {
    setDraft((d) => (d ? { ...d, otherAccountId: candidate.acc.id, matchedTxnId: candidate.txn.id } : d));
  }

  // Removing the cash link never deletes its data — if it had a
  // pre-existing line (from when this trade was opened), it's queued to
  // be split off into its own standalone record on save, same as Unlink.
  function removeLink() {
    setDraft((d) => {
      if (!d) return d;
      if (d.otherLineSnapshot && d.otherLineSnapshot.accountId === d.otherAccountId && !d.matchedTxnId) {
        return { ...d, otherAccountId: "", matchedTxnId: null, otherLineSnapshot: null, splitOffLines: [...d.splitOffLines, d.otherLineSnapshot] };
      }
      return { ...d, otherAccountId: "", matchedTxnId: null, otherLineSnapshot: null };
    });
  }

  // Picking a different account from the dropdown re-points the link the
  // same way removing and re-adding one would — any pre-existing snapshot
  // that no longer matches gets split off rather than silently dropped.
  function repointOtherAccount(newId) {
    setDraft((d) => {
      if (!d) return d;
      let otherLineSnapshot = d.otherLineSnapshot;
      let splitOffLines = d.splitOffLines;
      if (otherLineSnapshot && otherLineSnapshot.accountId !== newId) {
        splitOffLines = [...splitOffLines, otherLineSnapshot];
        otherLineSnapshot = null;
      }
      return { ...d, otherAccountId: newId, matchedTxnId: null, otherLineSnapshot, splitOffLines };
    });
  }

  // Splits an already-linked entry back into two separate, unlinked
  // records — the exact reverse of a match. Neither side's data (including
  // its own date) is touched; each just goes back to standing alone.
  function unlinkNow() {
    if (!draft || !draft.originalTxn || draft.originalTxn.lines.length !== 2) return;
    const t = draft.originalTxn;
    const mine = t.lines.find((l) => l.accountId === account.id);
    const other = t.lines.find((l) => l.accountId !== account.id);
    onSaveTxn(
      { id: t.id, description: t.description, lines: [mine] },
      undefined,
      [{ description: t.description, lines: [other] }]
    );
    setDraft(null);
    setDraftError("");
  }

  function commit() {
    if (!draft) return;
    if (unitsDeltaOf(draft) === 0) { setDraftError("Enter units in or out."); return; }
    const data = draftToTxn(draft, draft.mode === "edit" ? draft.txnId : undefined);
    const splitOffExtras = draft.splitOffLines.length
      ? draft.splitOffLines.map((sn) => ({ description: draft.originalTxn ? draft.originalTxn.description : draft.description, lines: [sn] }))
      : undefined;
    onSaveTxn(
      { id: draft.mode === "edit" ? draft.txnId : undefined, description: data.description.trim(), lines: data.lines },
      draft.matchedTxnId || undefined,
      splitOffExtras
    );
    setDraft(null);
    setDraftError("");
  }

  function cancel() {
    if (draft && draft.mode === "edit") pendingSettleId.current = draft.txnId;
    setDraft(null);
    setDraftError("");
  }

  const gridCols = "110px 1fr 90px 90px 110px 60px";

  return (
    <div>
      <div className="flex items-start justify-between mb-5">
        <div>
          <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>Stocks & Shares · {account.currency}</div>
          <h2 className="ll-serif" style={{ fontSize: 24, marginTop: 2 }}>{account.name} <span style={{ color: C.gold }}>{account.symbol}</span></h2>
          <div className="ll-mono" style={{ fontSize: 22, marginTop: 6 }}>
            {fmtUnits(balance)} <span style={{ fontSize: 14, color: C.inkFaint }}>units</span>
            {avgCost !== null && <span style={{ fontSize: 13, color: C.inkFaint, marginLeft: 10 }}>avg {fmt(avgCost, account.currency)}/unit</span>}
          </div>
        </div>
        <div className="flex gap-2">
          <div className="flex rounded overflow-hidden" style={{ border: `1px solid ${C.line}` }}>
            <button onClick={() => setView("ledger")} title="Ledger" className="flex items-center gap-1.5 px-3" style={{ background: view === "ledger" ? C.paperDim : "transparent", color: view === "ledger" ? C.ink : C.inkFaint, fontSize: 13 }}>
              <TableProperties size={14} /> Ledger
            </button>
            <button onClick={() => setView("chart")} title="Chart" className="flex items-center gap-1.5 px-3" style={{ background: view === "chart" ? C.paperDim : "transparent", color: view === "chart" ? C.ink : C.inkFaint, fontSize: 13 }}>
              <TrendingUp size={14} /> Chart
            </button>
          </div>
          <button onClick={onEditAccount} className="px-3 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13 }}>Edit account</button>
          <button
            onClick={() => { setDraft(blankStockDraft(account)); setDraftError(""); }}
            disabled={!!draft}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded"
            style={{ background: draft ? C.inkFaint : C.ink, color: C.paper, fontSize: 13, cursor: draft ? "default" : "pointer" }}
          >
            <Plus size={14} /> Add trade
          </button>
        </div>
      </div>

      {view === "chart" ? (
        <UnitsChart account={account} transactions={transactions} />
      ) : (
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden", background: C.card }}>
        <div className="grid" style={{ gridTemplateColumns: gridCols, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.6, color: C.inkFaint, padding: "10px 16px", borderBottom: `1px solid ${C.line}` }}>
          <div>Date</div><div>Description</div><div className="text-right">Units out</div><div className="text-right">Units in</div><div className="text-right">Balance</div><div />
        </div>

        {rows.length === 0 && !draft && <div style={{ padding: "24px 16px", fontSize: 13, color: C.inkFaint }}>No trades yet in this account.</div>}

        {rows.map((r) => {
          const isEditing = r.txn.id === editingKey;
          const unitsOut = r.line.amount < 0 ? -r.line.amount : 0;
          const unitsIn = r.line.amount > 0 ? r.line.amount : 0;
          const natural = r.line.cashValue !== undefined ? -r.line.cashValue : null;
          const unmatched = r.txn.lines.length === 1;

          if (isEditing) {
            return (
              <div key={r.txn.id} ref={(el) => (rowRefs.current[r.txn.id] = el)} style={{ borderBottom: `1px solid ${C.lineSoft}`, background: C.paperDim, padding: "10px 16px" }}>
                <div className="grid items-center" style={{ gridTemplateColumns: gridCols, gap: 8 }}>
                  <input type="date" autoFocus value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} style={miniInput} />
                  <input type="text" placeholder="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={miniInput} />
                  <input
                    type="number" step="0.000001" placeholder="Out" value={draft.unitsOutStr}
                    onChange={(e) => setDraft(draft.matchedTxnId ? { ...clearMatch(draft), unitsOutStr: e.target.value } : { ...draft, unitsOutStr: e.target.value })}
                    className="ll-mono text-right" style={{ ...miniInput, color: C.debit }}
                    onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") cancel(); }}
                  />
                  <input
                    type="number" step="0.000001" placeholder="In" value={draft.unitsInStr}
                    onChange={(e) => setDraft(draft.matchedTxnId ? { ...clearMatch(draft), unitsInStr: e.target.value } : { ...draft, unitsInStr: e.target.value })}
                    className="ll-mono text-right" style={{ ...miniInput, color: C.credit }}
                    onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") cancel(); }}
                  />
                  <div className="ll-mono text-right" style={{ fontWeight: 600, fontSize: 13.5 }}>{fmtUnits(r.running)}</div>
                  <div className="flex gap-1 justify-end">
                    <button onClick={commit} title="Save" style={iconBtn(C.credit)}><Check size={15} /></button>
                    <button onClick={cancel} title="Cancel" style={iconBtn(C.inkFaint)}><X size={15} /></button>
                  </div>
                </div>

                <div className="flex items-center gap-2 mt-2 flex-wrap" style={{ paddingLeft: 118 }}>
                  <span style={{ fontSize: 12, color: C.inkFaint }}>Cash out</span>
                  <input
                    type="number" step="0.01" placeholder="0.00" value={draft.cashOutStr}
                    onChange={(e) => setDraft(draft.matchedTxnId ? { ...clearMatch(draft), cashOutStr: e.target.value } : { ...draft, cashOutStr: e.target.value })}
                    className="ll-mono" style={{ ...miniInput, width: 90, color: C.debit }}
                  />
                  <span style={{ fontSize: 12, color: C.inkFaint }}>Cash in</span>
                  <input
                    type="number" step="0.01" placeholder="0.00" value={draft.cashInStr}
                    onChange={(e) => setDraft(draft.matchedTxnId ? { ...clearMatch(draft), cashInStr: e.target.value } : { ...draft, cashInStr: e.target.value })}
                    className="ll-mono" style={{ ...miniInput, width: 90, color: C.credit }}
                  />
                  <span className="ll-mono" style={{ fontSize: 12.5, color: C.inkFaint, padding: "0 4px" }}>{account.currency}</span>
                  <select
                    value={draft.otherAccountId}
                    onChange={(e) => repointOtherAccount(e.target.value)}
                    style={{ ...miniInput, width: 160 }}
                  >
                    <option value="">— unmatched —</option>
                    {accounts.filter((a) => a.id !== account.id && a.type !== "investment").map((a) => (
                      <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>
                    ))}
                  </select>
                  {draft.otherAccountId && (
                    <button type="button" onClick={removeLink} title="Remove this link"><X size={15} color={C.inkFaint} /></button>
                  )}
                </div>

                {draft.splitOffLines.length > 0 && (
                  <div className="mt-2" style={{ paddingLeft: 118, fontSize: 11.5, color: C.inkFaint }}>
                    The removed cash line will be saved as a separate, unlinked entry — not deleted.
                  </div>
                )}

                {draft.matchedTxnId ? (
                  <div className="flex items-center gap-2 mt-2" style={{ paddingLeft: 118 }}>
                    <Check size={13} color={C.credit} />
                    <span style={{ fontSize: 12, color: C.credit }}>
                      Matched to {accounts.find((a) => a.id === draft.otherAccountId)?.name} · will merge into one entry on save
                    </span>
                    <button type="button" onClick={() => setDraft(clearMatch(draft))} style={{ fontSize: 12, color: C.gold }}>Undo</button>
                  </div>
                ) : (
                  !draft.otherAccountId && matchCandidates.length > 0 && (
                    <div className="mt-2" style={{ paddingLeft: 118 }}>
                      <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Possible matches</div>
                      <div className="flex flex-col gap-1">
                        {matchCandidates.map((c) => (
                          <button
                            key={c.txn.id}
                            type="button"
                            onClick={() => selectMatch(c)}
                            className="flex items-center justify-between px-2 py-1.5 rounded text-left"
                            style={{ border: `1px solid ${C.line}`, background: C.card }}
                          >
                            <span style={{ fontSize: 12.5 }}>
                              <strong>{c.acc.name}</strong> · {fmtDate(c.line.date)}{c.txn.description ? ` · ${c.txn.description}` : ""}
                            </span>
                            <span className="ll-mono" style={{ fontSize: 12.5, color: c.line.amount < 0 ? C.debit : C.credit }}>{fmt(c.line.amount, c.acc.currency)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                )}

                <div className="flex items-center justify-between mt-2">
                  <span style={{ fontSize: 12, color: draftError ? C.debit : C.inkFaint }}>
                    {draftError || (draft.otherAccountId ? "Cash leg linked" : "Cash side unmatched — can be matched to a cash account later")}
                  </span>
                  {draft.mode === "edit" && (
                    <div className="flex items-center gap-3">
                      {draft.originalTxn && draft.originalTxn.lines.length === 2 && (
                        <button onClick={unlinkNow} title="Split back into two separate, unlinked entries" className="flex items-center gap-1" style={{ fontSize: 12, color: C.gold }}><Unlink2 size={12} /> Unlink</button>
                      )}
                      <button onClick={() => { onDeleteTxn(draft.txnId); setDraft(null); setDraftError(""); }} className="flex items-center gap-1" style={{ fontSize: 12, color: C.debit }}><Trash2 size={12} /> Delete</button>
                    </div>
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
              className="ll-row cursor-pointer"
              style={{ padding: "10px 16px", borderBottom: `1px solid ${C.lineSoft}` }}
            >
              <div className="grid items-center" style={{ gridTemplateColumns: gridCols, fontSize: 13.5 }}>
                <div style={{ color: C.inkSoft, fontSize: 12.5 }}>{fmtDate(r.line.date)}</div>
                <div className="flex items-center gap-2">
                  {r.txn.description || <span style={{ color: C.inkFaint }}>—</span>}
                  {unmatched && <span title="Cash side not yet matched to another account"><AlertTriangle size={12} color={C.gold} /></span>}
                </div>
                <div className="ll-mono text-right" style={{ color: unitsOut ? C.debit : C.inkFaint }}>{unitsOut ? fmtUnits(unitsOut) : "—"}</div>
                <div className="ll-mono text-right" style={{ color: unitsIn ? C.credit : C.inkFaint }}>{unitsIn ? fmtUnits(unitsIn) : "—"}</div>
                <div className="ll-mono text-right" style={{ fontWeight: 600 }}>{fmtUnits(r.running)}</div>
                <div className="flex justify-end"><Pencil size={13} color={C.inkFaint} /></div>
              </div>
              {natural !== null && (
                <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 3, paddingLeft: 118 }}>
                  Cash {fmt(natural, r.line.cashCurrency)}
                  {r.others.length > 0 ? ` · ${r.others.map((a) => a.name).join(", ")}` : " · unmatched"}
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}


function iconBtn(color) { return { padding: 6, borderRadius: 4, border: `1px solid ${C.line}`, color, background: C.card }; }
const miniInput = { width: "100%", padding: "7px 8px", borderRadius: 4, border: `1px solid ${C.line}`, background: C.paper, fontSize: 13, color: C.ink, outline: "none" };

/* ---------------------------------------------------------
   Account form modal
--------------------------------------------------------- */
function AccountFormModal({ initial, onCancel, onSave, onDelete }) {
  const [name, setName] = useState(initial.name || "");
  const [type, setType] = useState(initial.type || "asset");
  const [currency, setCurrency] = useState(initial.currency || "GBP");
  const [symbol, setSymbol] = useState(initial.symbol || "");
  const [opening, setOpening] = useState(initial.openingBalance ? String(initial.openingBalance) : "0");

  function submit() {
    if (!name.trim()) return;
    if (type === "investment" && !symbol.trim()) return;
    onSave({
      id: initial.id,
      name: name.trim(),
      type,
      currency,
      openingBalance: parseFloat(opening) || 0,
      ...(type === "investment" ? { symbol: symbol.trim().toUpperCase() } : {}),
    });
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
        {type === "investment" && (
          <Field label="Symbol">
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} style={{ ...inputStyle, textTransform: "uppercase" }} placeholder="e.g. AAPL" />
          </Field>
        )}
        <Field label={type === "investment" ? "Trading currency" : "Currency"}>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        {type !== "investment" && (
          <Field label="Opening balance"><input type="number" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} style={inputStyle} /></Field>
        )}
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
