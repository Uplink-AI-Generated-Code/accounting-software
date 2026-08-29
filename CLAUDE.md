# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Ledger App

A single-page double-entry personal ledger: cash accounts, UK Stocks & Shares
ISA support with allowance tracking, and one-security-per-account stock
accounts with cost basis / portfolio value tracking. State is persisted by a
Symfony backend (`backend/`) into SQLite via Doctrine — see "Backend" below.

**The frontend is a per-account editor, not a "load everything" app.**
Exactly one thing is kept loaded app-wide: a lightweight account list (id,
name, type, currency, and a server-computed `balance` / `costBasis` /
`portfolioValue` per account — no line-level data). Everything below that —
one account's own transactions, ISA allowance usage, match candidates while
linking an entry — is fetched from the backend on demand and never held in
one big client-side array. This is a deliberate rewrite of an earlier
version that loaded the whole ledger into React state up front; see
"Backend" for what moved server-side and why.

`src/App.jsx` is the top-level component (state, persistence, routing, the
modal/nav-guard wiring) — it renders the pieces below but holds no ledger
math itself, and holds no transaction data at all (that's fetched per
account view — see `useAccountLedger`). `src/main.jsx` is just the React
mount point. `src/api.js` is the typed client for the Symfony backend's
endpoints — every mutation in `App.jsx`, and every per-account/per-search
fetch in the components below, goes through it. The one piece of state that
isn't ledger data at all — `ledger-selected-account`, which account was
last viewed, a per-browser convenience — is read/written directly via
`localStorage` in `App.jsx`, not through `api.js`.

The app was originally one ~3100-line `ledger-app.jsx` file and was split by
domain, not by component-per-file dogma — some UI pieces still share a file
because they're small or tightly coupled:

- `src/lib/` — pure logic, no JSX, no fetching: `theme.js` (colors/tokens,
  `TYPES`, `ISA_KINDS`, `CURRENCIES`, `GROUP_DIMENSIONS`), `format.js`
  (date/currency formatting, `uid`), `grouping.js` (sidebar/Overview
  nesting, `bucketBy`, `reorderSameDate`), `isa.js` (the static tax-year
  rules and `isaProducts` grouping — the actual usage computation is
  server-side now, see below), `stockMath.js` (the running cost-basis /
  portfolio-value walk, still used client-side for a ledger's own running
  column and its chart), `matching.js` (`formatCandidateAmount`,
  `candidateIsNegative`, `balanceHint` — the actual match *search* is
  server-side now), `chartSeries.js` (daily-series builder for charts),
  `hash.js` (the `#/account/<id>` router).
