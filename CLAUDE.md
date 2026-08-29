# Ledger App

A single-page double-entry personal ledger: cash accounts, UK Stocks & Shares
ISA support with allowance tracking, and one-security-per-account stock
accounts with cost basis / portfolio value tracking. No backend — state
persists via `window.storage` (see `storageShim.js`).

Main file: `ledger-app.jsx`. Read the whole file before making structural
changes — it's one file by design, and several helpers are shared across
components in ways that aren't obvious from any single section.

## Commands

- Install: `npm install`
- Dev server: `npm run dev`
- (Confirm these against `package.json` — this section may drift from
  whatever build tooling is actually configured.)

## Data model — read this before touching transactions

- A **transaction** is `{ id, lines: [] }`. There is no transaction-level
  `date` or `description` — both live on each **line**. Two lines of the
  same transaction can have different dates and different descriptions.
  This was a deliberate fix for a real bug (linked rows sharing one
  description); never reintroduce transaction-level date/description.
- A **line** is `{ accountId, amount, date, description, order?, ... }`.
  `amount` is signed: positive = increase, negative = decrease, regardless
  of account type. There is no separate debit/credit; the UI just labels
  positive/negative as "In"/"Out".
- Account types: `asset`, `liability`, `equity`, `income`, `expense`,
  `investment`, `isa-parent`. An `isa-parent` holds no balance itself —
  it's a wrapper grouping subaccounts via `isaParentId`.
- **Investment accounts hold exactly one security** (symbol + trading
  currency live on the account, not per-line). `amount` on an investment
  line is *units*, not cash.
- **Never store a price-per-unit field.** Price is always derived as
  `cashValue / units` on demand. This has come up multiple times — resist
  adding a stored price field even when it seems convenient.
- `line.order` (number, optional) breaks ties between same-date lines in a
  given account's ledger. Missing `order` defaults to 0.
- `line.cashValue` / `line.cashCurrency`: the cash side of a trade, tagged
  onto the investment line itself. **`cashValue` mirrors the sign of
  `amount`**, not the natural cash direction — a buy has positive units
  *and* positive `cashValue`, even though cash actually left the account.
  Natural cash paid/received is always `-cashValue`. This mirror
  convention is intentional (see `getComparableAmount` below) — don't
  "fix" the sign without re-deriving every call site that depends on it.
- `line.exchangeAmount` / `line.exchangeCurrency`: same mirror convention,
  for a currency-exchange tag on a plain cash line.

## Matching and linking — two different comparison functions, on purpose

- `getComparableAmount(line, acc, targetCurrency)`: returns the *mirrored*
  value (raw `amount`, or `cashValue`/`exchangeAmount` as stored). Used
  wherever the target itself was computed as `-delta` of the line being
  edited — the double negation is what makes a cash outflow correctly
  find a stock purchase's positive `cashValue`.
- `getDirectComparableAmount(line, acc, targetCurrency)`: returns the
  *natural* value (un-mirrors an investment line's `cashValue`). Used
  when the user has directly typed "In 14" / "Out 226.95" into a specific
  split leg and expects to find a record that literally reads that way.
- Getting these two swapped silently breaks matching for one direction
  (cash↔cash still looks fine; cash↔stock doesn't). If you touch either
  function, re-verify both a plain 2-way match and a split leg that finds
  a stock trade.
- `useOtherLines(account, accounts, transactions, draft, setDraft,
  smartDefaultForFirst)` is a shared hook used by **both** `AccountLedger`
  and `StockLedger` for their arrays of linked "other account" legs —
  adding, removing, updating, resolving to a savable line, and per-leg
  match search. `OtherLinesEditor` is the shared row-rendering component.
  Do not reintroduce a per-component copy of this logic; extend the
  shared hook/component instead.
- Removing or re-pointing a linked leg never deletes the other side's
  data — it gets queued into `splitOffLines` and saved as its own
  standalone record. This is load-bearing behavior, not an edge case:
  unlinking, deleting an account with entries, and repointing a split leg
  all rely on it.

## ISA allowance engine

- `computeIsaUsage` treats a flat ISA account and a Stocks & Shares ISA
  wrapper (+ its subaccounts) as one "product" each. A transfer between
  two of the user's own ISAs (or between subaccounts of the same wrapper)
  never counts as a new subscription — detected by checking whether the
  *other* side of a transaction is itself ISA-tagged.
- Flexible ISAs are modeled with real lot-tracking (`priorPoolEntering`,
  chronological event simulation across all flexible products together),
  not a simple running total. Withdrawals draw down this year's own
  subscriptions first; only the this-year portion is replaceable into
  *any* flexible ISA, older money only back into the same one. Don't
  simplify this back to `deposits - withdrawals` — that was tried and
  produced wrong (negative) numbers when a withdrawal wasn't replaced.

## Stock valuation — three distinct, deliberately different numbers

- **Units**: running balance, like any account.
- **Cost basis** (`applyCostBasisLine` / `buildCostBasisSeries`):
  average-cost method. A sale removes a *proportional* share of average
  cost, not the sale proceeds — settles to exactly 0 once fully sold.
- **Portfolio value** (`applyPortfolioValueLine` /
  `buildPortfolioValueSeries`): "mark to last trade" — the most recent
  trade's own implied price, applied to the *whole* current holding.
- None of these is a live market value — there is no price feed anywhere
  in this app. Don't let a future request to "show current value" quietly
  turn into fabricating market prices; surface the distinction to the
  user instead, same as prior turns in this project have done.

## UI conventions

- Colors, fonts, and spacing tokens live in the `C` object at the top of
  the file — reuse the palette rather than introducing new hex values
  inline; there's a `plum` token specifically added for a third chart
  series when gold/credit/debit weren't enough.
- Editing a ledger row uses inline expansion in place (no modals) with a
  shared CSS-grid column template so per-field alignment lines up with
  the read-only row above it. When adding a new field to an editing row,
  match its `gridColumn` against the same template used by the row header
  and the read-only row, not an ad hoc layout.
- Navigating away from an in-progress edit is guarded (`ledgerGuardRef`,
  `attemptNavigation` in `App`): a clean/untouched draft is discarded
  silently, a dirty one prompts Save/Discard/Stay. If you add a new
  top-level navigation action, route it through `attemptNavigation`
  rather than calling `setSelectedId`/state setters directly, or it will
  silently bypass the guard.
- Grouping (sidebar + Overview) is a cascading 1–3 level picker over
  {Type, Institution, Currency} with savable presets in
  `settings.savedGroupings`. `buildNestedGroups` / `bucketBy` are generic
  over the dimension — extend those rather than writing a new grouping
  path for a new dimension.

## Things intentionally *not* built (don't add without asking)

- No live market price feed / real "current value".
- No multi-currency conversion beyond the per-line exchange tag.
- No JISA, no LISA bonus modeling, no flexible-ISA partial-year handling.
