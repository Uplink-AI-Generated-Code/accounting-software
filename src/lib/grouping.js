import { TYPES, GROUP_DIMENSIONS } from "./theme";

// An ISA subaccount doesn't set its own institution — it inherits its
// wrapper's, the same way it inherits flexibility. Always resolved
// against the *full* account list, since a nested grouping level may be
// working with a subset that doesn't include the wrapper itself.
export function institutionOf(account, allAccounts) {
  if (account.institution) return account.institution;
  if (account.isaParentId) {
    const parent = allAccounts.find((a) => a.id === account.isaParentId);
    if (parent && parent.institution) return parent.institution;
  }
  return "";
}

// Splits one set of accounts into labelled buckets along a single
// dimension. `allAccounts` is only needed to resolve inherited
// institutions correctly inside a nested/filtered subset. `symbols` is
// only needed to resolve an investment account's trading currency (which
// lives on its Symbol, not the account itself — see CLAUDE.md) for the
// "currency" dimension.
export function bucketBy(subset, dim, allAccounts, symbols = []) {
  if (dim === "type") {
    return TYPES.map((t) => ({ key: t.key, label: t.label, items: subset.filter((a) => a.type === t.key) })).filter((g) => g.items.length);
  }
  if (dim === "currency") {
    const byCur = {};
    const wrappers = [];
    subset.forEach((a) => {
      if (a.type === "isa-parent") { wrappers.push(a); return; }
      const cur = (a.type === "investment" ? symbols.find((s) => s.ticker === a.symbol)?.tradingCurrency : a.currency) || "—";
      byCur[cur] = byCur[cur] || [];
      byCur[cur].push(a);
    });
    const order = Object.keys(byCur).sort((a, b) => (a === "GBP" ? -1 : b === "GBP" ? 1 : a.localeCompare(b)));
    const groups = order.map((cur) => ({ key: cur, label: cur, items: byCur[cur] }));
    if (wrappers.length) groups.push({ key: "__isa", label: "Stocks & Shares ISAs", items: wrappers });
    return groups;
  }
  if (dim === "subtype") {
    // No inheritance from an ISA wrapper (unlike institution) — subtype is
    // a property of the individual account/product, not something a
    // wrapper meaningfully has one of on behalf of its subaccounts.
    const bySub = {};
    subset.forEach((a) => {
      const sub = a.subtype || "No subtype";
      bySub[sub] = bySub[sub] || [];
      bySub[sub].push(a);
    });
    const keys = Object.keys(bySub).sort((a, b) => (a === "No subtype" ? 1 : b === "No subtype" ? -1 : a.localeCompare(b)));
    return keys.map((k) => ({ key: k, label: k, items: bySub[k] }));
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
export function buildNestedGroups(subset, levels, allAccounts, symbols = []) {
  const [dim, ...rest] = levels;
  const buckets = bucketBy(subset, dim, allAccounts, symbols);
  return buckets.map((b) => ({
    key: `${dim}:${b.key}`,
    label: b.label,
    dim,
    items: b.items,
    leaf: rest.length === 0,
    children: rest.length === 0 ? null : buildNestedGroups(b.items, rest, allAccounts, symbols),
  }));
}

export function subtotalsForItems(items) {
  const sub = {};
  items.filter((a) => a.type !== "investment" && a.type !== "isa-parent").forEach((a) => { sub[a.currency] = (sub[a.currency] || 0) + (a.balance || 0); });
  return sub;
}

// A compact cascading picker for up to three nested grouping levels — the
// first is always active (defaulting to Type); each subsequent one offers
// "—" to stop nesting there, plus whichever dimensions aren't already
// used earlier in the chain. Changing a level resets anything after it,
// so the chain can never end up with a dimension repeated or a gap.
export function groupLevelsLabel(levels) {
  return levels.map((k) => GROUP_DIMENSIONS.find((d) => d.key === k)?.label || k).join(" › ");
}

// Computes the renumbered `order` values needed to move one row earlier
// or later among its same-date neighbours in this account's ledger.
// Rows with the same date otherwise have no inherent order, so this
// stamps a fresh 0..n-1 sequence across the whole same-date group rather
// than just swapping two values — which stays correct even when three or
// more rows share a date. Returns null if there's no same-date neighbour
// in that direction to move past.
//
// Each row must carry `record` (the full `{transactionId, lines}` this
// row belongs to) and `line` (this account's own line within it, the
// exact same object reference as one entry of `record.lines` — used
// below to patch only that one line's `order`, keeping the rest of a
// linked record's lines untouched). Returns record-shaped patches ready
// for lib/ledgerOperations.js's buildReorderOperations().
export function reorderSameDate(rows, idx, dir) {
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
    return {
      transactionId: r.record.transactionId,
      lineId: r.record.transactionId ? null : r.line.id,
      lines: r.record.lines.map((l) => (l === r.line ? { ...l, order: seq } : l)),
    };
  });
}
