import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Check, X, AlertTriangle, Pencil, Unlink2, TrendingUp, TableProperties, ChevronUp, ChevronDown } from "lucide-react";
import { C } from "../lib/theme";
import { fmt, fmtUnits, todayISO, fmtDate } from "../lib/format";
import { toMinorUnits, fromMinorUnits, divRoundHalfUp } from "../lib/scale";
import { reorderSameDate } from "../lib/grouping";
import { applyCostBasisLine, applyPortfolioValueLine } from "../lib/stockMath";
import { formatCandidateAmount, candidateIsNegative } from "../lib/matching";
import { dateOutsideTaxYear, taxYearBounds } from "../lib/isa";
import { buildSaveOperations, buildUnlinkOperations, buildDeleteOperations, buildReorderOperations } from "../lib/ledgerOperations";
import { useOtherLines, OtherLinesEditor } from "./otherLines";
import { useAccountLedger } from "./useAccountLedger";
import { useMatchCandidates } from "./useMatchCandidates";
import { useLedgerRowAnimation } from "./useLedgerRowAnimation";
import { UnitsChart } from "./charts";
import { iconBtn, miniInput, ImbalanceBadge } from "./ui";

/* ---------------------------------------------------------
   Stock Ledger — one account, one security. Trades are units against a
   cash value; no price-per-unit field exists anywhere — it's always
   cashValue divided by units, computed on the fly, exactly like the FX
   rate in the cash ledger's currency exchange tag. Since the account has
   exactly one symbol and one trading currency (set at account creation),
   trades don't need to ask for either.
--------------------------------------------------------- */

// A record's stable row identity — see AccountLedger.jsx's rowKey().
function rowKey(record) {
  return record.transactionId || `line-${record.lines[0].id}`;
}

function blankStockDraft() {
  return {
    mode: "new",
    transactionId: null,
    lineId: null,
    date: todayISO(),
    description: "",
    otherLines: [],
    splitOffLines: [],
    unitsInStr: "",
    unitsOutStr: "",
    valueStr: "",
  };
}

