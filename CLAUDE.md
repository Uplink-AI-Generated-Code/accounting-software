# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Ledger App

A single-page double-entry personal ledger: cash accounts, UK Stocks & Shares
ISA support with allowance tracking, and one-security-per-account stock
accounts with cost basis / portfolio value tracking. State is persisted by a
Symfony backend (`backend/`) into SQLite via Doctrine — see "Backend" below.

`src/App.jsx` is the top-level component (state, persistence, routing, the
modal/nav-guard wiring) — it renders the pieces below but holds no ledger
math itself. `src/main.jsx` is just the React mount point. `src/api.js` is
the typed client for the Symfony backend's discrete endpoints (see
"Backend" below) — every mutation in `App.jsx` goes through it. The one
piece of state that isn't ledger data at all — `ledger-selected-account`,
which account was last viewed, a per-browser convenience — is read/written
directly via `localStorage` in `App.jsx`, not through `api.js`.

The app was originally one ~3100-line `ledger-app.jsx` file and was split by
domain, not by component-per-file dogma — some UI pieces still share a file
because they're small or tightly coupled:

- `src/lib/` — pure logic, no JSX: `theme.js` (colors/tokens, `TYPES`,
  `ISA_KINDS`, `CURRENCIES`, `GROUP_DIMENSIONS`), `format.js` (date/currency
  formatting, `uid`), `grouping.js` (sidebar/Overview nesting, `bucketBy`,
  `reorderSameDate`), `isa.js` (tax-year rules, `computeIsaUsage`),
  `stockMath.js` (cost basis / portfolio value), `matching.js`
  (`getComparableAmount`, `getDirectComparableAmount`, `balanceHint`),
  `chartSeries.js` (daily-series builder for charts), `hash.js` (the
  `#/account/<id>` router).
- `src/components/` — UI: `AccountLedger.jsx` and `StockLedger.jsx` are the
  two ledger views; both depend on `otherLines.jsx`, which holds the
  `useOtherLines` hook and `OtherLinesEditor` component **shared between
  them** (see below — do not fork this per-ledger). `charts.jsx` holds all
  the Recharts wrappers together since they share tooltip/series-hook
  plumbing. `Overview.jsx`, `OverviewGroupTree.jsx`, `SidebarGroupTree.jsx`,
  `AccountCard.jsx`, `GroupLevelPicker.jsx` are the grouping/browsing UI.
  `IsaParentView.jsx`, `AllowanceView.jsx`, `AccountFormModal.jsx` are the
  remaining top-level views/modals. `ui.jsx` holds tiny shared primitives
  (`ModalShell`, `Field`, `miniInput`/`inputStyle`, `iconBtn`).
  `useLedgerRowAnimation.js` is the FLIP/autoscroll hook shared by both
  ledgers' row lists.

When adding a helper, put it in the `lib/` module that already owns that
domain rather than inlining it into a component or creating a new module for
one function.

## Commands

Frontend: Vite + React, `yarn.lock` is the checked-in lockfile (no
`package-lock.json`).

- Install: `yarn install` (or `npm install`)
- Dev server: `yarn dev` — starts Vite on :5173, proxying `/api/*` to the
  Symfony backend on :8000 (see `vite.config.js`) — **the backend must
  already be running** for the app to load any data.
- Build: `yarn build`
- Preview a production build: `yarn preview`

Backend: Symfony 8 (API-only skeleton, no Twig), Doctrine ORM + Migrations,
SQLite. All commands run from `backend/`.

- Install: `composer install`
- Dev server: `symfony server:start --port=8000` (or `symfony server:start -d
  --port=8000` to background it)
- Apply migrations: `php bin/console doctrine:migrations:migrate`
- After changing an entity: `php bin/console doctrine:migrations:diff` to
  generate the migration, then `migrate` as above — never hand-edit the
  SQLite schema directly.
- One-time import of existing browser data: export it from devtools
  (`copy(localStorage.getItem('ledger-storage:personal:ledger-data'))`),
  save it as a JSON file, then `php bin/console app:import-local-storage
  path/to/file.json` — see `src/Command/ImportLocalStorageCommand.php`.
  **This replaces the whole database**, it's not a merge.
