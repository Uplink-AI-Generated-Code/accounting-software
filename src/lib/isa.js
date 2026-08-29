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

// The actual usage computation — computeIsaUsage's flexible-ISA lot
// simulation and isExternalLine's transfer detection — now lives in the
// backend (IsaAllowanceService), since it needs every ISA-tagged
// account's full transaction history. See api.getIsaAllowance() and
// AllowanceView.jsx. isaProducts() above stays here: it's pure and only
// needs the account list, which the frontend already has loaded.
