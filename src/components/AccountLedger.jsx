import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Check, X, ArrowLeftRight, AlertTriangle, Pencil, Unlink2, TrendingUp, TableProperties, ChevronUp, ChevronDown } from "lucide-react";
import { C, TYPES, CURRENCIES } from "../lib/theme";
import { fmt, todayISO, fmtDate } from "../lib/format";
import { reorderSameDate } from "../lib/grouping";
import { formatCandidateAmount, candidateIsNegative, balanceHint } from "../lib/matching";
import { blankOtherLine, useOtherLines, OtherLinesEditor } from "./otherLines";
import { useAccountLedger } from "./useAccountLedger";
import { useMatchCandidates } from "./useMatchCandidates";
import { useLedgerRowAnimation } from "./useLedgerRowAnimation";
import { BalanceChart } from "./charts";
import { iconBtn, miniInput } from "./ui";

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

export function AccountLedger({ account, accounts, balance, onEditAccount, onSaveTxn, onDeleteTxn, onUpdateTxns, guardRef }) {
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState("");
  const [view, setView] = useState("ledger");

  // This account's own transactions — fetched on mount and whenever the
  // account changes, discarded on navigating away. reload() is called
  // after this ledger's own mutations succeed.
  const { transactions, loaded, reload } = useAccountLedger(account.id);

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

  const { otherLineFromLine, resolveOtherLine, addOtherLine, removeOtherLine, updateOtherLine, otherLineCandidates, selectMatchForOtherLine } = useOtherLines(
    account, accounts, draft, setDraft,
    (d) => {
      const delta = draftDelta(d);
      return delta !== 0 ? { isOut: delta > 0, amountStr: String(Math.abs(delta)) } : null;
    }
  );

  function draftToTxn(d, forcedId) {
    const delta = draftDelta(d);
    const line1 = { accountId: account.id, amount: delta, date: d.date || todayISO(), description: (d.description || "").trim() };

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
      return { id: forcedId || d.txnId, lines: [line1] };
    }

    const lines = [line1, ...activeOtherLines.map((ol) => resolveOtherLine(d, ol))];
    return { id: forcedId || d.txnId, lines };
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
  // Searched server-side (mirrored mode), so this also picks up the cash
  // side of stock trades automatically — see api.getMatchCandidates.
  const matchParams = useMemo(() => {
    if (!draft || draft.otherLines.length > 0) return null;
    const delta = draftDelta(draft);
    if (delta === 0 || !draft.date) return null;

    let targetAmount = -delta;
    let targetCurrency = account.currency;
    if (draft.exchangeChecked && draft.exchangeCurrency && (draft.exchangeOutStr !== "" || draft.exchangeInStr !== "")) {
      targetAmount = -exchangeDelta(draft);
      targetCurrency = draft.exchangeCurrency;
    }

    return { currency: targetCurrency, amount: targetAmount, date: draft.date, excludeTransactionId: draft.txnId, excludeAccountIds: [account.id] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, account]);
  const matchCandidates = useMatchCandidates(matchParams);

  // Once a split has more than one leg, each not-yet-assigned leg also
  // gets its own candidate search — see useOtherLines.

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
      description: line.description || "",
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
      ol.matchedLine = candidate.line;
      return { ...d, otherLines: [...d.otherLines, ol] };
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
      { id: t.id, lines: [mine] },
      undefined,
      rest.map((l) => ({ lines: [l] }))
    ).then(reload);
    setDraft(null);
    setDraftError("");
  }

  // Rows sharing a date otherwise fall back to an arbitrary tiebreak — this
  // lets that order be set deliberately instead.
  function moveRow(idx, dir) {
    const updates = reorderSameDate(rows, idx, dir, account.id);
    if (updates) onUpdateTxns(updates).then(reload);
  }

  function commit() {
    if (!draft) return false;
    const delta = draftDelta(draft);
    if (delta === 0) { setDraftError("Enter an amount in In or Out."); return false; }
    const data = draftToTxn(draft, draft.mode === "edit" ? draft.txnId : undefined);
    const matchedId = draft.otherLines.find((ol) => ol.matchedTxnId)?.matchedTxnId;
    const splitOffExtras = draft.splitOffLines.length
      ? draft.splitOffLines.map((sn) => ({ lines: [sn] }))
      : undefined;
    onSaveTxn(
      { id: draft.mode === "edit" ? draft.txnId : undefined, lines: data.lines },
      matchedId,
      splitOffExtras
    ).then(reload);
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
            disabled={!!draft || !loaded}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded"
            style={{ background: draft || !loaded ? C.inkFaint : C.ink, color: C.paper, fontSize: 13, cursor: draft || !loaded ? "default" : "pointer" }}
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

        {!loaded && <div style={{ padding: "24px 16px", fontSize: 13, color: C.inkFaint }}>Loading…</div>}

        {loaded && rows.length === 0 && !draft && <div style={{ padding: "24px 16px", fontSize: 13, color: C.inkFaint }}>No entries yet in this account.</div>}

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

                <OtherLinesEditor
                  draft={draft}
                  account={account}
                  accounts={accounts}
                  otherLineCandidates={otherLineCandidates}
                  updateOtherLine={updateOtherLine}
                  removeOtherLine={removeOtherLine}
                  selectMatchForOtherLine={selectMatchForOtherLine}
                  addOtherLine={addOtherLine}
                  paddingLeft={128}
                />

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
                            <strong>{c.acc.name}</strong> · {fmtDate(c.line.date)}{c.line.description ? ` · ${c.line.description}` : ""}
                          </span>
                          <span className="ll-mono" style={{ fontSize: 12.5, color: candidateIsNegative(c) ? C.debit : C.credit }}>{formatCandidateAmount(c)}</span>
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
                      <button onClick={() => { onDeleteTxn(draft.txnId).then(reload); setDraft(null); setDraftError(""); }} className="flex items-center gap-1" style={{ fontSize: 12, color: C.debit }}><Trash2 size={12} /> Delete</button>
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
                <span style={{ color: unbalanced ? C.debit : C.ink }}>{r.line.description || <span style={{ color: C.inkFaint }}>—</span>}</span>
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