- Backup/export the current database: `php bin/console app:export-state
  path/to/file.json` — see `src/Command/ExportStateCommand.php`. Writes
  the same shape `GET /api/state` returns, so the file round-trips
  straight back through `app:import-local-storage`.
- The SQLite file lives at `backend/var/data_dev.db` (gitignored, along with
  the rest of `var/`).

There is no test suite and no linter configured in either half of the repo.

## Backend

- **Single user, no auth.** This is a personal local app; there's no `User`
  entity and no login. If that ever changes, every controller and the
  `LedgerStateService` write path need an ownership check added, not just a
  login screen bolted on.
- **The live app uses discrete, per-entity endpoints**, not one bulk
  save — `PUT`/`DELETE /api/accounts/{id}` (`AccountController.php`),
  `PUT /api/settings` (`SettingsController.php`), and
  `POST /api/transactions/batch` (`TransactionController.php`).
  `GET /api/state` (`StateController.php`) still returns the full
  `{ accounts, transactions, settings }` shape for the frontend's one-shot
  initial load — reads never had the atomicity problem writes did, so
  there was no reason to split that into three requests.
- **Compound frontend actions become one `POST /api/transactions/batch`
  call**, not several separate requests. Merging two entries, splitting a
  removed line off into its own standalone record, and reordering several
  same-date rows all used to need one atomic "save everything" call
  because the old model kept state only in memory; with a real database
  each row is independently authoritative, so the *only* remaining reason
  for a batch is that these specific frontend actions still need several
  DB rows to change together. The endpoint takes an ordered list of
  `{op: "upsert", transaction: {...}}` / `{op: "delete", id}` and applies
  them in one DB transaction — see
  `LedgerStateService::applyTransactionOperations()`. A plain single save
  or delete just sends a one-element list; don't special-case that into a
  separate endpoint, it'd be a second code path doing the same thing.
- **Accounts and settings never had that compound-atomicity problem**, so
  they're plain single-resource endpoints: `PUT` upserts one account (ids
  are frontend-provided, so PUT-with-client-chosen-id doubles as create),
  `DELETE` removes one. Deleting an account still has to cascade —
  stripping its line out of every transaction and deleting any transaction
  that becomes fully empty as a result — so `DELETE` returns the fresh
  transactions list (`LedgerStateService::deleteAccount()`) rather than
  the frontend recomputing that itself, the way it used to.
- **None of the discrete write handlers are optimistic on the frontend**
  except `saveAccount`/`saveSettings` in `App.jsx` (plain replaces with no
  side effects elsewhere). Account deletion and every transaction write
  wait for the response and set state from it, specifically to avoid
  re-implementing the cascade/merge/split-off logic a second time in JS —
  see the comments on `performDeleteAccount`/`saveTransaction` in
  `App.jsx`. If this ever needs to feel snappier, that's the place to add
  optimistic updates, not by moving business logic back to the frontend.
- **`Account`/`Transaction` ids are frontend-provided strings** (the
  frontend already generates them with `uid()`), not Doctrine-generated —
  this is what lets a round-trip save keep every id stable. `Line` has no
  id in the frontend's model at all, so it's the one entity with a normal
  auto-increment PK.
- **The `Transaction` entity's table is explicitly named `transactions`**,
  not the default `transaction` — `transaction` is a reserved word in
  SQLite. DBAL's own DDL generation auto-quotes reserved table names, which
  masked this until ORM-generated (unquoted) INSERT/DELETE statements hit
  it. If you add another entity whose class name collides with a SQL
  keyword, expect the same failure mode and fix it the same way.
- **Nullable columns are omitted from the JSON**, not sent as `null` — see
  `accountToArray()`/`lineToArray()`'s `array_filter`. This matches the
  frontend's own convention of fields like `line.order` or `line.cashValue`
  being entirely absent rather than present-but-null.
- `writeState()` (a full wipe-and-rebuild in one DB transaction) still
  exists on `LedgerStateService`, but only `ImportLocalStorageCommand`
  calls it — a first-time import is genuinely a "replace everything"
  operation. Don't route live app traffic through it; that's what the
  discrete endpoints above are for.

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

- Colors, fonts, and spacing tokens live in the `C` object in
  `src/lib/theme.js` — reuse the palette rather than introducing new hex
  values inline; there's a `plum` token specifically added for a third
  chart series when gold/credit/debit weren't enough.
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
