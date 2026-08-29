import { useMemo } from "react";
import { Plus, X, Check } from "lucide-react";
import { C } from "../lib/theme";
import { uid, todayISO, daysDiff, fmtDate } from "../lib/format";
import { getDirectComparableAmount, formatCandidateAmount, candidateIsNegative } from "../lib/matching";
import { miniInput } from "./ui";

/* ---------------------------------------------------------
   Account Ledger — inline add/edit, live FLIP reorder + autoscroll
--------------------------------------------------------- */
export function blankOtherLine(accountId) {
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

// Shared by both ledgers: everything needed to manage a draft's array of
// "other account" legs — building one from an existing line, resolving
// one back to a savable line, adding/removing/updating them, and finding
// match candidates for whichever legs don't have an account chosen yet.
// Parameterized by whichever account is being edited (cash or stock) so
// the same logic drives both without duplicating it.
export function useOtherLines(account, accounts, transactions, draft, setDraft, smartDefaultForFirst) {
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
      const base = unchanged ? { ...ol.snapshot } : { accountId: ol.accountId, date: d.date || todayISO(), description: d.description };
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
    if (unchanged) return { ...ol.snapshot, amount: amt };
    return { accountId: ol.accountId, amount: amt, date: d.date || todayISO(), description: d.description };
  }

  function addOtherLine() {
    setDraft((d) => {
      if (!d) return d;
      const isFirst = d.otherLines.length === 0;
      const ol = blankOtherLine("");
      if (isFirst && smartDefaultForFirst) {
        const sd = smartDefaultForFirst(d);
        if (sd) { ol.isOut = sd.isOut; ol.amountStr = sd.amountStr; }
      }
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

  // Each not-yet-assigned leg gets its own candidate search, using
  // exactly what's typed into that leg's own In/Out + amount as a
  // *direct* description of what the other record should show.
  // getDirectComparableAmount un-mirrors a stock trade's cashValue so
  // that means the same thing a plain account's amount already does.
  const otherLineCandidates = useMemo(() => {
    if (!draft || !draft.date) return {};
    const usedAccountIds = new Set([account.id, ...draft.otherLines.map((o) => o.accountId).filter(Boolean)]);
    const map = {};
    draft.otherLines.forEach((ol) => {
      if (ol.accountId || ol.matchedTxnId) return;
      const mag = parseFloat(ol.amountStr);
      if (isNaN(mag) || mag === 0) return;
      const targetAmount = ol.isOut ? -mag : mag;
      const targetCurrency = account.currency;
      const candidates = transactions
        .filter((t) => t.id !== draft.txnId && t.lines.length === 1)
        .map((t) => ({ txn: t, line: t.lines[0], acc: accounts.find((a) => a.id === t.lines[0].accountId) }))
        .filter((c) => c.acc && !usedAccountIds.has(c.acc.id))
        .map((c) => ({ ...c, comparable: getDirectComparableAmount(c.line, c.acc, targetCurrency) }))
        .filter((c) => c.comparable !== undefined && Math.abs(c.comparable - targetAmount) < 0.005)
        .filter((c) => Math.abs(daysDiff(draft.date, c.line.date)) <= 3)
        .sort((a, b) => Math.abs(daysDiff(draft.date, a.line.date)) - Math.abs(daysDiff(draft.date, b.line.date)));
      if (candidates.length) map[ol.key] = candidates;
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, transactions, accounts, account]);

  function selectMatchForOtherLine(key, candidate) {
    setDraft((d) => {
      if (!d) return d;
      const otherLines = d.otherLines.map((ol) => {
        if (ol.key !== key) return ol;
        const resolved = otherLineFromLine(candidate.line, null);
        resolved.key = ol.key;
        resolved.matchedTxnId = candidate.txn.id;
        return resolved;
      });
      return { ...d, otherLines };
    });
  }

  return { otherLineFromLine, resolveOtherLine, addOtherLine, removeOtherLine, updateOtherLine, otherLineCandidates, selectMatchForOtherLine };
}

// The list of "other account" leg rows shared by both ledgers' editors —
// an account picker, then either plain In/Out + amount, or (for an
// investment account) units and cost fields, plus that leg's own match
// suggestions when it doesn't have an account chosen yet.
export function OtherLinesEditor({ draft, account, accounts, otherLineCandidates, updateOtherLine, removeOtherLine, selectMatchForOtherLine, addOtherLine, paddingLeft }) {
  return (
    <>
      {draft.otherLines.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5" style={{ paddingLeft }}>
          {draft.otherLines.map((ol) => {
            const olAcc = accounts.find((a) => a.id === ol.accountId);
            const isStock = olAcc && olAcc.type === "investment";
            const olCandidates = otherLineCandidates[ol.key];
            return (
              <div key={ol.key} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 flex-wrap">
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
                {!ol.accountId && !ol.matchedTxnId && olCandidates && olCandidates.length > 0 && (
                  <div className="flex flex-col gap-1" style={{ paddingLeft: 4 }}>
                    <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.5 }}>Possible matches</div>
                    {olCandidates.map((c) => (
                      <button
                        key={c.txn.id}
                        type="button"
                        onClick={() => selectMatchForOtherLine(ol.key, c)}
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
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="flex items-center gap-3 mt-2 flex-wrap" style={{ paddingLeft }}>
        <button type="button" onClick={addOtherLine} className="flex items-center gap-1" style={{ fontSize: 12, color: C.gold }}>
          <Plus size={12} /> {draft.otherLines.length === 0 ? "Link another account" : "Add split line"}
        </button>
      </div>
    </>
  );
}
