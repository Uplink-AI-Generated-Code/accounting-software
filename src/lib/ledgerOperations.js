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

export function buildDeleteOperations(record) {
  return record.transactionId
    ? [{ op: "deleteTransaction", transactionId: record.transactionId }]
    : [{ op: "deleteLine", lineId: record.lines[0].id }];
}

// One operation per patched record — see lib/grouping.js's
// reorderSameDate(), which returns { transactionId, lineId, lines }
// patches directly in this shape.
export function buildReorderOperations(patches) {
  return patches.map(({ transactionId, lineId, lines }) =>
    transactionId ? { op: "upsertTransaction", transactionId, lines } : { op: "upsertLine", lineId, line: lines[0] }
  );
}