- `src/components/` — UI: `AccountLedger.jsx` and `StockLedger.jsx` are the
  two ledger views; both depend on `otherLines.jsx`, which holds the
  `useOtherLines` hook and `OtherLinesEditor` component **shared between
  them** (see below — do not fork this per-ledger), and on two small fetch
  hooks: `useAccountLedger.js` (loads/reloads one account's transactions)
  and `useMatchCandidates.js` (debounced match search for the row currently
  being edited). `charts.jsx` holds all the Recharts wrappers together
  since they share tooltip/series-hook plumbing. `Overview.jsx`,
  `OverviewGroupTree.jsx`, `SidebarGroupTree.jsx`, `AccountCard.jsx`,
  `GroupLevelPicker.jsx` are the grouping/browsing UI — all read
  `balance`/`costBasis`/`portfolioValue` straight off each account object
  rather than from a separately-computed lookup map. `IsaParentView.jsx`,
  `AllowanceView.jsx`, `AccountFormModal.jsx` are the remaining top-level
  views/modals. `ui.jsx` holds tiny shared primitives (`ModalShell`,
  `Field`, `miniInput`/`inputStyle`, `iconBtn`). `useLedgerRowAnimation.js`
  is the FLIP/autoscroll hook shared by both ledgers' row lists.

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
  the same shape `LedgerStateService::readState()` produces internally, so
  the file round-trips straight back through `app:import-local-storage`.
- The SQLite file lives at `backend/var/data_dev.db` (gitignored, along with
  the rest of `var/`); a separate `var/data_test.db` is used for the test
  suite (see below).
- Run the backend test suite: `php bin/phpunit` (from `backend/`). Uses the
  `test` environment's own SQLite file — run `php bin/console
  doctrine:migrations:migrate --env=test` once after a fresh clone or a new
  migration, same as for `dev`.

There is a small PHPUnit suite for the backend (see "Backend" below for what
it covers and why); no test suite and no linter on the frontend.

## Backend

- **Single user, no auth.** This is a personal local app; there's no `User`
  entity and no login. If that ever changes, every controller and every
  service's write path need an ownership check added, not just a login
  screen bolted on.
- **Endpoints, grouped by what the frontend uses them for:**
  - `GET /api/accounts` (`AccountController::list`) — the lightweight,
    app-wide list. `LedgerStateService::accountsWithStats()` computes each
    account's `balance` (a SQL `SUM`) and `entryCount`, plus — for
    investment accounts — `costBasis`/`portfolioValue` by walking that
    one account's own lines in the same order the frontend's ledger rows
    use (see "Stock valuation" below). Called on load and after every
    mutation (`App.jsx`'s `refreshAccounts()`).
  - `GET /api/accounts/{id}/ledger` (`AccountController::ledger`) — every
    transaction touching one account, complete with *all* of that
    transaction's lines (not just this account's own), in the same
    `{id, lines: [...]}` shape the old full-ledger load used — see
    `LedgerStateService::accountLedger()`. Fetched by
    `useAccountLedger.js` on mount/account-change and re-fetched after
    that ledger's own mutations; nothing else holds this data, so
    navigating away discards it.
  - `PUT`/`DELETE /api/accounts/{id}` (`AccountController`) — plain
    single-account upsert/delete. Ids are frontend-provided (see below),
    so `PUT` doubles as create. `DELETE` cascades server-side — stripping
    the account's line out of every transaction and deleting any
    transaction left with zero lines — and returns no data: deleting
    always navigates the frontend away from the account being viewed, so
    there's no ledger screen left to patch (`LedgerStateService::deleteAccount()`).
  - `GET`/`PUT /api/settings` (`SettingsController`) — plain singleton
    read/replace.
  - `POST /api/transactions/batch` (`TransactionController`) — the one
    endpoint that still takes a *list*: `{operations: [{op: "upsert",
    transaction: {...}} | {op: "delete", id}]}`, applied atomically in one
    DB transaction (`LedgerStateService::applyTransactionOperations()`).
    Merging two entries, splitting a removed line off into its own
    standalone record, and reordering several same-date rows all become
    one call here; a plain single save or delete just sends a
    one-element list — don't give that its own endpoint, it'd be a second
    code path doing the same thing. This is the *only* place several rows
    still need to change together: with a real database every other write
    is independently atomic per-row, which is what let the old "compute
    the whole next state, save it all at once" pattern go away.
  - `GET /api/match-candidates` (`MatchController` /
    `MatchingService::findCandidates()`) — replaces the old client-side
    "scan every transaction for a plausible counterpart" search. Query
    params: `currency`, `amount`, `date`, `mode` (`mirrored` or `direct` —
    same distinction `getComparableAmount`/`getDirectComparableAmount`
    used to draw, see "Matching and linking" below), optionally
    `excludeTransactionId` and `excludeAccountIds`. Called debounced
    (`useMatchCandidates.js`, and the per-split-leg search inside
    `otherLines.jsx`) as the user types an amount into an unmatched leg,
    not on every keystroke synchronously.
  - `GET /api/isa-allowance?taxYearStart=YYYY` (`IsaAllowanceController` /
    `IsaAllowanceService::computeUsage()`) — see "ISA allowance engine"
    below.
- **None of the write handlers are optimistic on the frontend** except
  `saveAccount`/`saveSettings` in `App.jsx` (plain replaces with no
  cascading effect elsewhere). Account deletion and every transaction
  write wait for the response, then re-fetch (`refreshAccounts()` for the
  account list; each ledger's own `reload()` for its rows) rather than
  trying to patch local state — specifically so the cascade/merge/
  split-off logic lives in exactly one place (the backend), not
  duplicated in JS. If this ever needs to feel snappier, that's the place
  to add optimism, not to move business logic back to the frontend.
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
- **Always hydrate a bidirectional `Transaction`↔`Line` pair via
  `$transaction->addLine($line)`, never `$line->setTransaction($transaction)`
  alone.** `addLine()` keeps the Transaction's own in-memory `lines`
  collection in sync; without it, reading that Transaction's lines back
  *within the same request* (e.g. `IsaAllowanceService`/`MatchingService`
  reading a just-written transaction, or a test that writes then reads)
  sees Doctrine's stale, still-empty collection from construction, even
  though the DB row is correct — the identity map serves back the same PHP
  object rather than re-querying. This bit `IsaAllowanceServiceTest`
  before the fix; see `LedgerStateService::hydrateLine()`'s comment.
- **Nullable columns are omitted from the JSON**, not sent as `null` — see
  `accountToArray()`/`lineToArray()`'s `array_filter`. This matches the
  frontend's own convention of fields like `line.order` or `line.cashValue`
  being entirely absent rather than present-but-null.
- `readState()`/`writeState()` (a full read/wipe-and-rebuild) still exist
  on `LedgerStateService`, used only by `ExportStateCommand` and
  `ImportLocalStorageCommand` — a backup or a first-time import is
  genuinely a "everything at once" operation. Live app traffic never calls
  either; that's what the endpoints above are for.
- **Test suite** (`backend/tests/`, run via `php bin/phpunit`): covers
  `IsaAllowanceService` specifically — the flexible-ISA lot-tracking
  simulation is the one piece of logic in this app subtle enough to have
  produced a real bug before (see "ISA allowance engine"), so it gets a
  safety net where everything else relies on manual browser verification.
  Add a case there before changing that algorithm; don't feel obliged to
  add tests elsewhere in the backend to match.

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
  convention is intentional (see "Matching and linking" below) — don't
  "fix" the sign without re-deriving every call site that depends on it.
- `line.exchangeAmount` / `line.exchangeCurrency`: same mirror convention,
  for a currency-exchange tag on a plain cash line.

## Matching and linking — two different comparison modes, on purpose

The search itself is server-side (`MatchingService::findCandidates()`,
`GET /api/match-candidates`); this is about the two ways it can compare a
line's value against a target, and where each is used.

- **Mirrored mode** (`MatchingService::comparableAmount($line, $acc,
  $targetCurrency, direct: false)`): returns the *mirrored* value (raw
  `amount`, or `cashValue`/`exchangeAmount` as stored). Used wherever the
  search target itself was computed as `-delta` of the line being edited —
  the double negation is what makes a cash outflow correctly find a stock
  purchase's positive `cashValue`. This is `AccountLedger`/`StockLedger`'s
  own primary-leg search (`useMatchCandidates.js`, `mode: "mirrored"`).
- **Direct mode** (`direct: true`): returns the *natural* value (un-mirrors
  an investment line's `cashValue`). Used when the user has directly typed
  "In 14" / "Out 226.95" into a specific split leg and expects to find a
  record that literally reads that way. This is the per-leg search inside
  `useOtherLines` (`otherLines.jsx`, `mode: "direct"`).
- Getting these two swapped silently breaks matching for one direction
  (cash↔cash still looks fine; cash↔stock doesn't). If you touch
  `comparableAmount()`, re-verify both a plain 2-way match and a split leg
  that finds a stock trade — this was ported from the frontend's old
  `getComparableAmount`/`getDirectComparableAmount` and has no test
  coverage of its own yet.
- `useOtherLines(account, accounts, draft, setDraft, smartDefaultForFirst)`
  is a shared hook used by **both** `AccountLedger` and `StockLedger` for
  their arrays of linked "other account" legs — adding, removing,
  updating, resolving to a savable line, and a debounced per-leg match
  search. `OtherLinesEditor` is the shared row-rendering component. Do not
  reintroduce a per-component copy of this logic; extend the shared
  hook/component instead.
- A selected match candidate's line data is stored directly on the
  `otherLine` as `matchedLine` (set in `selectMatch`/
  `selectMatchForOtherLine`) rather than looked up from a `transactions`
  array — there isn't one client-side anymore. `resolveOtherLine()` uses
  `ol.matchedLine` when saving a matched leg.
- Removing or re-pointing a linked leg never deletes the other side's
  data — it gets queued into `splitOffLines` and saved as its own
  standalone record. This is load-bearing behavior, not an edge case:
  unlinking, deleting an account with entries, and repointing a split leg
  all rely on it.

## ISA allowance engine

Ported to PHP (`backend/src/Service/IsaAllowanceService.php`,
`GET /api/isa-allowance?taxYearStart=YYYY`) — it needs every ISA-tagged
account's full transaction history, which the frontend no longer loads.
Kept deliberately close to the original `src/lib/isa.js` source (same
variable names, same structure) to make auditing the two side by side
easy; `isaProducts()`/`isaRulesFor()` stayed client-side in `lib/isa.js`
since they're pure and only need the account list, which is loaded anyway.

- `computeUsage()` treats a flat ISA account and a Stocks & Shares ISA
  wrapper (+ its subaccounts) as one "product" each. A transfer between
  two of the user's own ISAs (or between subaccounts of the same wrapper)
  never counts as a new subscription — detected by checking whether the
  *other* side of a transaction is itself ISA-tagged
  (`isExternalLine()`).
- Flexible ISAs are modeled with real lot-tracking (`priorPoolEntering()`,
  chronological event simulation across all flexible products together),
  not a simple running total. Withdrawals draw down this year's own
  subscriptions first; only the this-year portion is replaceable into
  *any* flexible ISA, older money only back into the same one. Don't
  simplify this back to `deposits - withdrawals` — that was tried and
  produced wrong (negative) numbers when a withdrawal wasn't replaced.
- **This is the one algorithm in the app with test coverage**
  (`backend/tests/Service/IsaAllowanceServiceTest.php`) — non-flexible
  deposits/withdrawals, a transfer between two own ISAs, a flexible
  same-year withdrawal replaced into a *different* flexible ISA, and
  prior-year money only being replaceable into the *same* ISA. Extend
  these tests rather than relying on manual verification if you change
  this file — that's exactly the class of regression they exist to catch.

## Stock valuation — three distinct, deliberately different numbers

- **Units**: running balance, like any account.
- **Cost basis** (`applyCostBasisLine`, ported to
  `LedgerStateService::applyCostBasisLine()` for `GET /api/accounts`'
  `costBasis`): average-cost method. A sale removes a *proportional*
  share of average cost, not the sale proceeds — settles to exactly 0
  once fully sold.
- **Portfolio value** (`applyPortfolioValueLine`, same PHP-port
  situation, → `portfolioValue`): "mark to last trade" — the most recent
  trade's own implied price, applied to the *whole* current holding.
- Both live in **two places now**: `src/lib/stockMath.js` still has
  `applyCostBasisLine`/`applyPortfolioValueLine`/`buildCostBasisSeries`/
  `buildPortfolioValueSeries`, used client-side for a stock ledger's own
  running-total column and its chart (both operate on the one account's
  already-fetched lines — cheap, no reason to move). The *current totals*
  shown in the sidebar/Overview/account header come from the backend's
  port instead (`LedgerStateService::stockStatsFor()`), computed over
  that account's lines in the exact same order
  (`orderedLinesFor()`: date, then `order`, then transaction id) — same-day
  ordering can change the result, so the tiebreak has to match exactly or
  the two totals will silently disagree.
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
