import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { Plus, Trash2, Check, X, Wallet, ArrowLeftRight, AlertTriangle, BookOpen, Pencil, Unlink2, TrendingUp, TableProperties, BookmarkPlus, ChevronUp, ChevronDown } from "lucide-react";
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
  { key: "isa-parent", label: "Stocks & Shares ISAs" },
];
// Used only to translate a plain "increase/decrease" entry into formal debit/credit
// for the balance-check hint — never shown to the user, never used for storage or display.
const CONTRA_TYPES = new Set(["liability", "equity", "income"]);

const CURRENCIES = ["GBP", "USD", "EUR", "JPY", "CHF", "CAD", "AUD"];

/* ---------------------------------------------------------
   UK ISA allowance rules
   Keyed by the tax year's start year (a UK tax year runs 6 April to the
   following 5 April). To handle a future rule change, add a new row here
   — everything else (which tax year "today" falls in, which cap applies)
   is derived automatically, nothing else in the app needs editing.
--------------------------------------------------------- */
const ISA_KINDS = [
  { key: "cash-isa", label: "Cash ISA" },
  { key: "stocks-shares-isa", label: "Stocks & Shares ISA" },
  { key: "lifetime-isa", label: "Lifetime ISA" },
  { key: "innovative-finance-isa", label: "Innovative Finance ISA" },
];

// startYear = the calendar year the tax year begins in (e.g. 2026 means
// the 2026/27 tax year, 6 April 2026 – 5 April 2027).
const ISA_RULE_TABLE = [
  { startYear: 2026, total: 20000, subCaps: { "lifetime-isa": 4000 } },
  { startYear: 2027, total: 20000, subCaps: { "lifetime-isa": 4000, "cash-isa": 12000 } },
];

// UK tax years run 6 April – 5 April, not the calendar year.
function taxYearStartYearFor(dateISO) {
  const d = new Date(dateISO + "T00:00:00");
  const y = d.getFullYear();
  const boundary = new Date(y, 3, 6); // 6 April, month is 0-indexed
  return d < boundary ? y - 1 : y;
}
function taxYearBounds(startYear) {
  const start = `${startYear}-04-06`;
  const end = `${startYear + 1}-04-05`;
  return { start, end, label: `${startYear}/${String(startYear + 1).slice(2)}` };
}
// Rules in effect for a given tax year — falls back to the latest known
// rule set for any year beyond the table, since allowances don't lapse.
// Over-65s are exempt from the Cash ISA sub-cap once it exists.
function isaRulesFor(startYear, over65) {
  const applicable = ISA_RULE_TABLE.filter((r) => r.startYear <= startYear);
  const rules = applicable.length ? applicable[applicable.length - 1] : ISA_RULE_TABLE[0];
  if (over65 && rules.subCaps["cash-isa"] !== undefined) {
    const { "cash-isa": _drop, ...rest } = rules.subCaps;
    return { ...rules, subCaps: rest };
  }
  return rules;
}

// An ISA subaccount doesn't set its own institution — it inherits its
// wrapper's, the same way it inherits flexibility. Always resolved
// against the *full* account list, since a nested grouping level may be
// working with a subset that doesn't include the wrapper itself.
function institutionOf(account, allAccounts) {
  if (account.institution) return account.institution;
  if (account.isaParentId) {
    const parent = allAccounts.find((a) => a.id === account.isaParentId);
    if (parent && parent.institution) return parent.institution;
  }
  return "";
}

const GROUP_DIMENSIONS = [
  { key: "type", label: "Type" },
  { key: "institution", label: "Institution" },
  { key: "currency", label: "Currency" },
];

// Splits one set of accounts into labelled buckets along a single
// dimension. `allAccounts` is only needed to resolve inherited
// institutions correctly inside a nested/filtered subset.
function bucketBy(subset, dim, allAccounts) {
  if (dim === "type") {
    return TYPES.map((t) => ({ key: t.key, label: t.label, items: subset.filter((a) => a.type === t.key) })).filter((g) => g.items.length);
  }
  if (dim === "currency") {
    const byCur = {};
    const wrappers = [];
    subset.forEach((a) => {
      if (a.type === "isa-parent") { wrappers.push(a); return; }
      const cur = a.currency || "—";
      byCur[cur] = byCur[cur] || [];
      byCur[cur].push(a);
    });
    const order = Object.keys(byCur).sort((a, b) => (a === "GBP" ? -1 : b === "GBP" ? 1 : a.localeCompare(b)));
    const groups = order.map((cur) => ({ key: cur, label: cur, items: byCur[cur] }));
    if (wrappers.length) groups.push({ key: "__isa", label: "Stocks & Shares ISAs", items: wrappers });
    return groups;
  }
  // institution
  const byInst = {};
  subset.forEach((a) => {
    const inst = institutionOf(a, allAccounts) || "No institution";
    byInst[inst] = byInst[inst] || [];
    byInst[inst].push(a);
  });
  const keys = Object.keys(byInst).sort((a, b) => (a === "No institution" ? 1 : b === "No institution" ? -1 : a.localeCompare(b)));
  return keys.map((k) => ({ key: k, label: k, items: byInst[k] }));
}

// Recursively buckets accounts through up to three chosen dimensions —
// levels like ["institution", "currency"] produce one institution section
// per top level, each split into currency sub-sections underneath. Every
// node (leaf or not) keeps its full flattened `items` list, so a subtotal
// can be shown at any level, not just the deepest one.
function buildNestedGroups(subset, levels, allAccounts) {
  const [dim, ...rest] = levels;
  const buckets = bucketBy(subset, dim, allAccounts);
  return buckets.map((b) => ({
    key: `${dim}:${b.key}`,
    label: b.label,
    dim,
    items: b.items,
    leaf: rest.length === 0,
    children: rest.length === 0 ? null : buildNestedGroups(b.items, rest, allAccounts),
  }));
}

function subtotalsForItems(items, balances) {
  const sub = {};
  items.filter((a) => a.type !== "investment" && a.type !== "isa-parent").forEach((a) => { sub[a.currency] = (sub[a.currency] || 0) + (balances[a.id] || 0); });
  return sub;
}

