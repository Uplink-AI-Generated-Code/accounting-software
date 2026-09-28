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
  `format.js` (date/currency formatting, `uid`), `decimal.js` (the
  canonical-decimal-string arithmetic core, no floats — see below; the
  frontend modules with their own tests are `decimal.js`
  (`decimal.test.js`), `format.js` (`format.test.js`), and `stockMath.js`
  (`stockMath.test.js`, its `stockPlaces` cases only — see "Stock
  valuation" below), all run via `yarn test`),
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
  ledgers' row lists — it also owns drag-to-reorder among same-date rows
  (`startDrag`, wired to each row's grip handle). It measures and scrolls
  relative to the row list's nearest overflow container (`App.jsx`'s
  `<main>`), not the window, since that's what actually scrolls.

When adding a helper, put it in the `lib/` module that already owns that
domain rather than inlining it into a component or creating a new module for
one function.

## Commands

Frontend: Vite + React, `yarn.lock` is the checked-in lockfile (no
`package-lock.json`).

- Install: `yarn install` (or `npm install`)
- Dev server: `yarn dev` — starts Vite on :5173, proxying `/api/*` to the
  Symfony backend on :8000 (see `vite.config.js`) — **the backend must
  already be running** for the app to load any data. Set `LEDGER_API` to
  override the proxy target (e.g. `LEDGER_API=http://127.0.0.1:8001 yarn
  dev`), for pointing a dev server at a backend running on a different
  port than the default :8000.
- Test: `yarn test` (Vitest) — covers `src/lib/decimal.js`
  (`decimal.test.js`, run against the shared `tests/fixtures/
  decimal-cases.json`), `src/lib/format.js` (`format.test.js`:
  `fmt`/`fmtPlain`/`fmtUnits` never rounding, always showing at least
  `scale` decimals and every stored digit beyond it), and
  `src/lib/stockMath.js` (`stockMath.test.js`: the `stockPlaces` cases of
  the same shared fixture, cross-checked against the PHP
  `StockPrecisionTest` — see "Stock valuation" below); see "Amounts,
  currencies, and reference data" below.
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
  SQLite schema directly. **Any generated migration containing `DROP
  TABLE`** (the temp-table-rebuild pattern Doctrine emits whenever a
  column changes on SQLite) **must disable the `foreign_keys` pragma
  around the rebuild, then re-enable it with a `PRAGMA foreign_key_check`
  in between** — now that `foreign_keys` enforcement is on in every
  environment (see `ForeignKeysMiddleware` under "Backend" below),
  SQLite's `DROP TABLE` performs an implicit `DELETE FROM <table>` first,
  which fires any `ON DELETE CASCADE` pointing at that table and can
  silently wipe dependent rows (this is exactly what happened to every
  `line` row via `line.account_id`'s cascade in
  `Version20260919194846.php` before it was fixed). `PRAGMA
  foreign_keys` is a documented no-op inside an active transaction in
  SQLite, so the migration also needs `isTransactional(): bool { return
  false; }`, and the pragma statements must go through `$this->addSql()`
  like every other statement, not a direct
  `$this->connection->executeStatement()` call — `addSql()` only queues
  SQL into `$plannedSql`, executed by the migrator in order *after*
  `up()`/`down()` returns, so a pragma toggled via `executeStatement()`
  runs at the wrong time (immediately, interleaved with nothing) instead
  of bracketing the queued `DROP TABLE`/`CREATE TABLE`/`INSERT` sequence
  the way it needs to. Verify empirically against a copy of a real
  database (never the live file — see the testing-isolation memory) by
  running the actual `doctrine:migrations:migrate` command and comparing
  row counts before/after, not just by reasoning about the SQL.
  **Known quirk:** `doctrine:migrations:diff` currently also proposes a
  spurious `line_tag.line_id` column rebuild on a fully up-to-date schema
  — a DBAL SQLite introspection quirk that predates the decimal-storage
  work. Don't commit that piece of a generated diff; review what
  `migrations:diff` proposes before accepting it wholesale.
- One-time import of existing browser data: export it from devtools
  (`copy(localStorage.getItem('ledger-storage:personal:ledger-data'))`),
  save it as a JSON file, then `php bin/console app:import-local-storage
  path/to/file.json` — see `src/Command/ImportLocalStorageCommand.php`.
  **This replaces the whole database's accounts/lines/transactions** (not
  a merge) **and upserts whatever `currencies` the file declares** — see
  "Amounts, currencies, and reference data" below. Amounts in the file can
  be either canonical decimal strings (the current export format) or the
  older pre-phase-2 scaled integers — `App\Money\LegacyIntegerAmounts::
  upgrade()` detects and converts the latter using each account's own
  currency/symbol scale at the time of conversion; a JSON float is
  ambiguous and rejected outright rather than guessed at.
- Backup/export the current database: `php bin/console app:export-state
  path/to/file.json` — see `src/Command/ExportStateCommand.php`. Writes
  the same shape `LedgerStateService::readState()` produces internally
  (amounts as canonical decimal strings), so the file round-trips
  straight back through `app:import-local-storage`.
- Fresh database bootstrap: `php bin/console app:currencies:seed` populates
  a baseline currency list (GBP/USD/EUR/JPY/CHF/CAD/AUD/RON/INR) — see
  `src/Command/SeedCurrenciesCommand.php`. Idempotent, safe to re-run.
  Not the only way a currency gets added — see below.
- Bootstrap the *next* tax year's database from the current one:
  `php bin/console app:new-year databases/2025-2026.sqlite3` — see
  `src/Command/NewYearCommand.php` and "The active tax year" below. The
  actual copy/wipe/carry-forward logic lives in `NewYearService::
  createNextYear()`, shared with `DatabaseController::newYear()`'s
  in-app "Start a new tax year" action (see "Backend" below) — this
  command is now a thin wrapper around it, kept for scripting/backup
  use. Copies the live SQLite file wholesale (so every Currency/Symbol/
  Counterparty/Tag/Account definition and the settings row carry over
  exactly, no re-derivation), then, in the copy only, wipes every
  line/transaction and sets each account's `openingBalance`/
  `openingBalanceCashValue` to its *current* closing balance/cost basis
  for asset/liability/equity/investment accounts, or resets both to
  null for income/isa-income/expense/investment-parent accounts (period-specific
  flows, not a balance that carries across tax years). Refuses to run if
  the target path already exists. This CLI path never touches which
  file the running app is pointed at — use the in-app switcher, or
  `POST /api/databases/active`, for that.
- `backend/databases/` holds one `.sqlite3` file per tax year (plus any
  other files present), and `databases/app-settings.yaml` names which
  one is currently active — see `AppSettingsRepository`/
  `ActiveDatabaseDriver` under "Backend" below for how switching works.
  `backend/databases/` is gitignored via its own rule, separate from
  `var/` (which is also entirely gitignored); a separate `var/data_test.db`
  is used for the test suite (see below). `DATABASE_URL` (`.env`/
  `.env.local`) is only meaningful for the `test` environment now — dev
  and prod resolve their connection from `app-settings.yaml` instead, at
  the moment each connection actually opens (see `ActiveDatabasePathResolver`).
- Run the backend test suite: `php bin/phpunit` (from `backend/`). Uses the
  `test` environment's own SQLite file — run `php bin/console
  doctrine:migrations:migrate --env=test` once after a fresh clone or a new
  migration, same as for `dev`.
- **Migrating every tax-year database after pulling a schema change**
  (e.g. after merging the phase-2 decimal-storage migration): `backend/
  databases/` typically holds more than one `.sqlite3` file (one per tax
  year — see below), and only whichever one is currently active gets
  migrated by an ordinary `doctrine:migrations:migrate` run against the
  dev connection. Migrate all of them, each targeted directly via
  `ACTIVE_DATABASE_PATH_OVERRIDE` (the same override
  `ActiveDatabasePathResolver`/`DatabaseController::create()` use — see
  below) rather than switching the active database back and forth:

  ```bash
  cd backend
  backup="databases/backup-$(date +%Y%m%d-%H%M%S)" && mkdir -p "$backup" && cp -n databases/*.sqlite3 "$backup"/
  for f in databases/*.sqlite3; do echo "== $f"; ACTIVE_DATABASE_PATH_OVERRIDE="$PWD/$f" php bin/console doctrine:migrations:migrate --no-interaction || break; done
  ```

  Back up first, unconditionally — the backup is the undo, since a
  migration like the phase-2 one rewrites every stored amount in place.
  The backup goes under `databases/backup-<timestamp>/`, inside
  `backend/databases/` itself: that whole directory is already gitignored
  (`/databases/` in `backend/.gitignore`, confirmed with `git
  check-ignore`), so the backup can never end up committed by a stray
  `git add -A` the way a sibling `../db-backups/` folder could. The
  timestamp also means re-running this after a partial failure creates a
  *new* backup folder rather than overwriting the pre-migration one, and
  `cp -n` refuses to clobber a file that's already there for the same
  reason. The loop's own glob, `databases/*.sqlite3`, is non-recursive —
  it only matches files directly under `databases/`, never anything
  inside `databases/backup-*/`, so the backup folder's own copies are
  never picked back up as migration targets. Each iteration echoes the
  file it's about to migrate first, so a failure identifies exactly which
  database it was.

  `MigrationStatusListener` refuses every `/api/*` request against any
  database whose schema isn't caught up (see "Backend" below), so a file
  left unmigrated simply can't be selected as active until this is run
  against it; and a migration's own `down()` can refuse to run — the
  phase-2 migration's `down()` in particular refuses to convert a value
  back to a scaled integer if it now has more decimal places than its
  currency's/symbol's `scale`, or would need more than 18 total digits,
  since either would silently lose data going back to the old
  representation.

There is a small PHPUnit suite for the backend (see "Backend" below for what
it covers and why); the frontend has a small Vitest suite scoped to
`src/lib/decimal.js`/`src/lib/format.js`/`src/lib/stockMath.js` (`yarn
test`, see "Amounts, currencies, and reference data" and "Stock valuation"
below) and no linter, but otherwise no test suite.

## Backend

- **Single user, no auth.** This is a personal local app; there's no `User`
  entity and no login. If that ever changes, every controller and every
  service's write path need an ownership check added, not just a login
  screen bolted on.
- **`MigrationStatusListener`** (`src/EventListener/`, `kernel.request`,
  priority 300) checks, in order: is there an active database at all
  (`databases/app-settings.yaml`'s `activeDatabase` must be non-null and
  name a file that exists under `databases/` — see `AppSettingsRepository`
  below), then is its schema caught up with the latest migration. It
  refuses every `/api/*` request except
  `/api/databases*` (which needs to work *without* an active database,
  to power the picker) with a `503` and a `reason` field —
  `no_active_database`, or `migrations_pending` with a clear
  `{"error": "Database schema is out of date (N migration(s) pending) —
  run: php bin/console doctrine:migrations:migrate"}` — checked via
  `DependencyFactory::getMigrationStatusCalculator()`, not by parsing
  whatever SQL exception happens to surface first. Runs before routing so
  no controller/service ever touches a missing or stale schema.
  `App.jsx` surfaces `no_active_database` as the full-screen
  `DatabaseSwitcherBlocking` picker, and the migrations-pending message
  in its "can't reach backend" banner otherwise — see its
  `backendErrorReason`/`noActiveDatabase` state. The migrations-pending
  half of this existed because it bit for real once: copying a database
  for a new tax year before running a later migration against it made
  `GET /api/accounts` 500, which — because `App.jsx` used to gate its
  whole startup fetch on accounts succeeding — cascaded into the currency
  picker looking broken too, with no clue the actual problem was one
  unrun migration.
- **`DatabaseController`** (`/api/databases*`) is what the in-app
  switcher (`src/components/DatabaseSwitcher.jsx`) talks to: `GET
  /api/databases` lists every `.sqlite3` file present with `{filename,
  label, isTaxYear, active}`; `POST /api/databases/active` (body
  `{filename}`) writes `activeDatabase` via `AppSettingsRepository::
  write()`; `POST /api/databases` (body `{startYear}`) creates a
  brand-new `<year>-<year+1>.sqlite3`, running
  `doctrine:migrations:migrate` then `app:currencies:seed` against it
  via `Symfony\Component\Process\Process` before it's considered created
  (cleans up the empty file on any failure); `POST /api/databases/new-year`
  (no body) is the in-app "start a new tax year" action, calling the
  same `NewYearService::createNextYear()` the `app:new-year` command
  uses, against the currently-active file.
- **`AppSettingsRepository`** (`src/Service/`) owns
  `backend/databases/app-settings.yaml` — a plain, hand-editable,
  gitignored YAML file (not Doctrine-managed) holding `activeDatabase`
  (which tax-year file is active) plus two settings that are genuinely
  global rather than tied to one tax year: `groupLevels`, `savedGroupings`
  (see "UI conventions" below). `read()` returns defaults
  (`activeDatabase: null`, `groupLevels: []`, one seeded `savedGroupings`
  entry) when the file is missing or fails to parse. `write(array
  $partial)` does a `flock()`-guarded read-merge-write: a *separate*,
  never-renamed lock file (`app-settings.yaml.lock`) guards the critical
  section — locking the data file's own descriptor doesn't work, since
  `write()` also atomically `rename()`s a temp file over that same path,
  which would swap the lock's inode out from under it mid-write. This
  replaced an earlier design (`databases/active.sqlite3`, a symlink) that
  needed a `SIGUSR2` php-fpm pool-reload and `idle_connection_ttl` tuning
  to work around real staleness bugs — see
  `docs/superpowers/specs/2026-09-19-app-settings-and-active-database-design.md`
  for the history.
- **`ActiveDatabasePathResolver`**/**`ActiveDatabaseDriver`**/
  **`ActiveDatabaseMiddleware`** (`src/Doctrine/`) are how a real SQLite
  connection actually gets pointed at the active file: `ActiveDatabaseMiddleware`
  implements `Doctrine\DBAL\Driver\Middleware` (auto-registered for the
  `default` connection by doctrine-bundle's autoconfiguration, no
  `services.yaml` wiring needed) and, for every environment except
  `test`, wraps the driver in `ActiveDatabaseDriver`, whose `connect()`
  calls `ActiveDatabasePathResolver::resolve()` and overrides the
  connection's `path` param with whatever it returns — read fresh from
  `app-settings.yaml` on every real connection attempt, with no env var,
  symlink, or compiled-container value in between to go stale. `resolve()`
  checks `getenv('ACTIVE_DATABASE_PATH_OVERRIDE')` first (used by
  `DatabaseController::create()`'s migrate/seed subprocess to target a
  brand-new, not-yet-active file — deliberately not `DATABASE_URL`,
  since that name is tracked by Symfony's Dotenv and a subprocess
  inheriting `SYMFONY_DOTENV_VARS` would have it silently overwritten
  from `.env.dev`); otherwise it reads `activeDatabase` and throws if
  nothing's configured. That throw is safe for the HTTP path —
  `MigrationStatusListener` already refuses every `/api/*` request
  before any connection is attempted when there's no active database —
  but means a bare CLI command (e.g. `doctrine:migrations:migrate`) run
  with nothing configured now fails loudly instead of silently
  succeeding against the wrong file. **Anything that needs the active
  database's real file path directly (not through the ORM's own live
  connection) must go through `ActiveDatabasePathResolver::resolve()`**
  — `Doctrine\DBAL\Connection::getParams()['path']` reflects only the
  connection's *original* params from `DATABASE_URL`, never this
  middleware's override, since `AbstractDriverMiddleware::connect(array
  $params)` takes `$params` by value and the mutation never propagates
  back into `Connection`'s own stored params. This bit `NewYearService`
  for real once — it read `getParams()` directly and silently built a
  new tax year's file from the wrong source.
  `config/packages/doctrine.yaml`'s `dbal: url:` stays pointed at the
  base `.env`'s templated default; it's resolved once at connection
  construction and then unconditionally overwritten by
  `ActiveDatabaseDriver` for every environment except `test`, so its
  actual value doesn't matter outside `test`. `backend/.env.dev` no
  longer sets `DATABASE_URL` at all (only its `APP_SECRET` block
  remains) — there's nothing left for it to override.
- **Endpoints, grouped by what the frontend uses them for:**
  - `GET /api/accounts` (`AccountController::list`) — the lightweight,
    app-wide list. `LedgerStateService::accountsWithStats()` computes each
    account's `balance` and `entryCount` — via `lineSumsByAccount()`,
    which sums every line's `amount` exactly in PHP with
    `Decimal::add()`, not a SQL `SUM(amount)` (SQLite's `SUM` on a `TEXT`
    column coerces to floats, which is exactly what storing exact decimal
    strings exists to avoid) — plus, for
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
  - `GET`/`PATCH /api/settings` (`SettingsController`) — a merged view
    over two different backends, transparent to the frontend: `over65`
    lives per-database, in a `Setting` key-value table (natural-key
    entity, `key`+`value`, `value` always valid JSON text — see
    `SettingsService`); `groupLevels`/`savedGroupings` live globally, in
    `app-settings.yaml` (see `AppSettingsRepository` above) — a UI
    grouping preference has no reason to reset just because you switched
    tax years. `GET` merges both plus two read-only *computed* fields,
    `activeTaxYearStart`/`outOfTaxYearLineCount`, added on top by
    `LedgerStateService::getSettings()` — see "The active tax year"
    below; there's no column backing either. `PATCH` takes a **partial**
    object — only the field(s) actually changing — and
    `LedgerStateService::patchSettings()` routes each key present to
    whichever backend owns it; the frontend never spreads the whole
    `settings` object into a save call any more (`App.jsx`'s
    `saveSettings()` merges the partial into local state instead of
    replacing it).
  - `POST /api/ledger/batch` (`LedgerController`) — the one endpoint that
    still takes a *list*: `{operations: [...]}`, a 5-primitive vocabulary
    (`createLine`, `updateLine`, `deleteLine`, `linkLines`, `unlinkLine`)
    applied atomically in one DB transaction
    (`LedgerStateService::applyLedgerOperations()`). Every line's `date`
    in the batch is hard-validated against this ledger's one (freshly
    computed, never stored) tax year before any operation runs; a
    rejection is a `400` with a clear message, not the usual uncaught
    500 — see "The active tax year" below. `createLine` always creates a
    fresh standalone line (there's no `transactionId` field to set —
    membership is established later, if at all, by `linkLines`);
    `updateLine` edits an existing line's own fields in place and never
    touches transaction membership either way; `deleteLine` deletes a
    line outright, and — like `unlinkLine` below — cascades to dissolve
    its transaction (or demote the sole survivor to standalone) if that
    drops it below 2 lines. `linkLines` puts 2+ given lines (real ids
    and/or tempIds from an earlier `createLine` in the same batch) into
    one transaction — extending the single existing transaction they
    already share, or creating a fresh one if none of them has one yet —
    and errors if they span two different existing transactions or
    repeat an id. `unlinkLine` is idempotent: it removes one line from
    its transaction, or does nothing if the line is already standalone.
    `src/lib/ledgerOperations.js` (`buildSaveOperations`,
    `buildUnlinkOperations`, `buildDeleteOperations`,
    `buildReorderOperations`) is the *only* place that decides which
    primitives a given UI transition needs — a plain edit, a merge (two
    standalones → `linkLines`), an unlink (one `unlinkLine` per line
    being detached), a split-off, a 2→1 demotion, or a same-date reorder
    all funnel through it. Don't hand-assemble an `operations` array
    anywhere else. This is the *only* place several rows still need to
    change together: with a real database every other write is
    independently atomic per-row, which is what let the old "compute the
    whole next state, save it all at once" pattern go away.
  - `GET /api/match-candidates` (`MatchController` /
    `MatchingService::findCandidates()`) — replaces the old client-side
    "scan every transaction for a plausible counterpart" search. Query
    params: `currency`, `amount` (a decimal string, same wire format as
    every other amount), `date`, `mode` (`mirrored` or `direct` — same
    distinction `getComparableAmount`/`getDirectComparableAmount` used to
    draw, see "Matching and linking" below), optionally
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
    list all rows of the three reference entities, fetched once by
    `App.jsx` alongside the account list (see "Amounts, currencies, and
    reference data" below). `Currency` and `Symbol` now have full admin
    CRUD (`POST`/`PATCH`/`DELETE`, see below and
    `src/components/ReferenceDataView.jsx`); `Counterparty` remains the
    one that's genuinely read-only/find-or-create-only — see
    `resolveCounterparty()` under "Amounts, currencies, and reference
    data" below.
  - `POST`/`PATCH`/`DELETE /api/currencies[/{code}]` (`CurrencyController`)
    and `POST`/`PATCH`/`DELETE /api/symbols[/{ticker}/{tradingCurrency}]`
    (`SymbolController`) — full admin CRUD for these two closed-set
    reference entities (Symbol's identity is the pair `(ticker,
    tradingCurrency)`, not the ticker alone — see "Amounts, currencies,
    and reference data" below — so its duplicate check on create, and its
    `PATCH`/`DELETE` routes, key on the pair). `code`/`(ticker,
    tradingCurrency)` are immutable once created; `PATCH` can change
    `name` and/or `scale`. Now that storage is arbitrary-precision decimal
    strings (see "Amounts, currencies, and reference data" below), `scale`
    is just the minimum number of decimals *displayed* — editing it is a
    plain field update on the `Currency`/`Symbol` row and never touches a
    single stored amount; there is no rescale/rewrite step and no
    precision-loss check to fail. `scale`
    itself is capped at 12. `DELETE` relies on the schema's own
    foreign-key enforcement to refuse a still-referenced row, translated
    into a clean `409`. `POST /api/symbols` was added first, specifically
    because Symbol (unlike Counterparty) is a closed set with no
    find-or-create and no seed command like `app:currencies:seed`: a
    blank database starts with zero symbols, which made it impossible to
    create the *first* investment/Stocks & Shares ISA account at all —
    used by `AccountFormModal.jsx`'s inline "+ Add a new symbol" flow,
    which opens automatically wherever the Symbol picker would otherwise
    be a dead end. See
    docs/superpowers/specs/2026-09-26-currency-symbol-admin-design.md for
    the full design.
- **None of the write handlers are optimistic on the frontend** except
  `saveAccount`/`saveSettings` in `App.jsx` (plain replaces with no
  cascading effect elsewhere) and a same-date reorder
  (`useAccountLedger.js`'s `reorder()`, which overlays the new `order`
  values on the fetched records until the save and reload land — it only
  touches `order` on lines already on screen, so there's no cascade to
  get wrong, and it lets the row animate on click/drop instead of after
  a round trip). Account deletion and every transaction
  write wait for the response, then re-fetch (`refreshAccounts()` for the
  account list; each ledger's own `reload()` for its rows) rather than
  trying to patch local state — specifically so the cascade/merge/
  split-off logic lives in exactly one place (the backend), not
  duplicated in JS. If this ever needs to feel snappier, that's the place
  to add optimism, not to move business logic back to the frontend.
- **`Account`/`Transaction` ids are frontend-provided strings** (the
  frontend already generates them with `uid()`), not Doctrine-generated —
  this is what lets a round-trip save keep every id stable. The one
  exception: when `linkLines` needs a brand-new Transaction (none of the
  lines being linked already has one), the *backend* generates its id
  (`bin2hex(random_bytes(8))`, 16 hex characters) — deliberately narrow,
  made possible because the frontend never needs to know a Transaction's
  id in advance, since it always refetches after a write rather than
  trusting a locally-assembled id back. `Line` is the
  one entity with a normal auto-increment PK, and — unlike Account/
  Transaction — the frontend *does* see that id (`lineToArray()` includes
  it): a standalone line has no Transaction id to key off, so its own
  backend-assigned `id` is what the frontend uses as its row identity
  (`rowKey()` in `AccountLedger.jsx`/`StockLedger.jsx`) and what
  `updateLine`/`deleteLine` (and `linkLines`/`unlinkLine`, which address a
  line the same way) operations address it by.
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
- **SQLite's `foreign_keys` pragma is enabled on every connection this
  app makes** (`src/Doctrine/ForeignKeysMiddleware`/`ForeignKeysDriver`,
  a Doctrine connection middleware executing `PRAGMA foreign_keys = ON`
  immediately after every real connect — SQLite doesn't enforce foreign
  keys by default, and the setting isn't stored in the database file
  itself, so it has to be set per-connection every time). Every FK in
  the schema is now genuinely enforced, not merely declarative — see
  `docs/superpowers/specs/2026-09-19-generalized-investment-parent-design.md`
  for the audit confirming this doesn't conflict with any existing
  bulk-delete/insert ordering in this codebase.
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
- **Test suite** (`backend/tests/`, run via `php bin/phpunit`):
  `Money/DecimalTest` cross-checks `App\Money\Decimal` against the shared
  `tests/fixtures/decimal-cases.json` fixture (also run from the JS side
  by `decimal.test.js` — see "Amounts, currencies, and reference data"
  above); `Money/StockPrecisionTest` does the same for
  `App\Money\StockPrecision::places()` against that fixture's
  `"stockPlaces"` cases (mirrored by `stockMath.test.js`); `Money/
  LegacyIntegerAmountsTest` covers `LegacyIntegerAmounts::upgrade()`'s
  scaled-integer→decimal-string conversion used by
  `app:import-local-storage` on an older export; `Money/ScaledAmountTest`
  covers the older `toDecimal()` conversion helper directly;
  `Doctrine/DecimalTextTypeTest` covers the `decimal_text` Doctrine type
  — `TEXT`/`CLOB` affinity, refusing to write a non-canonical string, and
  round-tripping a value back out unchanged (see "Amounts, currencies,
  and reference data" above for why this matters on SQLite);
  `Service/LedgerStateServiceAmountsTest` covers exact-decimal balance
  summation beyond a currency's own scale, the stock walk dividing
  exactly and rounding only its output (including a repeating-quotient
  case), adaptive stock precision end-to-end, and that a bad write (an
  unknown account, a non-decimal JSON amount) throws and leaves nothing
  written; `Service/IsaAllowanceServiceTest` covers `IsaAllowanceService`
  specifically — the flexible-ISA lot-tracking simulation is the one
  piece of business logic in this app subtle enough to have produced a
  real bug before (see "ISA allowance engine"), so it gets a safety net
  where everything else relies on manual browser verification. Add a
  case to the relevant file before changing the logic it covers; don't
  feel obliged to add tests elsewhere in the backend to match.

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
  under "Backend" above). `amount` is a **canonical decimal string**, on
  the wire and in storage alike (see "Amounts, currencies, and reference
  data" below), signed: positive = increase, negative =
  decrease, regardless of account type. There is no separate debit/credit;
  the UI just labels positive/negative as "In"/"Out".
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
  `expense`, `investment`, `investment-parent`. An `investment-parent`
  holds no balance itself — it's a wrapper grouping subaccounts via a
  real, enforced foreign key, `parentId` (`Account.parent` backend-side,
  `ON DELETE NO ACTION`). It groups either a Stocks & Shares ISA (when
  its `isaKind` is `"stocks-shares-isa"` — the same field flat ISA
  accounts use, reused here rather than a separate flag) or a plain
  organizational holding with no ISA meaning at all. A `type:
  "investment"` account must always have a parent — enforced at the
  frontend, in `LedgerStateService::hydrateAccount()`, and by a database
  `CHECK` constraint (`type != 'investment' OR parent_id IS NOT NULL`).
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
- **Investment accounts hold exactly one security**, referenced via two
  columns, `account.symbolTicker`/`account.symbolCurrency` (a composite FK
  into `Symbol`'s own composite `(ticker, tradingCurrency)` key — see
  "Amounts, currencies, and reference data" below). Trading currency lives
  on this pair, not on the account's own `currency` field, which is
  unused/absent for an investment account: `symbolCurrency` **is** the
  trading currency, readable directly off the account object — no
  separate `Symbol` lookup needed, and never `account.currency`, for an
  investment account. `amount` on an investment line is *units* (scaled by
  the symbol's own `scale`, a different scale from any currency's), not
  cash.
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

Amounts used to be plain floats, then scaled integers, then (phase 1 of
`docs/superpowers/specs/2026-09-27-arbitrary-precision-decimals-design.md`)
canonical decimal strings on the wire only, with storage still scaled
integers underneath. **Phase 2 finished the move: storage itself is now
canonical decimal strings, end to end, with no precision limit on either
side of the decimal point.** A canonical string has no `+` sign, no
leading zeros, no trailing fractional zeros, and spells zero as `"0"`
(e.g. `"20.50"` → `"20.5"`, `".5"` → `"0.5"`) — see the spec's "Canonical
form" for the exact grammar. This touches every amount-like field:
`Line.amount`, `Line.cashValue`, `Line.exchangeAmount`,
`Account.openingBalance`, `Account.openingBalanceCashValue`, and the
computed `balance`/`costBasis`/`portfolioValue`/`imbalanceIn`/
`imbalanceOut` fields. Every one of those columns is `TEXT`, via the
Doctrine type `decimal_text` (`backend/src/Doctrine/DecimalTextType.php`,
registered in `config/packages/doctrine.yaml`) — **never Doctrine's own
`decimal` type**, which on SQLite becomes `NUMERIC(p,s)`: SQLite's
`NUMERIC` affinity silently converts a stored string like `"20.50"` into
a float, exactly the drift this whole effort exists to eliminate.
`decimal_text` declares its column via `getClobTypeDeclarationSQL`
(`CLOB`, which — like `TEXT` — carries `TEXT` affinity in SQLite, so
nothing gets converted), and its `convertToDatabaseValue()` refuses to
write anything that isn't already a canonical string (`App\Money\Decimal::
isCanonical()`), so a stray float or a non-canonical string like
`"20.50"` can never reach the database. `App\Money\Decimal`
(`backend/src/Money/Decimal.php`) is the backend's arithmetic core —
static methods over `BcMath\Number`, mirroring `src/lib/decimal.js`
function for function; every service (`LedgerStateService`,
`IsaAllowanceService`, `MatchingService`, `TagService`, `NewYearService`)
and every controller works in canonical decimal strings throughout, with
no integer⟷decimal conversion layer left anywhere. So JSON looks like
`"amount": "20.5"`, not `"amount": 2000` — a decimal string in both
directions across the API, never a raw integer and never a float.
`readState()`/`writeState()` (export/import) and `NewYearService` all
speak decimal strings too, not scaled integers.

- **`Currency`, `Symbol`, `Counterparty` are natural-key reference
  entities** (`backend/src/Entity/`), each with the business key itself
  as primary key — `Currency.code` (`"GBP"`), `Symbol` the composite pair
  `(ticker, tradingCurrency)` (`"AAPL"` + `"USD"`), `Counterparty.name`
  (`"Barclays"`) — no surrogate id, deliberately, so raw DB records stay
  human-readable. `Account.currency` / `Account.symbolTicker`+`symbolCurrency`
  (composite FK) / `Account.counterparty` and `Line.cashCurrency` /
  `Line.exchangeCurrency` are FKs to these, not free strings anymore.
  `Counterparty` covers both meanings `Account.counterparty` can have —
  "where this account is held" for a real account, "who was paid/who
  paid" for an income/expense/isa-income one; `AccountFormModal` labels
  the field "Institution" or "Counterparty" depending on `account.type`,
  but it's one column, one entity, either way.
  `Currency` also carries an optional `name` (e.g. "British Pound
  Sterling"). `Symbol`'s primary key is the pair `(ticker,
  tradingCurrency)`, not `ticker` alone — the same ticker can exist more
  than once, one row per trading currency it's actually traded in (e.g.
  "AAPL" in USD and a separately-tracked "AAPL" GBP line are two distinct
  Symbol rows) — mirroring `Tag`'s own composite `(dimension, value)`
  key. `Symbol` additionally carries `name` and `scale` (unit precision —
  *not* a currency scale); `tradingCurrency` is part of its identity, not
  an ordinary field, so it's never edited after creation. `Account.symbol`
  is therefore two columns, `symbolTicker`/`symbolCurrency`, forming a
  composite FK into `Symbol` (wire format: `"symbolTicker": "AAPL",
  "symbolCurrency": "USD"`, never a nested object) — backed by a `CHECK
  ((symbol_ticker IS NULL) = (symbol_currency IS NULL))` so the two always
  travel together. `Account.subtype`, by contrast, is a **plain string
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
- **API wire format for these FKs** — `Currency` and `Counterparty` use a
  natural-key string (`"currency": "GBP"`, `"counterparty": "Barclays"`),
  consistent with how `Account`/`Transaction` ids already work — never a
  nested object. `Symbol` uses two separate fields since it's a composite
  key: `"symbolTicker"` and `"symbolCurrency"` (as documented above).
- **`LedgerStateService::resolveCurrency()`/`resolveSymbol()`/
  `resolveCounterparty()`** are where a JSON payload's currency
  code/ticker/counterparty name gets turned into the actual entity on
  write. `resolveCurrency`/`resolveSymbol`
  **hard-error** (`InvalidArgumentException`) on an unknown code, or an
  unknown `(ticker, tradingCurrency)` pair — Currency and Symbol are
  deliberately curated, closed sets; a new one needs a real `scale`
  decided, which is exactly what the `Currency`/`Symbol` admin CRUD
  (`ReferenceDataView.jsx`, `CurrencyController`/`SymbolController` — see
  "Backend" above) exists to do. `resolveCounterparty` **find-or-creates**
  instead — institution/
  counterparty names were always free text before this schema existed
  (any bank, or any payee, not used yet is fine to type in
  `AccountFormModal`), and there's no meaningful extra data a first use
  needs to supply, so it stays that way rather than regressing into a
  closed picker.
- **`Currency`/`Symbol` now have full admin CRUD** (`CurrencyController`,
  `SymbolController`, `src/components/ReferenceDataView.jsx`) — `POST`
  create, `PATCH` edit `name`/`scale`, `DELETE`. `code`/`(ticker,
  tradingCurrency)` are immutable once created — a different one is a new
  row, not a rename. `scale` is display-only now (see "Amounts,
  currencies, and reference data" above) — editing it is a plain field
  update with no data rewrite and no precision-loss check.
  `ReferenceDataView.jsx`/`AccountFormModal.jsx` label the field
  "Min. decimals"/"Minimum decimals shown" rather than just "Scale",
  since that's now literally what it controls — a floor on the digits
  shown, not a stored precision; amount inputs across the app use
  `step="any"` rather than a scale-derived step, since typed precision is
  no longer constrained by it either. See
  docs/superpowers/specs/2026-09-26-currency-symbol-admin-design.md for
  the original (phase-1) design this superseded. `ReferenceDataView.jsx`
  no longer warns about rescaling before a scale edit — there's nothing
  left to warn about. Deleting a still-referenced currency/symbol already
  fails at the
  database level (every FK into `currency`/`symbol` is `NOT DEFERRABLE
  INITIALLY IMMEDIATE`, and `foreign_keys` enforcement is on everywhere)
  — both controllers just translate that into a clean `409`, the same
  pattern `AccountController::delete()` already uses for a wrapper
  account with subaccounts. `Counterparty` stays free-text/find-or-create
  and out of this admin surface entirely.
- **`GET /api/currencies`/`/api/symbols`/`/api/counterparties`** — `App.jsx`
  fetches all three once alongside the account list and passes them down as
  props (`currencies`, `symbols`, `counterparties`) to whatever needs them
  (`AccountFormModal`'s pickers, `AccountLedger`/`StockLedger`/
  `otherLines.jsx`'s scale lookups, `lib/grouping.js`'s currency-dimension
  bucketing). There's no context/global store — this app prop-drills
  already, see `accounts` itself. `Counterparty` and (prior to `POST
  /api/symbols`) `Currency`/`Symbol` were read-only; `Currency`/`Symbol`
  now have full admin endpoints (see above), while `Counterparty` remains
  read-only and find-or-create only.
- **`src/lib/decimal.js`** (replaces the old `src/lib/scale.js`) is the
  frontend's decimal arithmetic core, built on big.js, with its own
  Vitest suite (`decimal.test.js`, plus `format.test.js` for display
  formatting — `yarn test`) run against
  `tests/fixtures/decimal-cases.json`. Four rules govern it everywhere in
  this codebase:
  1. Amounts are canonical decimal strings everywhere outside
     `src/lib/decimal.js`, all the way down to storage now — the
     backend's counterpart is `App\Money\Decimal`
     (`backend/src/Money/Decimal.php`), static methods over
     `BcMath\Number` mirroring this module function for function, used
     throughout every service and controller with no integer conversion
     layer left anywhere (see "Amounts, currencies, and reference data"
     above).
  2. Nothing divides amounts except `divide()` (20dp, round half-up,
     returns `"0"` for a zero divisor) — `Decimal::divide()` on the PHP
     side has the identical contract.
  3. A float appears only at a handful of named renderer boundaries,
     never in arithmetic: `toNumber()`/`fromNumber()` for Recharts'
     series data and its tick/tooltip formatters (`charts.jsx`), the ISA
     allowance bar's CSS `width` percentage (`AllowanceView.jsx`), and
     the FX-rate display's `Intl` significant-digit formatting
     (`lib/matching.js`'s rate string). Each of these is display-only —
     none of their outputs ever get parsed back into an amount.
  4. **The PHP and JS implementations must agree, and this is now
     enforced.** `tests/fixtures/decimal-cases.json` is the shared
     fixture: `decimal.test.js` (JS) and `backend/tests/Money/
     DecimalTest.php` (PHP) both run it, via `yarn test` and `php
     bin/phpunit` respectively — a case added to the fixture is checked
     on both sides automatically, not just by hand.
  `parseDecimal(str)`/`parseOrZero(str)` replace `toMinorUnits` for
  turning typed input into a canonical string (returning `null`/`"0"`
  respectively for invalid input, rather than `NaN`); `canonical`,
  `add`/`sub`/`mul`/`neg`/`abs`, `cmp`/`sign`/`isZero`/`isNegative`/
  `isPositive`/`isNonZero`, `min`/`sum`, `divide`, `round`,
  `fractionDigits`, and `toNumber`/`fromNumber` (the float boundary, rule
  3 above) round out the module. An input field's onChange handler
  (`AccountLedger.jsx`/`StockLedger.jsx`/`otherLines.jsx`/
  `AccountFormModal.jsx`) just stores the raw typed text in state (e.g.
  `amountStr`) — parsing happens later, via `parseDecimal`/`parseOrZero`,
  wherever that value is actually read (a delta computation, a save, a
  precision check), not in the handler itself. **Never hold a big.js
  object outside `decimal.js`** — every exported function takes and
  returns plain canonical strings, so React state, props, `===`, and
  JSON stay plain; don't leak a `Big` instance into a component or into
  state.
- **`divRoundHalfUp` is gone from both sides.** The old integer-`BigInt`
  JS copy in `scale.js` was replaced by `decimal.js`'s `divide()` +
  `round()` in phase 1; the PHP copy, formerly a private method on
  `LedgerStateService` doing integer cross-multiply-then-divide, is gone
  too now that internal cost-basis/portfolio-value math runs on
  `App\Money\Decimal` throughout (see "Stock valuation" below) — both
  sides now divide the same way, at 20 decimal places via
  `Decimal::divide()`/`divide()`.
- **`src/lib/format.js`'s `fmt(amount, currencyCode)`/`fmtUnits(n,
  symbolKeyString)`** keep their 2-argument call-site shape everywhere in
  the app — they don't take a `scale` parameter directly, and both now
  take a canonical decimal *string* for the amount, not a scaled integer.
  `fmt` takes a currency code; `fmtUnits` takes `symbolKeyString`, the
  composite key from `lib/symbolKey.js`'s `symbolKey(ticker,
  tradingCurrency)` (not a bare ticker, since the same ticker can exist
  under multiple trading currencies).
  `setCurrencyScales(currencies)`/`setSymbolScales(symbols)` are called once
  by `App.jsx` right after fetching `/api/currencies`/`/api/symbols`,
  populating a small module-level lookup `fmt`/`fmtUnits` read from
  internally. This was a deliberate choice over threading a `scale` argument
  through every single display call site (`AccountRow`, `Overview`,
  `charts.jsx`, ...) — a lookup by code/ticker+currency is simpler than a
  prop-drilled parameter for something that's genuinely global, read-only,
  loaded-once data. If a value's scale genuinely isn't in the registry yet
  (e.g. mid-load), `fmt`/`fmtUnits` fall back to a plausible default (2 / 6)
  places rather than crashing. **`scale` no longer constrains what can be
  typed or stored** — it's purely how many decimals `fmt`/`fmtUnits`
  display, and it's a *minimum*, not a fixed count: `fmt`/`fmtPlain`/
  `fmtUnits` never round, and always show every digit actually stored,
  padding with trailing zeros only up to `scale` when the stored value has
  fewer — a caller displaying a *computed* value (anything from `divide()`,
  or a Recharts float) rounds it first, there's nothing left in `format.js`
  itself that would round for them. `fmtParts(amount, code, kind)` (`kind`:
  `"plain"` / `"currency"` / `"units"`, matching `fmtPlain`/`fmt`/`fmtUnits`)
  splits the formatted string into `{int, frac}` at the decimal point;
  `maxPlaces(minPlaces, values)` is the most fractional digits among a set
  of stored values, never fewer than `minPlaces`; `fracWidth(entries)`
  (each entry `{value, code, kind}`) is the widest fraction a column of
  those entries will ever show. `src/components/ui.jsx`'s `<Amount value
  code kind fracWidth />` uses `fmtParts` to render the integer part plus a
  fraction span that is itself left-aligned (`text-align: left`) with a
  `min-width` of `fracWidth + 1` characters (the `+1` is the decimal
  point) — sitting inside a right-aligned table cell, so a column of
  amounts lines up on the decimal point regardless of how many fractional
  digits any one row shows; relies on the `ll-mono` font, where `1ch` is
  exactly one digit's width. `<Amount>` is used for the actual ledger
  numbers: the `AccountLedger`/`StockLedger` table columns (including the
  opening-balance row and the editing row's running-total cell), the cash
  balances `SidebarGroupTree`/`OverviewGroupTree`/`AccountRow` show per
  group, and `IsaParentView`'s cash list — not for badges, headers,
  charts, or the compound investment text (e.g. `App.jsx`'s
  `accountDisplay()`, rendered as "1.5 AAPL · £150.00" — units, ticker, then
  portfolio value), which stay plain `fmt`/`fmtUnits` calls. Now that
  storage is arbitrary-precision,
  there is no precision limit tied to an account's currency/symbol scale:
  `format.js`'s old `precisionError(lines, accounts)` guard, and the
  matching client-side checks in `AccountFormModal.jsx`'s save handler
  and `useMatchCandidates.js`/`otherLines.jsx`'s per-leg search, are gone
  — a typed value simply saves at whatever precision it was entered with.
  The one remaining validation is shape, not precision: the backend
  (`amountOrNull()` on `LedgerStateService`, and `MatchController`'s
  query-param handling) rejects a non-string/non-decimal JSON `amount`
  with a `400` via `Decimal::parse()`, the same posture `resolveCurrency()`/
  `resolveSymbol()` already take for other malformed input.

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
  search. `OtherLinesEditor` is the shared row-rendering component (also
  takes `symbols`, to resolve an investment leg's trading currency via
  its `Symbol` — never `account.currency`, see "Amounts, currencies, and
  reference data" above). Do not reintroduce a per-component copy of this
  logic; extend the shared hook/component instead.
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
  called from `hydrateLine()`, so every write path (`createLine`,
  `updateLine`, `writeState()`) carries tags the same way as every
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
    server-side total grouped by `(value, currency)`, summed exactly with
    `Decimal::add()` (`TagService::computeTagTotals()`) rather than a SQL
    `SUM(amount)`, for the same float-coercion reason as
    `lineSumsByAccount()` above — each row's summed field is named
    `amount`, a decimal string like every other amount on the wire — same
    "never sum bulk line data client-side" posture as
    `accountsWithStats()`'s own balance total. A line carrying more than
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
Accounts project has always worked (one SQLite file per tax year).
Unlike an earlier version of this app, switching which file is active,
creating a brand-new database, and rolling forward into a new tax
year's file are now all done from inside the running app — see
`DatabaseController` under "Backend" below — rather than by hand-editing
`.env.local` and running `app:new-year` from a terminal.

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
  (added by `getSettings()` on top of the per-database `over65`
  value plus the global `groupLevels`/`savedGroupings` — `readState()`/
  `writeState()` (full per-database export/import) only ever carry
  `over65`, since the other two aren't per-database data at all; a
  database-level backup was never a meaningful place for a global UI
  preference to live):
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
  raw `cashValue`/`units` pair and divides only once per computation, at
  20 decimal places via `Decimal::divide()`/`divide()` with no per-step
  rounding — avoids compounding rounding error across many trades. Units
  hits exactly `0` when fully sold, since the arithmetic is exact on both
  sides now; `cost` is still zeroed defensively when units reaches zero,
  to absorb any residual rounding dust from the one division, not float
  fuzz (there never was float fuzz here even in the scaled-integer days,
  but the defensive zeroing is cheap insurance).
- Cost basis / portfolio value math **touches two different kinds of
  amount** — `cost`/`cashValue` are currency amounts, `units`/`amount` are
  symbol (unit) amounts — but nothing about either one's scale gates or
  shapes the arithmetic itself: the running state is kept as exact,
  unrounded decimal strings throughout the walk on both sides
  (`App\Money\Decimal` in PHP, `src/lib/decimal.js` in JS — no more
  integer cross-multiply-then-divide, no more `cashPlaces` threaded
  through `stockMath.js`'s division calls). Rounding happens exactly
  once, on the way out, and at an **adaptive** number of places rather
  than a fixed `scale` — `stockPlaces(cashScale, opening, lines)`
  (`src/lib/stockMath.js`) and its PHP mirror `App\Money\StockPrecision::
  places()` (`backend/src/Money/StockPrecision.php`) both derive
  `{moneyPlaces, unitPlaces, pricePlaces}` from the account's own data:
  `moneyPlaces` is the most decimals any `cashValue` (or
  `openingBalanceCashValue`) on the account has ever used, never fewer
  than the trading currency's own `scale`; `unitPlaces` is the most
  decimals any unit `amount` (or `openingBalance`) has used; `pricePlaces`
  is `moneyPlaces + unitPlaces`, so a displayed price × units reproduces
  a cash value to its own precision. The two implementations are pinned
  together by the `"stockPlaces"` cases in the shared
  `tests/fixtures/decimal-cases.json` fixture, run by
  `src/lib/stockMath.test.js` (JS) and
  `backend/tests/Money/StockPrecisionTest.php` (PHP) — the same
  cross-checked-fixture pattern `Decimal`/`decimal.js` already use (see
  above). The backend rounds `costBasis`/`portfolioValue` to
  `moneyPlaces` before putting them on the `GET /api/accounts` response
  (`stockStatsFor()`); `StockLedger.jsx`'s header rounds the same way —
  cost basis and portfolio value to `moneyPlaces`, average price to
  `pricePlaces` — and each row's Cost/Worth sub-line rounds its running
  cost/value to `moneyPlaces` too, so the header, the running column, and
  the backend's own totals never disagree on precision.
  `src/components/charts.jsx` rounds chart labels the same way: a stock
  chart's money series to `moneyPlaces` and its units series to
  `max(unitPlaces, symbol scale)`; a cash-balance chart (no `stockPlaces`
  involved) rounds to `maxPlaces(currency scale, the account's own
  amounts)` — in every case a Recharts tooltip/axis value is rounded
  before formatting, since Recharts always hands back a float and
  `fmt`/`fmtUnits` never round on their own (see "Amounts, currencies,
  and reference data" above) — this is what keeps a chart label from
  ever showing float noise like `66.66666666666667`.
- Both live in **two places now**: `src/lib/stockMath.js` still has
  `applyCostBasisLine`/`applyPortfolioValueLine`/`buildCostBasisSeries`/
  `buildPortfolioValueSeries`, used client-side for a stock ledger's own
  running-total column *and its own header* (both operate on the one
  account's already-fetched lines — cheap, no reason to move; see
  `StockLedger.jsx`'s `costBasis`/`portfolioValue`/`avgCost`, rounded to
  `stockPlaces()`'s `moneyPlaces`/`pricePlaces`). The totals shown in the
  sidebar/Overview/an ISA wrapper's totals come from the backend's port
  instead (`LedgerStateService::stockStatsFor()`), computed over that
  account's lines in the exact same order (`orderedLinesFor()`: date,
  then `order`, then transaction id) — same-day ordering can change the
  result, so the tiebreak has to match exactly or the two totals will
  silently disagree. The shared `stockPlaces()`/`StockPrecision::places()`
  fixture and the identical unrounded 20-dp walk on both sides (see above)
  are what keep the client-computed ledger header and the backend-computed
  sidebar figure in agreement despite being computed in two different
  places.
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
- No general admin UI/write endpoints for counterparties — `Currency` and
  `Symbol` now have full admin CRUD (`ReferenceDataView.jsx`,
  `CurrencyController`/`SymbolController` — see "Backend" above), but
  `Counterparty` stays read-only/find-or-create-only by design (see
  `resolveCounterparty()` under "Amounts, currencies, and reference data"
  below) — don't build a write surface for it without discussing scope
  first.
