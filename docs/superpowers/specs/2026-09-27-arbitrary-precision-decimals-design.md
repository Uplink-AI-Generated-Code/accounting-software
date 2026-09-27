# Arbitrary-precision decimal amounts — design

## Problem

Every amount in the app is a scaled integer (`2000` = £20.00 at GBP's
`scale` of 2). This caused three problems:

1. **Conversion churn.** About 130 frontend call sites go through
   `toMinorUnits`/`fromMinorUnits`/`divRoundHalfUp` or a scale lookup just
   to move between the stored integer and what a human reads or types.
2. **Precision is tied to the currency.** A trade's cash side often needs
   more decimals than the currency's native scale (e.g. `123.4567` GBP),
   and there's no way to store that. Changing a scale needs a data
   rewrite (`rescaleCurrency()`/`rescaleSymbol()`).
3. **A ceiling on the left of the decimal point.** JS `Number` (safe up to
   2⁵³) and PHP's 64-bit int bound the magnitude, and the bound shrinks
   as the scale grows — £10m at scale 12 already overflows `Number`.

## Decision summary

- Amounts become **canonical decimal strings** end to end: in the API,
  in SQLite (`TEXT`), and in React state. They're stored exactly as
  entered (after normalization), with no precision limit on either side
  of the decimal point.
