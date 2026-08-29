import { ISA_KINDS } from "./theme";

/* ---------------------------------------------------------
   UK ISA allowance rules
   Keyed by the tax year's start year (a UK tax year runs 6 April to the
   following 5 April). To handle a future rule change, add a new row here
   — everything else (which tax year "today" falls in, which cap applies)
   is derived automatically, nothing else in the app needs editing.
--------------------------------------------------------- */
// startYear = the calendar year the tax year begins in (e.g. 2026 means
// the 2026/27 tax year, 6 April 2026 – 5 April 2027).
const ISA_RULE_TABLE = [
  { startYear: 2026, total: 20000, subCaps: { "lifetime-isa": 4000 } },
  { startYear: 2027, total: 20000, subCaps: { "lifetime-isa": 4000, "cash-isa": 12000 } },
];

// UK tax years run 6 April – 5 April, not the calendar year.
export function taxYearStartYearFor(dateISO) {
  const d = new Date(dateISO + "T00:00:00");
  const y = d.getFullYear();
  const boundary = new Date(y, 3, 6); // 6 April, month is 0-indexed
  return d < boundary ? y - 1 : y;
}
export function taxYearBounds(startYear) {
  const start = `${startYear}-04-06`;
  const end = `${startYear + 1}-04-05`;
  return { start, end, label: `${startYear}/${String(startYear + 1).slice(2)}` };
}
// Rules in effect for a given tax year — falls back to the latest known
// rule set for any year beyond the table, since allowances don't lapse.
// Over-65s are exempt from the Cash ISA sub-cap once it exists.
export function isaRulesFor(startYear, over65) {
  const applicable = ISA_RULE_TABLE.filter((r) => r.startYear <= startYear);
  const rules = applicable.length ? applicable[applicable.length - 1] : ISA_RULE_TABLE[0];
  if (over65 && rules.subCaps["cash-isa"] !== undefined) {
    const { "cash-isa": _drop, ...rest } = rules.subCaps;
    return { ...rules, subCaps: rest };
  }
  return rules;
}

// account is its own product; a Stocks & Shares ISA wrapper and all of
// its subaccounts together form one product, since both the allowance
// and flexibility apply to the ISA itself, not each subaccount.
export function isaProducts(accounts) {
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
export function computeIsaUsage(accounts, transactions, startYear) {
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
