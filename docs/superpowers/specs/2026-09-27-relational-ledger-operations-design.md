# Relational ledger-write operations

## Problem

`POST /api/ledger/batch` (`LedgerController::batch()` /
`LedgerStateService::applyLedgerOperations()`) currently exposes four
primitives: `upsertLine`, `deleteLine`, `upsertTransaction`,
`deleteTransaction`. The frontend (`src/lib/ledgerOperations.js`'s four
builder functions) computes each record's *entire new shape* — the full
lines array a Transaction should end up with — and the backend blindly
replaces: `opUpsertTransaction` deletes every existing line of that
transaction and re-inserts the new set from scratch
(`deleteTransactionLines()` then N fresh `Line` inserts), even when only
one leg actually changed. `deleteTransaction` is the same story — the
frontend decides a Transaction must go and rebuilds the survivor(s) as
fresh standalone lines via separate `upsertLine` calls.

This is a document-database pattern (send the whole desired document,
replace it wholesale) left over from this app's original all-in-memory,
localStorage-backed design. It no longer fits: storage is now a real SQL
database with an ORM, foreign keys, and auto-increment `Line` ids that
this pattern churns unnecessarily. It also means the frontend, not the
backend, owns the actual business logic of when a Transaction is born,
merges, or dissolves — despite `CLAUDE.md` already stating the backend
should own exactly this kind of cascading decision.

## Goals

- Replace the upsert/replace vocabulary with primitives that express
  *intent* — create a line, edit a line's own fields, delete a line, put
  lines in one transaction together, take a line out of its transaction —
  and let the backend derive the resulting Transaction lifecycle (create
  one when needed, delete one that drops below 2 lines, demoting its
  lone survivor back to standalone).
- Eliminate delete-and-recreate for any line whose own data hasn't
  changed. Editing one leg of a 3-leg transaction should touch exactly
  that one row.
- No backend diffing engine. Each primitive does one obvious, narrowly
  scoped thing; the frontend still composes a short sequence of them per
  user action, same as today, just without pre-computing final-state
  arrays.
- Keep the same atomicity and validation guarantees: one ordered array of
  operations, applied inside one Doctrine transaction, with the existing
  active-tax-year date check running before any operation executes.

## Non-goals

- No change to `GET /api/accounts`, `GET /api/accounts/{id}/ledger`,
  match search, tags, or any read endpoint — this is a write-path-only
  change.
- No versioning/back-compat shim for the old vocabulary. Single-user
  local app, no external API consumers — frontend and backend change
  together in one PR.
- No general "patch this Transaction's lines in bulk" primitive. Every
  compound frontend action (merge, split-off, unlink, reorder) is
  expressed as a short sequence of the five primitives below, not a
  bespoke bulk verb.

## The five primitives

All five replace `upsertLine`/`deleteLine`/`upsertTransaction`/
`deleteTransaction` entirely inside `POST /api/ledger/batch`'s
`operations` array. Still processed strictly in array order, inside one
`$this->em->wrapInTransaction(...)` call, with
`assertOperationDatesInActiveTaxYear()` run once up front against every
`createLine`/`updateLine` op's `date` field (the two ops that can
introduce or change a date).

### `createLine`

```json
{ "op": "createLine", "tempId": "a1", "accountId": "...", "amount": "12.5", "date": "2026-01-01", "description": "...", ... }
```

Creates a new **standalone** line — there is no `transactionId` field on
this op at all; a line is always born standalone. `tempId` is a
client-chosen opaque string, unique within the batch. Any later op in the
same batch may reference this not-yet-persisted line by `tempId` in place
of a real `lineId` (see "Temp-id resolution" below). Field set and
validation are otherwise identical to today's `hydrateLine()` fill (all
of `amount`/`date`/`description`/`order`/`cashValue`+`cashCurrency`/
`exchangeAmount`+`exchangeCurrency`/`tags`).

### `updateLine`

```json
{ "op": "updateLine", "lineId": 42, "amount": "12.5", "date": "2026-01-01", "description": "...", ... }
```

Replaces this line's own fields in place — the same full-field-replace
`hydrateLine()` already does today (not a partial patch; every field
`hydrateLine()` currently fills must be present, same as `upsertLine`
requires today). **Never touches transaction membership** — a line
already linked stays linked to the same Transaction, a standalone line
stays standalone. Unknown `lineId` → `400`.

### `deleteLine`

```json
{ "op": "deleteLine", "lineId": 42 }
```

Deletes the line outright (and its tags, same as today's
`deleteTransactionLines()`/direct `Line` removal). **Cascade**: if this
line belonged to a Transaction, and removing it leaves that Transaction
with fewer than 2 lines, the Transaction is deleted and its sole
remaining line (if any) is demoted to standalone
(`transaction_id = NULL`) — the same invariant already stated in
`CLAUDE.md`'s "Data model" section, just enforced here instead of by the
frontend precomputing it. Unknown `lineId` → `400`.

