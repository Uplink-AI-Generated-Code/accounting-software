# Currency and Symbol admin capabilities — Design

## Context

`Currency` and `Symbol` are natural-key reference entities (`backend/src/Entity/`) that today are almost entirely read-only from the API's point of view: `GET /api/currencies` and `GET /api/symbols` exist so the frontend can populate pickers, and `POST /api/symbols` exists as one narrow exception (added specifically to unblock creating the very first investment account in a blank database — see `SymbolController`'s own docblock). CLAUDE.md explicitly calls this out as a "don't build without asking" area, planned but not started. This spec is that conversation: full admin capabilities (create/edit/delete) for both entities.

The highest-risk part of this feature is editing a `scale` — every stored amount referencing a `Currency` or `Symbol` is an integer scaled by that entity's own `scale` (CLAUDE.md's "Amounts, currencies, and reference data"); changing `scale` after data exists means reinterpreting every one of those integers, not just changing a display setting. The user explicitly asked for this capability anyway, with an in-transaction rescale of every affected row, and separately asked for `Symbol` to support multiple rows sharing one `ticker` (each with a different `tradingCurrency`) — which changes `Symbol`'s identity from a simple one-column natural key to a composite one.

## Global Constraints

- Single-user, no-auth personal app (unchanged).
- `Counterparty` stays completely out of scope — it's already a free-text, find-or-create set (CLAUDE.md), not a closed one; nothing here changes it.
- `Currency.code` and `Symbol`'s new composite identity `(ticker, tradingCurrency)` are never editable after creation — only `name` and `scale` can be edited. To use a different code/ticker/tradingCurrency, create a new entry (blocked from colliding with an existing one) rather than renaming.
- A `scale` decrease that would lose precision on any existing stored amount is refused outright (`400`), never silently rounded. A `scale` increase is always lossless and always allowed.
- Every rescale (the `scale` update itself, plus every dependent row it touches) commits in one database transaction — either all of it happens or none of it does.
- This only ever touches the currently active database — `Currency`/`Symbol` are per-database data like everything else in this app (no cross-tax-year-file operation).
- `IsaAllowanceService.php`/`src/lib/isa.js` are unaffected by this feature (they don't reference `Symbol` scale or `Currency` scale at all) — no changes needed there.

## Data model

**`Symbol`** (`backend/src/Entity/Symbol.php`) gets a composite primary key, mirroring `Tag`'s existing `(dimension, value)` pattern (see CLAUDE.md's "Tags" section) — the difference being one half of this composite key is itself a foreign key, not a plain string:

```php
#[ORM\Entity(repositoryClass: SymbolRepository::class)]
class Symbol
{
    #[ORM\Id]
    #[ORM\Column(length: 32)]
    private string $ticker;

    #[ORM\Id]
    #[ORM\ManyToOne(targetEntity: Currency::class)]
    #[ORM\JoinColumn(name: 'trading_currency', referencedColumnName: 'code', nullable: false)]
    private Currency $tradingCurrency;

    #[ORM\Column(length: 255)]
    private string $name;

    #[ORM\Column]
    private int $scale;

    // getters/setters unchanged in shape; no setTicker()/setTradingCurrency()
    // callable after construction — both are part of the identity now, set
    // once at creation via the constructor or immediately after persist,
    // never via a later PATCH.
}
```

`tradingCurrency` moves from "a field that happens to never change in practice" to "explicitly, structurally immutable" — it's part of the identity, so editing it doesn't even type-check as an "edit," it's a different row. This directly satisfies "do not allow editing of tradingCurrency" and "allow a symbol to exist multiple times with one tradingCurrency per instance" together, with no separate flag or check needed — the database's own primary key uniqueness does the work.

**`Account`** (`backend/src/Entity/Account.php`) replaces its single `symbol` join column with two, forming a composite FK into `Symbol`'s new composite key:

```php
#[ORM\ManyToOne(targetEntity: Symbol::class)]
#[ORM\JoinColumns([
    new ORM\JoinColumn(name: 'symbol_ticker', referencedColumnName: 'ticker', nullable: true),
    new ORM\JoinColumn(name: 'symbol_currency', referencedColumnName: 'trading_currency', nullable: true),
])]
private ?Symbol $symbol = null;
```

Both columns are nullable together (an account either has a symbol or doesn't — there's no valid state with only one set); `hydrateAccount()`/`accountToArray()` (see "Backend" below) are responsible for keeping them in lockstep, backed by a hand-added `CHECK ((symbol_ticker IS NULL) = (symbol_currency IS NULL))` in the same migration — the same "enforce it at the database too, not just in application code" layering the `investment`-requires-parent `CHECK` already established for this schema.

**API wire format** changes for `Account` only: `"symbol": "AAPL"` becomes `"symbolTicker": "AAPL", "symbolCurrency": "USD"`. `GET /api/symbols`'s response shape is unchanged (`{ticker, name, scale, tradingCurrency}` per entry) — `tradingCurrency` was already part of every entry, it's just now part of that entry's identity rather than an incidental field.

