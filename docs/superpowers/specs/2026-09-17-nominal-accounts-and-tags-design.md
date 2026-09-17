# Nominal accounts and line tags

Date: 2026-09-17

## Problem

The account model's four grouping dimensions — Type, Institution, Subtype,
Currency, plus a Name — fit asset/liability/investment accounts well: those
are real-world things, held at an institution, of some product type. They
fit Income/Expense poorly. A credit card with no distinguishing name ends up
with a redundant `(Subtype=Credit Card, Name=Credit Card)`. Income/Expense
accounts often have no institution at all (or an awkward one — should every
supermarket be its own "institution"?), and a Name field that's usually
either empty or redundant with the category itself.

Underneath this is a real distinction double-entry bookkeeping already
makes: **real accounts** (asset, liability, equity, investment — things
that exist in the world and carry a balance forward indefinitely) versus
**nominal accounts** (income, expense — categorization for a period). The
four-dimension model is a good fit for real accounts specifically, not for
accounts in general; Income/Expense were being forced into a shape built
for a different kind of object.

Separately, some genuinely useful questions ("how much did I spend on this
car," "how much of this trip was tax-deductible," "was this refunded") cut
*across* whatever category or institution a line sits under, and don't fit
any single-parent hierarchy — they need a tagging mechanism, not another
grouping dimension.

## Decisions

### 1. Account model changes

- **`Account.name` becomes an optional, non-nullable string** — empty
  string, not null, since the two would mean the same thing here. No
  database migration is expected to be needed for this (the column is
  likely already a non-nullable string that can hold `""`); the change is
  in validation (drop the "required" rule in `AccountFormModal`) and in
  display.
- **Display fallback**: wherever an account's `name` is rendered and it's
  blank, show a generated label instead — `"{Subtype} · {Counterparty}"`,
  degrading gracefully if either part is missing. Computed for display
  only, never stored, same spirit as `activeTaxYearStart` or
  `imbalancedLineCount` today.
- **`Account.institution` is renamed to `Account.counterparty`** — same FK
  to the existing `Institution` entity, same find-or-create resolution
  (today's `resolveInstitution`), same closed-vs-open semantics. Only the
  field name changes: entity property, migration column, `accountToArray()`
  JSON key, `api.js`, and every component/prop that reads it.
- **The UI label for this field depends on `account.type`**: "Institution"
  for `asset`/`liability`/`investment`/`isa-parent`, "Counterparty" for
  `income`/`expense`/`isa-income` — one column, two labels, chosen the same
  way other type-dependent UI text already varies.
- **`Type`, `Currency`, `Subtype`, and all grouping/search machinery are
  unchanged** — `Subtype` already works for both real and nominal accounts
  (Credit Card, Trading, Groceries, Employment, Self-employment, ISA
  interest are all just `Subtype` values); `buildNestedGroups`,
  `flattenAllAccounts`, `leafMatchesQuery` don't need to know the
  Institution column was renamed to Counterparty.

This alone resolves most of the original motivating questions: "spent at
Tesco" becomes grouping accounts by Counterparty and reading the Tesco
subtree's total; "spent on restaurants" is grouping by Subtype; "income per
client, per income type, in total" is Counterparty/Subtype/Type grouping on
Income accounts. None of that needs a new query — it's the existing
Overview/sidebar grouping tree, unchanged in mechanism, now applied to
Income/Expense accounts that finally fit the same shape as everything else.

### 2. The `Tag` entity

Tags cover only what Counterparty/Subtype/Type genuinely can't express:
cross-cutting facts like which car, which trip, which person, whether
something is tax-deductible or reimbursable, or its refund/return/
cancellation status. ("Client" and "merchant" were considered as tag
dimensions during design but turned out to be redundant with Counterparty
once nominal accounts adopted it — they aren't part of this design.)

- **`Tag` is a natural-key reference entity**, same philosophy as
  `Currency`/`Symbol`/`Institution` (the business key is the primary key,
  no surrogate id, human-readable raw rows) — but its natural key is
  **composite**: `(dimension, value)`, e.g. `("Car", "AB12CDE")`,
  `("Status", "Refunded")`. No other columns — no color, no "kind"
  (dimensional-vs-status) flag; that distinction stays a usage convention,
  not a schema constraint, since nothing in the query design needs to
  enforce it.
- **Both `dimension` and `value` are open, free-form strings, resolved
  find-or-create** — same posture as `resolveInstitution` today, not the
  closed-set, hard-error posture of `resolveCurrency`/`resolveSymbol`. A
  new dimension or value comes into existence the first time it's typed.
  The UI must offer autocomplete over existing dimensions, and existing
  values once a dimension is chosen, since nothing at the schema level
  prevents "Refunded" and "refund" from silently becoming two different
  tags.
- **`value` is optional — an empty string, never null**, same convention
  as `Account.name` and for the same reason (null and `""` would mean the
  same thing here). This makes a bare, flag-style tag a first-class case
  rather than a workaround: `{dimension: "Car", value: ""}` for someone
  with exactly one car, `{dimension: "Tax-deductible", value: ""}` for a
  plain yes/no fact — no need to invent a fake value just to satisfy a
  composite key. A flat tag isn't a different mechanism from a structured
  one, it's a structured tag with a blank value. If a second car (or a
  second anything) shows up later, the fix is a one-time bulk edit — find
  every `{Car, ""}` tag and set its value to the first car's actual
  identifier, then start using real values going forward. This is an
  accepted, deliberate trade-off rather than something designed around
  up front.
- **`Line`↔`Tag` is a plain many-to-many** via a `line_tag` join table
  (`line_id`, `tag_dimension`, `tag_value`, composite PK on all three).
  This needs a composite-key FK mapping in Doctrine, slightly more
  boilerplate than the single-column FKs `Account.currency`/`Account.symbol`
  use — accepted in exchange for keeping `Tag` human-readable without a
  join, consistent with why Currency/Symbol/Institution avoided surrogate
  ids in the first place.
- **No uniqueness rule beyond exact `(dimension, value)` duplication on one
  line.** A line can carry two different values of the same dimension
  (e.g. both `Status:Refunded` and `Status:Cancelled`) — left unconstrained
  by design decision, not disallowed.
- **Tags live on the line, not the transaction.** This mirrors the
  existing, deliberate choice to keep `date`/`description` per-line rather
  than per-transaction (two lines of one transaction can already have
  different dates/descriptions — this is documented, load-bearing
  behavior). Tags follow the same rule: a fuel purchase's expense leg gets
  `Car:AB12CDE`, its bank-withdrawal leg doesn't need to inherit or "borrow"
  it. There is no tag-ownership concept and no dummy-transaction workaround
  for standalone lines, because tags never required a transaction to
  attach to in the first place.
- **Wire format**: a line's `tags` field is a plain array of
  `{dimension, value}` pairs, omitted or `[]` when empty, consistent with
  the existing null/absent-field convention and with sending natural keys
  directly (as `currency`/`symbol` already do).
- **Resolution**: a new `resolveTags(array $tagPairs): array` on
  `LedgerStateService`, called from `upsertLine` and the line-building side
  of `upsertTransaction`. Each save does a full replace of a line's Tag
  set (not incremental add/remove) — matches how the rest of a line's
  fields are already overwritten wholesale on edit.

### 3. Refunds

A refund is always its own real line (money genuinely moving), dated
whenever it actually happened — never a same-line void. `Refunded` is
purely an annotation on the *original* line, informing a reader "this one's
reversed elsewhere," and tags never affect `balance`/`costBasis`/any stored
computation — they're metadata for filtering/searching after the fact, in
keeping with this app's existing principle that nothing computed is
silently affected by peripheral data.

### 4. Query/aggregation endpoints

Three new endpoints, deliberately narrow — most of the original "how much
did I spend/earn on X" questions are answered by Section 1's Counterparty
rename plus the existing account-grouping tree, not by these:

- **`GET /api/tags[?dimension=Car]`** — list distinct `(dimension, value)`
  pairs in use, optionally scoped to one dimension. Powers the autocomplete
  picker described above.
- **`GET /api/lines?dimension=Car&value=AB12CDE`** — every line carrying
  that exact tag, each with its account context
  (`{lineId, line, account}`, matching the shape `GET /api/match-candidates`
  already uses). The drill-down view behind a tag total.
- **`GET /api/tag-totals?dimension=Car[&excludeTag=Status:Refunded]`** —
  server-side `SUM`, grouped by `(value, currency)`. Computed server-side
  for the same reason `accountsWithStats()`'s balance `SUM` is — this app's
  frontend never reduces bulk line data itself. `excludeTag` covers
  "Groceries total, excluding refunded" style filtering; it is a single
  filter, not a general query language.

**Scope cut**: `tag-totals` sums only cash lines (asset, liability, income,
expense, isa-income) — never investment lines. An investment line's
`amount` is units and its `cashValue` a separately-scaled cash figure;
summing either uniformly into one `(value, currency)` bucket alongside
plain cash amounts would silently mix incompatible quantities. Investment
lines can still be tagged (they'll show up in the `GET /api/lines`
drill-down), they just don't contribute to a `tag-totals` sum in this
iteration.

### 5. Migration

- **`Tag` + `line_tag` tables**: pure additions, no backfill needed — a
  new, currently-empty feature.
- **`Account.institution` → `Account.counterparty`**: must be a genuine
  `RENAME COLUMN` migration (carrying the FK constraint across), written by
  hand rather than trusting a `doctrine:migrations:diff`-generated
  drop-and-recreate, which would silently lose every account's existing
  institution/counterparty data. Verify against a copy of `data_dev.db`
  before applying to the real one. The `Institution` entity/table itself
  is untouched — only the FK column name on `Account` changes.
- **`Account.name` optional**: likely no schema migration at all — confirm
  the column is already non-nullable-and-blank-capable; if so this is a
  frontend validation change only.
- **No retroactive tagging** of existing lines — tag historical lines by
  hand, at your own pace, through the normal edit flow, if and when wanted.

### 6. UI touch points

- **`AccountFormModal.jsx`**: Institution/Counterparty field label switches
  on `account.type`; `Name` loses its required validation, with a
  placeholder hinting at the fallback (e.g. *"auto: Subtype · Counterparty"*).
- **Display fallback helper**: `displayAccountName(account)` (likely in
  `lib/format.js`), used wherever `account.name` is currently rendered
  directly — `AccountRow.jsx`, `SidebarGroupTree.jsx`,
  `OverviewGroupTree.jsx`, ledger headers, pickers.
- **Tagging a line**: a tag picker in the inline row editor of
  `AccountLedger.jsx`/`StockLedger.jsx` and in `otherLines.jsx`'s per-leg
  editor, following the existing shared CSS-grid column template. The
  read-only row shows existing tags as small chips.
  **`lib/ledgerOperations.js`'s `draftLines()` includes `tags`** in what
  gets saved (unlike `id`, which it deliberately omits) — this carries
  tags through every save/merge/unlink/split-off transition for free,
  the same way `date`/`description`/`cashValue` already are.
- **New Tags view**: a sibling to `Overview.jsx` — pick a dimension
  (autocompleted via `GET /api/tags`), see its values with totals
  (`GET /api/tag-totals`), drill into a value's line list
  (`GET /api/lines`). New fetch hook (`useTagTotals.js`, shaped like
  `useAccountLedger.js`) and a new hash route (`#/tags`, `#/tags/Car`) in
  `lib/hash.js`.
- **Not merged into the existing account search** — `flattenAllAccounts`/
  `leafMatchesQuery` is unchanged; tags are line-level, not account-level,
  and get their own search surface in the new Tags view.
- **`api.js`** gains `fetchTags()`, `fetchTagTotals(dimension, opts)`,
  `fetchTaggedLines(dimension, value)`; every line-upsert payload gains a
  `tags` field.
- **Backend rename fan-out**: `Account` entity property, `accountToArray()`
  JSON key, `AccountController`, `LedgerStateService`
  (`resolveInstitution` → `resolveCounterparty` or similar), and
  `lib/grouping.js`'s dimension list all follow the column rename.

## Explicitly out of scope for this iteration

- Tag-based totals for investment lines.
- Any mechanism correlating a refund with its original purchase beyond
  visual matching (or ad hoc use of transaction splits) — no
  `refundOfLineId`-style link.
- A "kind" field distinguishing dimensional tags (Car, Client) from status
  tags (Refunded, Cancelled) at the schema level.
- Enforcing single-value-per-dimension on a line.
- Folding tag search into the existing account search UI.
