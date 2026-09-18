# In-app database switcher — design

Status: approved, pending implementation plan
Date: 2026-09-18

## Context

Per CLAUDE.md's "The active tax year", ledger-project belongs to exactly
one UK tax year's database for its whole lifetime, with a per-tax-year
SQLite file convention under `backend/databases/` (one file per year,
`YYYY-YYYY.sqlite3`). Until now, switching which file is active meant
hand-editing `backend/.env.local` (commenting the current `DATABASE_URL`
line, uncommenting another) and reloading — a convention CLAUDE.md
explicitly chose *over* an in-app switcher, on the reasoning that the app
shouldn't manage its own multiple files.

This session's work repeatedly ran into friction from that boundary: a
database missing a migration after being copied by `app:new-year`, a
currency picker that looked broken because of it, and general tedium/
error-risk in the manual `.env.local` edit itself. The user asked to
revisit the boundary. This spec covers exactly that: a small in-app
switcher, nothing else. `app:new-year` (creating a *new* tax year's file)
is out of scope — this is purely about switching among files that
already exist.

## Mechanism

`backend/databases/active.sqlite3` becomes a symlink to whichever real
per-year file is currently active. `DATABASE_URL` is set once, in a new
committed `backend/.env.dev` file (a dev-environment-only override,
already a documented Symfony convention referenced in `.env`'s own header
comment), to the fixed path:

```
DATABASE_URL="sqlite:///%kernel.project_dir%/databases/active.sqlite3"
```

`.env.dev` only overrides the `dev` environment — the base `.env`'s
`DATABASE_URL` (templated with `%kernel.environment%`, giving `test` its
own separate `var/data_test.db`) is untouched, so `php bin/phpunit`'s
isolated test database is unaffected. `backend/.env.local`'s entire
`DATABASE_URL` block (the commented list of per-year files, and its
explanatory comment) is removed — there's nothing machine-specific left
to store there once the path is always the fixed symlink.

Switching databases = atomically repointing the symlink: create a new
symlink under a temporary name in the same directory, then `rename()` it
over `active.sqlite3`. `rename()` is atomic on the same filesystem, so a
request arriving mid-switch never sees a missing or broken symlink.
Since Symfony resolves `DATABASE_URL` fresh per request (confirmed
empirically this session, repeatedly, via the copy-test-restore
workflow), the very next API call after a switch already hits the new
file — no server restart needed.

**One-time real migration**, done as an explicit, watched step during
implementation (not silently folded into "testing"):
1. Confirm which file `backend/.env.local`'s `DATABASE_URL` currently
   points at (as of this spec, `2024-2025.sqlite3` — but re-check at
   implementation time, since the user switches files without always
   mentioning it).
2. Create `backend/databases/active.sqlite3` as a symlink to that file.
3. Add `backend/.env.dev` with the fixed `DATABASE_URL` above.
4. Remove the `DATABASE_URL` block from `backend/.env.local`.
5. Verify the live app still serves the same data through the symlink
   before considering the migration done.

## Backend

New `DatabaseController` (`backend/src/Controller/DatabaseController.php`)
— pure filesystem operations, no `EntityManager`:

- `GET /api/databases` — lists every `*.sqlite3` file directly under
  `backend/databases/` **except** `active.sqlite3` itself (which is the
  pointer, not a real target). Each entry:
  `{filename, label, isTaxYear, active}`.
  - `label`: derived *only* from the filename pattern
    `^(\d{4})-(\d{4})\.sqlite3$` → `"2025/26"`; `null` for anything else
    (e.g. `development.sqlite3`). This is a filename-driven display
    convenience for the picker — it is **not** the same thing as the
    app's existing *computed*, data-derived active tax year
    (`LedgerStateService::determinedTaxYearStart()`/
    `GET /api/settings`'s `activeTaxYearStart`), which stays entirely
    unchanged and keeps being computed from actual line dates, never
    from a filename. The two can disagree (e.g. a misnamed or
    hand-edited file) without that being treated as an error anywhere.
  - `isTaxYear`: true only when the filename matches that pattern —
    drives the frontend's default-filtered list.
  - `active`: true for whichever file `readlink()`ing
    `databases/active.sqlite3` currently resolves to (compared by
    basename).
- `POST /api/databases/active`, body `{filename}` — switches the active
  database. Validates:
  - `filename` matches `^[A-Za-z0-9_.-]+\.sqlite3$` (no `/`, no `..` —
    a bare filename only).
  - A file with that name exists directly under `backend/databases/`.
  - `filename` is not `active.sqlite3` itself.
  On success, atomically repoints the symlink (see Mechanism above) and
  returns the new active entry in the same shape `GET` uses. On
  validation failure, `400` with a clear `{"error": "..."}` message,
  matching this app's existing error-response convention (see
  `LedgerController`/`SymbolController`).

**`MigrationStatusListener` exemption**: this listener currently guards
every `/api/*` route with a `503` when the *active* database is behind
on migrations. Both new routes must be exempted — otherwise, a database
that's behind on migrations would make it impossible to even reach the
switcher to pick a *different*, up-to-date database. Add an explicit
path check (`str_starts_with($path, '/api/databases')`) alongside the
existing `/api` prefix check.

## Frontend

The existing header badge (`App.jsx`, currently reads
`{taxYearBounds(activeTaxYearStart).label} tax year`) becomes the
switcher's own trigger button, and its label changes to reflect the
*active file* rather than always the computed tax-year label:
- Tax-year-pattern file → the friendly label with a dropdown indicator,
  e.g. **"2025/26 ▾"**.
- Any other file → its raw filename, e.g. **"development.sqlite3 ▾"** —
  satisfies "display the filename somewhere prominent" by construction,
  since a non-standard file's name *is* the button's own label.

This is a distinct concern from the existing "N outside tax year"
warning badge (data-derived, unchanged) — one says which *file* you're
in, the other what the *data in it* says.

Clicking opens a small dropdown (new component, e.g.
`DatabaseSwitcher.jsx`):
- Lists databases from `GET /api/databases`, filtered to `isTaxYear`
  entries by default.
- A "Show all files" checkbox lifts that filter, revealing
  `development.sqlite3` and anything else.
- The active entry is visibly marked.
- Picking a different entry:
  1. Routes through the existing `attemptNavigation()` guard (same
     Save/Discard/Stay prompt used elsewhere for disruptive navigation
     away from a dirty draft — see CLAUDE.md's "UI conventions").
  2. On a clean draft or explicit discard, calls the new
     `api.setActiveDatabase(filename)`.
  3. On success, `window.location.reload()` — full reload, not a soft
     refetch, so every piece of app state (accounts, currencies,
     symbols, counterparties, tags, settings, selected account, hash
     routing, sidebar filters, any draft) resets in one guaranteed-
     consistent step rather than needing each to be individually
     audited for staleness.

New `src/api.js` functions: `getDatabases()`
(`GET /api/databases`), `setActiveDatabase(filename)`
(`POST /api/databases/active`).

## Safety & validation

- Filename validation (regex, existence check, no path traversal) as
  described under Backend above — this is a web-reachable endpoint, so
  it validates even though this is a single-user local app.
- Same "single user, no auth" posture as the rest of the backend (see
  CLAUDE.md) — no new auth model introduced for this.
- Atomic symlink swap — no torn/missing-symlink window.

## Testing

No new PHPUnit coverage — consistent with CLAUDE.md's existing posture
(only `IsaAllowanceService` has test coverage, as the one algorithm
subtle enough to have produced a real bug before; everything else here
is pure filesystem glue, verified manually). Manual verification plan:

1. The one-time real migration itself (see Mechanism) — confirmed
   against the actual running app afterward, not treated as disposable
   test data.
2. Switch between at least two real tax-year files via the new UI,
   confirming each reload picks up the right data.
3. Confirm the dirty-draft guard actually blocks a switch attempt
   started mid-edit (Stay keeps you on the draft; Discard/Save then
   switch proceeds).
4. Using a scratch copy (per this session's standing testing-isolation
   convention — never point `.env`/the symlink at a database being
   deliberately broken for a test): confirm `GET`/`POST /api/databases`
   still work when the *active* database is deliberately behind on
   migrations, proving the `MigrationStatusListener` exemption is
   correct.
5. `yarn build` clean, no new frontend errors.

## Out of scope

- Creating a *new* tax year's database from this UI — that's
  `app:new-year`, unchanged, still a terminal command.
- Any change to how the *computed* active tax year
  (`determinedTaxYearStart()`) works — untouched.
- An admin UI for anything else (currencies/symbols/counterparties) —
  unrelated, still deliberately out of scope per CLAUDE.md.