### `linkLines`

```json
{ "op": "linkLines", "lineIds": ["a1", 17, 23] }
```

Takes 2+ ids (real `lineId`s and/or in-batch `tempId`s) and ensures they
all belong to one Transaction:

- If none of them currently belong to any Transaction → a new Transaction
  is created and all of them are attached to it.
- If they already all belong to the *same* existing Transaction (or a mix
  of that Transaction's members and standalone lines) → the standalone
  ones are attached to that existing Transaction; already-attached lines
  are left as-is.
- If the given lines span **two or more different existing
  Transactions** → hard `400` error. `linkLines` never merges two
  pre-existing Transactions as a side effect. A caller that genuinely
  needs to combine two linked transactions does it explicitly:
  `unlinkLine` every line of one of them first (which may itself cascade
  those lines back to standalone/dissolve that Transaction), then
  `linkLines` the resulting standalone lines into the target. In
  practice this case can't arise from match-based merging today —
  `MatchingService::findCandidates()` only ever returns standalone lines
  (`WHERE l.transaction IS NULL`) — so this is a defensive rule, not a
  restriction on any existing user flow.
- Fewer than 2 **distinct** ids → `400`. Ids are compared after temp-id
  resolution (two `tempId`s resolving to the same pending line, or a
  `tempId` and the real `lineId` it resolves to, count as the same id for
  this check). Any duplicate in the given list → `400` — `linkLines`
  never silently dedupes down to fewer than the caller asked for; a
  caller passing the same id twice is a bug, not a shorthand for passing
  it once.

### `unlinkLine`

```json
{ "op": "unlinkLine", "lineId": 42 }
```

Removes this one line from its Transaction, making it standalone.
**Idempotent**: if the line is already standalone — whether it started
that way or an earlier op in the same batch (its own cascade, or another
`unlinkLine`/`deleteLine` on a sibling line) already demoted it — this is
a no-op success, not an error. This is what lets a full unlink be
expressed as one `unlinkLine` per line of the record, all N of them,
without the caller having to know in advance that removing the
second-to-last line will cascade-demote the last one for free (see
"Full unlink" in the frontend-impact table below) — sending only N-1 and
relying on the cascade still works too, it's just no longer required.
Cascade on an actual removal is the same as `deleteLine`: if the
Transaction now has fewer than 2 lines, it's deleted and the remaining
line (if any) is demoted to standalone. Unknown `lineId` → `400` (that
case is still a real error — the line was never in scope for this
edit).

### Shared cascade helper

Both `deleteLine` and `unlinkLine` call one private helper, e.g.
`demoteOrDeleteTransactionIfBelowMinimum(?Transaction $transaction)`,
after removing/detaching the line — checking the remaining line count and
either leaving it alone (≥2), deleting the Transaction and setting the
lone survivor's `transaction` to `null` (=1), or doing nothing further
(0, which cascades naturally via the ORM once the Transaction itself is
deleted — no line can be left pointing at a deleted Transaction row).
No duplicated cascade logic between the two ops.

## Temp-id resolution

`createLine` ops may carry a client-chosen `tempId`. Within
`applyLedgerOperations()`, a small in-memory map (`tempId → Line`,
scoped to one call) is populated as each `createLine` runs. Any
subsequent op's `lineIds`/`lineId` fields are resolved by checking that
map first, falling back to a real numeric id lookup. Referencing a
`tempId` that hasn't been created earlier in the same array, or that
doesn't exist, is a `400`. This is the only new piece of server-side
bookkeeping this design adds — it exists purely to let one atomic batch
create brand-new linked lines without a round trip to get real ids back
first.

The batch response stays `{"ok": true}` — the frontend already reloads
the full ledger view after every write (`AccountLedger`/`StockLedger`'s
`reload()`), so no id mapping needs to travel back over the wire.

## Frontend impact

`src/lib/ledgerOperations.js`'s four builders (`buildSaveOperations`,
`buildUnlinkOperations`, `buildDeleteOperations`, `buildReorderOperations`)
are rewritten against the five primitives. What each user action becomes:

| Action | Today | New |
|---|---|---|
| Plain edit, no shape change | `upsertLine` or `upsertTransaction` (whole record rewritten) | `updateLine` for each changed leg only |
| New standalone entry | `upsertLine(lineId: null)` | `createLine` |
| New linked entry (N new legs) | `upsertTransaction` with a fresh id, all-new lines | `createLine` ×N (tempIds) + one `linkLines([...tempIds])` |
| Merging an existing standalone line into the current row | delete old line/transaction, `upsertTransaction` rebuilding everything | `linkLines([currentLineOrMemberId, otherLineId])` — no delete, no recreate |
| Splitting one leg off an existing transaction, keeping it | `deleteTransaction` + `upsertLine` per survivor incl. the split-off one | `unlinkLine(thatLegsLineId)` — cascade handles the rest automatically |
| Full unlink (record → N standalones) | `deleteTransaction` + `upsertLine` per line | `unlinkLine` for every line of the record (simplest, since the frontend doesn't have to hold one back); `unlinkLine` for all-but-one also still works, cascade auto-demotes the last survivor |
| Deleting this account's own leg(s) from a record | `upsertTransaction` (remaining legs) or `deleteTransaction` + `upsertLine` (survivor) | `deleteLine` for each of this account's own lines; cascade handles Transaction cleanup |
| Same-date reorder | `upsertTransaction`/`upsertLine` carrying `order` | unchanged in spirit: a loop of `updateLine({ order })` |

The exact rewiring of `AccountLedger.jsx`/`StockLedger.jsx`/
`otherLines.jsx` (`commit()`, `unlinkNow()`, `deleteEntry()`,
`useOtherLines`'s per-leg add/remove/match state) is implementation
detail for the plan, not this spec — but the guiding rule is: **the
frontend already knows, per leg, whether it's brand new (no id), an
existing member of this record whose own fields changed, or a
match-selected existing standalone line** (this is exactly what
`otherLines.jsx`'s `snapshot`/`matchedLineId` fields already track). Each
category maps directly to one of `createLine`/`updateLine`/`linkLines`
above — the frontend was never actually diffing blindly, it already
carries this provenance per leg; it just currently throws that
information away and sends a flat final-state array instead of primitive
ops.

## Validation posture

Unknown `lineId` on `updateLine`/`deleteLine`/`unlinkLine`, an unresolved
`tempId` reference, `linkLines` with fewer than 2 ids, and `linkLines`
spanning two different existing Transactions are all hard `400`s via
`\InvalidArgumentException`, caught the same way `LedgerController::batch()`
already catches today's `InvalidArgumentException`s (bad dates,
non-decimal amounts). This tightens today's behavior, where an unknown
`deleteLine`/`lineId` silently no-ops (`opDeleteLine` just checks `if
($line)`) — consistent with this codebase's existing closed-set,
fail-loud posture (`resolveCurrency()`/`resolveSymbol()`).

## Testing

New test coverage in `backend/tests/Service/` (extending
`LedgerStateServiceAmountsTest.php` or a new file) for each primitive and
cascade path — the exploration for this design found **no existing test**
for `deleteLine`, `deleteTransaction`, or `upsertTransaction`'s
replace-in-place path, so this closes a real gap, not just tests new
code:

- `createLine` creates a standalone line; batch-referencing its `tempId`
  from a later `linkLines` in the same array resolves correctly.
- `updateLine` changes a line's fields without touching its Transaction
  membership (linked line stays linked, standalone stays standalone).
- `deleteLine` on a standalone line just removes it.
- `deleteLine` on one leg of a 2-line Transaction deletes the Transaction
  and demotes the survivor to standalone.
- `deleteLine` on one leg of a 3+-line Transaction leaves the Transaction
  intact with the remaining legs.
- `linkLines` creates a new Transaction from two standalone lines.
- `linkLines` extends an existing Transaction with an additional
  standalone line.
- `linkLines` given lines from two different existing Transactions →
  `400`, nothing written.
- `linkLines` given fewer than 2 distinct ids → `400`, including the case
  of 2+ ids where one is a duplicate (e.g. `[17, 17]`) and the case of a
  `tempId` duplicating another op's `lineId`/`tempId` after resolution.
- `unlinkLine` on a 2-line Transaction dissolves it, demoting the
  survivor.
- `unlinkLine` on a 3+-line Transaction just detaches the one line.
- `unlinkLine` called on every line of a Transaction in one batch (not
  holding one back) succeeds: the earlier calls detach normally, the
  last one hits an already-standalone line via cascade and is a no-op,
  and the end state matches calling it on all-but-one.
- `unlinkLine` called on a line that was standalone before the batch even
  started is also a no-op success, not an error.
- Unknown `lineId`/unresolved `tempId` on each op → `400`, nothing
  written (mirroring the existing
  `testUpsertLineWithUnknownAccountThrowsAndWritesNothing`-style
  rollback assertions).
- A full batch mixing `createLine` (with `tempId`), `updateLine`,
  `deleteLine`, and `linkLines` in one call, asserting it's all applied
  atomically.

No frontend test suite exists for `ledgerOperations.js` today (it isn't
one of `src/lib/decimal.js`/`format.js`/`stockMath.js`, the only
Vitest-covered modules) and this design doesn't add one — manual browser
verification of the rewritten builders remains the standard for this
part of the app, same as today.

## Migration

This is a breaking change to `POST /api/ledger/batch`'s wire format, done
in one PR across frontend and backend together — no dual-vocabulary
transition period, consistent with this being a single-user local app
with no external consumers of this endpoint.
