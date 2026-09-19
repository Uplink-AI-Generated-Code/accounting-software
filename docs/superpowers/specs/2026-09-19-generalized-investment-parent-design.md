# Generalized investment-parent wrapper + enforced foreign keys — Design

## Context

Today, a "wrapper" account that groups several investment subaccounts under one heading only exists for Stocks & Shares ISAs: `type: "isa-parent"`, with each subaccount pointing back at it via a plain string field, `isaParentId`. The user wants the same organizational grouping for non-ISA holdings (e.g. a "Trading 212" or "Vanguard" wrapper with no allowance or rule attached to it) — purely a UI/grouping convenience, not a new financial concept.

Rather than add a second, parallel wrapper type, this generalizes the existing one: `isa-parent` becomes `investment-parent`, and whether a given wrapper *is* an ISA is now expressed the same way ISA-ness is already expressed everywhere else in this app — via the existing `isaKind` field, reusing the already-defined `"stocks-shares-isa"` value from `ISA_KINDS` (`src/lib/theme.js`) rather than inventing a new flag. `isaParentId` becomes `parentId`, and — because the user specifically asked for it, having correctly recalled that SQLite doesn't enforce foreign keys by default — becomes a genuine, database-enforced foreign key rather than a bare string, alongside enabling `PRAGMA foreign_keys = ON` for every connection this app makes (currently never enabled, confirmed by grep and by two existing code comments documenting the app's manual workarounds for that absence).

## Global Constraints