## Backend

**`LedgerStateService::resolveSymbol()`** changes from a single-argument ticker lookup to a two-argument `(ticker, tradingCurrencyCode)` lookup against the composite key, keeping the same hard-error-on-unknown convention:

```php
private function resolveSymbol(mixed $ticker, mixed $tradingCurrencyCode): ?Symbol
{
    if (null === $ticker || '' === $ticker) {
        return null;
    }
    $currency = $this->resolveCurrency($tradingCurrencyCode); // hard-errors on unknown code
    if (!$currency) {
        throw new \InvalidArgumentException('A symbol reference requires its trading currency.');
    }
    $symbol = $this->em->getRepository(Symbol::class)->find(['ticker' => (string) $ticker, 'tradingCurrency' => $currency]);
    if (!$symbol) {
        throw new \InvalidArgumentException(sprintf('Unknown symbol "%s" in %s.', $ticker, $tradingCurrencyCode));
    }

    return $symbol;
}
```

`hydrateAccount()`'s call site becomes `$account->setSymbol($this->resolveSymbol($data['symbolTicker'] ?? null, $data['symbolCurrency'] ?? null));`. `accountToArray()` emits both `'symbolTicker' => $a->getSymbol()?->getTicker()` and `'symbolCurrency' => $a->getSymbol()?->getTradingCurrency()->getCode()`, both omitted together when there's no symbol (existing null-omission convention).

### New/changed endpoints

