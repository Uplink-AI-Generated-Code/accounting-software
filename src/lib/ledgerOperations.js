// Builds the operations array for POST /api/ledger/batch — see
// backend/src/Service/LedgerStateService.php's applyLedgerOperations()
// docblock for the five primitives these compose. Shared by
// AccountLedger.jsx and StockLedger.jsx so the standalone-vs-linked
// transition logic exists in exactly one place.
//
// A record is `{ transactionId: string|null, lines: [...] }` — standalone
// (transactionId null) or linked (2+ lines). Transaction lifecycle
// (creating one, extending one, dissolving one, demoting a lone survivor
// back to standalone) is decided entirely by the backend now — this
// module only ever expresses intent: create this line, edit that one,
// put these lines together, take this one out of its group, delete this
// one outright. Line ids never need to be invented client-side any more:
// a brand-new line is given a `tempId` and referenced by it within the
// same batch, resolved to its real id by the backend before the batch
// commits.

let tempIdCounter = 0;
function nextTempId() {
  return `tmp${++tempIdCounter}`;
}

// Builds the ops for saving one record's full edit: the primary line
// (this account's own leg, always present in `newLines[0]`), any other
// legs still active, and any legs explicitly split off this save.
// `primaryLineId` is this account's own existing line id — whether it was
// standalone or already linked — or null for a brand-new entry. Each
// other line in `newLines` (index >= 1) carries its own `id` already if
// it has a backing row (a pre-existing unchanged leg, or one selected via
// match search) — see otherLines.jsx's `resolveOtherLine`.
export function buildSaveOperations({ primaryLineId, newLines, splitOffLineIds = [] }) {
  const ops = splitOffLineIds.map((lineId) => ({ op: "unlinkLine", lineId }));

  const refs = newLines.map((line, i) => {
    const existingId = i === 0 ? primaryLineId : (line.id ?? null);
    if (existingId) {
      ops.push({ op: "updateLine", lineId: existingId, ...line });
      return existingId;
    }
    const tempId = nextTempId();
    ops.push({ op: "createLine", tempId, ...line });
    return tempId;
  });

  if (refs.length >= 2) {
    ops.push({ op: "linkLines", lineIds: refs });
  }

  return ops;
}

// Splits an already-linked record back into N fully separate, unlinked
// standalone lines — the reverse of a merge. No side's data (including
// its own date) is touched; each just goes back to standing alone.
// unlinkLine is idempotent, so every line of the record is sent — no need
// to hold one back for the cascade that demotes the last survivor.
export function buildUnlinkOperations(lines) {
  return lines.map((line) => ({ op: "unlinkLine", lineId: line.id }));
}

// Deletes only the calling account's own leg(s) of a record. A standalone
// line just goes. A linked transaction never has any other account's
// line(s) discarded with it — mirroring removeOtherLine()'s "removing a
// leg never deletes the other side's data" rule (see CLAUDE.md's
// "Matching and linking"). The backend's deleteLine cascade demotes a
// lone survivor to standalone, or dissolves the transaction entirely, on
// its own.
export function buildDeleteOperations(record, accountId) {
  return record.lines.filter((l) => l.accountId === accountId).map((l) => ({ op: "deleteLine", lineId: l.id }));
}

// One updateLine per patched line — see lib/grouping.js's
// reorderSameDate(), which returns `{ lineId, line }` patches directly in
// this shape (the full line, minus its own id, plus its new order).
export function buildReorderOperations(patches) {
  return patches.map(({ lineId, line }) => ({ op: "updateLine", lineId, ...line }));
}