- Single-user, no-auth personal app.
- No new financial rule or limit is introduced — this is purely organizational. A non-ISA `investment-parent` must never appear in ISA allowance tracking.
- `IsaAllowanceService.php` (backend) and `src/lib/isa.js` (frontend) are independent ports of the same logic — CLAUDE.md requires they stay in exact agreement; every change here applies to both identically.
- API wire format for `parentId` stays a flat natural-key string (the referenced account's `id`), never a nested object — matching how `currency`/`symbol`/`counterparty` FKs already work despite being real associations backend-side.
- Enabling `foreign_keys` enforcement must not change behavior for any *existing* write path — verified by audit (see "Foreign key enforcement" below) before this was agreed to.

## Data model

**`Account` entity** (`backend/src/Entity/Account.php`):

- `type`'s `"isa-parent"` value is renamed to `"investment-parent"` — a wrapper account with no balance of its own, grouping other accounts.
- `isaParentId` (currently a plain `?string` column, explicitly *not* a mapped association — see the entity's own docblock) becomes `parentId`, a real self-referential association:
  ```php
  #[ORM\ManyToOne(targetEntity: Account::class)]
  #[ORM\JoinColumn(name: 'parent_id', referencedColumnName: 'id', nullable: true)]
  private ?Account $parent = null;
  ```
  `ON DELETE NO ACTION` (SQLite's default, and what every other FK on this entity already uses — `currency`, `symbol`, `counterparty`). With `foreign_keys` enforcement on (see below), this now genuinely blocks deleting a wrapper that still has subaccounts pointing at it, at the database level, not just via the frontend's existing pre-check.
- `isaKind` (already exists, currently only ever set on a standalone flat ISA account) becomes meaningful on an `investment-parent` account too: `"stocks-shares-isa"` marks it as an ISA wrapper (identical behavior to today's `isa-parent`); `null`/empty marks a plain organizational wrapper with no ISA meaning at all. No new column — same field, same vocabulary, used in a context it wasn't used in before.
- `flexible` (already exists) stays exactly as-is, but only shown/meaningful when the wrapper *is* an ISA (see "Frontend" below) — a non-ISA wrapper has no flexible-ISA concept to toggle.

Wire format: `{"parentId": "acc-123"}` (or `null`), never a nested object — unchanged from how `isaParentId` was already exposed, just renamed.

**A `type: "investment"` account must always have a parent** — a per-symbol holding may never exist outside some wrapper (ISA or not). Checked before this feature, every real tax-year database currently has zero investment accounts at all, so this is a pure tightening with no existing data to migrate or reconcile; only a scratch `development.sqlite3` file has one standalone investment account, which is out of scope (throwaway dev data, not real financial data). Enforced at all three layers this app already distinguishes:

1. **Frontend** (`AccountFormModal.jsx`): an investment account can't be saved without a wrapper chosen first.
2. **Backend** (`LedgerStateService::hydrateAccount()`, shared by the live `PUT /api/accounts/{id}` endpoint and `app:import-local-storage`): throws `\InvalidArgumentException` if `type === 'investment'` and `parentId` doesn't resolve to an existing account — the same hard-error convention `resolveCurrency()`/`resolveSymbol()` already use for an unknown reference, applied here for a missing one. `AccountController::put()` currently has no `try/catch` around this at all (confirmed by reading it — `LedgerController`/`DatabaseController` already catch `\InvalidArgumentException` → `400`, `AccountController` doesn't), so this also closes a pre-existing gap where an invalid currency/symbol on account save today falls through to a generic `500` instead of the clean `400` the rest of the app gives for the same class of mistake.
3. **Database**: a `CHECK` constraint on the `account` table — `CHECK (type != 'investment' OR parent_id IS NOT NULL)` — added by hand to the same migration's schema-rebuild (Doctrine's entity attributes have no first-class way to express a cross-column `CHECK`, so this line is hand-written into the generated `CREATE TABLE account (...)` statement, not auto-generated). This is independent of the `foreign_keys` pragma — SQLite always enforces `CHECK` constraints regardless of that setting.

## Foreign key enforcement

SQLite's `foreign_keys` pragma is off by default and must be set on every connection individually — it is not stored in the database file. This app has never enabled it; two existing code comments (`LedgerStateService.php`'s `writeState()` and `deleteTransactionLines()`) explicitly document manual cleanup done *because* `ON DELETE CASCADE` on `line_tag` never fires on its own. Enabling it is a bigger change than just making the new `parentId` FK real — it affects every existing FK in the schema at once, so it was audited before being agreed to:

- Every raw bulk-delete in the codebase (`writeState()`, `deleteTransactionLines()`, `NewYearService::createNextYear()`) already deletes in child-before-parent order (`line_tag` → `line` → `transactions` → `account`). Enabling enforcement doesn't conflict with any of them — it just makes the already-declared `ON DELETE CASCADE` on `line`/`line_tag` start actually firing, making the existing manual cleanup redundant (deleting an already-gone row is a harmless no-op) rather than broken.
- ORM-managed writes (`deleteAccount()`, normal account/line saves via `EntityManager`) already get correct dependency ordering from Doctrine's own `UnitOfWork` commit-order calculation during `flush()`, independent of database-level enforcement. Making `parentId` a real mapped association means a subaccount created in the same save batch as its new wrapper account gets inserted in the correct order automatically.
- `NewYearService::createNextYear()` opens its own connection directly via `DriverManager::getConnection()`, bypassing the app's normal connection setup — it will **not** inherit the new pragma. This is fine: it only ever runs `DELETE`s (already correctly ordered, see above) and plain `UPDATE`s on existing rows, nothing that could violate any FK.

**Mechanism:** a new Doctrine driver middleware, `backend/src/Doctrine/ForeignKeysDriver.php` + `ForeignKeysMiddleware.php` (mirroring the existing `ActiveDatabaseDriver`/`ActiveDatabaseMiddleware` pattern from the database-switcher feature, in the same `src/Doctrine/` namespace) — but **not** environment-gated, unlike `ActiveDatabaseMiddleware`: it applies to every environment, including `test`, so the test suite genuinely exercises the new constraint. `connect()` opens the connection as normal via `parent::connect($params)`, then executes `PRAGMA foreign_keys = ON` on the returned driver-level connection before returning it. Doctrine-bundle auto-registers any `Middleware` implementation (confirmed during the last feature's work — no `services.yaml` wiring needed), and multiple middlewares compose cleanly (each wraps the driver returned by the previous one).

## Backend logic

`IsaAllowanceService::isaProducts()` (`backend/src/Service/IsaAllowanceService.php:214,217`) and `src/lib/isa.js`'s `isaProducts()` — both change identically, keeping the two ports in agreement:

```php
if ('investment-parent' === $a['type'] && 'stocks-shares-isa' === ($a['isaKind'] ?? null)) {
    $childIds = array_values(array_map(
        static fn ($x) => $x['id'],
        array_filter($accounts, static fn ($x) => ($x['parentId'] ?? null) === $a['id'])
    ));
    // ...rest unchanged
```

A non-ISA `investment-parent` wrapper simply never enters `$products`/`products` — invisible to ISA allowance tracking entirely, by construction, not by a special-case exclusion.

`AccountController`'s delete path (backed by `LedgerStateService::deleteAccount()`) must catch the new FK constraint violation and turn it into the same clear JSON error this app already uses for expected rejections, rather than letting a raw Doctrine/PDO exception surface as a generic 500 — matching the frontend's existing message ("Can't delete an ISA that still has subaccounts. Delete those first.", generalized to not assume "ISA").

## Frontend

- `AccountFormModal.jsx`: `isWrapper = type === "investment-parent"` (was `"isa-parent"`). The existing ISA-choice UI, for a wrapper, becomes a plain "This is a Stocks & Shares ISA" checkbox — setting `isaKind` to `"stocks-shares-isa"` or `""` — rather than the full `ISA_KINDS` dropdown a flat (non-wrapper) account gets, since the other three kinds (`cash-isa`/`lifetime-isa`/`innovative-finance-isa`) don't apply to a wrapper account. `showFlexible` narrows to only when the wrapper's `isaKind` is `"stocks-shares-isa"` — a non-ISA wrapper never shows the flexible toggle.
- `App.jsx`, `src/lib/grouping.js`, `src/lib/isa.js`: every `type === "isa-parent"` becomes `type === "investment-parent"`; every `.isaParentId` becomes `.parentId`.
- The account-deletion error message shown to the user generalizes from "Can't delete an ISA that still has subaccounts" to something that covers both cases (e.g. "Can't delete a wrapper account that still has subaccounts. Delete those first.").

## Migration

One migration, generated via `doctrine:migrations:diff` after the entity change (this project's standing convention), plus hand-added data statements:

```sql
UPDATE account SET type = 'investment-parent' WHERE type = 'isa-parent';
UPDATE account SET isa_kind = 'stocks-shares-isa' WHERE type = 'investment-parent';
```

(every *existing* wrapper was implicitly a Stocks & Shares ISA, since that's all `isa-parent` ever meant — this is a faithful carry-forward, not a reset, unlike the earlier app-settings migration's deliberate `groupLevels`/`savedGroupings` reset). These only touch the `type`/`isa_kind` columns, which the generated schema-rebuild leaves untouched by name or position, so their exact placement relative to that rebuild doesn't affect correctness — placing them first, before the rebuild, is simplest to read and matches this project's existing migration style.

The generated schema-rebuild renames `isa_parent_id` → `parent_id` (handled automatically by the temp-table-rebuild pattern's column mapping, not by a hand-written data statement) and adds the FK constraint. The `CHECK (type != 'investment' OR parent_id IS NOT NULL)` constraint is hand-added to the same generated `CREATE TABLE account (...)` statement. Applies to each real tax-year database the same on-demand way every other migration in this project does — picked up the next time each file is switched into and migrated, not all at once. On `development.sqlite3` specifically, this migration will fail to apply as-is, since that scratch file has one standalone investment account violating the new `CHECK` — expected and acceptable (it's throwaway dev data, not covered by this feature), fixed by deleting or re-parenting that one row before migrating that file, not by weakening the constraint.

## Testing

- `IsaAllowanceServiceTest.php` has real coverage of the Stocks & Shares ISA path via `isa-parent` fixtures — these update to `type: 'investment-parent', isaKind: 'stocks-shares-isa'`; same assertions, since behavior is unchanged for that path.
- With `foreign_keys` enforcement now on for `test` too, the existing test suite running green after this change is itself a meaningful regression check on the enforcement audit above — if any existing write path violated FK ordering, the tests would now fail where they previously wouldn't have.
- Manual verification: an existing ISA wrapper still tracks its allowance correctly after migration; a *new*, non-ISA `investment-parent` wrapper groups its subaccounts in the UI but never appears on the Allowance page; deleting a wrapper with subaccounts still fails, now with a database-enforced guarantee behind the existing frontend check, surfaced as the same clear error message either way; attempting to create/save an investment account with no parent is rejected at each of the three layers independently (try the backend and database layers directly, bypassing the frontend, e.g. via `curl`, to confirm they don't merely rely on the frontend never sending a bad request).