// Computes the renumbered `order` values needed to move one row earlier
// or later among its same-date neighbours in this account's ledger.
// Rows with the same date otherwise have no inherent order, so this
// stamps a fresh 0..n-1 sequence across the whole same-date group rather
// than just swapping two values — which stays correct even when three or
// more rows share a date. Returns null if there's no same-date neighbour
// in that direction to move past.
function reorderSameDate(rows, idx, dir, accountId) {
  const date = rows[idx].line.date;
  let start = idx, end = idx;
  while (start > 0 && rows[start - 1].line.date === date) start--;
  while (end < rows.length - 1 && rows[end + 1].line.date === date) end++;
  if (start === end) return null;
  const groupIdxs = [];
  for (let i = start; i <= end; i++) groupIdxs.push(i);
  const localPos = idx - start;
  const targetLocalPos = localPos + dir;
  if (targetLocalPos < 0 || targetLocalPos >= groupIdxs.length) return null;
  const newOrderArr = [...groupIdxs];
  [newOrderArr[localPos], newOrderArr[targetLocalPos]] = [newOrderArr[targetLocalPos], newOrderArr[localPos]];
  return newOrderArr.map((absIdx, seq) => {
    const r = rows[absIdx];
    return { id: r.txn.id, lines: r.txn.lines.map((l) => (l.accountId === accountId ? { ...l, order: seq } : l)) };
  });
}

// A compact cascading picker for up to three nested grouping levels — the
// first is always active (defaulting to Type); each subsequent one offers
// "—" to stop nesting there, plus whichever dimensions aren't already
// used earlier in the chain. Changing a level resets anything after it,
// so the chain can never end up with a dimension repeated or a gap.
function groupLevelsLabel(levels) {
  return levels.map((k) => GROUP_DIMENSIONS.find((d) => d.key === k)?.label || k).join(" › ");
}