- `POST /api/currencies` (new, `CurrencyController`) — body `{code, scale, name?}`; `400` on a missing/invalid field, `409` if `code` already exists. Mirrors `SymbolController::create()`'s existing validation style.
- `PATCH /api/currencies/{code}` (new) — partial body, only `name` and/or `scale` accepted. A `name`-only patch is a plain field write. A `scale` change runs the rescale operation (below) inside one transaction; `400` with a clear message if the decrease would lose precision on any existing row, naming how many rows would be affected (not each one — keeping the response small).
- `DELETE /api/currencies/{code}` (new) — the existing schema already declares every FK into `currency` as `NOT DEFERRABLE INITIALLY IMMEDIATE` (no cascade), and `foreign_keys` enforcement is on everywhere (`ForeignKeysMiddleware`) — so a still-referenced currency already fails to delete at the database level. The controller catches `\Doctrine\DBAL\Exception\ForeignKeyConstraintViolationException` → `409 {"error": "Currency \"<code>\" is still in use and can't be deleted."}`, the same pattern `AccountController::delete()` already uses for a wrapper-with-subaccounts.
- `POST /api/symbols` (existing route, changed uniqueness check) — the `409` duplicate check moves from "does this ticker exist" to "does this exact `(ticker, tradingCurrency)` pair exist" — the same ticker under a different trading currency is now a valid second row, not a conflict.
- `PATCH /api/symbols/{ticker}/{tradingCurrency}` (new) — partial body, only `name` and/or `scale` accepted (no `tradingCurrency` key — sending one is ignored/rejected as unrecognized, since it isn't part of what a `PATCH` can change). Same transactional-rescale/precision-loss-refusal shape as Currency's.
- `DELETE /api/symbols/{ticker}/{tradingCurrency}` (new) — same FK-violation → `409` pattern as Currency's delete.

### The rescale operation

Lives on a small new method, e.g. `LedgerStateService::rescaleCurrency(string $code, int $newScale): int` / `rescaleSymbol(string $ticker, string $tradingCurrencyCode, int $newScale): int` (return value: how many rows were touched, surfaced in the success response), each wrapped in `$this->em->wrapInTransaction(...)`.

**`rescaleCurrency`** touches, for the given currency code and `$delta = $newScale - $oldScale`:
- `account.opening_balance` — every non-investment account whose `currency` = this code
- `account.opening_balance_cash_value` — every investment account whose symbol's `tradingCurrency` = this code
- `line.amount` — every line on a non-investment account whose `currency` = this code
- `line.cash_value` — every line whose `cash_currency` = this code
- `line.exchange_amount` — every line whose `exchange_currency` = this code

**`rescaleSymbol`** touches, for the given `(ticker, tradingCurrency)` pair:
- `account.opening_balance` — every investment account whose `symbol_ticker`/`symbol_currency` match
- `line.amount` — every line on such an account

Each is a raw DBAL `UPDATE ... SET <column> = <column> * <multiplier>` (delta > 0) or `<column> = <column> / <divisor>` (delta < 0) with the matching `WHERE`, run via `$this->connection->executeStatement()` inside the wrapping transaction — not loaded as entities and saved one by one, since this can touch every line in a database and entity hydration for a pure arithmetic rewrite would be wasted work.

**Precision-loss guard** (delta < 0 only): before any `UPDATE`, run the equivalent `SELECT COUNT(*) FROM <table> WHERE <column> % <divisor> != 0 AND <same WHERE as above>` for every one of the columns above. If any count is nonzero, throw `\InvalidArgumentException` naming the total affected-row count before any `UPDATE` runs — the whole transaction rolls back cleanly, nothing partially rescales.

## Migration

One migration: the `Symbol` table's primary key changes from `(ticker)` to `(ticker, trading_currency)`, and `Account` gets `symbol_ticker`/`symbol_currency` replacing `symbol`. Since every real tax-year database currently has at most one `Symbol` row per ticker (today's schema already enforces that), this migration is a pure structural change with a trivial data carry-forward (`symbol_ticker = symbol`, `symbol_currency` = that symbol's existing `trading_currency`) — no ambiguity to resolve, unlike the investment-parent migration's `type` rename. Doctrine's standard SQLite temp-table-rebuild pattern applies to both `symbol` and `account`; per CLAUDE.md's now-standing convention (added after the last feature's migration incident), any `DROP TABLE` in the generated SQL for either table must bracket the rebuild with `PRAGMA foreign_keys = OFF` / `PRAGMA foreign_key_check` / `PRAGMA foreign_keys = ON`, via `addSql()` (not `executeStatement()`) with `isTransactional(): bool { return false; }` on the migration class — verified empirically against a copy of a real database's row counts before merging, exactly as that convention now requires.

## Frontend

A new top-level view, `ReferenceDataView.jsx`, added as a nav item alongside `Overview`/`AllowanceView`/`TagsView` in `App.jsx`. Two sections (Currencies, Symbols), each a simple table:

- **Name** — inline text input, saved via `PATCH` on blur/Enter.
- **Scale** — plain text plus a separate "Change scale…" action (never inline-editable like name, since it's destructive/irreversible on real data). Clicking it shows a plain confirmation ("Changing scale will rescale every existing amount using this currency/symbol and cannot be undone. Continue?") before firing the `PATCH`; a `400` (lossy decrease) surfaces its message inline instead of applying anything; a success shows how many rows were rescaled.
- **Delete** — attempted directly; a `409`'s message is shown inline on failure (mirrors how account deletion already surfaces its blocked-delete error).
- **Add new** — a small inline "+ Add currency" / "+ Add symbol" form per section, separate from `AccountFormModal.jsx`'s existing inline symbol-creator (which stays exactly as-is for the "need one right now while making an account" shortcut — not replaced by this view).

None of this view's writes are optimistic — every mutation awaits its response, and only then does `App.jsx` refetch `currencies`/`symbols` (the same `GET` calls it already makes once at startup) so every other view (pickers, `fmt`/`fmtUnits`'s scale cache, grouping) picks up the change. This matches CLAUDE.md's existing "none of the write handlers are optimistic... except `saveAccount`/`saveSettings`" posture.

**Every existing frontend spot keyed by `ticker` alone becomes a match on `(ticker, tradingCurrency)`** now that ticker isn't unique on its own:
- `src/lib/scale.js`'s `setSymbolScales()`/`fmtUnits()` cache, currently keyed by ticker — becomes keyed by a composite key (e.g. `` `${ticker}:${tradingCurrency}` `` internally; this is purely an internal cache key, never exposed on the wire).
- `AccountFormModal.jsx`'s symbol `<select>` (now must also carry/select a trading currency alongside ticker — since the same ticker can appear twice with different currencies, the option list needs to disambiguate, e.g. `"AAPL — USD"` vs `"AAPL — GBP"` as distinct options), and its "+ Add a new symbol" inline flow's duplicate-conflict handling.
- `otherLines.jsx`'s `tradingCurrencyFor()` helper and `scaleForSymbol()` — both currently look up by ticker alone, must become `(ticker, tradingCurrency)` lookups sourced from the leg's own account (which already carries both `symbolTicker`/`symbolCurrency` post-rename).
- `StockLedger.jsx`'s scale lookups, same shift.
- `lib/grouping.js`/`lib/stockMath.js` — spot-check during implementation for any other ticker-only lookup; none are known to exist beyond the above based on CLAUDE.md's own file-by-file description of `src/lib/`, but the implementation plan should verify this by grep rather than assume the list above is exhaustive.

## Testing

- No frontend test suite exists (manual browser verification, per CLAUDE.md's established convention) — verify the new admin view and every ripple-affected symbol lookup manually against a scratch backend, per this project's usual practice.
- Backend: a new PHPUnit test class (e.g. `ReferenceDataServiceTest.php` or added to a suitable existing service test) covering the rescale operation specifically, since it's the one genuinely subtle piece of new logic here — an increase that's always allowed, a decrease that divides evenly and succeeds, a decrease that doesn't divide evenly and is refused with nothing partially applied (assert the pre-refusal state is fully intact after the attempt), and a currency rescale correctly leaving an unrelated currency's amounts untouched.
- Manual `curl` verification for every new endpoint against a scratch copy of a real tax-year database (never the live file, per this project's own testing-isolation convention), including the delete-blocked-while-referenced path and the migration's row-count-preserving verification per the standing convention.
