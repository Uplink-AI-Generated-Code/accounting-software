import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Check, X, AlertTriangle, Pencil, Unlink2, TrendingUp, TableProperties, ChevronUp, ChevronDown } from "lucide-react";
import { C } from "../lib/theme";
import { fmt, fmtUnits, todayISO, daysDiff, fmtDate } from "../lib/format";
import { reorderSameDate } from "../lib/grouping";
import { applyCostBasisLine, applyPortfolioValueLine } from "../lib/stockMath";
import { getComparableAmount, formatCandidateAmount, candidateIsNegative } from "../lib/matching";
import { useOtherLines, OtherLinesEditor } from "./otherLines";
import { useLedgerRowAnimation } from "./useLedgerRowAnimation";
import { UnitsChart } from "./charts";
import { iconBtn, miniInput } from "./ui";

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
    otherLines: [],
    splitOffLines: [],
    unitsInStr: "",
    unitsOutStr: "",
    valueStr: "",
  };
}

export function StockLedger({ account, accounts, transactions, balance, onEditAccount, onSaveTxn, onDeleteTxn, onUpdateTxns, guardRef }) {
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState("");
  const [view, setView] = useState("ledger");

  function unitsDeltaOf(d) {
    const i = parseFloat(d.unitsInStr);
    const o = parseFloat(d.unitsOutStr);
    return (isNaN(i) ? 0 : i) - (isNaN(o) ? 0 : o);
  }
  // The cash side is never chosen independently — buying (units in)
  // always pays value out, selling (units out) always receives value in.
  // The sign comes from whichever units field is in use, so there's only
  // one number to type instead of two that have to agree with each other.
  function cashDeltaOf(d) {
    const mag = parseFloat(d.valueStr);
    if (isNaN(mag)) return 0;
    const delta = unitsDeltaOf(d);
    if (delta > 0) return -mag;
    if (delta < 0) return mag;
    if (d.unitsInStr !== "") return -mag;
    if (d.unitsOutStr !== "") return mag;
    return 0;
  }

  const { otherLineFromLine, resolveOtherLine, addOtherLine, removeOtherLine, updateOtherLine, otherLineCandidates, selectMatchForOtherLine } = useOtherLines(
    account, accounts, transactions, draft, setDraft,
    (d) => {
      const natural = cashDeltaOf(d);
      return natural !== 0 ? { isOut: natural < 0, amountStr: String(Math.abs(natural)) } : null;
    }
  );

  function draftToTxn(d, forcedId) {
    const unitsDelta = unitsDeltaOf(d);
    const cashNatural = cashDeltaOf(d);
    const desc = (d.description || "").trim();
    const line1 = { accountId: account.id, amount: unitsDelta, date: d.date || todayISO(), description: desc };
    if (d.valueStr !== "") {
      line1.cashValue = -cashNatural;
      line1.cashCurrency = account.currency;
    }

    const activeOtherLines = d.otherLines.filter((ol) => {
      if (!ol.accountId) return false;
      if (ol.matchedTxnId) return true;
      const olAcc = accounts.find((a) => a.id === ol.accountId);
      return olAcc && olAcc.type === "investment" ? ol.unitsStr !== "" : ol.amountStr !== "";
    });
    if (activeOtherLines.length === 0) {
      return { id: forcedId || d.txnId, lines: [line1] };
    }
    const lines = [line1, ...activeOtherLines.map((ol) => resolveOtherLine(d, ol))];
    return { id: forcedId || d.txnId, lines };
  }

  const editingKey = draft ? (draft.mode === "edit" ? draft.txnId : "DRAFT_NEW") : null;

  // Match candidates for the trade's own tag — only offered before any
  // other leg has been added, since matching decides what the first one
  // should be. Same "-cashValue" convention as getComparableAmount.
  const matchCandidates = useMemo(() => {
    if (!draft || draft.otherLines.length > 0) return [];
    if (unitsDeltaOf(draft) === 0 || !draft.date) return [];
    if (draft.valueStr === "") return [];
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
    const costState = { units: 0, cost: 0 };
    const valueState = { units: 0, lastPrice: 0, value: 0 };
    return sorted.map(({ txn: t, line }) => {
      running += line.amount || 0;
      applyCostBasisLine(costState, line);
      applyPortfolioValueLine(valueState, line);
      const others = t.lines.filter((l) => l.accountId !== account.id).map((l) => accounts.find((a) => a.id === l.accountId)).filter(Boolean);
      return { txn: t, line, running, runningCost: costState.cost, runningValue: valueState.value, others };
    });
  }, [effectiveTxns, account, accounts]);

  const { rowRefs, pendingSettleId } = useLedgerRowAnimation(rows, editingKey);

  // Current cost basis, portfolio value, and the average price cost basis
  // implies — all read straight off the ledger's own running totals, so
  // the header, each row, and the chart are always telling the same story.
  const costBasis = rows.length ? rows[rows.length - 1].runningCost : 0;
  const portfolioValue = rows.length ? rows[rows.length - 1].runningValue : 0;
  const avgCost = balance > 0 ? costBasis / balance : null;

  function buildDraftFromTxn(t) {
    const line = t.lines.find((l) => l.accountId === account.id);
    const others = t.lines.filter((l) => l.accountId !== account.id);
    const naturalCash = line.cashValue !== undefined ? -line.cashValue : 0;
    return {
      mode: "edit",
      txnId: t.id,
      originalTxn: t,
      splitOffLines: [],
      date: line.date,
      description: line.description || "",
      unitsInStr: line.amount > 0 ? String(line.amount) : "",
      unitsOutStr: line.amount < 0 ? String(-line.amount) : "",
      valueStr: line.cashValue !== undefined ? String(Math.abs(naturalCash)) : "",
      otherLines: others.map((o) => otherLineFromLine(o, o)),
    };
  }

  function startEdit(t) {
    setDraft(buildDraftFromTxn(t));
    setDraftError("");
  }

  // True if the trade being edited has actually changed since it was
  // opened (or, for a new trade, has anything entered at all). `key` is
  // stripped from otherLines before comparing since it's a fresh random
  // id every time, not a real content difference.
  function isDraftDirty() {
    if (!draft) return false;
    if (draft.mode === "new") {
      return !!(
        draft.description.trim() || draft.unitsInStr !== "" || draft.unitsOutStr !== "" ||
        draft.otherLines.length > 0 || draft.valueStr !== ""
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

  // Splits an already-linked entry back into fully separate, unlinked
  // records — the exact reverse of a match. Nobody's data (including its
  // own date) is touched; each just goes back to standing alone.
  function unlinkNow() {
    if (!draft || !draft.originalTxn || draft.originalTxn.lines.length < 2) return;
    const t = draft.originalTxn;
    const mine = t.lines.find((l) => l.accountId === account.id);
    const rest = t.lines.filter((l) => l.accountId !== account.id);
    onSaveTxn(
      { id: t.id, lines: [mine] },
      undefined,
      rest.map((l) => ({ lines: [l] }))
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
    const matchedId = draft.otherLines.find((ol) => ol.matchedTxnId)?.matchedTxnId;
    const splitOffExtras = draft.splitOffLines.length
      ? draft.splitOffLines.map((sn) => ({ lines: [sn] }))
      : undefined;
    onSaveTxn(
      { id: draft.mode === "edit" ? draft.txnId : undefined, lines: data.lines },
      matchedId,
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
            <span style={{ fontSize: 15, color: C.ink, marginLeft: 10 }}>{fmt(portfolioValue, account.currency)}</span>
            {avgCost !== null && <span style={{ fontSize: 13, color: C.inkFaint, marginLeft: 10 }}>avg {fmt(avgCost, account.currency)}/unit</span>}
          </div>
          <div style={{ fontSize: 12.5, color: C.inkFaint, marginTop: 2 }}>Cost basis {fmt(costBasis, account.currency)}</div>
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
            const unitsSide = draft.unitsOutStr !== "" && draft.unitsInStr === "" ? "out" : "in";
            return (
              <div key={r.txn.id} ref={(el) => (rowRefs.current[r.txn.id] = el)} style={{ borderBottom: `1px solid ${C.lineSoft}`, background: C.paperDim, padding: "10px 16px" }}>
                <div className="grid items-center" style={{ gridTemplateColumns: gridCols, gap: 8 }}>
                  <input type="date" autoFocus value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} style={miniInput} />
                  <input type="text" placeholder="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={miniInput} />
                  <input
                    type="number" step="0.000001" placeholder="Out" value={draft.unitsOutStr}
                    onChange={(e) => setDraft({ ...draft, unitsOutStr: e.target.value })}
                    className="ll-mono text-right" style={{ ...miniInput, color: C.debit }}
                    onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") cancel(); }}
                  />
                  <input
                    type="number" step="0.000001" placeholder="In" value={draft.unitsInStr}
                    onChange={(e) => setDraft({ ...draft, unitsInStr: e.target.value })}
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
                  <div style={{ fontSize: 12, color: C.inkSoft, marginBottom: 4 }}>
                    Value <span style={{ color: C.inkFaint, fontWeight: 400 }}>— {unitsSide === "out" ? "received for the units sold" : "paid for the units acquired"}</span>
                  </div>
                  <div className="grid items-center" style={{ gridTemplateColumns: gridCols, gap: 8 }}>
                    <input
                      type="number" step="0.01" placeholder={account.currency} value={draft.valueStr}
                      onChange={(e) => setDraft({ ...draft, valueStr: e.target.value })}
                      className="ll-mono text-right"
                      style={{ ...miniInput, gridColumn: unitsSide === "out" ? 3 : 4, color: unitsSide === "in" ? C.debit : C.credit }}
                    />
                    <div className="ll-mono" style={{ gridColumn: 5, fontSize: 12.5, color: C.inkFaint }}>{draft.valueStr !== "" ? account.currency : ""}</div>
                  </div>
                </div>

                <OtherLinesEditor
                  draft={draft}
                  account={account}
                  accounts={accounts}
                  otherLineCandidates={otherLineCandidates}
                  updateOtherLine={updateOtherLine}
                  removeOtherLine={removeOtherLine}
                  selectMatchForOtherLine={selectMatchForOtherLine}
                  addOtherLine={addOtherLine}
                  paddingLeft={118}
                />

                {draft.splitOffLines.length > 0 && (
                  <div className="mt-2" style={{ paddingLeft: 118, fontSize: 11.5, color: C.inkFaint }}>
                    The removed line will be saved as a separate, unlinked entry — not deleted.
                  </div>
                )}

                {draft.otherLines.length === 0 && matchCandidates.length > 0 && (
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
                            <strong>{c.acc.name}</strong> · {fmtDate(c.line.date)}{c.line.description ? ` · ${c.line.description}` : ""}
                          </span>
                          <span className="ll-mono" style={{ fontSize: 12.5, color: candidateIsNegative(c) ? C.debit : C.credit }}>{formatCandidateAmount(c)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between mt-2">
                  <span style={{ fontSize: 12, color: draftError ? C.debit : C.inkFaint }}>
                    {draftError || (draft.otherLines.length > 0 ? "Value leg linked" : "Value side unmatched — can be matched to a cash account later")}
                  </span>
                  {draft.mode === "edit" && (
                    <div className="flex items-center gap-3">
                      {draft.originalTxn && draft.originalTxn.lines.length >= 2 && (
                        <button onClick={unlinkNow} title="Split back into separate, unlinked entries" className="flex items-center gap-1" style={{ fontSize: 12, color: C.gold }}><Unlink2 size={12} /> Unlink</button>
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
                  {r.line.description || <span style={{ color: C.inkFaint }}>—</span>}
                  {unmatched && <span title="Value side not yet matched to another account"><AlertTriangle size={12} color={C.gold} /></span>}
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
              <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 3, paddingLeft: 118 }}>
                {natural !== null && <>Value {fmt(natural, r.line.cashCurrency)} · </>}
                Cost {fmt(r.runningCost, account.currency)} · Worth {fmt(r.runningValue, account.currency)}
                {r.others.length > 0 ? ` · ${r.others.map((a) => a.name).join(", ")}` : " · unmatched"}
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
