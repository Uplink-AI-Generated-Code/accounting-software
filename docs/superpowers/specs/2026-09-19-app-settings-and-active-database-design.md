# App settings file and connection-middleware active database — Design

## Context

The in-app database switcher (see `2026-09-18-in-app-database-switcher-design.md`) introduced `databases/active.sqlite3`, a symlink repointed at whichever tax-year file is currently active. Getting that symlink to actually work reliably took real effort: a relative-vs-absolute resolution bug, a php-fpm worker-pool staleness bug requiring a `SIGUSR2` pool reload after every switch, and a `SYMFONY_DOTENV_VARS` leak that could corrupt the wrong database during creation. All of that complexity exists because the mechanism resolves "which file is active" through several layers that can each go stale independently — Symfony's compiled container, Dotenv's bookkeeping, PHP's realpath cache, an OS-level symlink.

Separately, the per-database `Settings` entity (`over65`, `groupLevels`, `savedGroupings`) conflates two different lifetimes: `over65` is a fact that should carry forward with each new tax year (which it already does, via `NewYearService`'s wholesale-copy), but `groupLevels`/`savedGroupings` are just "how I like the chart of accounts arranged" — they've only ever varied per tax-year file because there was nowhere else to put them, not because that variation is wanted.

This design replaces the symlink with a Doctrine connection middleware that reads a small YAML file directly at connect time, and splits per-database settings from genuinely global ones. The YAML file also holds which database is active, replacing the symlink outright — not fixing it, eliminating the whole class of problem it was in.

## Global Constraints

- Single-user, no-auth personal app (see CLAUDE.md's "Backend") — no multi-tenancy, no per-request tenant resolution.
- `test` environment must remain fully unaffected — no dependency on `app-settings.yaml` in test runs.
- `backend/.env.dev`'s `APP_SECRET` block must be preserved when its `DATABASE_URL` block is removed — this file has been wholesale-overwritten by mistake twice already in this project's history.
- No new `.gitignore` entry is needed — `backend/databases/` is already ignored as a whole directory.

## Architecture overview

Two data stores replace the current single `settings` table:

1. **`backend/databases/app-settings.yaml`** — global, gitignored (inherited from `databases/`'s existing blanket ignore), hand-editable. Holds `activeDatabase` (replacing the symlink entirely) and the two settings moved out of the per-database table: `groupLevels`, `savedGroupings`.
2. **Each ledger database's `setting` table** (renamed/reshaped from `settings`) — one row per key, holding `over65` today and anything else genuinely tax-year-scoped later, without a migration per new key.

A new Doctrine connection middleware reads `app-settings.yaml`'s `activeDatabase` at the moment each real PDO connection is opened, and builds the SQLite DSN directly from it (`sqlite:///databases/<name>`) — no symlink, no `DATABASE_URL` pointing at a fixed file, no OS-level indirection. This eliminates `SIGUSR2`/pool-reload entirely, and the relative-vs-absolute symlink question along with it, because there is no symlink for either concern to apply to.

## The global settings file

`backend/databases/app-settings.yaml`:

```yaml
activeDatabase: 2024-2025.sqlite3
groupLevels: []
savedGroupings:
  - id: <uid>
    levels: [type, currency, subtype, counterparty]
```

Defaults for a fresh/missing file: `activeDatabase: null`, `groupLevels: []`, `savedGroupings` seeded with one entry — `[type, currency, subtype, counterparty]` (the "Institution" label is the same `counterparty` dimension under its type-dependent display name — see CLAUDE.md's "UI conventions").

A plain PHP `AppSettingsRepository` (no Doctrine involvement — this file isn't ORM-managed) owns all reads/writes to it:

- `read(): array` — parses the YAML; returns the defaults above if the file doesn't exist yet.
- `write(array $partial): void` — opens the file with an exclusive `flock()`, re-reads the current content *under the lock*, merges `$partial` into it, writes the result to a temp file in the same directory, `rename()`s over the real file (atomic on the same filesystem, same pattern the symlink switch used), then releases the lock.

The lock is what closes the read-modify-write race a naive "read, merge, write" would have under two near-simultaneous requests (e.g. two browser tabs) — without it, the second writer's merge could be based on stale content and silently clobber the first writer's change.

Both the settings API (for `groupLevels`/`savedGroupings`) and `DatabaseController` (for `activeDatabase`) go through this one repository — it's the single place that knows this file's shape and locking discipline.

## Per-database settings

The `Settings` entity is renamed to `Setting` and reshaped into a key-value table (matching this project's existing convention of natural-key reference entities — `Currency`, `Symbol`, `Counterparty` — using the business key itself as the primary key, no surrogate id):

```php
#[ORM\Entity]
class Setting
{
    #[ORM\Id, ORM\Column(length: 64)]
    private string $key;

    #[ORM\Column(type: 'text')]
    private string $value; // always valid JSON — json_decode($value, true) recovers the real PHP type
}
```

No separate type column: JSON's own syntax already disambiguates `5` from `"5"` from `true` from `null` from an array, so `json_decode`/`json_encode` alone are enough to round-trip any of the scalar/array shapes a setting needs.

A `SettingsService` owns type-safe access: `get(string $key): mixed` (decodes the row's JSON, or `null` if the key doesn't exist) and `set(string $key, mixed $value): void` (upserts, JSON-encoding `$value`). A `SettingKeys` class holds known key names as constants (`OVER_65 = 'over65'` for now) so nothing scatters magic strings across controllers/services.

## Connection resolution

- `config/packages/doctrine.yaml` drops the top-level `dbal: url: '%env(resolve:DATABASE_URL)%'` — there is no static DSN for dev/prod anymore.
- A new Doctrine driver middleware (`Doctrine\DBAL\Driver\Middleware`, wrapping the SQLite driver) intercepts `connect()`, reads `app-settings.yaml`'s `activeDatabase` via `AppSettingsRepository`, and connects to `databases/<activeDatabase>` directly.
- This middleware is registered for dev/prod only, never `test`.
- `when@test` keeps its own `url: '%env(resolve:DATABASE_URL)%'` plus the existing `dbname_suffix: '_test%env(default::TEST_TOKEN)%'`, entirely unchanged — test continues to use the base `.env`'s templated `var/data_test.db`, with zero dependency on `app-settings.yaml`.
- `backend/.env.dev` has its `DATABASE_URL` block (and its explanatory comment) removed, but its `APP_SECRET` block is left untouched.
- `MigrationStatusListener`'s "no active database" check changes from `is_link()`/`realpath()` on a symlink to: does `app-settings.yaml` exist and have a non-null `activeDatabase`, and does that named file exist under `databases/`?
- `DatabaseController::activateSymlink()` and `reloadPhpFpmWorkers()` are deleted outright — there is nothing left for either to do.

## API and DatabaseController

- `GET /api/settings` merges three sources into the one flat object the frontend already expects: `SettingsService`'s per-database keys (`over65`), `AppSettingsRepository`'s global keys (`groupLevels`, `savedGroupings`), and the existing computed fields (`activeTaxYearStart`, `outOfTaxYearLineCount`, both still derived from the active ledger database exactly as today).
- `PUT /api/settings` becomes `PATCH /api/settings`, accepting a **partial** object — only the field(s) actually being changed. Each key present routes to whichever backend owns it: `over65` → `SettingsService::set()`; `groupLevels`/`savedGroupings` → `AppSettingsRepository::write()`.
- `DatabaseController::setActive()`/`create()`/`newYear()` write `activeDatabase` via `AppSettingsRepository::write(['activeDatabase' => $filename])` instead of repointing a symlink.
- `entryFor()`'s active-flag logic reads `AppSettingsRepository::read()['activeDatabase']` instead of resolving a symlink target.

### Frontend

`src/api.js`'s `putSettings(settings)` becomes `patchSettings(partial)` (method `PATCH`). Every call site in `src/App.jsx` that currently spreads the whole `settings` object (`saveSettings({ ...settings, groupLevels: lv })`, the saved-grouping add/remove handlers, `AllowanceView`'s `over65` toggle) sends only the field(s) it's actually changing — the spread pattern goes away, since the backend no longer expects or needs a full snapshot.

## Migration and rollout

**Per-database migration** (one new Doctrine migration, applies uniformly wherever it's run — dev, test, or any tax-year file): creates the `setting` table, copies the old `settings` row's `over65` value across as its JSON literal (reading the actual column, not hardcoding `false`, so it's correct even where it's `true`), then drops the old `settings` table — `group_levels`/`saved_groupings` are discarded with it, a deliberate reset rather than an attempted merge, since their per-file variance was never meaningful (confirmed: every real tax-year file today has `over65 = false`, and `groupLevels`/`savedGroupings` differ per file only because there was nowhere else to set them globally). This migration's `down()` is necessarily one-way in practice: it can recreate the old `settings` table's shape and restore `over65`, but `group_levels`/`saved_groupings` have no source to restore from once discarded — `down()` should recreate them with the entity's original defaults (`["type"]` / `[]`), not silently fabricate data.

This app already has a standing pattern for a migration spanning multiple `.sqlite3` files: each file only picks up a new migration when something actually points a connection at it and hits the app, and `MigrationStatusListener` blocks with a clear message until that happens. This design keeps that precedent rather than adding a new "migrate every file in `databases/` at once" command — inactive tax-year files pick up the `setting` table whenever next switched into, same as any other migration in this project's history.

**The real cutover**, once this is built, against the actual checkout (not a worktree): create `databases/app-settings.yaml` seeded with `activeDatabase: 2024-2025.sqlite3` (today's actual active file) and the settings defaults; delete `databases/active.sqlite3` (the symlink); run the new migration against `2024-2025.sqlite3` so the app boots immediately; strip the `DATABASE_URL` block out of `.env.dev`, keeping `APP_SECRET`.

**`LedgerStateService::readState()`/`writeState()`** (full per-database export/import — `app:export-state`/`app:import-local-storage`) currently include `settings: {over65, groupLevels, savedGroupings}`. Since `groupLevels`/`savedGroupings` are no longer per-database data at all, the exported/imported `settings` shrinks to `{over65}` only — a database-level backup was never a meaningful place for a global UI preference to live.

## What this removes entirely

- `databases/active.sqlite3` (the symlink) and everything that manipulated it (`activateSymlink()`).
- `DatabaseController::reloadPhpFpmWorkers()` and the `SIGUSR2` pool-reload mechanism.
- `idle_connection_ttl` tuning in `config/packages/doctrine.yaml` (it existed only to paper over the symlink-era staleness).
- The `realpath()`-based active-database resolution in both `DatabaseController::activeTarget()` and `MigrationStatusListener::hasActiveDatabase()`.

## Testing

- Backend: `test` environment is untouched by construction (own fixed DSN, middleware not registered for it) — existing tests need no changes for connection resolution. `SettingsRepository`/`Settings`-entity references are limited to production code (`SettingsRepository.php`, `Settings.php`, `SettingsController.php`, `LedgerStateService.php`) — no test file references the entity directly, so the rename is contained.
- Manual browser verification (this project's standing convention, per CLAUDE.md): switching databases via the UI still works with no restart and no stale reads; the empty-state/no-active-database picker still triggers correctly when `app-settings.yaml` is missing or names a file that doesn't exist; `groupLevels`/`savedGroupings` persist across a database switch (proving they're genuinely global now); `over65` does not persist across a switch to a *different* tax year, but does carry forward through `app:new-year`/the in-app "start a new tax year" action.
