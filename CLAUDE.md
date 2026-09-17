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
  `TYPES`, `ISA_KINDS`, `GROUP_DIMENSIONS` — no `CURRENCIES` constant
  anymore, see "Amounts, currencies, and reference data" below),
  `format.js` (date/currency formatting, `uid`), `scale.js`
  (integer⟷decimal-string conversion, no floats — see below),
  `grouping.js` (sidebar/Overview nesting, `bucketBy`, `reorderSameDate`),
  `isa.js` (the static tax-year rules and `isaProducts` grouping — the
  actual usage computation is server-side now, see below), `stockMath.js`
  (the running cost-basis / portfolio-value walk, still used client-side
  for a ledger's own running column and its chart), `matching.js`
  (`formatCandidateAmount`, `candidateIsNegative`, `balanceHint` — the
  actual match *search* is server-side now), `chartSeries.js`
  (daily-series builder for charts), `hash.js` (the `#/account/<id>`
  router).
- `src/components/` — UI: `AccountLedger.jsx` and `StockLedger.jsx` are the
  two ledger views; both depend on `otherLines.jsx`, which holds the
  `useOtherLines` hook and `OtherLinesEditor` component **shared between
  them** (see below — do not fork this per-ledger), and on three small
  fetch hooks: `useAccountLedger.js` (loads/reloads one account's
  transactions), `useMatchCandidates.js` (debounced match search for the
  row currently being edited), and `useTagTotals.js` (fetches
  `GET /api/tag-totals` for one dimension, used by `TagsView.jsx`).
  `charts.jsx` holds all the Recharts wrappers together since they share
  tooltip/series-hook plumbing. `Overview.jsx`, `OverviewGroupTree.jsx`,
  `SidebarGroupTree.jsx`, `AccountRow.jsx`, `GroupLevelPicker.jsx` are the
  grouping/browsing UI — all read `balance`/`costBasis`/`portfolioValue`
  straight off each account object rather than from a separately-computed
  lookup map. `IsaParentView.jsx`, `AllowanceView.jsx`, `TagsView.jsx`,
  `AccountFormModal.jsx` are the remaining top-level views/modals —
  `TagsView.jsx` is deliberately separate from `Overview.jsx` rather than
  a mode of it, since it browses by tag dimension/value, not by account.
  `ui.jsx` holds tiny shared primitives (`ModalShell`, `Field`,
  `miniInput`/`inputStyle`, `iconBtn`, and the tag-editing pair
  `TagChips`/`TagsEditor` used by both ledgers' row editors).
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
  **This replaces the whole database's accounts/lines/transactions** (not
  a merge) **and upserts whatever `currencies` the file declares** — see
  "Amounts, currencies, and reference data" below.
- Backup/export the current database: `php bin/console app:export-state
  path/to/file.json` — see `src/Command/ExportStateCommand.php`. Writes
  the same shape `LedgerStateService::readState()` produces internally, so
  the file round-trips straight back through `app:import-local-storage`.
- Fresh database bootstrap: `php bin/console app:currencies:seed` populates
  a baseline currency list (GBP/USD/EUR/JPY/CHF/CAD/AUD/RON/INR) — see
  `src/Command/SeedCurrenciesCommand.php`. Idempotent, safe to re-run.
  Not the only way a currency gets added — see below.
- Bootstrap the *next* tax year's database from the current one:
  `php bin/console app:new-year databases/2025-2026.sqlite3` — see
  `src/Command/NewYearCommand.php` and "The active tax year" below. Copies
  the live SQLite file wholesale (so every Currency/Symbol/Counterparty/
  Tag/Account definition and the settings row carry over exactly, no
  re-derivation), then, in the copy only, wipes every line/transaction and
  sets each account's `openingBalance`/`openingBalanceCashValue` to its
  *current* closing balance/cost basis for asset/liability/equity/
  investment accounts, or resets both to null for income/isa-income/
  expense/isa-parent accounts (period-specific flows, not a balance that
  carries across tax years). Refuses to run if the target path already
  exists. Point `DATABASE_URL` (`.env.local`) at the new file once you're
  ready to start using it — this doesn't touch which file the app itself
  is pointed at.
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
    use (see "Stock valuation" below), plus `imbalancedLineCount`/
    `imbalanceIn`/`imbalanceOut` when the account has any (see "Matching
    and linking" below). Called on load and after every mutation
    (`App.jsx`'s `refreshAccounts()`).
  - `GET /api/accounts/{id}/ledger` (`AccountController::ledger`) — every
    **record** touching one account (see "Data model" below for what a
    record is), complete with *all* of that record's lines (not just this
    account's own), as `{records: [...]}` — see
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
    read/replace for the *stored* fields (`over65`, `groupLevels`,
    `savedGroupings`). `GET`'s response also carries two read-only
    *computed* fields, `activeTaxYearStart`/`outOfTaxYearLineCount`,
    added on top by `LedgerStateService::getSettings()` — see "The
    active tax year" below; there's no column backing either, and `PUT`
    ignores them if a client sends them back.
  - `POST /api/ledger/batch` (`LedgerController`) — the one endpoint that
    still takes a *list*: `{operations: [...]}`, a 4-primitive vocabulary
    (`upsertLine`, `deleteLine`, `upsertTransaction`, `deleteTransaction`)
    applied atomically in one DB transaction
    (`LedgerStateService::applyLedgerOperations()`). Every line's `date`
    in the batch is hard-validated against this ledger's one (freshly
    computed, never stored) tax year before any operation runs; a
    rejection is a `400` with a clear message, not the usual uncaught
    500 — see "The active tax year" below. `upsertLine` always
    creates/updates a standalone line (`transaction: null`);
    `upsertTransaction` replaces a Transaction's whole line set in one go.
    `src/lib/ledgerOperations.js` (`buildSaveOperations`,
    `buildUnlinkOperations`, `buildDeleteOperations`,
    `buildReorderOperations`) is the *only* place that decides which
    primitives a given UI transition needs — a plain edit, a merge
    (two standalones → one `upsertTransaction`), an unlink
    (`deleteTransaction` + N `upsertLine`), a split-off, a 2→1 demotion,
    or a same-date reorder all funnel through it. Don't hand-assemble an
    `operations` array anywhere else. This is the *only* place several
    rows still need to change together: with a real database every other
    write is independently atomic per-row, which is what let the old
    "compute the whole next state, save it all at once" pattern go away.
  - `GET /api/match-candidates` (`MatchController` /
    `MatchingService::findCandidates()`) — replaces the old client-side
    "scan every transaction for a plausible counterpart" search. Query
    params: `currency`, `amount`, `date`, `mode` (`mirrored` or `direct` —
    same distinction `getComparableAmount`/`getDirectComparableAmount`
    used to draw, see "Matching and linking" below), optionally
    `excludeAccountIds`. Each candidate is `{lineId, line, account}` — a
    standalone line's own id doubles as its candidate identity; there's no
    `excludeTransactionId` param because the current draft's own account
    is already in `excludeAccountIds`, which already prevents a standalone
    line matching itself. Called debounced (`useMatchCandidates.js`, and
    the per-split-leg search inside `otherLines.jsx`) as the user types an
    amount into an unmatched leg, not on every keystroke synchronously.
  - `GET /api/isa-allowance?taxYearStart=YYYY` (`IsaAllowanceController` /
    `IsaAllowanceService::computeUsage()`) — see "ISA allowance engine"
    below.
  - `GET /api/currencies` / `GET /api/symbols` / `GET /api/counterparties`
    (`CurrencyController`/`SymbolController`/`CounterpartyController`) —
    read-only lists of the three reference entities, fetched once by
    `App.jsx` alongside the account list (see "Amounts, currencies, and
    reference data" below). No write endpoints exist yet — deliberately
    out of scope until an admin area is built; don't add `POST`/`PUT`
    here without discussing scope first.
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
  this is what lets a round-trip save keep every id stable. `Line` is the
  one entity with a normal auto-increment PK, and — unlike Account/
  Transaction — the frontend *does* see that id (`lineToArray()` includes
  it): a standalone line has no Transaction id to key off, so its own
  backend-assigned `id` is what the frontend uses as its row identity
  (`rowKey()` in `AccountLedger.jsx`/`StockLedger.jsx`) and what
  `upsertLine`/`deleteLine` operations address it by.
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
  either; that's what the endpoints above are for. `readState()` returns
  `{accounts, records, settings}`; `records` items are `{transactionId,
  lines}` — `transactionId: null` for a standalone line. `ImportLocalStorageCommand` also accepts the older
  `{transactions: [...]}` export shape and upgrades it on the fly
  (`upgradeLegacyShape()`: any transaction left with fewer than 2 lines
  becomes a standalone record) — kept specifically so a differently-shaped
  external database can still be imported later; don't remove that
  upgrade path without checking it's no longer needed.
- **Test suite** (`backend/tests/`, run via `php bin/phpunit`): covers
  `IsaAllowanceService` specifically — the flexible-ISA lot-tracking
  simulation is the one piece of logic in this app subtle enough to have
  produced a real bug before (see "ISA allowance engine"), so it gets a
  safety net where everything else relies on manual browser verification.
  Add a case there before changing that algorithm; don't feel obliged to
  add tests elsewhere in the backend to match.

## Data model — read this before touching transactions

- A **record** is `{ transactionId, lines: [] }` — the unit a ledger row
  actually represents, and the shape `GET /api/accounts/{id}/ledger`
  returns. `transactionId` is `null` for a **standalone line** (one line,
  no `Transaction` row in the backend at all) or a real id for a
  **linked transaction** (2+ lines, backed by a `Transaction` row). A
  `Transaction` strictly means 2+ linked lines — the moment an edit would
  leave it with fewer than 2, it's deleted and the remaining line becomes
  standalone instead of an emptied/1-line Transaction. There is no
  transaction-level `date` or `description` — both live on each **line**.
  Two lines of the same transaction can have different dates and
  different descriptions. This was a deliberate fix for a real bug
  (linked rows sharing one description); never reintroduce
  transaction-level date/description.
- A **line** is `{ accountId, amount, date, description, order?, ... }`,
  plus a backend-assigned `id` once persisted (see the id-exposure note
  under "Backend" above). `amount` is a **scaled integer**, signed:
  positive = increase, negative = decrease, regardless of account type —
  see "Amounts, currencies, and reference data" below for what "scaled"
  means. There is no separate debit/credit; the UI just labels
  positive/negative as "In"/"Out".
- `src/lib/ledgerOperations.js` is where every UI transition (plain edit,
  merge, unlink, split-off, 2→1 demotion, same-date reorder) gets
  translated into `POST /api/ledger/batch` operations — see the endpoint
  description under "Backend" above. `rowKey(record)` in
  `AccountLedger.jsx`/`StockLedger.jsx` (`record.transactionId ||
  \`line-${record.lines[0].id}\``) is the client-side row identity used
  for React keys, row-ref tracking, and matching the row currently being
  edited — **a standalone line's substituted draft in `effectiveRecords`
  must keep `lines[0].id` set to the real line id**, or `rowKey()` on the
  live-edited row silently stops matching `editingKey` and the row can no
  longer be opened for editing (this exact bug shipped once — the
  `draftLines()` helper intentionally omits `id` when building the lines
  a save would send, so the `effectiveRecords` substitution has to add it
  back in for display purposes).
- Account types: `asset`, `liability`, `equity`, `income`, `isa-income`,
  `expense`, `investment`, `isa-parent`. An `isa-parent` holds no balance
  itself — it's a wrapper grouping subaccounts via `isaParentId`.
- **`isa-income`** is a plain, balance-bearing, contra (credit-normal —
  it's in `CONTRA_TYPES`) account type for dividends/interest generated
  *inside* an ISA — HMRC doesn't count that money against the
  subscription limit even though it's genuinely new money entering an
  ISA-tagged account. It is **not** itself one of `isaProducts()` (no
  `isaKind`, no allowance usage of its own, no ISA picker in
  `AccountFormModal`) — it only matters as the *counterpart* line of a
  transaction: `IsaAllowanceService::isExternalLine()` treats a
  counterpart on an `isa-income` account the same as one on an
  `isaKind`-tagged account (internal, not a new subscription). Model a
  dividend/interest credit as a linked transaction between the ISA
  account and an `isa-income` account, not a standalone line — a
  standalone line has no counterpart to check and is always treated as
  external (see `isExternalLine()`'s docblock), so it would incorrectly
  count towards the allowance.
- **Investment accounts hold exactly one security**, referenced via
  `account.symbol` (a `Symbol` entity — see below). Trading currency
  lives on the `Symbol`, not the account: an investment account's own
  `currency` field is unused/absent — always derive trading currency via
  `symbol.tradingCurrency`, never `account.currency`, for an investment
  account. `amount` on an investment line is *units* (scaled by the
  symbol's own `scale`, a different scale from any currency's), not cash.
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

## Amounts, currencies, and reference data

Amounts used to be plain floats. They're **exact integers now, scaled by
a currency's or symbol's own `scale`** (e.g. `2000` = £20.00 at GBP's
scale of 2; `0` decimal places for JPY) — ported from a related legacy
project specifically to eliminate floating-point drift. This touches
every amount-like field: `Line.amount`, `Line.cashValue`,
`Line.exchangeAmount`, `Account.openingBalance`. The scaled-integer
representation crosses the API boundary too — the backend never emits a
decimal string for an amount, and the frontend never receives one; it's
integers in both directions, JSON like `"amount": 2000`.

- **`Currency`, `Symbol`, `Counterparty` are natural-key reference
  entities** (`backend/src/Entity/`), each with the business key itself
  as primary key — `Currency.code` (`"GBP"`), `Symbol.ticker`
  (`"AAPL"`), `Counterparty.name` (`"Barclays"`) — no surrogate id,
  deliberately, so raw DB records stay human-readable. `Account.currency`
  / `Account.symbol` / `Account.counterparty` and `Line.cashCurrency` /
  `Line.exchangeCurrency` are FKs to these, not free strings anymore.
  `Counterparty` covers both meanings `Account.counterparty` can have —
  "where this account is held" for a real account, "who was paid/who
  paid" for an income/expense/isa-income one; `AccountFormModal` labels
  the field "Institution" or "Counterparty" depending on `account.type`,
  but it's one column, one entity, either way.
  `Currency` also carries an optional `name` (e.g. "British Pound
  Sterling"). `Symbol` additionally carries `name`, `scale` (unit
  precision — *not* a currency scale), and `tradingCurrency` (FK to
  `Currency`). `Account.subtype`, by contrast, is a **plain string
  column, not a reference entity** — nothing else references it, so
  there's no half-normalization benefit to a table for it the way there
  is for Currency/Symbol/Counterparty; see "UI conventions" below for what
  it's for.
- **A currency is part of the imported *data*, not a fixed app-wide
  list** — `LedgerStateService::writeState()` (so `app:import-local-storage`
  too) takes an optional `currencies` array (`[{code, scale, name?},
  ...]`) and **upserts** each one (write scale/name, create if missing)
  *before* rebuilding accounts/lines/transactions from the rest of the
  same file. This is deliberately an upsert, not a wipe-and-rebuild like
  account/line/transactions: `Symbol.tradingCurrency` and this same
  import's own account/line rows hold `NOT DEFERRABLE INITIALLY
  IMMEDIATE` foreign keys into `currency`, so deleting a code a `Symbol`
  still references (when that `Symbol` isn't itself part of this import)
  would throw immediately — upsert gets the real goal ("the currencies
  this data needs now exist, with the right scale") without that
  failure mode. `LedgerStateService::readState()` (so `app:export-state`
  too) always includes the *full* `currencies` table in its output, not
  just codes actually referenced — a full export should carry currency
  data the same way it carries everything else.
- **`app:currencies:seed`** (`SeedCurrenciesCommand`) is a separate,
  idempotent convenience for bootstrapping a *fresh* database with a
  baseline currency list — not the mechanism real data flows through.
  A state-JSON import from a database with different currencies (e.g.
  RON/INR from the sibling Nucleware/Accounts project) just declares
  them in its own `currencies` array instead.
- **API wire format for these FKs is still just the natural-key string**
  (`"currency": "GBP"`, `"symbol": "AAPL"`), consistent with how
  `Account`/`Transaction` ids already work — never a nested object.
- **`LedgerStateService::resolveCurrency()`/`resolveSymbol()`/
  `resolveCounterparty()`** are where a JSON payload's currency
  code/ticker/counterparty name gets turned into the actual entity on
  write. `resolveCurrency`/`resolveSymbol`
  **hard-error** (`InvalidArgumentException`) on an unknown code/ticker —
  Currency and Symbol are deliberately curated, closed sets; a new one
  needs a real `scale` decided, which is exactly what a future "add
  symbol" admin flow (asking for name + scale) would exist to do.
  `resolveCounterparty` **find-or-creates** instead — institution/
  counterparty names were always free text before this schema existed
  (any bank, or any payee, not used yet is fine to type in
  `AccountFormModal`), and there's no meaningful extra data a first use
  needs to supply, so it stays that way rather than regressing into a
  closed picker.
- **`GET /api/currencies`/`/api/symbols`/`/api/counterparties`** are
  read-only for now (see "Backend" above) — `App.jsx` fetches all three
  once alongside the account list and passes them down as props
  (`currencies`, `symbols`, `counterparties`) to whatever needs them
  (`AccountFormModal`'s pickers, `AccountLedger`/`StockLedger`/
  `otherLines.jsx`'s scale lookups, `lib/grouping.js`'s currency-dimension
  bucketing). There's no context/global store — this app prop-drills
  already, see `accounts` itself.
- **`src/lib/scale.js`** is the one place that converts between the
  wire-format integer and a human-editable decimal string, without ever
  going through a float intermediate: `toMinorUnits(str, scale)` (parse,
  mirrors `parseFloat`'s NaN-on-failure contract) and `fromMinorUnits(value,
  scale)` (format, trims trailing zeros). Every input field's onChange
  handler across `AccountLedger.jsx`/`StockLedger.jsx`/`otherLines.jsx`/
  `AccountFormModal.jsx` goes through these instead of `parseFloat`/
  `String()` — don't reintroduce either.
- **`divRoundHalfUp(numerator, denominator)`** (also `lib/scale.js`, and
  mirrored exactly as a private method on `LedgerStateService` in PHP) is
  exact-integer division with round-half-up, implemented with plain
  integer arithmetic (`(2n*num + den) / (2n*den)` — no bcmath, no float
  division; PHP's 64-bit ints and JS `BigInt` both have ample headroom
  for any realistic ledger amount). This is the one place naive
  int-division would silently reintroduce drift — see "Stock valuation"
  below for where it's actually used, and keep the PHP and JS versions
  byte-identical if you ever touch either.
- **`src/lib/format.js`'s `fmt(amount, currencyCode)`/`fmtUnits(n,
  symbolTicker)`** keep their existing 2-argument call-site shape
  everywhere in the app — they don't take a `scale` parameter directly.
  Instead, `setCurrencyScales(currencies)`/`setSymbolScales(symbols)` are
  called once by `App.jsx` right after fetching `/api/currencies`/
  `/api/symbols`, populating a small module-level lookup `fmt`/`fmtUnits`
  read from internally. This was a deliberate choice over threading a
  `scale` argument through every single display call site (`AccountRow`,
  `Overview`, `charts.jsx`, ...) — a lookup by code/ticker is simpler than
  a prop-drilled parameter for something that's genuinely global,
  read-only, loaded-once data. If a value's scale genuinely isn't in the
  registry yet (e.g. mid-load), `fmt`/`fmtUnits` fall back to a plausible
  default (2 / 6) rather than crashing.

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
- `useOtherLines(account, accounts, draft, setDraft, smartDefaultForFirst,
  currencies, symbols)` is a shared hook used by **both** `AccountLedger`
  and `StockLedger` for their arrays of linked "other account" legs —
  adding, removing, updating, resolving to a savable line, and a
  debounced per-leg match search. `currencies`/`symbols` are needed for
  scale-aware amount parsing and to resolve an investment leg's trading
  currency via its `Symbol` (never `account.currency` — see "Amounts,
  currencies, and reference data" above). `OtherLinesEditor` is the
  shared row-rendering component (also takes `symbols`, for the same
  reason). Do not reintroduce a per-component copy of this logic; extend
  the shared hook/component instead.
- A selected match candidate's line data is stored directly on the
  `otherLine` as `matchedLineId`/`matchedLine` (set in `selectMatch`/
  `selectMatchForOtherLine`) rather than looked up from a `transactions`
  array — there isn't one client-side anymore. `resolveOtherLine()` uses
  `ol.matchedLine` when saving a matched leg.
- Removing or re-pointing a linked leg never deletes the other side's
  data — it gets queued into `splitOffLines` and saved as its own
  standalone record. This is load-bearing behavior, not an edge case:
  unlinking, deleting an account with entries, and repointing a split leg
  all rely on it.
- **Account-level imbalance stats** (`imbalancedLineCount`/`imbalanceIn`/
  `imbalanceOut`, in `GET /api/accounts`) are a global, precomputed
  mirror of `balanceHint()`'s own classification, not something the
  frontend re-derives — `LedgerStateService::imbalanceStatsByAccount()`
  walks every record once (a record's lines can span more than one
  account, so this can't be done per-account without loading every
  account's own ledger, which is exactly what the always-loaded account
  list exists to avoid — see "The frontend is a per-account editor"
  above). A record is imbalanced under the same rule `balanceHint()`
  uses: a lone unmatched line ("single"), or lines that don't net to
  zero within a currency ("unbalanced"); a genuine FX exchange (two
  legs, two currencies, opposite signs) and an empty/all-zero record are
  *not* imbalanced. Every line of an imbalanced record adds to its own
  account's count, and to `imbalanceIn` (sum of its positive-valued
  imbalanced lines) or `imbalanceOut` (sum of the magnitude of its
  negative-valued ones) — the same sign convention the ledger's own
  In/Out columns already use (see "Data model" above). **Deliberately
  two non-negative sums, not one netted signed value** — an account can
  show a nonzero `imbalancedLineCount` with real, nonzero `imbalanceIn`
  *and* `imbalanceOut` that happen to cancel (e.g. two separate
  unmatched lines, +50 and -50); a single net figure would hide that
  entirely, which is exactly the case this split exists to surface —
  don't collapse it back into one value. All three fields are omitted
  (not `0`) when an account has no imbalanced lines, per the usual
  null-omission convention; `imbalanceIn`/`imbalanceOut` individually
  can still be `0` while the account has imbalance (e.g. every
  imbalanced line is an "Out"). `AccountRow`/`SidebarGroupTree`
  highlight an imbalanced account with a left border + ⚠ badge (Out/In ·
  count, only whichever of Out/In is actually nonzero); its own ledger
  page (`AccountLedger`/`StockLedger`'s header) shows the same via the
  shared `ImbalanceBadge` in `ui.jsx` — pass it the account's own
  currency, or its Symbol's `tradingCurrency` for an investment account,
  same as the header's own balance display already does. The sidebar and
  Overview both offer an "Imbalanced only" checkbox that composes with
  an active search the same way (narrow first, then rebuild the nested
  grouping from what's left — see the search behavior above). Keep the
  PHP port and `lib/matching.js`'s `balanceHint()`/`lineBalanceValue()`
  in agreement if you touch either.

## Tags — cross-cutting facts that don't fit the account model

Some facts about a line cut across whatever Type/Subtype/Counterparty it
sits under — which car, which trip, whether something is tax-deductible,
its refund status — and don't fit a single-parent hierarchy. Tags cover
only these; **most of the "how much did I spend/earn on X" questions this
was originally motivated by are already answered by the account-grouping
tree** (Counterparty/Subtype/Type — see "UI conventions" below) once
nominal accounts adopted Counterparty. "Client" and "merchant" were
considered as tag dimensions during design but turned out redundant with
Counterparty and were dropped — don't reintroduce them as tags.

- **`Tag`** (`backend/src/Entity/Tag.php`) is a natural-key reference
  entity like `Currency`/`Symbol`/`Counterparty`, but with a **composite**
  key: `(dimension, value)` — e.g. `("Car", "AB12CDE")`,
  `("Status", "Refunded")`. Both `dimension` and `value` are open,
  find-or-create strings (`LedgerStateService::resolveTags()`), never a
  closed/curated set like Currency/Symbol. **`value` may be an empty
  string** — a bare, flag-style tag (`{"Car", ""}` for someone with
  exactly one car, `{"Tax-deductible", ""}` for a plain yes/no fact)
  rather than a fake value invented to satisfy the composite key; empty
  string, not null, same reasoning as `Account.name`. If a second
  instance of a previously-bare dimension shows up later (e.g. a second
  car), the fix is a one-time bulk edit of the existing `{dimension, ""}`
  tags to real values — an accepted trade-off, not something designed
  around up front.
- **`Line`↔`Tag` is a plain many-to-many** (`line_tag` join table,
  composite FK into `tag(dimension, value)`) — **tags live on the line,
  not the transaction**, mirroring the existing, deliberate choice to keep
  `date`/`description` per-line (two lines of one transaction can already
  have different dates/descriptions — see "Data model" above). A fuel
  purchase's expense leg gets `Car:AB12CDE`; its bank-withdrawal leg
  doesn't need to inherit or "borrow" it — there's no tag-ownership
  concept, and no dummy-transaction workaround for standalone lines,
  because tags never needed a transaction to attach to. If you want both
  legs of a transaction visibly tagged, tag both lines explicitly.
- **No uniqueness rule beyond exact `(dimension, value)` duplication on
  one line** — a line can carry two different values of the same
  dimension (e.g. both `Status:Refunded` and `Status:Cancelled`, or two
  different `Car` tags) — left unconstrained by design decision, not
  disallowed.
- **A refund is always its own real line**, dated whenever it actually
  happened, never a same-line void — `Refunded` is purely an annotation
  on the *original* line. Tags never affect `balance`/`costBasis`/any
  stored computation; they're metadata for filtering/searching after the
  fact only.
- **`LedgerStateService::resolveTags()`** does a full replace of a line's
  Tag set on every save (`Line::setTags()`), not incremental add/remove —
  called from `hydrateLine()`, so every write path (`upsertLine`,
  `upsertTransaction`, `writeState()`) carries tags the same way as every
  other line field.
- **Query endpoints** (`TagController`/`TagService`), deliberately narrow:
  - `GET /api/tags[?dimension=Car]` — distinct `(dimension, value)` pairs
    in use, optionally scoped to one dimension. Powers autocomplete
    (existing dimensions first, then existing values once one's chosen) —
    the guardrail against "Refunded" vs "refund" silently fragmenting a
    report, since nothing at the schema level prevents that.
  - `GET /api/lines?dimension=Car&value=AB12CDE` — every line carrying
    that exact tag, each with its account context
    (`{lineId, line, account}`, shaped like `GET /api/match-candidates`'s
    own candidates) — the drill-down behind a tag total.
  - `GET /api/tag-totals?dimension=Car[&excludeTag=Status:Refunded]` —
    server-side `SUM` grouped by `(value, currency)`, same
    "never sum bulk line data client-side" posture as
    `accountsWithStats()`'s own balance `SUM`. A line carrying more than
    one value of the requested dimension contributes to each value's
    total, not just one. **Scope cut: never sums investment lines** — an
    investment line's `amount` is units, not cash, so mixing it into a
    cash total under one `(value, currency)` bucket would silently
    combine incompatible quantities; an investment line can still be
    tagged and drilled into via `GET /api/lines`, just not summed here.
- **Not merged into the existing account search** — `flattenAllAccounts`/
  `leafMatchesQuery` (see "UI conventions" below) stays account-attribute
  search only; tags are line-level and get their own search surface.

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

## The active tax year — always computed, never stored

**A single ledger-project database belongs to exactly one UK tax year,
for its entire lifetime.** This mirrors how the sibling Nucleware/
Accounts project has always worked (one SQLite file per tax year) —
unlike that project, this app doesn't manage the multiple files itself
(there's no in-app database switcher); running a second tax year means
pointing a separate instance/`DATABASE_URL` at a separate file, entirely
outside this app's concern. `app:new-year` (see "Commands" above)
bootstraps that next file from the current one's closing balances —
still a separate, manual step (copy the file, then swap `DATABASE_URL`),
not something the running app triggers itself.

- **There is no stored setting for this — no column, no migration, no
  picker.** `LedgerStateService::determinedTaxYearStart()` computes it
  fresh on every call: `taxYearStartYearFor()` of the earliest date
  among every line currently in the database (`SELECT MIN(date) FROM
  line`), plus `$extraDates` when called from the live-write path (the
  batch about to be saved — so a blank database's very first save
  determines its own year in the same breath it's validated against).
  Nothing is ever written to persist this; it's recomputed every time
  it's needed, from whatever data actually exists right now. A prior
  design tried storing it in `settings.activeTaxYearStart` and only
  letting a blank database auto-determine it (to avoid retroactively
  restricting older, already-multi-year data) — dropped entirely once
  it turned out the real data was never multi-year to begin with; don't
  reintroduce that column/migration.
- **`GET /api/settings` exposes two *computed*, read-only fields**
  (added by `getSettings()` on top of `settingsToArray()` — the latter
  stays pure/stored-only, used unchanged by `readState()`/
  `replaceSettings()`, so a full export/import never carries these):
  - `activeTaxYearStart` — the year above, or `null` on a genuinely
    blank database (no lines saved anywhere yet). `App.jsx`'s header
    only renders the `2024/25 tax year` badge when this is non-null;
    don't reintroduce a `?? todayISO()`-style fallback for the null
    case, it means exactly "nothing to derive from yet."
  - `outOfTaxYearLineCount` — how many *already-saved* lines fall
    outside that year's bounds (`LedgerStateService::outOfTaxYearLineCount()`).
    Since the year is derived from the *earliest* date, nothing can be
    before it by construction — this only ever counts lines *after* the
    year's end, e.g. an import that itself spanned more than one tax
    year. **Warning-only, never blocks** — existing data is never
    rejected retroactively, only flagged (`App.jsx`'s header shows a
    small "N outside" badge next to the tax-year label when nonzero).
- **Only *new* lines are ever hard-blocked** — `AccountLedger`/
  `StockLedger`'s `commit()` (`lib/isa.js`'s `dateOutsideTaxYear()`, a
  no-op when `activeTaxYearStart` is `null`) rejects client-side before
  ever calling the API, and
  `LedgerStateService::assertOperationDatesInActiveTaxYear()`
  independently rejects server-side with a `400` — the same "don't just
  trust the frontend" posture `resolveCurrency()`/`resolveSymbol()`
  already take elsewhere. `writeState()` (import/restore) does **not**
  block anything — a historical import is exactly the case that can
  legitimately produce an `outOfTaxYearLineCount` warning rather than a
  rejection. Since the determined year (and the warning count) can
  shift with *any* write — a new earliest date moves the year, which
  can also change which existing lines now count as "outside" —
  `App.jsx`'s `saveLedgerOperations()` refetches `/api/settings` after
  every ledger write, not just once. If you touch the UK tax-year math
  (6 April boundary, the `"YYYY/YY"` label), update `lib/isa.js`'s
  `taxYearStartYearFor()`/`taxYearBounds()` *and* `LedgerStateService`'s
  copies of the same together — independent ports of the same rule, not
  shared code; a drift between them means a line one side accepts the
  other silently rejects (or vice versa).
- **Every line about to be saved is checked, not just the draft's own
  `date` field** — `draftLines()`'s output includes a matched existing
  line's *own* original date (`otherLines.jsx`'s `resolveOtherLine()`
  returns `{ ...ol.matchedLine }` verbatim for a matched leg), which can
  predate the determined tax year even when the row being edited
  otherwise looks fine. That's intentional, not a bug to "fix" by only
  checking `draft.date`.
- **`BalanceChart`/`UnitsChart` only offer two intervals: "Tax Year" and
  "Custom"** (`lib/chartSeries.js`'s `CHART_INTERVALS`/`intervalRange()`)
  — every fixed-lookback preset that used to exist (30D/3M/6M/1Y/YTD/All)
  was removed deliberately: they're all anchored to *today*, which makes
  them useless once you're looking at a past tax year's chart (a "1Y"
  button showing the wrong year is worse than not having it). "Tax Year"
  defaults every account's chart to this ledger's own computed tax year
  — `intervalRange("taxyear", { taxYearStart, ... })` uses `lib/isa.js`'s
  `taxYearBounds()`, clamped to today so a step series never charts into
  the future. `AccountLedger`/`StockLedger` thread their own
  `activeTaxYearStart` prop straight through as `taxYearStart`; falls
  back to earliest-line-date..today when it's `null` (blank ledger,
  nothing to bound by yet). "Custom" is a plain from/to date pair local
  to each chart component (`customStart`/`customEnd` state, not lifted
  to `App.jsx` — there's no reason another view would need it) —
  `charts.jsx`'s `selectIntervalWithCustomSeed()` pre-fills both fields
  with the tax year's own bounds the *first* time "Custom" is picked
  (only while both are still empty), so there's a sensible starting
  point to tweak from instead of a blank/unbounded default; it never
  overwrites a value the user's already typed.

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
  Rather than storing a rounded price, the state keeps the last trade's
  raw `cashValue`/`units` pair and divides only once per computation
  (`divRoundHalfUp`) — avoids compounding rounding error across many
  trades. The old `1e-9` float-epsilon "snap to zero" is gone entirely:
  with exact integers, units hits exactly `0` when fully sold; the only
  thing zeroed defensively now is `cost`, to absorb ±1-minor-unit
  rounding dust from `divRoundHalfUp`, not float fuzz.
- Cost basis / portfolio value math mixes **two different scales** —
  `cost`/`cashValue` are currency-scale integers, `units`/`amount` are
  symbol-scale integers. A cross-multiply-then-divide via
  `divRoundHalfUp` (see "Amounts, currencies, and reference data" above)
  keeps every intermediate value an exact integer of the correct implied
  scale without either function ever needing to know either scale
  explicitly — don't "simplify" this to a plain `/` division.
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
- **`Account.openingBalanceCashValue`** pairs with `openingBalance` the
  same way a trade's `cashValue` pairs with `amount` — the cost basis
  tied to that opening unit count, only ever meaningful for an investment
  account. Nullable, omitted from JSON like every other nullable field,
  and set only by `app:new-year` (see "Commands" above) when carrying an
  investment account's closing position into a fresh tax year's file —
  there's no UI for it. Both `stockStatsFor()` and the frontend
  equivalents (`StockLedger.jsx`'s running column,
  `stockMath.js`'s `buildCostBasisSeries`/`buildPortfolioValueSeries` for
  the chart) seed their cost/value walk from `openingBalance`/
  `openingBalanceCashValue` instead of starting at zero — keep these in
  agreement if you touch any of them, or a rolled-over account's header,
  its own running column, and its chart will silently disagree.

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
- Grouping (sidebar + Overview) is a cascading 1–4 level picker over
  {Type, Counterparty, Subtype, Currency} with savable presets in
  `settings.savedGroupings`. `buildNestedGroups` / `bucketBy` are generic
  over the dimension — extend those rather than writing a new grouping
  path for a new dimension. `account.counterparty` (an FK to `Counterparty`
  — see "Amounts, currencies, and reference data" above) is labelled
  "Institution" or "Counterparty" in the UI depending on `account.type`,
  but it's a single grouping dimension either way — the tree doesn't split
  by label. `account.subtype` (a free-text product-type tag like "Credit
  Card"/"Loan"/"Trading", not a reference entity — see "Data model" below)
  exists specifically as a fourth dimension for when counterparty alone
  doesn't split a crowded chart of accounts finely enough (e.g. several
  credit products at one bank, or several accounts with no real
  institution at all). Unlike counterparty, an ISA subaccount does **not**
  inherit `subtype` from its wrapper — it's a property of the individual
  product, not something a wrapper has one of on its subaccounts' behalf.
- Every account search (the sidebar, Overview, and the linked-account
  picker in `otherLines.jsx`) is free text over all four grouping
  dimensions **plus the account name**, matched independently of
  whatever grouping is currently active — `lib/grouping.js`'s
  `flattenAllAccounts()` always builds the full {Type, Counterparty,
  Subtype, Currency} path for every account, and `leafMatchesQuery()`
  does a whitespace-split, order-independent AND match against
  `path + name`. This is deliberately decoupled from `buildNestedGroups`
  (which only nests by the levels actually selected) — searching by
  counterparty has to work even when the tree on screen is grouped by
  Type alone.
- The sidebar and Overview keep their normal nested-tree/grid layout
  while searching, rather than flattening to a plain result list: a
  query first narrows the account list down to matches (via
  `flattenAllAccounts`/`leafMatchesQuery` above), then that narrowed
  list is run back through `buildNestedGroups` with the *active*
  `groupLevels` and rendered with the same `SidebarGroupTree`/
  `OverviewGroupTree` used for normal browsing — empty groups just drop
  out on their own. A match on a dimension the active grouping doesn't
  nest by (e.g. counterparty while grouped by Type alone) still surfaces
  the right account, just nested under whatever levels are actually
  active, not annotated with the dimension it matched on. The account
  picker (`AccountPicker.jsx`) is the one exception — it's a compact
  select-one widget, not a browsing view, so its search intentionally
  stays a flat, path-annotated list for fast keyboard selection.

## Things intentionally *not* built (don't add without asking)

- No live market price feed / real "current value".
- No multi-currency conversion beyond the per-line exchange tag.
- No JISA, no LISA bonus modeling, no flexible-ISA partial-year handling.
- No admin UI/write endpoints for currencies, symbols, or counterparties —
  `GET /api/currencies`/`/api/symbols`/`/api/counterparties` are read-only
  by design (see "Amounts, currencies, and reference data"). A future
  admin area, including a modal to define a new stock symbol's name and
  scale, is planned but not started — don't build ahead of that
  conversation.
