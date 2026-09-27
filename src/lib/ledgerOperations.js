import { uid } from "./format";

// Builds the operations array for POST /api/ledger/batch — see
// backend/src/Service/LedgerStateService.php's applyLedgerOperations()
// docblock for the four primitives these compose. Shared by
// AccountLedger.jsx and StockLedger.jsx so the standalone-vs-linked
// transition logic exists in exactly one place.
//
// A record is `{ transactionId: string|null, lines: [...] }` — standalone
// (transactionId null) or linked (2+ lines, always a real transactionId).
// Line ids don't survive a shape transition (standalone becoming linked,
// or vice versa) — a fresh row is always created on the new side, matching
// this endpoint's existing "wholesale replace, don't diff" philosophy.
// They *do* survive a same-shape edit (upsertLine/upsertTransaction with
// the existing id).

// oldTransactionId/oldLineId: this record's identity before the edit
//   (exactly one set, or both null for a brand new entry).
// newLines: the full new lines array for this record (>=1).
// absorbedLineIds: standalone lines being matched/merged in — their old
//   rows are retired.
// extraStandaloneLines: legs split off this record that become their own
//   new standalone entries (never re-linked to anything).
export function buildSaveOperations({ oldTransactionId, oldLineId, newLines, absorbedLineIds = [], extraStandaloneLines = [] }) {
  const ops = absorbedLineIds.map((lineId) => ({ op: "deleteLine", lineId }));

  if (newLines.length >= 2) {
    const transactionId = oldTransactionId || uid();
    if (oldLineId) ops.push({ op: "deleteLine", lineId: oldLineId });
    ops.push({ op: "upsertTransaction", transactionId, lines: newLines });
  } else {
    if (oldTransactionId) ops.push({ op: "deleteTransaction", transactionId: oldTransactionId });
    ops.push({ op: "upsertLine", lineId: oldLineId || null, line: newLines[0] });
  }

  extraStandaloneLines.forEach((line) => ops.push({ op: "upsertLine", lineId: null, line }));

  return ops;
}

// Splits an already-linked record back into N fully separate, unlinked
// standalone lines — the reverse of a merge. None of the lines' own data
// (including dates) is touched; each just goes back to standing alone.
export function buildUnlinkOperations(transactionId, lines) {
  return [
    { op: "deleteTransaction", transactionId },
    ...lines.map((line) => ({ op: "upsertLine", lineId: null, line })),
  ];
}

// Deletes only the calling account's own leg(s) of a record. A standalone
// line just goes. A linked transaction never has any other account's
// line(s) discarded with it — mirroring removeOtherLine()'s "removing a
// leg never deletes the other side's data" rule (see CLAUDE.md's
// "Matching and linking"). If 2+ other lines remain, this is really just
// an edit of the same transaction down to fewer lines — one
// `upsertTransaction` against its existing `transactionId`, same as
// buildSaveOperations' own oldTransactionId/newLines.length>=2 branch, no
// separate delete needed. Only when a single line remains does the
// transaction itself have to go (a Transaction is never fewer than 2
// lines — see "Data model" in CLAUDE.md), demoting that survivor to a
// standalone line the same way buildSaveOperations' 2→1 branch already
// does.
export function buildDeleteOperations(record, accountId) {
  if (!record.transactionId) {
    return [{ op: "deleteLine", lineId: record.lines[0].id }];
  }
  const remaining = record.lines.filter((l) => l.accountId !== accountId);
  if (remaining.length >= 2) {
    return [{ op: "upsertTransaction", transactionId: record.transactionId, lines: remaining }];
  }
  return [
    { op: "deleteTransaction", transactionId: record.transactionId },
    ...remaining.map((line) => ({ op: "upsertLine", lineId: null, line })),
  ];
}

// One operation per patched record — see lib/grouping.js's
// reorderSameDate(), which returns { transactionId, lineId, lines }
// patches directly in this shape.
export function buildReorderOperations(patches) {
  return patches.map(({ transactionId, lineId, lines }) =>
    transactionId ? { op: "upsertTransaction", transactionId, lines } : { op: "upsertLine", lineId, line: lines[0] }
  );
}