export function StockLedger({ account, accounts, symbols, currencies, groupLevels, activeTaxYearStart, balance, onEditAccount, onLedgerOperations, guardRef }) {
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState("");
  const [view, setView] = useState("ledger");

  const { records, loaded, reload } = useAccountLedger(account.id);

  // Trading currency now lives on the Symbol, not the Account itself —
  // an investment account's own `currency` field is unused, see
  // CLAUDE.md. Units are scaled by the symbol's own scale, cash by the
  // trading currency's scale — two different scales, never conflated.
  const unitScale = symbols.find((s) => s.ticker === account.symbol)?.scale ?? 6;
  const tradingCurrency = symbols.find((s) => s.ticker === account.symbol)?.tradingCurrency;
  const cashScale = currencies.find((c) => c.code === tradingCurrency)?.scale ?? 2;

  function unitsDeltaOf(d) {
    const i = toMinorUnits(d.unitsInStr, unitScale);
    const o = toMinorUnits(d.unitsOutStr, unitScale);
    return (isNaN(i) ? 0 : i) - (isNaN(o) ? 0 : o);
  }
  // The cash side is never chosen independently — buying (units in)
  // always pays value out, selling (units out) always receives value in.
  // The sign comes from whichever units field is in use, so there's only
  // one number to type instead of two that have to agree with each other.
  function cashDeltaOf(d) {
    const mag = toMinorUnits(d.valueStr, cashScale);
    if (isNaN(mag)) return 0;
    const delta = unitsDeltaOf(d);
    if (delta > 0) return -mag;
    if (delta < 0) return mag;
    if (d.unitsInStr !== "") return -mag;
    if (d.unitsOutStr !== "") return mag;
    return 0;
  }

  const { otherLineFromLine, resolveOtherLine, addOtherLine, removeOtherLine, updateOtherLine, otherLineCandidates, selectMatchForOtherLine } = useOtherLines(
    account, accounts, draft, setDraft,
    (d) => {
      const natural = cashDeltaOf(d);
      return natural !== 0 ? { isOut: natural < 0, amountStr: fromMinorUnits(Math.abs(natural), cashScale) } : null;
    },
    currencies, symbols
  );

  function draftLines(d) {
    const unitsDelta = unitsDeltaOf(d);
    const cashNatural = cashDeltaOf(d);
    const desc = (d.description || "").trim();
    const line1 = { accountId: account.id, amount: unitsDelta, date: d.date || todayISO(), description: desc };
    if (d.valueStr !== "") {
      line1.cashValue = -cashNatural;
      line1.cashCurrency = tradingCurrency;
    }

    const activeOtherLines = d.otherLines.filter((ol) => {
      if (!ol.accountId) return false;
      if (ol.matchedLineId) return true;
      const olAcc = accounts.find((a) => a.id === ol.accountId);
      return olAcc && olAcc.type === "investment" ? ol.unitsStr !== "" : ol.amountStr !== "";
    });
    return [line1, ...activeOtherLines.map((ol) => resolveOtherLine(d, ol))];
  }

  const editingKey = draft ? (draft.mode === "edit" ? (draft.transactionId || `line-${draft.lineId}`) : "DRAFT_NEW") : null;

  // Match candidates for the trade's own tag — only offered before any
  // other leg has been added, since matching decides what the first one
  // should be. Same "-cashValue" convention as mirrored mode elsewhere —
  // see api.getMatchCandidates.
  const matchParams = useMemo(() => {
    if (!draft || draft.otherLines.length > 0) return null;
    if (unitsDeltaOf(draft) === 0 || !draft.date) return null;
    if (draft.valueStr === "") return null;
    const targetAmount = cashDeltaOf(draft); // = -cashValue, i.e. the real counterpart's own amount
    return { currency: tradingCurrency, amount: targetAmount, date: draft.date, excludeAccountIds: [account.id] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, account]);
  const matchCandidates = useMatchCandidates(matchParams);

  const effectiveRecords = useMemo(() => {
    let list = records;
    if (draft && draft.mode === "edit") {
      const key = draft.transactionId || `line-${draft.lineId}`;
      list = list.map((r) => {
        if (rowKey(r) !== key) return r;
        const lines = draftLines(draft);
        if (!draft.transactionId) lines[0] = { ...lines[0], id: draft.lineId };
        return { transactionId: draft.transactionId, lines };
      });
    }
    if (draft && draft.mode === "new") {
      list = [...list, { transactionId: "DRAFT_NEW", lines: draftLines(draft) }];
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, draft, account, accounts]);

  // One security per account, so a single running total — sorted and
  // balanced by this account's own line's own date, since the cash leg of
  // a trade can carry a different date.
  const rows = useMemo(() => {
    const relevant = effectiveRecords
      .filter((r) => r.lines.some((l) => l.accountId === account.id))
      .map((r) => ({ record: r, line: r.lines.find((l) => l.accountId === account.id) }));
    const sorted = relevant.sort((a, b) => {
      if (a.line.date !== b.line.date) return a.line.date < b.line.date ? -1 : 1;
      const ao = a.line.order ?? 0, bo = b.line.order ?? 0;
      if (ao !== bo) return ao - bo;
      return rowKey(a.record).localeCompare(rowKey(b.record));
    });
    let running = account.openingBalance || 0;
    const costState = { units: 0, cost: 0 };
    const valueState = { units: 0, lastPrice: 0, value: 0 };
    return sorted.map(({ record, line }) => {
      running += line.amount || 0;
      applyCostBasisLine(costState, line);
      applyPortfolioValueLine(valueState, line);
      const others = record.lines.filter((l) => l.accountId !== account.id).map((l) => accounts.find((a) => a.id === l.accountId)).filter(Boolean);
      return { record, line, running, runningCost: costState.cost, runningValue: valueState.value, others, key: rowKey(record) };
    });
  }, [effectiveRecords, account, accounts]);

  const { rowRefs, pendingSettleId } = useLedgerRowAnimation(rows, editingKey);

  // Current cost basis, portfolio value, and the average price cost basis
  // implies — all read straight off the ledger's own running totals, so
  // the header, each row, and the chart are always telling the same story.
  const costBasis = rows.length ? rows[rows.length - 1].runningCost : 0;
  const portfolioValue = rows.length ? rows[rows.length - 1].runningValue : 0;
  // Cost per *whole* unit, in the trading currency's own minor units —
  // costBasis and balance are integers of two different scales (cash vs
  // units), so the unit scale has to be multiplied back in before
  // dividing, exactly (see divRoundHalfUp — no float division).
  const avgCost = balance > 0 ? divRoundHalfUp(costBasis * 10 ** unitScale, balance) : null;

  function buildDraftFromRecord(record) {
    const line = record.lines.find((l) => l.accountId === account.id);
    const others = record.lines.filter((l) => l.accountId !== account.id);
    const naturalCash = line.cashValue !== undefined ? -line.cashValue : 0;
    return {
      mode: "edit",
      transactionId: record.transactionId,
      lineId: record.transactionId ? null : line.id,
      originalRecord: record,
      splitOffLines: [],
      date: line.date,
      description: line.description || "",
      unitsInStr: line.amount > 0 ? fromMinorUnits(line.amount, unitScale) : "",
      unitsOutStr: line.amount < 0 ? fromMinorUnits(-line.amount, unitScale) : "",
      valueStr: line.cashValue !== undefined ? fromMinorUnits(Math.abs(naturalCash), cashScale) : "",
      otherLines: others.map((o) => otherLineFromLine(o, o)),
    };
  }

  function startEdit(record) {
    setDraft(buildDraftFromRecord(record));
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
    if (!draft.originalRecord) return false;
    const fresh = buildDraftFromRecord(draft.originalRecord);
    const norm = (d) => JSON.stringify({ ...d, originalRecord: undefined, otherLines: d.otherLines.map(({ key, ...rest }) => rest) });
    return norm(draft) !== norm(fresh);
  }

  function selectMatch(candidate) {
    setDraft((d) => {
      if (!d) return d;
      const ol = otherLineFromLine(candidate.line, null);
      ol.matchedLineId = candidate.lineId;
      ol.matchedLine = candidate.line;
      return { ...d, otherLines: [...d.otherLines, ol] };
    });
  }

  // Splits an already-linked entry back into fully separate, unlinked
  // records — the exact reverse of a match. Nobody's data (including its
  // own date) is touched; each just goes back to standing alone.
  function unlinkNow() {
    if (!draft || !draft.originalRecord || draft.originalRecord.lines.length < 2) return;
    onLedgerOperations(buildUnlinkOperations(draft.transactionId, draft.originalRecord.lines)).then(reload);
    setDraft(null);
    setDraftError("");
  }

  // Rows sharing a date otherwise fall back to an arbitrary tiebreak — this
  // lets that order be set deliberately instead.
  function moveRow(idx, dir) {
    const patches = reorderSameDate(rows, idx, dir);
    if (patches) onLedgerOperations(buildReorderOperations(patches)).then(reload);
  }

  function commit() {
    if (!draft) return false;
    if (unitsDeltaOf(draft) === 0) { setDraftError("Enter units in or out."); return false; }
    const newLines = draftLines(draft);
    // See AccountLedger.jsx's commit() for why every line is checked, not
    // just draft.date, and why this mirrors the backend's own check.
    const offender = newLines.find((l) => dateOutsideTaxYear(l.date, activeTaxYearStart));
    if (offender) {
      setDraftError(`${fmtDate(offender.date)} is outside the ${taxYearBounds(activeTaxYearStart).label} tax year.`);
      return false;
    }
    const absorbedLineIds = draft.otherLines.filter((ol) => ol.matchedLineId).map((ol) => ol.matchedLineId);
    const operations = buildSaveOperations({
      oldTransactionId: draft.transactionId,
      oldLineId: draft.lineId,
      newLines,
      absorbedLineIds,
      extraStandaloneLines: draft.splitOffLines,
    });
    onLedgerOperations(operations).then(reload);
    setDraft(null);
    setDraftError("");
    return true;
  }

  function cancel() {
    if (draft && draft.mode === "edit") pendingSettleId.current = editingKey;
    setDraft(null);
    setDraftError("");
  }

  function deleteEntry() {
    if (!draft || !draft.originalRecord) return;
    onLedgerOperations(buildDeleteOperations(draft.originalRecord)).then(reload);
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
          <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>Stocks & Shares · {tradingCurrency}</div>
          <h2 className="ll-serif" style={{ fontSize: 24, marginTop: 2 }}>{account.name} <span style={{ color: C.gold }}>{account.symbol}</span></h2>
          <div className="ll-mono" style={{ fontSize: 22, marginTop: 6 }}>
            {fmtUnits(balance, account.symbol)} <span style={{ fontSize: 14, color: C.inkFaint }}>units</span>
            <span style={{ fontSize: 15, color: C.ink, marginLeft: 10 }}>{fmt(portfolioValue, tradingCurrency)}</span>
            {avgCost !== null && <span style={{ fontSize: 13, color: C.inkFaint, marginLeft: 10 }}>avg {fmt(avgCost, tradingCurrency)}/unit</span>}
          </div>
          <div style={{ fontSize: 12.5, color: C.inkFaint, marginTop: 2 }}>Cost basis {fmt(costBasis, tradingCurrency)}</div>
          <ImbalanceBadge account={account} currency={tradingCurrency} />
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
            onClick={() => { setDraft(blankStockDraft()); setDraftError(""); }}
            disabled={!!draft || !loaded}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded"
            style={{ background: draft || !loaded ? C.inkFaint : C.ink, color: C.paper, fontSize: 13, cursor: draft || !loaded ? "default" : "pointer" }}
          >
            <Plus size={14} /> Add trade
          </button>
        </div>
      </div>

      {view === "chart" ? (
        <UnitsChart account={account} transactions={records} tradingCurrency={tradingCurrency} />
      ) : (
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden", background: C.card }}>
        <div className="grid" style={{ gridTemplateColumns: gridCols, fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.6, color: C.inkFaint, padding: "10px 16px", borderBottom: `1px solid ${C.line}` }}>
          <div>Date</div><div>Description</div><div className="text-right">Units out</div><div className="text-right">Units in</div><div className="text-right">Balance</div><div />
        </div>

        {!loaded && <div style={{ padding: "24px 16px", fontSize: 13, color: C.inkFaint }}>Loading…</div>}
        {loaded && rows.length === 0 && !draft && <div style={{ padding: "24px 16px", fontSize: 13, color: C.inkFaint }}>No trades yet in this account.</div>}

        {rows.map((r, idx) => {
          const key = r.key;
          const isEditing = key === editingKey;
          const unitsOut = r.line.amount < 0 ? -r.line.amount : 0;
          const unitsIn = r.line.amount > 0 ? r.line.amount : 0;
          const natural = r.line.cashValue !== undefined ? -r.line.cashValue : null;
          const unmatched = r.record.transactionId === null;
          const hasAbove = idx > 0 && rows[idx - 1].line.date === r.line.date;
          const hasBelow = idx < rows.length - 1 && rows[idx + 1].line.date === r.line.date;

          if (isEditing) {
            const unitsSide = draft.unitsOutStr !== "" && draft.unitsInStr === "" ? "out" : "in";
            return (
              <div key={key} ref={(el) => (rowRefs.current[key] = el)} style={{ borderBottom: `1px solid ${C.lineSoft}`, background: C.paperDim, padding: "10px 16px" }}>
                <div className="grid items-center" style={{ gridTemplateColumns: gridCols, gap: 8 }}>
                  <input type="date" autoFocus value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} style={miniInput} />
                  <input type="text" placeholder="Description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={miniInput} />
                  <input
                    type="number" step={10 ** -unitScale} placeholder="Out" value={draft.unitsOutStr}
                    onChange={(e) => setDraft({ ...draft, unitsOutStr: e.target.value })}
                    className="ll-mono text-right" style={{ ...miniInput, color: C.debit }}
                    onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") cancel(); }}
                  />
                  <input
                    type="number" step={10 ** -unitScale} placeholder="In" value={draft.unitsInStr}
                    onChange={(e) => setDraft({ ...draft, unitsInStr: e.target.value })}
                    className="ll-mono text-right" style={{ ...miniInput, color: C.credit }}
                    onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") cancel(); }}
                  />
                  <div className="ll-mono text-right" style={{ fontWeight: 600, fontSize: 13.5 }}>{fmtUnits(r.running, account.symbol)}</div>
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
                      type="number" step={10 ** -cashScale} placeholder={tradingCurrency} value={draft.valueStr}
                      onChange={(e) => setDraft({ ...draft, valueStr: e.target.value })}
                      className="ll-mono text-right"
                      style={{ ...miniInput, gridColumn: unitsSide === "out" ? 3 : 4, color: unitsSide === "in" ? C.debit : C.credit }}
                    />
                    <div className="ll-mono" style={{ gridColumn: 5, fontSize: 12.5, color: C.inkFaint }}>{draft.valueStr !== "" ? tradingCurrency : ""}</div>
                  </div>
                </div>

                <OtherLinesEditor
                  draft={draft}
                  account={account}
                  accounts={accounts}
                  symbols={symbols}
                  groupLevels={groupLevels}
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
                          key={c.lineId}
                          type="button"
                          onClick={() => selectMatch(c)}
                          className="flex items-center justify-between px-2 py-1.5 rounded text-left"
                          style={{ border: `1px solid ${C.line}`, background: C.card }}
                        >
                          <span style={{ fontSize: 12.5 }}>
                            <strong>{c.account.name}</strong> · {fmtDate(c.line.date)}{c.line.description ? ` · ${c.line.description}` : ""}
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
                      {draft.originalRecord && draft.originalRecord.lines.length >= 2 && (
                        <button onClick={unlinkNow} title="Split back into separate, unlinked entries" className="flex items-center gap-1" style={{ fontSize: 12, color: C.gold }}><Unlink2 size={12} /> Unlink</button>
                      )}
                      <button onClick={deleteEntry} className="flex items-center gap-1" style={{ fontSize: 12, color: C.debit }}><Trash2 size={12} /> Delete</button>
                    </div>
                  )}
                </div>
              </div>
            );
          }

          return (
            <div
              key={key}
              ref={(el) => (rowRefs.current[key] = el)}
              onClick={() => (draft ? null : startEdit(r.record))}
              className="ll-row cursor-pointer"
              style={{ padding: "10px 16px", borderBottom: `1px solid ${C.lineSoft}` }}
            >
              <div className="grid items-center" style={{ gridTemplateColumns: gridCols, fontSize: 13.5 }}>
                <div style={{ color: C.inkSoft, fontSize: 12.5 }}>{fmtDate(r.line.date)}</div>
                <div className="flex items-center gap-2">
                  {r.line.description || <span style={{ color: C.inkFaint }}>—</span>}
                  {unmatched && <span title="Value side not yet matched to another account"><AlertTriangle size={12} color={C.gold} /></span>}
                </div>
                <div className="ll-mono text-right" style={{ color: unitsOut ? C.debit : C.inkFaint }}>{unitsOut ? fmtUnits(unitsOut, account.symbol) : "—"}</div>
                <div className="ll-mono text-right" style={{ color: unitsIn ? C.credit : C.inkFaint }}>{unitsIn ? fmtUnits(unitsIn, account.symbol) : "—"}</div>
                <div className="ll-mono text-right" style={{ fontWeight: 600 }}>{fmtUnits(r.running, account.symbol)}</div>
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
                Cost {fmt(r.runningCost, tradingCurrency)} · Worth {fmt(r.runningValue, tradingCurrency)}
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