function GroupLevelPicker({ levels, onChange, saved, onSave, onRemove }) {
  function setLevel(i, val) {
    const next = levels.slice(0, i);
    if (val) next.push(val);
    onChange(next.length ? next : ["type"]);
  }
  const selStyle = { fontSize: 11.5, padding: "3px 5px", border: `1px solid ${C.line}`, borderRadius: 4, background: C.paper, color: C.ink };
  const alreadySaved = (saved || []).some((s) => JSON.stringify(s.levels) === JSON.stringify(levels));
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => {
          if (i > 0 && !levels[i - 1]) return null;
          const used = levels.slice(0, i);
          const options = GROUP_DIMENSIONS.filter((d) => !used.includes(d.key));
          return (
            <React.Fragment key={i}>
              {i > 0 && <span style={{ color: C.inkFaint, fontSize: 11 }}>›</span>}
              <select value={levels[i] || ""} onChange={(e) => setLevel(i, e.target.value)} style={selStyle}>
                {i > 0 && <option value="">—</option>}
                {options.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            </React.Fragment>
          );
        })}
        {onSave && (
          <button
            onClick={() => !alreadySaved && onSave(levels)}
            disabled={alreadySaved}
            title={alreadySaved ? "Already saved" : "Save this grouping"}
            style={{ padding: 4, color: alreadySaved ? C.goldDim : C.inkFaint, opacity: alreadySaved ? 0.6 : 1 }}
          >
            <BookmarkPlus size={14} />
          </button>
        )}
      </div>
      {saved && saved.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {saved.map((s) => {
            const active = JSON.stringify(s.levels) === JSON.stringify(levels);
            return (
              <span key={s.id} className="flex items-center" style={{ border: `1px solid ${active ? C.gold : C.line}`, borderRadius: 4, overflow: "hidden" }}>
                <button onClick={() => onChange(s.levels)} style={{ padding: "3px 6px", fontSize: 11, background: active ? C.paperDim : "transparent", color: active ? C.ink : C.inkSoft, fontWeight: active ? 600 : 400 }}>
                  {groupLevelsLabel(s.levels)}
                </button>
                <button onClick={() => onRemove(s.id)} title="Remove" style={{ padding: "3px 4px", color: C.inkFaint }}>
                  <X size={11} />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Renders nested groups in the sidebar — indented headers down to
// whichever level is a leaf, where actual clickable account rows appear.
function SidebarGroupTree({ groups, depth, selectedId, onSelect, balances, accountDisplay }) {
  return groups.map((g) => (
    <div key={g.key} className="mb-3" style={{ marginLeft: depth * 8 }}>
      <div style={{ fontSize: 10.5, letterSpacing: 1, textTransform: "uppercase", color: C.inkFaint, padding: "4px 8px" }}>{g.label}</div>
      {g.leaf ? (
        g.items.map((a) => (
          <button key={a.id} onClick={() => onSelect(a.id)} className="w-full text-left px-2 py-1.5 rounded flex items-center justify-between" style={{ background: selectedId === a.id ? C.paperDim : "transparent" }}>
            <span style={{ fontSize: 13.5, color: C.ink, display: "flex", alignItems: "center", gap: 5 }}>
              {a.name}
              {a.isaKind && <span title={ISA_KINDS.find((k) => k.key === a.isaKind)?.label} style={{ fontSize: 9.5, fontWeight: 700, color: C.gold, border: `1px solid ${C.goldDim}`, borderRadius: 3, padding: "1px 3px", letterSpacing: 0.3 }}>ISA</span>}
            </span>
            <span className="ll-mono" style={{ fontSize: a.type === "investment" ? 11 : 12, color: (balances[a.id] || 0) < 0 ? C.debit : C.inkSoft }}>{accountDisplay(a)}</span>
          </button>
        ))
      ) : (
        <SidebarGroupTree groups={g.children} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} balances={balances} accountDisplay={accountDisplay} />
      )}
    </div>
  ));
}

function AccountCard({ a, accounts, balances, onSelect }) {
  return (
    <button onClick={() => onSelect(a.id)} className="text-left p-4 rounded" style={{ background: C.card, border: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>
        {TYPES.find((t) => t.key === a.type)?.label}{a.type === "investment" ? ` · ${a.symbol}` : ""}
        {a.isaKind ? ` · ${ISA_KINDS.find((k) => k.key === a.isaKind)?.label}` : ""}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, marginTop: 4 }}>{a.name}</div>
      {a.type === "isa-parent" ? (
        <div className="ll-mono" style={{ fontSize: 14, marginTop: 8, color: C.inkFaint }}>{accounts.filter((x) => x.isaParentId === a.id).length} subaccounts</div>
      ) : a.type === "investment" ? (
        <div className="ll-mono" style={{ fontSize: 16, marginTop: 8, color: C.ink }}>{fmtUnits(balances[a.id] || 0)} <span style={{ fontSize: 13, color: C.inkFaint }}>units</span></div>
      ) : (
        <div className="ll-mono" style={{ fontSize: 18, marginTop: 8, color: (balances[a.id] || 0) < 0 ? C.debit : C.ink }}>{fmt(balances[a.id] || 0, a.currency)}</div>
      )}
    </button>
  );
}

// Renders nested groups on the Overview page — a subtotal line at every
// non-Type level, and a card grid once a branch reaches its leaf.
function OverviewGroupTree({ groups, depth, accounts, balances, onSelect }) {
  return groups.map((g) => {
    const sub = g.dim !== "type" ? subtotalsForItems(g.items, balances) : null;
    return (
      <div key={g.key} className="mb-6" style={{ marginLeft: depth * 14 }}>
        <div className="flex items-baseline justify-between mb-2">
          <div style={{ fontSize: depth === 0 ? 12 : 11, fontWeight: 600, color: C.inkSoft, textTransform: "uppercase", letterSpacing: 0.6 }}>{g.label}</div>
          {sub && Object.keys(sub).length > 0 && (
            <div className="ll-mono" style={{ fontSize: 12, color: C.inkFaint }}>{Object.entries(sub).map(([c, v]) => fmt(v, c)).join("  ·  ")}</div>
          )}
        </div>
        {g.leaf ? (
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {g.items.map((a) => <AccountCard key={a.id} a={a} accounts={accounts} balances={balances} onSelect={onSelect} />)}
          </div>
        ) : (
          <OverviewGroupTree groups={g.children} depth={depth + 1} accounts={accounts} balances={balances} onSelect={onSelect} />
        )}
      </div>
    );
  });
}


// account is its own product; a Stocks & Shares ISA wrapper and all of
// its subaccounts together form one product, since both the allowance
// and flexibility apply to the ISA itself, not each subaccount.
function isaProducts(accounts) {
  const products = [];
  accounts.forEach((a) => {
    if (a.type === "isa-parent") {
      products.push({
        account: a,
        kind: "stocks-shares-isa",
        flexible: !!a.flexible,
        accountIds: accounts.filter((x) => x.isaParentId === a.id).map((x) => x.id),
      });
    } else if (a.isaKind && a.isaKind !== "stocks-shares-isa") {
      products.push({ account: a, kind: a.isaKind, flexible: !!a.flexible, accountIds: [a.id] });
    }
  });
  return products;
}

function isExternalLine(t, line, accounts) {
  const others = t.lines.filter((l) => l.accountId !== line.accountId);
  return others.length === 0 || others.every((l) => {
    const oAcc = accounts.find((a) => a.id === l.accountId);
    return !oAcc || !oAcc.isaKind;
  });
}

// How much of a flexible product's balance, as at the start of a given
// tax year, was subscribed in tax years *before* that one — opening
// balances plus all external in/out flow before the year began. This is
// the pool that HMRC's rules say can only ever be replaced back into
// this exact ISA, never a different one.
function priorPoolEntering(product, accounts, transactions, yearStart) {
  let pool = 0;
  product.accountIds.forEach((id) => {
    const acc = accounts.find((a) => a.id === id);
    if (acc) pool += acc.openingBalance || 0;
  });
  transactions.forEach((t) => {
    t.lines.forEach((line) => {
      if (!product.accountIds.includes(line.accountId) || !line.amount) return;
      if (line.date >= yearStart) return;
      if (isExternalLine(t, line, accounts)) pool += line.amount;
    });
  });
  return Math.max(0, pool);
}

// How much of this tax year's allowance has been used, per ISA kind and
// overall.
//
// A transaction whose linked counterpart is itself an ISA — another of
// your ISAs, or another subaccount of the same wrapper — is a transfer,
// not a subscription, and never counts on either side.
//
// For a flexible ISA, withdrawals draw down this tax year's own
// subscriptions first, then older money (HMRC's ordering) — the
// this-year portion becomes replaceable into *any* flexible ISA, while
// the older portion is only replaceable back into the very same ISA.
// This is simulated chronologically across every flexible ISA together
// (using each one's full history to know how much of its balance predates
// the tax year in view), so a deposit is only ever treated as new money
// once genuine replacement capacity has been used up.
function computeIsaUsage(accounts, transactions, startYear) {
  const { start, end } = taxYearBounds(startYear);
  const byKind = {};
  ISA_KINDS.forEach((k) => (byKind[k.key] = 0));

  const products = isaProducts(accounts);

  // Non-flexible: unchanged — every deposit counts, withdrawals never
  // reduce anything.
  products.filter((p) => !p.flexible).forEach((product) => {
    let deposits = 0;
    transactions.forEach((t) => {
      t.lines.forEach((line) => {
        if (!product.accountIds.includes(line.accountId) || line.amount <= 0) return;
        if (line.date < start || line.date > end) return;
        if (isExternalLine(t, line, accounts)) deposits += line.amount;
      });
    });
    byKind[product.kind] = (byKind[product.kind] || 0) + deposits;
  });

  // Flexible: simulate withdrawal/replacement ordering together, in date
  // order across all of them, since a this-year withdrawal from one can
  // be replaced into another.
  const flexProducts = products.filter((p) => p.flexible);
  if (flexProducts.length) {
    const state = {};
    const accountToProduct = {};
    flexProducts.forEach((p) => {
      state[p.account.id] = {
        product: p,
        priorBalance: priorPoolEntering(p, accounts, transactions, start),
        priorReplaceable: 0,
        thisYearBalance: 0,
      };
      p.accountIds.forEach((id) => (accountToProduct[id] = p));
    });
    let globalReplaceable = 0; // this-year money, replaceable into any flexible ISA

    const events = [];
    transactions.forEach((t) => {
      t.lines.forEach((line) => {
        const product = accountToProduct[line.accountId];
        if (!product || !line.amount) return;
        if (line.date < start || line.date > end) return;
        if (isExternalLine(t, line, accounts)) events.push({ date: line.date, amount: line.amount, product });
      });
    });
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    events.forEach((ev) => {
      const s = state[ev.product.account.id];
      if (ev.amount < 0) {
        // Withdrawal: this year's own money goes first, freeing capacity
        // usable anywhere; anything beyond that draws on older money,
        // freeing capacity usable only back into this same ISA.
        let w = -ev.amount;
        const fromThisYear = Math.min(w, s.thisYearBalance);
        s.thisYearBalance -= fromThisYear;
        globalReplaceable += fromThisYear;
        w -= fromThisYear;
        const fromPrior = Math.min(w, s.priorBalance);
        s.priorBalance -= fromPrior;
        s.priorReplaceable += fromPrior;
      } else {
        // Deposit: first pays down this ISA's own same-account-only
        // replacement obligation, then any outstanding this-year
        // capacity from anywhere, and only what's left over is a
        // genuinely new subscription.
        let d = ev.amount;
        const fillPrior = Math.min(d, s.priorReplaceable);
        s.priorReplaceable -= fillPrior;
        s.priorBalance += fillPrior;
        d -= fillPrior;
        const fillGlobal = Math.min(d, globalReplaceable);
        globalReplaceable -= fillGlobal;
        s.thisYearBalance += fillGlobal;
        d -= fillGlobal;
        s.thisYearBalance += d;
      }
    });

    // A product's displayed usage is simply how much this-year-sourced
    // money is currently sitting in it: it went up on every genuinely new
    // subscription and every replacement received, and back down on every
    // withdrawal — so money withdrawn and never replaced anywhere
    // correctly stops counting, immediately, without waiting on a future
    // deposit to "cancel it out".
    Object.values(state).forEach((s) => {
      byKind[s.product.kind] = (byKind[s.product.kind] || 0) + Math.max(0, s.thisYearBalance);
    });
  }

  const total = Object.values(byKind).reduce((sum, v) => sum + v, 0);
  return { byKind, total };
}

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

/* ---------------------------------------------------------
   A minimal hash router — no server, so the URL fragment is the only
   thing that survives a refresh unprompted. #/account/<id> selects an
   account; #/ (or nothing) is the overview. pushState (not replaceState)
   so the browser's back/forward buttons move between accounts too.
--------------------------------------------------------- */
function accountIdFromHash() {
  if (typeof window === "undefined") return null;
  const m = (window.location.hash || "").match(/^#\/account\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function setHashForAccount(id) {
  if (typeof window === "undefined") return;
  try {
    const next = id ? `#/account/${encodeURIComponent(id)}` : "#/";
    if (window.location.hash !== next) window.history.pushState(null, "", next);
  } catch (e) {
    // Some embedding contexts restrict history manipulation — the app
    // still works, it just won't survive a refresh in that case.
  }
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
    return a.type === "investment" ? `${fmtUnits(bal)} ${a.symbol}` : fmt(bal, a.currency);
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
            <Overview accounts={accounts} balances={balances} settings={settings} onSaveSettings={saveSettings} onSaveGrouping={saveGroupingPreset} onRemoveGrouping={removeGroupingPreset} onSelect={setSelectedId} onNew={() => setAccountForm({})} />
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

/* ---------------------------------------------------------
   Overview
--------------------------------------------------------- */
function Overview({ accounts, balances, settings, onSaveSettings, onSaveGrouping, onRemoveGrouping, onSelect, onNew }) {
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
  accounts.filter((a) => a.type !== "investment" && a.type !== "isa-parent").forEach((a) => { totalsByCurrency[a.currency] = (totalsByCurrency[a.currency] || 0) + (balances[a.id] || 0); });

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

      <OverviewGroupTree groups={buildNestedGroups(accounts, groupLevels, accounts)} depth={0} accounts={accounts} balances={balances} onSelect={onSelect} />
    </div>
  );
}

/* ---------------------------------------------------------
   ISA parent (Stocks & Shares ISA wrapper) — holds no ledger of its own,
   just groups its cash and stock subaccounts.
--------------------------------------------------------- */
function IsaParentView({ account, accounts, balances, onEditAccount, onSelect, onNewSubaccount }) {
  const subs = accounts.filter((a) => a.isaParentId === account.id);
  const cashSubs = subs.filter((a) => a.type === "asset");
  const stockSubs = subs.filter((a) => a.type === "investment");

  return (
    <div>
      <div className="flex items-start justify-between mb-5">
        <div>
          <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>Stocks & Shares ISA</div>
          <h2 className="ll-serif" style={{ fontSize: 24, marginTop: 2 }}>{account.name}</h2>
          <div style={{ fontSize: 13, color: C.inkFaint, marginTop: 6 }}>{subs.length} subaccount{subs.length === 1 ? "" : "s"}</div>
        </div>
        <button onClick={onEditAccount} className="px-3 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13 }}>Edit ISA</button>
      </div>

      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <div style={{ fontSize: 11, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.6 }}>Cash</div>
          <button onClick={() => onNewSubaccount("asset")} className="flex items-center gap-1" style={{ fontSize: 12.5, color: C.gold }}><Plus size={13} /> Add cash subaccount</button>
        </div>
        {cashSubs.length === 0 ? (
          <div style={{ fontSize: 13, color: C.inkFaint, padding: "8px 0" }}>No cash subaccounts yet.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {cashSubs.map((a) => (
              <button key={a.id} onClick={() => onSelect(a.id)} className="flex items-center justify-between px-3 py-2.5 rounded text-left" style={{ background: C.card, border: `1px solid ${C.line}` }}>
                <span style={{ fontSize: 13.5 }}>{a.name} <span style={{ color: C.inkFaint, fontSize: 12 }}>({a.currency})</span></span>
                <span className="ll-mono" style={{ fontSize: 13.5, color: (balances[a.id] || 0) < 0 ? C.debit : C.ink }}>{fmt(balances[a.id] || 0, a.currency)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <div style={{ fontSize: 11, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.6 }}>Holdings</div>
          <button onClick={() => onNewSubaccount("investment")} className="flex items-center gap-1" style={{ fontSize: 12.5, color: C.gold }}><Plus size={13} /> Add stock subaccount</button>
        </div>
        {stockSubs.length === 0 ? (
          <div style={{ fontSize: 13, color: C.inkFaint, padding: "8px 0" }}>No stock subaccounts yet.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {stockSubs.map((a) => (
              <button key={a.id} onClick={() => onSelect(a.id)} className="flex items-center justify-between px-3 py-2.5 rounded text-left" style={{ background: C.card, border: `1px solid ${C.line}` }}>
                <span style={{ fontSize: 13.5 }}>{a.name} <span style={{ color: C.gold, fontSize: 12 }}>{a.symbol}</span></span>
                <span className="ll-mono" style={{ fontSize: 13.5 }}>{fmtUnits(balances[a.id] || 0)} units</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------
   ISA Allowance — how much of the current (or a nearby) UK tax year's
   allowance has been used, per ISA kind, against whichever rules apply
   to that tax year. The 2027/28 Cash ISA sub-cap appears automatically
   once that tax year is in view — nothing here needed manual updating.
--------------------------------------------------------- */
function AllowanceView({ accounts, transactions, settings, onSaveSettings, onSelect }) {
  const currentStartYear = taxYearStartYearFor(todayISO());
  const [startYear, setStartYear] = useState(currentStartYear);

  const { label } = taxYearBounds(startYear);
  const rules = isaRulesFor(startYear, settings.over65);
  const usage = useMemo(() => computeIsaUsage(accounts, transactions, startYear), [accounts, transactions, startYear]);

  function Bar({ used, cap, color }) {
    const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
    return (
      <div style={{ height: 6, borderRadius: 3, background: C.paperDim, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, transition: "width 300ms ease" }} />
      </div>
    );
  }

  const products = useMemo(() => isaProducts(accounts), [accounts]);
  const productsByKind = {};
  products.forEach((p) => {
    productsByKind[p.kind] = productsByKind[p.kind] || [];
    productsByKind[p.kind].push(p);
  });

  return (
    <div>
      <div className="flex items-start justify-between mb-5">
        <div>
          <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>ISA Allowance</div>
          <h2 className="ll-serif" style={{ fontSize: 24, marginTop: 2 }}>Tax year {label}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setStartYear((y) => y - 1)} className="px-2.5 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13 }}>←</button>
          <button onClick={() => setStartYear(currentStartYear)} disabled={startYear === currentStartYear} className="px-3 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13, opacity: startYear === currentStartYear ? 0.4 : 1 }}>This year</button>
          <button onClick={() => setStartYear((y) => y + 1)} className="px-2.5 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13 }}>→</button>
        </div>
      </div>

      <label className="flex items-center gap-2 mb-6" style={{ fontSize: 13, color: C.inkSoft }}>
        <input type="checkbox" checked={!!settings.over65} onChange={(e) => onSaveSettings({ ...settings, over65: e.target.checked })} />
        I'm 65 or over (keeps the full £20,000 Cash ISA capacity once the lower cap applies)
      </label>

      <div className="p-4 rounded mb-4" style={{ background: C.card, border: `1px solid ${C.line}` }}>
        <div className="flex items-center justify-between mb-2">
          <div style={{ fontSize: 13, fontWeight: 600 }}>Overall</div>
          <div className="ll-mono" style={{ fontSize: 13 }}>{fmt(usage.total, "GBP")} <span style={{ color: C.inkFaint }}>of {fmt(rules.total, "GBP")}</span></div>
        </div>
        <Bar used={usage.total} cap={rules.total} color={usage.total > rules.total ? C.debit : C.gold} />
      </div>

      <div className="flex flex-col gap-3">
        {ISA_KINDS.map((k) => {
          const used = usage.byKind[k.key] || 0;
          const cap = rules.subCaps[k.key];
          const holders = productsByKind[k.key] || [];
          if (used === 0 && holders.length === 0) return null;
          return (
            <div key={k.key} className="p-4 rounded" style={{ background: C.card, border: `1px solid ${C.line}` }}>
              <div className="flex items-center justify-between mb-2">
                <div style={{ fontSize: 13, fontWeight: 600 }}>{k.label}</div>
                <div className="ll-mono" style={{ fontSize: 13 }}>
                  {fmt(used, "GBP")} {cap ? <span style={{ color: C.inkFaint }}>of {fmt(cap, "GBP")}</span> : <span style={{ color: C.inkFaint }}>· no sub-cap</span>}
                </div>
              </div>
              {cap && <Bar used={used} cap={cap} color={used > cap ? C.debit : C.goldDim} />}
              {holders.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {holders.map((p) => (
                    <button key={p.account.id} onClick={() => onSelect(p.account.id)} className="flex items-center gap-1.5" style={{ fontSize: 11.5, color: C.inkFaint, border: `1px solid ${C.line}`, borderRadius: 4, padding: "2px 6px" }}>
                      <span className="ll-mono">{p.account.name}</span>
                      {p.flexible && <span style={{ color: C.gold, fontWeight: 700, fontSize: 10 }}>FLEX</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 16, lineHeight: 1.5 }}>
        Counts new money entering an ISA from outside your ISAs this tax year — a transfer between two of your own ISAs, or moving cash within the same Stocks & Shares ISA, is never new money and never counts. Opening balances aren't included, though they still count as "older money" for the rule below. For a flexible ISA (marked FLEX above), a withdrawal is treated as this year's own money first — replaceable into any flexible ISA — then older money, which is only replaceable back into that same ISA, matching HMRC's actual ordering. Non-flexible ISAs get none of this: withdrawals never free up allowance.
      </p>
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
    exchangeChecked: false,
    exchangeOutStr: "",
    exchangeInStr: "",
    exchangeCurrency: "",
  };
}

function AccountLedger({ account, accounts, transactions, balance, onEditAccount, onSaveTxn, onDeleteTxn, onUpdateTxns, guardRef }) {
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

  function exchangeDelta(d) {
    const inN = parseFloat(d.exchangeInStr);
    const outN = parseFloat(d.exchangeOutStr);
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
    if (d.exchangeChecked && d.exchangeCurrency && (d.exchangeOutStr !== "" || d.exchangeInStr !== "")) {
      line1.exchangeAmount = exchangeDelta(d);
      line1.exchangeCurrency = d.exchangeCurrency;
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
    if (draft.exchangeChecked && draft.exchangeCurrency && (draft.exchangeOutStr !== "" || draft.exchangeInStr !== "")) {
      targetAmount = -exchangeDelta(draft);
      targetCurrency = draft.exchangeCurrency;
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
    const sorted = relevant.sort((a, b) => {
      if (a.line.date !== b.line.date) return a.line.date < b.line.date ? -1 : 1;
      const ao = a.line.order ?? 0, bo = b.line.order ?? 0;
      if (ao !== bo) return ao - bo;
      return String(a.txn.id).localeCompare(String(b.txn.id));
    });
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

  // Pure builder so the same construction can be used both to actually
  // start an edit and, from isDraftDirty, to compute what a "clean"
  // (freshly-opened, unedited) draft for this transaction would look
  // like — comparing the two is how a dirty edit is detected.
  function buildDraftFromTxn(t) {
    const line = t.lines.find((l) => l.accountId === account.id);
    const others = t.lines.filter((l) => l.accountId !== account.id);
    return {
      mode: "edit",
      txnId: t.id,
      originalTxn: t,
      date: line.date,
      description: t.description || "",
      inAmountStr: line.amount > 0 ? String(line.amount) : "",
      outAmountStr: line.amount < 0 ? String(-line.amount) : "",
      exchangeChecked: line.exchangeAmount !== undefined,
      exchangeOutStr: line.exchangeAmount < 0 ? String(-line.exchangeAmount) : "",
      exchangeInStr: line.exchangeAmount > 0 ? String(line.exchangeAmount) : "",
      exchangeCurrency: line.exchangeCurrency ? line.exchangeCurrency : "",
      otherLines: others.map((o) => otherLineFromLine(o, o)),
      splitOffLines: [],
    };
  }

  function startEdit(t) {
    setDraft(buildDraftFromTxn(t));
    setDraftError("");
  }

  // True if the row being edited has actually changed since it was
  // opened (or, for a new entry, has anything entered at all) — used to
  // decide whether navigating away should just quietly drop it or ask
  // first. `key` is stripped from otherLines before comparing since it's
  // a fresh random id every time, not a real content difference.
  function isDraftDirty() {
    if (!draft) return false;
    if (draft.mode === "new") {
      return !!(
        draft.description.trim() || draft.inAmountStr !== "" || draft.outAmountStr !== "" ||
        draft.otherLines.length > 0 || (draft.exchangeChecked && (draft.exchangeOutStr !== "" || draft.exchangeInStr !== ""))
      );
    }
    if (!draft.originalTxn) return false;
    const fresh = buildDraftFromTxn(draft.originalTxn);
    const norm = (d) => JSON.stringify({ ...d, originalTxn: undefined, otherLines: d.otherLines.map(({ key, ...rest }) => rest) });
    return norm(draft) !== norm(fresh);
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

  // Rows sharing a date otherwise fall back to an arbitrary tiebreak — this
  // lets that order be set deliberately instead.
  function moveRow(idx, dir) {
    const updates = reorderSameDate(rows, idx, dir, account.id);
    if (updates) onUpdateTxns(updates);
  }

  function commit() {
    if (!draft) return false;
    const delta = draftDelta(draft);
    if (delta === 0) { setDraftError("Enter an amount in In or Out."); return false; }
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
    return true;
  }

  function cancel() {
    // The row is about to snap back to its original date/position — keep
    // following it with the same scroll-sync treatment it had while being
    // edited, even though `draft` (and so `editingKey`) is about to clear.
    if (draft && draft.mode === "edit") pendingSettleId.current = draft.txnId;
    setDraft(null);
    setDraftError("");
  }

  // Lets navigation elsewhere in the app check for, save, or discard an
  // in-progress edit here without lifting `draft` itself up to App.
  useEffect(() => {
    if (!guardRef) return;
    guardRef.current = { isDirty: isDraftDirty, commit, discard: cancel };
    return () => {
      guardRef.current = null;
    };
  });

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

        {rows.map((r, idx) => {
          const isEditing = r.txn.id === editingKey;
          const out = r.line.amount < 0 ? -r.line.amount : 0;
          const inn = r.line.amount > 0 ? r.line.amount : 0;
          const hint = balanceHint(r.txn.lines, accounts);
          const unbalanced = hint.type === "unbalanced";
          const hasAbove = idx > 0 && rows[idx - 1].line.date === r.line.date;
          const hasBelow = idx < rows.length - 1 && rows[idx + 1].line.date === r.line.date;

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

                <div className="mt-2" style={{ paddingLeft: 128 }}>
                  <label className="flex items-center gap-2" style={{ fontSize: 12, color: C.inkSoft }}>
                    <input type="checkbox" checked={!!draft.exchangeChecked} onChange={(e) => setDraft({ ...draft, exchangeChecked: e.target.checked })} />
                    Exchange
                    <span style={{ fontSize: 11, color: C.inkFaint }}>
                      {draft.otherLines.length === 0 ? "— the equivalent in another currency, for matching" : "— kept for reference"}
                    </span>
                  </label>
                  {draft.exchangeChecked && (
                    <div className="grid items-center mt-1.5" style={{ gridTemplateColumns: "120px 1fr 170px 100px 100px 120px 60px", gap: 8 }}>
                      <div />
                      <select value={draft.exchangeCurrency} onChange={(e) => setDraft({ ...draft, exchangeCurrency: e.target.value })} style={{ ...miniInput, width: 90 }}>
                        <option value="">currency…</option>
                        {CURRENCIES.filter((c) => c !== account.currency).map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                      <div />
                      <input
                        type="number" step="0.0001" placeholder="Out" value={draft.exchangeOutStr}
                        onChange={(e) => setDraft({ ...draft, exchangeOutStr: e.target.value })}
                        className="ll-mono text-right" style={{ ...miniInput, color: C.debit }}
                      />
                      <input
                        type="number" step="0.0001" placeholder="In" value={draft.exchangeInStr}
                        onChange={(e) => setDraft({ ...draft, exchangeInStr: e.target.value })}
                        className="ll-mono text-right" style={{ ...miniInput, color: C.credit }}
                      />
                      <div />
                      <div />
                    </div>
                  )}
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
              <div className="flex justify-end items-center gap-0.5">
                {hasAbove && (
                  <button onClick={(e) => { e.stopPropagation(); moveRow(idx, -1); }} title="Move earlier among same-date entries" style={{ padding: 2 }}>
                    <ChevronUp size={13} color={C.inkFaint} />
                  </button>
                )}
                {hasBelow && (
                  <button onClick={(e) => { e.stopPropagation(); moveRow(idx, 1); }} title="Move later among same-date entries" style={{ padding: 2 }}>
                    <ChevronDown size={13} color={C.inkFaint} />
                  </button>
                )}
                <Pencil size={13} color={C.inkFaint} />
              </div>
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
    cashChecked: false,
    cashInStr: "",
    cashOutStr: "",
  };
}

function StockLedger({ account, accounts, transactions, balance, onEditAccount, onSaveTxn, onDeleteTxn, onUpdateTxns, guardRef }) {
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
    if (d.cashChecked && (d.cashInStr !== "" || d.cashOutStr !== "")) {
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
    if (!draft.cashChecked || (draft.cashInStr === "" && draft.cashOutStr === "")) return [];
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
    const sorted = relevant.sort((a, b) => {
      if (a.line.date !== b.line.date) return a.line.date < b.line.date ? -1 : 1;
      const ao = a.line.order ?? 0, bo = b.line.order ?? 0;
      if (ao !== bo) return ao - bo;
      return String(a.txn.id).localeCompare(String(b.txn.id));
    });
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

  function buildDraftFromTxn(t) {
    const line = t.lines.find((l) => l.accountId === account.id);
    const other = t.lines.find((l) => l.accountId !== account.id);
    const naturalCash = line.cashValue !== undefined ? -line.cashValue : 0;
    return {
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
      cashChecked: line.cashValue !== undefined,
      cashInStr: naturalCash > 0 ? String(naturalCash) : "",
      cashOutStr: naturalCash < 0 ? String(-naturalCash) : "",
    };
  }

  function startEdit(t) {
    if (t.lines.length > 2) return;
    setDraft(buildDraftFromTxn(t));
    setDraftError("");
  }

  // True if the trade being edited has actually changed since it was
  // opened (or, for a new trade, has anything entered at all).
  function isDraftDirty() {
    if (!draft) return false;
    if (draft.mode === "new") {
      return !!(
        draft.description.trim() || draft.unitsInStr !== "" || draft.unitsOutStr !== "" ||
        draft.otherAccountId || (draft.cashChecked && (draft.cashInStr !== "" || draft.cashOutStr !== ""))
      );
    }
    if (!draft.originalTxn) return false;
    const fresh = buildDraftFromTxn(draft.originalTxn);
    const norm = (d) => JSON.stringify({ ...d, originalTxn: undefined });
    return norm(draft) !== norm(fresh);
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

  // Rows sharing a date otherwise fall back to an arbitrary tiebreak — this
  // lets that order be set deliberately instead.
  function moveRow(idx, dir) {
    const updates = reorderSameDate(rows, idx, dir, account.id);
    if (updates) onUpdateTxns(updates);
  }

  function commit() {
    if (!draft) return false;
    if (unitsDeltaOf(draft) === 0) { setDraftError("Enter units in or out."); return false; }
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
    return true;
  }

  function cancel() {
    if (draft && draft.mode === "edit") pendingSettleId.current = draft.txnId;
    setDraft(null);
    setDraftError("");
  }

  // Lets navigation elsewhere in the app check for, save, or discard an
  // in-progress edit here without lifting `draft` itself up to App.
  useEffect(() => {
    if (!guardRef) return;
    guardRef.current = { isDirty: isDraftDirty, commit, discard: cancel };
    return () => {
      guardRef.current = null;
    };
  });

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

        {rows.map((r, idx) => {
          const isEditing = r.txn.id === editingKey;
          const unitsOut = r.line.amount < 0 ? -r.line.amount : 0;
          const unitsIn = r.line.amount > 0 ? r.line.amount : 0;
          const natural = r.line.cashValue !== undefined ? -r.line.cashValue : null;
          const unmatched = r.txn.lines.length === 1;
          const hasAbove = idx > 0 && rows[idx - 1].line.date === r.line.date;
          const hasBelow = idx < rows.length - 1 && rows[idx + 1].line.date === r.line.date;

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

                <div className="mt-2" style={{ paddingLeft: 118 }}>
                  <label className="flex items-center gap-2" style={{ fontSize: 12, color: C.inkSoft }}>
                    <input
                      type="checkbox" checked={!!draft.cashChecked}
                      onChange={(e) => setDraft(draft.matchedTxnId ? { ...clearMatch(draft), cashChecked: e.target.checked } : { ...draft, cashChecked: e.target.checked })}
                    />
                    Cash
                  </label>
                  {draft.cashChecked && (
                    <div className="grid items-center mt-1.5" style={{ gridTemplateColumns: gridCols, gap: 8 }}>
                      <div /><div />
                      <input
                        type="number" step="0.01" placeholder="Out" value={draft.cashOutStr}
                        onChange={(e) => setDraft(draft.matchedTxnId ? { ...clearMatch(draft), cashOutStr: e.target.value } : { ...draft, cashOutStr: e.target.value })}
                        className="ll-mono text-right" style={{ ...miniInput, color: C.debit }}
                      />
                      <input
                        type="number" step="0.01" placeholder="In" value={draft.cashInStr}
                        onChange={(e) => setDraft(draft.matchedTxnId ? { ...clearMatch(draft), cashInStr: e.target.value } : { ...draft, cashInStr: e.target.value })}
                        className="ll-mono text-right" style={{ ...miniInput, color: C.credit }}
                      />
                      <div className="ll-mono" style={{ fontSize: 12.5, color: C.inkFaint }}>{account.currency}</div>
                      <div />
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 mt-2 flex-wrap" style={{ paddingLeft: 118 }}>
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
                <div className="flex justify-end items-center gap-0.5">
                  {hasAbove && (
                    <button onClick={(e) => { e.stopPropagation(); moveRow(idx, -1); }} title="Move earlier among same-date entries" style={{ padding: 2 }}>
                      <ChevronUp size={13} color={C.inkFaint} />
                    </button>
                  )}
                  {hasBelow && (
                    <button onClick={(e) => { e.stopPropagation(); moveRow(idx, 1); }} title="Move later among same-date entries" style={{ padding: 2 }}>
                      <ChevronDown size={13} color={C.inkFaint} />
                    </button>
                  )}
                  <Pencil size={13} color={C.inkFaint} />
                </div>
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
function AccountFormModal({ initial, accounts, onCancel, onSave, onDelete }) {
  const wrappers = accounts.filter((a) => a.type === "isa-parent");

  const [name, setName] = useState(initial.name || "");
  const [type, setType] = useState(initial.typePreset || initial.type || "asset");
  const [currency, setCurrency] = useState(initial.currency || "GBP");
  const [symbol, setSymbol] = useState(initial.symbol || "");
  const [opening, setOpening] = useState(initial.openingBalance ? String(initial.openingBalance) : "0");
  const [flexible, setFlexible] = useState(!!initial.flexible);
  const [institution, setInstitution] = useState(initial.institution || "");
  // "" = not an ISA, "cash-isa"/"lifetime-isa"/"innovative-finance-isa" = a
  // standalone flat ISA, or an isa-parent account id = "this is a
  // subaccount of that Stocks & Shares ISA wrapper".
  const [isaChoice, setIsaChoice] = useState(initial.isaParentPreset || initial.isaParentId || initial.isaKind || "");

  const isWrapper = type === "isa-parent";
  const isSubaccount = wrappers.some((w) => w.id === isaChoice);
  // Flexibility is a property of the ISA product itself (the wrapper, for
  // a Stocks & Shares ISA), not of each subaccount — so the toggle only
  // appears where it actually applies. Institution works the same way.
  const showFlexible = isWrapper || (!isSubaccount && !!isaChoice);
  const showInstitution = !isSubaccount;
  const knownInstitutions = Array.from(new Set(accounts.map((a) => a.institution).filter(Boolean))).sort();

  function submit() {
    if (!name.trim()) return;
    if (type === "investment" && !symbol.trim()) return;
    const data = {
      id: initial.id,
      name: name.trim(),
      type,
      currency,
      openingBalance: parseFloat(opening) || 0,
      ...(type === "investment" ? { symbol: symbol.trim().toUpperCase() } : {}),
      ...(showInstitution && institution.trim() ? { institution: institution.trim() } : {}),
    };
    const isaEligible = type === "asset" || type === "investment";
    if (isWrapper) {
      // A wrapper holds nothing directly — no currency or opening balance.
      delete data.currency;
      delete data.openingBalance;
      data.flexible = flexible;
    } else if (isaEligible && isSubaccount) {
      data.isaKind = "stocks-shares-isa";
      data.isaParentId = isaChoice;
    } else if (isaEligible && isaChoice) {
      data.isaKind = isaChoice;
      data.flexible = flexible;
    }
    onSave(data);
  }

  return (
    <ModalShell onCancel={onCancel} title={initial.id ? "Edit account" : "New account"}>
      <div className="flex flex-col gap-3" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}>
        <Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} placeholder="e.g. Barclays Current Account" /></Field>
        {showInstitution && (
          <Field label="Institution">
            <input value={institution} onChange={(e) => setInstitution(e.target.value)} style={inputStyle} placeholder="e.g. Barclays" list="ll-institutions" />
            <datalist id="ll-institutions">
              {knownInstitutions.map((i) => <option key={i} value={i} />)}
            </datalist>
          </Field>
        )}
        <Field label="Type">
          <select value={type} onChange={(e) => { setType(e.target.value); setIsaChoice(""); }} style={inputStyle} disabled={!!initial.typePreset}>
            {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </Field>

        {!isWrapper && type === "investment" && (
          <Field label="Symbol">
            <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} style={{ ...inputStyle, textTransform: "uppercase" }} placeholder="e.g. AAPL" />
          </Field>
        )}
        {!isWrapper && (
          <Field label={type === "investment" ? "Trading currency" : "Currency"}>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        )}
        {!isWrapper && type !== "investment" && (
          <Field label="Opening balance"><input type="number" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} style={inputStyle} /></Field>
        )}

        {!isWrapper && (type === "asset" || type === "investment") && (
          <Field label="ISA">
            <select value={isaChoice} onChange={(e) => setIsaChoice(e.target.value)} style={inputStyle} disabled={!!initial.isaParentPreset}>
              <option value="">Not an ISA</option>
              {type === "asset" && ISA_KINDS.filter((k) => k.key !== "stocks-shares-isa").map((k) => (
                <option key={k.key} value={k.key}>{k.label}</option>
              ))}
              {wrappers.map((w) => (
                <option key={w.id} value={w.id}>{type === "investment" ? "Part of" : "Cash within"}: {w.name}</option>
              ))}
            </select>
            {type === "investment" && wrappers.length === 0 && (
              <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 4 }}>Create a Stocks & Shares ISA wrapper first to hold this as a subaccount.</div>
            )}
          </Field>
        )}

        {showFlexible && (
          <label className="flex items-center gap-2" style={{ fontSize: 13, color: C.inkSoft }}>
            <input type="checkbox" checked={flexible} onChange={(e) => setFlexible(e.target.checked)} />
            Flexible ISA — withdrawals this tax year can be replaced without using extra allowance
          </label>
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