- **Arithmetic**: `BcMath\Number` (PHP 8.4+, available — the app runs on
  8.5) on the backend, [big.js](https://github.com/MikeMcl/big.js) on the
  frontend, each wrapped in one small module.
- **Division** is the only operation that can be inexact. It works at **20
  decimal places, rounding half-up**, through exactly one `divide()` helper
  per side. Division results are never stored, only recomputed, so this
  choice can be changed without touching data.
- **`scale` is kept, and redefined** as the *minimum number of decimals
  displayed*. It no longer affects storage or input validation.
- **Columns of amounts align on the decimal point**, so no scale has to be
  inflated just to line numbers up.
- **Computed values** (cost basis, portfolio value, price) are displayed
  with an **adaptive** number of decimals derived from the account's own
  inputs.
- Delivered in **three phases**: wire format → storage → display.

### Industry context (why decimals, not integers or fractions)

Payment systems (Stripe, TigerBeetle) use scaled integers because they
only move cash, with a fixed ISO 4217 exponent. Multi-commodity accounting
tools, which this ledger resembles, use arbitrary decimals (Beancount,
hledger) or exact fractions (ledger-cli; GnuCash for intermediate math).
Exact fractions were considered and rejected for now:

- Every *stored* value is a terminating decimal anyway.
- Fractions would only matter inside the cost-basis and portfolio-value
  walks, where 20-decimal-place division differs from exact fractions by
  about 10⁻²⁰ per operation.
- They would need a hand-maintained rational type in both PHP and JS.

**Keeping a later switch to fractions cheap** is an explicit design
constraint:

- All division goes through the single `divide()` helper on each side.
- Running cost/value state never leaves the walk functions.
- No computed value is ever cached or persisted.

A switch would then replace one helper and the two walks' internal state
per side, with no migration and no API change.

## The decimal core

### Canonical form

A canonical amount string matches `^-?(0|[1-9]\d*)(\.\d*[1-9])?$`, with
`"-0"` forbidden. In words:

- no `+` sign
- no leading zeros in the integer part
- no trailing zeros in the fractional part
- no bare `.`
- zero is `"0"`

Examples: `"20.50"` → `"20.5"`, `"020"` → `"20"`, `"-0.00"` → `"0"`,
`".5"` → `"0.5"`.

Because every value has exactly one spelling, string equality is numeric
equality. SQL `=`, change detection and tests can all compare strings
directly.

### Frontend: `src/lib/decimal.js` (replaces `src/lib/scale.js`)

Built on big.js. **Callers never hold big.js objects**: every function
takes and returns canonical strings, so React state, props, `===` and JSON
stay plain.

| Function | Purpose |
|---|---|
| `parseDecimal(str)` | Validate user input (optional sign, digits, optional `.`); return canonical string or `null` for invalid input. Empty-field handling stays at the call site. |
| `canonical(x)` | Normalize any accepted input to canonical form. |
| `add`, `sub`, `mul`, `neg`, `abs` | Exact arithmetic. |
| `cmp`, `isZero`, `sign` | Comparisons. |
| `divide(a, b)` | **The only division in the frontend.** 20 dp, round half-up; returns `"0"` for a zero divisor (same contract as today's `divRoundHalfUp`). |
| `round(x, places)` | Round half-up to `places` decimals (used only for computed-value display). |
| `fractionDigits(x)` | Number of fractional digits of a canonical string. |
| `toNumber(x)` | Float conversion **only** for the Recharts data boundary. |

### Backend: `App\Money\Decimal`

A static helper over `BcMath\Number` with the same operations and
contracts: `canonical()`, `divide()` (20 dp, half-up), `round()`,
`fractionDigits()`, `sum(iterable)`, `cmp()`. Services may use
`BcMath\Number` directly for readable arithmetic (`$a + $b`). Anything
assigned to an entity or put into JSON is a canonical string.

### Cross-language agreement

- A shared fixture file, `tests/fixtures/decimal-cases.json` (at the repo
  root, read by both suites), lists inputs and expected outputs for
  `canonical`, `divide`, `round`, and the adaptive-precision rule below.
  It includes cases such as `-0.000`, `1/3`, `2/3`, half-up exactly at the
  20th place, negative half-up, a zero divisor, and values with 40+
  integer digits.
- **Vitest** is added as a frontend dev dependency (`yarn test`), scoped
  to `src/lib/decimal.js` and the precision rule. The rest of the
  frontend stays without tests, as before.
- A PHPUnit test, `tests/Money/DecimalTest.php`, runs the same fixture.

### Rules (added to CLAUDE.md)

1. Amounts are canonical decimal strings everywhere outside the two
   decimal modules.
2. Nothing divides amounts except `divide()`.
3. A float appears only at the Recharts boundary, via `toNumber()`.
4. The PHP and JS implementations must agree, and the shared fixture
   enforces it.

## Phase 1 — wire format (database unchanged)

The API switches to decimal strings in both directions. SQLite keeps its
integer columns.

### Backend

- A temporary shim, `App\Money\ScaledAmount`:
  - `toDecimal(int $value, int $scale): string` — exact, via string
    manipulation.
  - `fromDecimal(string $value, int $scale): int` — throws
    `InvalidArgumentException` (→ `400`) when the value has more decimals
    than `$scale`. This is the one limit phase 1 keeps.
- The shim is applied only at serialization and hydration:
  - **Serialization:** `lineToArray()`, `accountToArray()`,
    `accountsWithStats()`, `MatchingService` candidates, `TagService`
    responses, `IsaAllowanceService`'s response.
  - **Hydration:** `hydrateLine()`, `hydrateAccount()`, and the
    `amount` query parameter of `GET /api/match-candidates`.
- Internal math is unchanged in this phase. `costBasis`/`portfolioValue`
  are still computed with integer `divRoundHalfUp` and sent as strings.

### Fields that become strings

| Where | Fields |
|---|---|
| Line | `amount`, `cashValue`, `exchangeAmount` |
| Account | `openingBalance`, `openingBalanceCashValue`, `balance`, `costBasis`, `portfolioValue`, `imbalanceIn`, `imbalanceOut` |
| `GET /api/tag-totals` | each row's `amount` |
| `GET /api/isa-allowance` | every usage/amount figure |

`entryCount` and `imbalancedLineCount` are counts and stay JSON numbers.

### Frontend

- **Input fields** keep the user's typed text in the draft and validate it
  with `parseDecimal()`. The draft no longer round-trips through
  `fromMinorUnits`.
- **Arithmetic** goes through `decimal.js`:
  - the running columns in `AccountLedger.jsx`/`StockLedger.jsx`
  - `chartSeries.js`
  - `stockMath.js` (its `divRoundHalfUp` becomes `divide()`)
  - `balanceHint()`/`lineBalanceValue()` in `matching.js`
  - group subtotals in `grouping.js`
  - `ImbalanceBadge`
- **`AllowanceView.jsx`'s `toPence`** is removed. The ISA rule caps in
  `lib/isa.js` become decimal strings (`"20000"`).
- **`fmt(amount, code)`/`fmtUnits(n, symbolKeyString)`** accept strings
  and keep their two-argument shape. In phase 1 they still format to
  exactly `scale` places.
- **Charts** convert with `toNumber()` only where series data is handed
  to Recharts.
- **`ledgerOperations.js`** is structurally unchanged, since it only moves
  values between records.

### Verification

1. Before starting, snapshot `GET /api/accounts` and several
   `GET /api/accounts/{id}/ledger` responses from a **copy** of a real
   tax-year database. Never use the live file.
2. After the change, compare the responses field by field, converting the
   snapshot's integers with `scale`. Every value must match exactly.
3. Check in the browser:
   - a plain edit
   - a two-way cash↔stock match (mirrored search) and a split leg that
     finds a stock trade (direct search)
   - an unlink, and a same-date reorder
   - an FX exchange line and its implied rate
   - the ISA allowance view
   - the charts
4. `yarn test` passes.

## Phase 2 — storage (API output unchanged)

### Schema

- Five columns become `TEXT`:
  - `line.amount`, `line.cash_value`, `line.exchange_amount`
  - `account.opening_balance`, `account.opening_balance_cash_value`
- They are mapped with a custom Doctrine type, **`decimal_text`**, which
  maps to SQL `TEXT` and throws on `convertToDatabaseValue()` if given
  anything other than a canonical string.
- **Do not use Doctrine's `decimal` type.** On SQLite it becomes
  `NUMERIC(p,s)`, and `NUMERIC` column affinity silently converts
  `"20.50"` into a float, which reintroduces exactly the drift this change
  removes.

### Migration

- Generated with `doctrine:migrations:diff`. It will emit the temp-table
  rebuild, so it follows CLAUDE.md's rule for `DROP TABLE` migrations:
  - `isTransactional(): false`
  - `PRAGMA foreign_keys = OFF` / `PRAGMA foreign_key_check` /
    `PRAGMA foreign_keys = ON`, all via `addSql()`
- **Data conversion.** `up()` reads every affected row (the data is still
  untouched when `up()` runs), together with its governing scale:

  | Column | Scale taken from |
  |---|---|
  | `line.amount` | the account's currency, or the account's `Symbol.scale` for an investment account |
  | `line.cash_value` | `line.cash_currency` |
  | `line.exchange_amount` | `line.exchange_currency` |
  | `account.opening_balance` | the account's currency, or its `Symbol.scale` |
  | `account.opening_balance_cash_value` | `account.symbol_currency` |

  It then queues one `UPDATE … SET col = '<canonical literal>' WHERE id =
  …` per row, to run after the rebuild.
- **`down()`** reverses the conversion. It aborts if any value has more
  decimals than its scale allows, or doesn't fit in a 64-bit integer.
- **Every file under `backend/databases/`** must be migrated. The spec'd
  procedure is a shell loop setting `ACTIVE_DATABASE_PATH_OVERRIDE` per
  file and running `doctrine:migrations:migrate --no-interaction`.
  `MigrationStatusListener` already blocks any file left unmigrated.
- Verified on **copies** only: row counts per table before and after, plus
  a spot-check of converted values against the phase 1 API snapshot.

### Backend math

- **Balances:** `SELECT COALESCE(SUM(amount), 0) …` in
  `accountsWithStats()` is replaced by fetching `account_id, amount` for
  all lines in one query and summing with `Decimal::sum` per account.
  Tag totals move to PHP summing the same way.
- **Stock valuation:** `applyCostBasisLine()`/`applyPortfolioValueLine()`/
  `stockStatsFor()` switch to `BcMath\Number`, with `Decimal::divide()`
  replacing `divRoundHalfUp()`, which is deleted. **For phase 2 only,**
  `costBasis`/`portfolioValue` are rounded to the currency's scale before
  being sent. That makes the API output byte-identical to phase 1, which
  proves the storage change in isolation.
- **Other services:**
  - `IsaAllowanceService` converts its `int` internals to decimals;
    `IsaAllowanceServiceTest` is updated to expect strings, with the same
    scenarios.
  - `MatchingService::comparableAmount()` and its comparisons move to
    decimals (canonical string equality suffices for exact-amount
    matching).
  - `NewYearService`'s raw `UPDATE account SET opening_balance = ?…`
    writes canonical strings.
  - `imbalanceStatsByAccount()` moves to decimals.
- **Removed:**
  - `rescaleCurrency()`/`rescaleSymbol()` and their precision-loss and
    safe-integer refusals. A `scale` change in `PATCH /api/currencies`/
    `PATCH /api/symbols` becomes a plain field update.
  - The `ScaledAmount` shim, and with it the phase 1 "too many decimals"
    `400`.

### Import and export

- `app:export-state` writes canonical strings.
- `app:import-local-storage` accepts canonical (or canonicalizable)
  strings. A JSON **integer** in an amount field is treated as a legacy
  scaled integer and converted using the scale of the currency or symbol
  it belongs to (from the file's own `currencies` array if declared,
  otherwise the database). Every pre-phase-2 backup therefore still
  restores.

### Verification

1. Snapshot the phase 1 API output on copied databases.
2. Migrate the copies and diff the output: it must be identical.
3. `php bin/phpunit` passes.
4. On a copy, enter a line with more decimals than its currency's scale
   (e.g. a `cashValue` of `123.4567` GBP). Confirm it round-trips exactly
   and that the balance and cost basis behave.

## Phase 3 — display

### Formatting

- `fmt()`/`fmtUnits()` keep their two-argument shape. They show **at least
  `scale` decimals and every stored digit beyond that**, with thousands
  separators as today. Examples: GBP `"20"` → `20.00`, `"123.4567"` →
  `123.4567`; a scale-0 BTC value `"0.5"` → `0.5`.
- `fmtParts(amount, code)` returns `{int, frac}`:
  - `int` carries the sign and thousands separators.
  - `frac` includes the leading `.`, or is `""` when there's nothing to
    show.

### Decimal-point alignment

CSS `text-align: "<string>"` was specified but is not implemented in any
browser. Instead:

- `<Amount value code kind fracWidth />` in `ui.jsx` renders the two
  parts as spans. The cell stays right-aligned. The fractional span is
  styled `display: inline-block; text-align: left; min-width:
  <fracWidth + 1>ch`, or `0` when `fracWidth` is 0.
- `fracWidth(values, code)` (in `format.js`) returns the widest fraction
  among the values as they would be displayed (at least `scale`).
- This relies on `ll-mono`: in a monospace font, `1ch` equals one digit's
  width.
- **Aligned:** ledger table columns (In/Out, running balance, units, cash
  value, cost basis, portfolio value, price), `IsaParentView` lists, and
  account rows within one sidebar/Overview group.
- **Not aligned:** inline amounts — badges, chips, tooltips, header
  totals, chart axes.

### Adaptive precision for computed values

A pure rule, implemented in `decimal.js` and `Decimal` and covered by the
shared fixture:

- `moneyPlaces = max(currency scale, max fractionDigits over the
  account's cashValue values and openingBalanceCashValue)`
- `pricePlaces = moneyPlaces + max fractionDigits over the account's
  line amounts (units) and openingBalance`

Applied as follows:

- `accountsWithStats()` rounds `costBasis`/`portfolioValue` to
  `moneyPlaces` (half-up), replacing phase 2's rounding to scale. The
  sidebar, Overview and account header display these as sent.
- `stockMath.js` applies the same rule to the running columns and chart
  series from the account's own loaded lines, so they agree with the
  header.
- `StockLedger`'s derived price (`cashValue / units`, via `divide()`) is
  rounded to `pricePlaces`. The price is still never stored.

### Reference data admin

- `ReferenceDataView.jsx` relabels `scale` as **"Minimum decimals
  shown"**.
- The rescale warnings and precision-loss copy are removed.
- Setting crypto currencies to scale 0 is then a normal edit with no data
  effect.

### Verification

Screenshots in the browser pane:

- A GBP column mixing `20`, `20.5` and `123.4567` aligns on the decimal
  point.
- A scale-0 crypto column mixing `0.5` and `0.00012345` aligns the same
  way.
- An account with one 4-decimal trade shows 4-decimal cost basis in both
  the header and the running column, and the two values agree.
- The layout works at phone width.

## Documentation

CLAUDE.md is updated at the end of each phase:

- The "Amounts, currencies, and reference data" section is rewritten.
- References to `scale.js`, `toMinorUnits`/`fromMinorUnits`,
  `divRoundHalfUp`, `rescaleCurrency`/`rescaleSymbol`, "JS safe-integer
  range", and the scale-edit data rewrite are removed.
- The four rules from "The decimal core" are added, together with the
  `decimal_text`/`NUMERIC`-affinity warning.

## Out of scope

- Exact-fraction arithmetic (deliberately deferred; kept cheap to adopt
  — see above).
- Any change to matching semantics, ISA rules, or the stock valuation
  methods themselves — only their number representation changes.
- Live market prices or currency conversion (unchanged: not built).
