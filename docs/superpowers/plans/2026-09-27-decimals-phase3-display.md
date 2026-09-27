# Decimal Amounts — Phase 3 (Display) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every amount displays with *at least* its currency's/symbol's `scale` decimals and every stored digit beyond. Columns of amounts line up on the decimal point. Computed stock values (cost basis, portfolio value, average price) use an adaptive number of decimals derived from the account's own inputs.

**Architecture:**
- **Formatting:** `src/lib/format.js` shows exact strings (no rounding) with `scale` as the minimum, and gains `fmtParts`/`fracWidth`/`maxPlaces` for alignment.
- **Alignment:** a small `<Amount>` component in `ui.jsx` renders integer and fraction spans, padding the fraction to a column-wide width in `ch` units (the app's amounts are all in the `ll-mono` font).
- **Adaptive precision:** one rule, implemented in `stockMath.js` (`stockPlaces`) and PHP (`App\Money\StockPrecision`), both pinned to new cases in the shared fixture. The backend rounds `costBasis`/`portfolioValue` with it; the frontend rounds running columns, the header and chart labels with it.

**Tech Stack:** React 18 + Vite 5, big.js 7, Vitest 2; Symfony 8 / PHP 8.5 (`BcMath\Number`), PHPUnit.

**Spec:** `docs/superpowers/specs/2026-09-27-arbitrary-precision-decimals-design.md` (the "Phase 3 — display" section). Phases 1 and 2 are on `main`.

## Global Constraints

- **`scale` is the *minimum* number of decimals displayed**, for currencies (`fmt`/`fmtPlain`) and symbols (`fmtUnits`) alike. A value with more fractional digits shows all of them. Examples: GBP `"20"` → `£20.00`; `"123.4567"` → `£123.4567`; a scale-0 currency `"0.5"` → `0.5`; a symbol with scale 4 and `"3"` → `3.0000`.
- **`fmt`, `fmtPlain` and `fmtUnits` never round.** They display the digits they're given. Any computed value (anything that went through `divide()`, or a float from Recharts) must be rounded by the caller *before* it's formatted.
- **Adaptive precision** is a pure rule, identical in PHP and JS and covered by the shared fixture:
  - `moneyPlaces = max(currency scale, max fractionDigits over the account's cashValue values and openingBalanceCashValue)`
  - `unitPlaces = max fractionDigits over the account's line amounts (units) and openingBalance` (no scale floor)
  - `pricePlaces = moneyPlaces + unitPlaces`
- **Backend:** `accountsWithStats()` rounds `costBasis`/`portfolioValue` to `moneyPlaces` (half away from zero). This replaces phase 2's rounding to the currency scale.
- **Frontend:**
  - the stock ledger's running Cost/Worth, header cost basis and header worth round to `moneyPlaces`
  - the header average price rounds to `pricePlaces`
  - chart money labels round to `moneyPlaces`, chart unit labels to `max(unitPlaces, symbol scale)`, and cash-balance chart labels to `maxPlaces(currency scale, [openingBalance, …amounts])`
- **Decimal-point alignment:**
  - Each amount is rendered as integer part + fraction part.
  - The fraction span is `display: inline-block; text-align: left; min-width: <fracWidth + 1>ch` (or `0` when `fracWidth` is 0).
  - The cell stays right-aligned.
  - `fracWidth` for a column is the widest fraction among the values shown in it (at least each value's scale).
  - **Aligned:** ledger table columns (cash Out/In/Balance including the opening row and the editing row's running cell; stock units Out/In/Balance), `IsaParentView`'s cash list, and cash-account balances within one sidebar group and one Overview group.
  - **Not aligned:** badges, chips, tooltips, header totals, chart axes, and compound investment text ("N units · £X").
- **No amount passes through a float** except at the renderer boundaries documented in CLAUDE.md (Recharts, the ISA bar's CSS width, the FX-rate display).
- **Never touch the user's live databases.** Verification uses copies in the worktree.
- Commit after every task. The `Co-Authored-By:` trailer names the model that actually wrote the commit (standing ruling).

## File Structure

**Create:**
- `src/lib/stockMath.test.js` — Vitest suite for `stockPlaces` (fixture-driven).
- `backend/src/Money/StockPrecision.php`, `backend/tests/Money/StockPrecisionTest.php`

**Modify:**
- `tests/fixtures/decimal-cases.json` — adds a `stockPlaces` key.
- lib: `src/lib/format.js`, `src/lib/format.test.js`, `src/lib/stockMath.js`
- components: `src/components/ui.jsx`, `AccountLedger.jsx`, `StockLedger.jsx`, `charts.jsx`, `SidebarGroupTree.jsx`, `OverviewGroupTree.jsx`, `AccountRow.jsx`, `IsaParentView.jsx`, `ReferenceDataView.jsx`, `AccountFormModal.jsx`, `otherLines.jsx`
- backend: `backend/src/Service/LedgerStateService.php`, `backend/tests/Service/LedgerStateServiceAmountsTest.php`
- `CLAUDE.md`

---

### Task 0: Workspace, database copies, baselines, display test data

**Files:** `backend/var/phase3-verify/capture.mjs` (throwaway, never committed)

**Interfaces:**
- Produces:
  - `backend/var/phase3-verify/baseline-2023/` and `baseline-2025/` — current-main API output on real-data copies, which must stay identical.
  - A 2024-25 copy carrying display test data.
  - A backend on :8001.

- [ ] **Step 1: Worktree.** `git worktree add .claude/worktrees/decimals-phase3 -b decimals-phase3 main`. The controller does this *without* switching the session into the worktree, so it can edit the main checkout's `.claude/launch.json` for the browser step. Every command below runs from the worktree root.

- [ ] **Step 2: Copies, dependencies, server.** `$MAIN` = `/Users/radu/Code/Claude/ledger-project`, read-only. Its databases are already migrated to phase 2.

```bash
mkdir -p backend/databases
cp "$MAIN/backend/databases/2023-2024.sqlite3" "$MAIN/backend/databases/2024-2025.sqlite3" "$MAIN/backend/databases/2025-2026.sqlite3" backend/databases/
printf "activeDatabase: 2023-2024.sqlite3\ngroupLevels: []\n" > backend/databases/app-settings.yaml
yarn install
(cd backend && composer install && php bin/console doctrine:migrations:migrate --env=test --no-interaction)
(cd backend && symfony server:start -d --port=8001)
```

- [ ] **Step 3: Capture script** at `backend/var/phase3-verify/capture.mjs`:

```js
// Usage: node capture.mjs <baseUrl> <outDir> — every API response carrying an amount.
import { mkdirSync, writeFileSync } from "node:fs";
const [base, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
async function get(path) {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
const save = (name, data) => writeFileSync(`${outDir}/${name}.json`, JSON.stringify(data, null, 2));
const accounts = await get("/api/accounts");
save("accounts", accounts);
for (const a of accounts) save(`ledger-${a.id}`, await get(`/api/accounts/${encodeURIComponent(a.id)}/ledger`));
const settings = await get("/api/settings");
if (settings.activeTaxYearStart != null) save("isa", await get(`/api/isa-allowance?taxYearStart=${settings.activeTaxYearStart}`));
console.log(`Captured ${accounts.length} accounts into ${outDir}`);
```

- [ ] **Step 4: Capture baselines** on the two real-data copies, then point the server at 2024-25:

```bash
node backend/var/phase3-verify/capture.mjs http://127.0.0.1:8001 backend/var/phase3-verify/baseline-2023
printf "activeDatabase: 2025-2026.sqlite3\ngroupLevels: []\n" > backend/databases/app-settings.yaml
node backend/var/phase3-verify/capture.mjs http://127.0.0.1:8001 backend/var/phase3-verify/baseline-2025
printf "activeDatabase: 2024-2025.sqlite3\ngroupLevels: []\n" > backend/databases/app-settings.yaml
```

- [ ] **Step 5: Display test data on the 2024-25 copy only.** It covers mixed precision in one cash account and a stock with deeper-than-scale inputs:

```bash
B=http://127.0.0.1:8001; H='Content-Type: application/json'
curl -s -X POST $B/api/symbols -H "$H" -d '{"ticker":"TEST","tradingCurrency":"GBP","scale":0,"name":"Test Co"}'
curl -s -X PUT $B/api/accounts/tp1 -H "$H" -d '{"name":"Test Wrapper","type":"investment-parent"}'
curl -s -X PUT $B/api/accounts/ti1 -H "$H" -d '{"name":"Test Stock","type":"investment","symbolTicker":"TEST","symbolCurrency":"GBP","parentId":"tp1"}'
curl -s -X PUT $B/api/accounts/tc1 -H "$H" -d '{"name":"Precision Cash","type":"asset","currency":"GBP"}'
curl -s -X POST $B/api/ledger/batch -H "$H" -d '{"operations":[
 {"op":"upsertLine","line":{"accountId":"ti1","amount":"3","date":"2024-06-01","description":"Buy","cashValue":"100","cashCurrency":"GBP"}},
 {"op":"upsertLine","line":{"accountId":"ti1","amount":"-1","date":"2024-07-01","description":"Sell","cashValue":"-40","cashCurrency":"GBP"}},
 {"op":"upsertLine","line":{"accountId":"ti1","amount":"0.12345","date":"2024-08-01","description":"Deep","cashValue":"123.4567","cashCurrency":"GBP"}},
 {"op":"upsertLine","line":{"accountId":"tc1","amount":"20","date":"2024-06-01","description":"Whole"}},
 {"op":"upsertLine","line":{"accountId":"tc1","amount":"20.5","date":"2024-06-02","description":"Half"}},
 {"op":"upsertLine","line":{"accountId":"tc1","amount":"-123.4567","date":"2024-06-03","description":"Deep"}}]}'
```

Expected: each call returns JSON, and the batch returns `{"ok":true}`. Nothing to commit.

---

### Task 1: `format.js` — at-least-scale display and alignment helpers

**Files:** Modify `src/lib/format.js`, `src/lib/format.test.js`

**Interfaces:**
- Produces (all exported from `src/lib/format.js`):
  - `fmt(amount?: str, currencyCode): string`, `fmtPlain(amount?, currencyCode): string`, `fmtUnits(n?, symbolKeyString): string` — at least `scale` decimals and every given digit, never rounding
  - `fmtParts(amount?, code, kind = "plain"): { int: string, frac: string }` — `kind` is `"plain"` (fmtPlain), `"currency"` (fmt) or `"units"` (fmtUnits, `code` = symbol key); `frac` starts with `.` or is `""`
  - `maxPlaces(minPlaces: number, values: (str|null|undefined)[]): number`
  - `fracWidth(entries: {value?: str|null, code: string, kind?: "plain"|"currency"|"units"}[]): number` — the widest displayed fraction; entries with a null/undefined value are ignored

- [ ] **Step 1: Update the tests.** In `src/lib/format.test.js`:
  - Make the `beforeAll` register a scale-0 currency too: `setCurrencyScales([{ code: "GBP", scale: 2 }, { code: "JPY", scale: 0 }, { code: "XBT", scale: 0 }])`, and `setSymbolScales([{ ticker: "AAPL", tradingCurrency: "USD", scale: 6 }, { ticker: "TEST", tradingCurrency: "GBP", scale: 0 }])`.
  - Replace the existing `describe("fmt family …")` block with:

```js
describe("fmt family: scale is the minimum, never a cap", () => {
  it("pads to the scale", () => {
    expect(fmt("20", "GBP")).toBe("£20.00");
    expect(fmt("-0.05", "GBP")).toBe("-£0.05");
    expect(fmt(undefined, "GBP")).toBe("£0.00");
    expect(fmtPlain("1500", "JPY")).toBe("1,500");
  });
  it("shows every stored digit beyond the scale, without rounding", () => {
    expect(fmt("123.4567", "GBP")).toBe("£123.4567");
    expect(fmtPlain("1234567890123456789.5", "GBP")).toBe("1,234,567,890,123,456,789.50");
    expect(fmtPlain("0.00012345", "XBT")).toBe("0.00012345");
    expect(fmtPlain("0.5", "XBT")).toBe("0.5");
  });
  it("uses the symbol scale as the minimum for units", () => {
    expect(fmtUnits("1.5", "AAPL:USD")).toBe("1.500000");
    expect(fmtUnits("3", "TEST:GBP")).toBe("3");
    expect(fmtUnits("0.12345", "TEST:GBP")).toBe("0.12345");
  });
});

describe("alignment helpers", () => {
  it("splits a formatted amount at the decimal point", () => {
    expect(fmtParts("-1234.5", "GBP")).toEqual({ int: "-1,234", frac: ".50" });
    expect(fmtParts("20", "GBP", "currency")).toEqual({ int: "£20", frac: ".00" });
    expect(fmtParts("1500", "JPY")).toEqual({ int: "1,500", frac: "" });
    expect(fmtParts("0.12345", "TEST:GBP", "units")).toEqual({ int: "0", frac: ".12345" });
  });
  it("computes the widest displayed fraction", () => {
    expect(maxPlaces(2, ["20", "20.5", "123.4567", undefined, null])).toBe(4);
    expect(maxPlaces(0, [])).toBe(0);
    expect(fracWidth([{ value: "20", code: "GBP" }, { value: "20.5", code: "GBP" }])).toBe(2);
    expect(fracWidth([{ value: "20", code: "GBP" }, { value: "-123.4567", code: "GBP" }])).toBe(4);
    expect(fracWidth([{ value: "0.5", code: "XBT" }, { value: "0.00012345", code: "XBT" }])).toBe(8);
    expect(fracWidth([{ value: null, code: "GBP" }])).toBe(0);
    expect(fracWidth([{ value: "3", code: "TEST:GBP", kind: "units" }])).toBe(0);
  });
});
```

  Add `fmtParts, maxPlaces, fracWidth` to the test file's import from `./format`.

- [ ] **Step 2: Run and confirm failure.** Run `yarn test`. Expect failures: `fmt("123.4567","GBP")` currently rounds to `£123.46`, and `fmtParts`/`maxPlaces`/`fracWidth` aren't exported.

- [ ] **Step 3: Implement in `src/lib/format.js`.**
  - Change the decimal import to `import { fractionDigits } from "./decimal";`. Drop `round` if it's no longer used in the file.
  - Replace `fmt`, `fmtPlain` and `fmtUnits` (and the comment block above `padFraction`) with:

```js
// Intl.NumberFormat formats a *string* as an exact decimal (ES2023), so no
// amount ever passes through a float here. A currency's/symbol's `scale`
// is the MINIMUM number of decimals shown: every stored digit beyond it is
// displayed too, and nothing is ever rounded — a computed value (anything
// from divide(), or a Recharts float) must be rounded by the caller first
// (see CLAUDE.md's "Stock valuation" adaptive precision).
function padFraction(v, places) {
  if (places === 0) return v;
  const [whole, frac = ""] = v.split(".");
  return `${whole}.${frac.padEnd(places, "0")}`;
}
function fractionOptions(value, minPlaces) {
  return { minimumFractionDigits: minPlaces, maximumFractionDigits: Math.max(minPlaces, fractionDigits(value)) };
}
export function fmt(amount, currency) {
  const scale = scaleForCurrency(currency);
  const v = amount ?? "0";
  try {
    // Intl doesn't reject an unrecognized-but-well-formed currency code
    // (e.g. "XBT") — it would silently use its own default digits, so the
    // fraction digits are always set explicitly.
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, ...fractionOptions(v, scale) }).format(v);
  } catch (e) {
    return `${padFraction(v, scale)} ${currency}`;
  }
}
```

    Keep the existing comment above `fmtPlain`, then:

```js
export function fmtPlain(amount, currency) {
  const v = amount ?? "0";
  return new Intl.NumberFormat("en-GB", fractionOptions(v, scaleForCurrency(currency))).format(v);
}
```

    Put `fmtUnits` where it currently is, rewriting its comment to say the symbol's scale is the minimum:

```js
export function fmtUnits(n, symbolKeyString) {
  const v = n ?? "0";
  return new Intl.NumberFormat("en-GB", fractionOptions(v, scaleForSymbol(symbolKeyString))).format(v);
}
```

  - Append the alignment helpers:

```js
// Decimal-point alignment (see ui.jsx's <Amount>): a formatted amount split
// into its integer part (sign, currency symbol, thousands separators) and
// its fraction ("." + digits, or "" when there's none to show).
export function fmtParts(amount, code, kind = "plain") {
  const s = kind === "currency" ? fmt(amount, code) : kind === "units" ? fmtUnits(amount, code) : fmtPlain(amount, code);
  const i = s.search(/\.\d/);
  return i === -1 ? { int: s, frac: "" } : { int: s.slice(0, i), frac: s.slice(i) };
}
// The most fractional digits among `values`, never fewer than `minPlaces`.
export function maxPlaces(minPlaces, values) {
  let p = minPlaces;
  for (const v of values) if (v != null) p = Math.max(p, fractionDigits(v));
  return p;
}
// Widest fraction a column will display — each entry shows at least its
// own scale — so every cell's fraction span can be padded to the same width.
export function fracWidth(entries) {
  let w = 0;
  for (const { value, code, kind = "plain" } of entries) {
    if (value == null) continue;
    const scale = kind === "units" ? scaleForSymbol(code) : scaleForCurrency(code);
    w = Math.max(w, scale, fractionDigits(value));
  }
  return w;
}
```

- [ ] **Step 4: Run** `yarn test && yarn build`. Expected: PASS (every suite) and a successful build. `grep -n "round(" src/lib/format.js` should find nothing.

- [ ] **Step 5: Commit** `src/lib/format.js` and `src/lib/format.test.js` with the message "Display: scale is the minimum decimals shown; add alignment helpers".

---

### Task 2: The adaptive precision rule (JS + PHP, shared fixture) and backend output

**Files:**
- Create: `src/lib/stockMath.test.js`, `backend/src/Money/StockPrecision.php`, `backend/tests/Money/StockPrecisionTest.php`
- Modify: `tests/fixtures/decimal-cases.json`, `src/lib/stockMath.js`, `backend/src/Service/LedgerStateService.php`, `backend/tests/Service/LedgerStateServiceAmountsTest.php`

**Interfaces:**
- Produces:
  - JS `stockPlaces(cashScale: number, opening: { openingBalance?: str, openingBalanceCashValue?: str }, lines: { amount: str, cashValue?: str }[]): { moneyPlaces, unitPlaces, pricePlaces }` (numbers), exported from `src/lib/stockMath.js`.
  - PHP `App\Money\StockPrecision::places(int $cashScale, ?string $openingUnits, ?string $openingCash, iterable $lines): array{money: int, units: int, price: int}`, where each line is `array{amount: string, cashValue: ?string}`.
  - `GET /api/accounts` `costBasis`/`portfolioValue` rounded to `money`.

- [ ] **Step 1: Add fixture cases.** In `tests/fixtures/decimal-cases.json`, add a top-level key `"stockPlaces"` next to the existing keys:

```json
  "stockPlaces": [
    { "cashScale": 2, "openingBalance": null, "openingBalanceCashValue": null, "lines": [{ "amount": "3", "cashValue": "100" }, { "amount": "-1", "cashValue": "-40" }], "money": 2, "units": 0, "price": 2 },
    { "cashScale": 2, "openingBalance": null, "openingBalanceCashValue": null, "lines": [{ "amount": "3", "cashValue": "100" }, { "amount": "0.12345", "cashValue": "123.4567" }], "money": 4, "units": 5, "price": 9 },
    { "cashScale": 0, "openingBalance": "1.5", "openingBalanceCashValue": "10.25", "lines": [], "money": 2, "units": 1, "price": 3 },
    { "cashScale": 2, "openingBalance": null, "openingBalanceCashValue": null, "lines": [{ "amount": "2", "cashValue": null }], "money": 2, "units": 0, "price": 2 }
  ]
```

- [ ] **Step 2: Write the JS failing test** at `src/lib/stockMath.test.js`:

```js
import { describe, it, expect } from "vitest";
import cases from "../../tests/fixtures/decimal-cases.json";
import { stockPlaces } from "./stockMath";

describe("stockPlaces (shared fixture)", () => {
  it.each(cases.stockPlaces.map((c, i) => [i, c]))("case %i", (_i, c) => {
    const lines = c.lines.map((l) => (l.cashValue == null ? { amount: l.amount } : l));
    const opening = {
      ...(c.openingBalance != null ? { openingBalance: c.openingBalance } : {}),
      ...(c.openingBalanceCashValue != null ? { openingBalanceCashValue: c.openingBalanceCashValue } : {}),
    };
    expect(stockPlaces(c.cashScale, opening, lines)).toEqual({ moneyPlaces: c.money, unitPlaces: c.units, pricePlaces: c.price });
  });
});
```

- [ ] **Step 3: Write the PHP failing test** at `backend/tests/Money/StockPrecisionTest.php`:

```php
<?php

namespace App\Tests\Money;

use App\Money\StockPrecision;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class StockPrecisionTest extends TestCase
{
    public static function cases(): iterable
    {
        $fixture = json_decode((string) file_get_contents(\dirname(__DIR__, 3).'/tests/fixtures/decimal-cases.json'), true, flags: \JSON_THROW_ON_ERROR);
        foreach ($fixture['stockPlaces'] as $i => $c) {
            yield "case $i" => [$c];
        }
    }

    /** @param array<string, mixed> $c */
    #[DataProvider('cases')]
    public function testMatchesSharedFixture(array $c): void
    {
        self::assertSame(
            ['money' => $c['money'], 'units' => $c['units'], 'price' => $c['price']],
            StockPrecision::places($c['cashScale'], $c['openingBalance'], $c['openingBalanceCashValue'], $c['lines']),
        );
    }
}
```

- [ ] **Step 4: Run both and confirm they fail.** `yarn test` fails because `stockPlaces` isn't exported. `cd backend && php bin/phpunit tests/Money/StockPrecisionTest.php` fails with a missing class.

- [ ] **Step 5: Implement JS** by appending to `src/lib/stockMath.js` (import `fractionDigits` from `./decimal`):

```js
// Adaptive precision for a stock account's computed values — mirrored
// exactly by App\Money\StockPrecision and pinned by the shared fixture.
// Money (cost basis, portfolio value) shows as many decimals as the
// account's own cash inputs ever used, never fewer than the trading
// currency's scale; a price (money ÷ units) adds the units' own decimals so
// price × units reproduces a cash value to its own precision.
export function stockPlaces(cashScale, opening, lines) {
  let money = cashScale;
  let units = 0;
  if (opening.openingBalanceCashValue != null) money = Math.max(money, fractionDigits(opening.openingBalanceCashValue));
  if (opening.openingBalance != null) units = Math.max(units, fractionDigits(opening.openingBalance));
  for (const l of lines) {
    units = Math.max(units, fractionDigits(l.amount));
    if (l.cashValue != null) money = Math.max(money, fractionDigits(l.cashValue));
  }
  return { moneyPlaces: money, unitPlaces: units, pricePlaces: money + units };
}
```

- [ ] **Step 6: Implement PHP** at `backend/src/Money/StockPrecision.php`:

```php
<?php

namespace App\Money;

/**
 * Adaptive precision for a stock account's computed values — mirrors
 * src/lib/stockMath.js's stockPlaces() exactly; both are pinned by the
 * "stockPlaces" cases in tests/fixtures/decimal-cases.json. money: the
 * most decimals any of the account's cash inputs used, never fewer than
 * the trading currency's scale; units: the most decimals any unit amount
 * used; price: money + units.
 */
final class StockPrecision
{
    /**
     * @param iterable<array{amount: string, cashValue: ?string}> $lines
     *
     * @return array{money: int, units: int, price: int}
     */
    public static function places(int $cashScale, ?string $openingUnits, ?string $openingCash, iterable $lines): array
    {
        $money = $cashScale;
        $units = 0;
        if (null !== $openingCash) {
            $money = max($money, Decimal::fractionDigits($openingCash));
        }
        if (null !== $openingUnits) {
            $units = max($units, Decimal::fractionDigits($openingUnits));
        }
        foreach ($lines as $l) {
            $units = max($units, Decimal::fractionDigits($l['amount']));
            if (null !== ($l['cashValue'] ?? null)) {
                $money = max($money, Decimal::fractionDigits($l['cashValue']));
            }
        }

        return ['money' => $money, 'units' => $units, 'price' => $money + $units];
    }
}
```

- [ ] **Step 7: Use it in `LedgerStateService::stockStatsFor()`.**
  - Store the ordered lines in a variable (`$lines = $this->orderedLinesFor($a);`) and walk `$lines`.
  - Replace the phase-2 rounding (the `$cashScale` line and the `return`) with:

```php
        // Adaptive output precision (phase 3): as many decimals as this
        // account's own cash inputs used, never fewer than the trading
        // currency's scale — see App\Money\StockPrecision.
        $places = StockPrecision::places(
            $a->getSymbol()?->getTradingCurrency()->getScale() ?? 2,
            $a->getOpeningBalance(),
            $a->getOpeningBalanceCashValue(),
            array_map(static fn (Line $l) => ['amount' => $l->getAmount(), 'cashValue' => $l->getCashValue()], $lines),
        );

        return ['cost' => Decimal::round($costState['cost'], $places['money']), 'value' => Decimal::round($value, $places['money'])];
```

  - Add `use App\Money\StockPrecision;`, and update the method docblock's "phase 2 rounds to scale" sentence.

- [ ] **Step 8: Extend `LedgerStateServiceAmountsTest`.** Add this test, following the file's existing helpers (`upsertAccount`, `applyLedgerOperations`, `line(...)`, `stats(...)`):

```php
    public function testComputedStockValuesUseAdaptivePrecision(): void
    {
        $this->state->upsertAccount('wrap', ['name' => 'W', 'type' => 'investment-parent']);
        $this->state->upsertAccount('inv', ['name' => 'S', 'type' => 'investment', 'symbolTicker' => 'TST', 'symbolCurrency' => 'GBP', 'parentId' => 'wrap']);
        $this->state->applyLedgerOperations([
            $this->line('inv', '3', '2026-05-01', ['cashValue' => '100', 'cashCurrency' => 'GBP']),
            $this->line('inv', '-1', '2026-06-01', ['cashValue' => '-40', 'cashCurrency' => 'GBP']),
            $this->line('inv', '0.12345', '2026-07-01', ['cashValue' => '123.4567', 'cashCurrency' => 'GBP']),
        ]);

        $s = $this->stats('inv');
        // money places = max(GBP 2, 0, 0, 4) = 4.
        // cost: 100 − 100/3 = 66.6666…67; + 123.4567 = 190.1233666…67 → 190.1234
        self::assertSame('190.1234', $s['costBasis']);
        // value: units 2.12345 × (123.4567 / 0.12345) = 2123.5626…; → 4 dp
        self::assertSame(Decimal::round(Decimal::divide(Decimal::mul('2.12345', '123.4567'), '0.12345'), 4), $s['portfolioValue']);
    }
```

  Add `use App\Money\Decimal;` to the test if it isn't there. The existing phase-2 stock tests still hold unchanged: their cash inputs have ≤2 decimals, or 3 (`100.005`) giving an exact `66.67`, which is canonical under both rules.

- [ ] **Step 9: Run** `yarn test && (cd backend && php bin/phpunit)`. Expected: all pass with pristine output.

- [ ] **Step 10: Commit** the fixture, `stockMath.js`, `stockMath.test.js`, `StockPrecision.php`, its test, `LedgerStateService.php` and `LedgerStateServiceAmountsTest.php` with the message "Adaptive precision for computed stock values (JS + PHP, shared fixture)".

---

### Task 3: `<Amount>`, ledger column alignment, stock and chart rounding

**Files:** Modify `src/components/ui.jsx`, `AccountLedger.jsx`, `StockLedger.jsx`, `charts.jsx`

**Interfaces:**
- Consumes: `fmtParts`, `fracWidth`, `maxPlaces` (Task 1); `stockPlaces` (Task 2); `round`, `divide`, `fromNumber` from `decimal.js`.
- Produces: `<Amount value code kind fracWidth />` exported from `ui.jsx`, with `kind` `"plain"` (default), `"currency"` or `"units"`.

- [ ] **Step 1: `ui.jsx`.** Import `fmtParts` from `../lib/format` and add:

```jsx
// A right-aligned amount whose fraction is padded to `fracWidth` digits of
// blank space, so a column of amounts lines up on the decimal point — CSS
// text-align:"<string>" isn't implemented in any browser. Relies on the
// ll-mono font, where 1ch is exactly one digit's width. Compute fracWidth
// once per column with lib/format.js's fracWidth().
export function Amount({ value, code, kind = "plain", fracWidth = 0 }) {
  const { int, frac } = fmtParts(value, code, kind);
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      {int}
      <span style={{ display: "inline-block", textAlign: "left", minWidth: fracWidth > 0 ? `${fracWidth + 1}ch` : 0 }}>{frac}</span>
    </span>
  );
}
```

- [ ] **Step 2: `AccountLedger.jsx`.**
  - Import `Amount` from `./ui` and `fracWidth` from `../lib/format`.
  - After the `rows` memo, add:

```js
  // One width for the Out/In/Balance columns: the running balance can't
  // have more decimals than the amounts that built it.
  const amountWidth = useMemo(
    () => fracWidth([account.openingBalance, ...rows.flatMap((r) => [r.line.amount, r.running])].map((value) => ({ value, code: account.currency }))),
    [rows, account.openingBalance, account.currency]
  );
```

  - Replace every `fmtPlain(X, account.currency)` in the opening-balance row, the editing row's running cell and the read-only row's Out/In/Balance cells with `<Amount value={X} code={account.currency} fracWidth={amountWidth} />`. Keep each cell's existing `div` (class `ll-mono text-right`, colours, `"—"` fallbacks).
  - The header balance (`fmt(balance, …)`) stays as it is: not aligned.
  - Remove the `fmtPlain` import if it's now unused.

- [ ] **Step 3: `StockLedger.jsx`.**
  - Import `Amount` from `./ui`, `fracWidth` from `../lib/format` and `stockPlaces` from `../lib/stockMath`.
  - After the `rows` memo:

```js
  // Adaptive precision for computed money (see lib/stockMath.js's
  // stockPlaces) — must agree with the backend's costBasis/portfolioValue.
  const places = useMemo(() => stockPlaces(cashScale, account, rows.map((r) => r.line)), [rows, cashScale, account]);
  const unitsKey = symbolKey(account.symbolTicker, account.symbolCurrency);
  const unitsWidth = useMemo(
    () => fracWidth([account.openingBalance, ...rows.flatMap((r) => [r.line.amount, r.running])].map((value) => ({ value, code: unitsKey, kind: "units" }))),
    [rows, account.openingBalance, unitsKey]
  );
```

  - Header figures, rounded before `fmt` (they may carry 20-dp division results):
    - `const costBasis = round(<existing expression>, places.moneyPlaces);`
    - `const portfolioValue = round(<existing expression>, places.moneyPlaces);`
    - `const avgCost = isPositive(balance) ? round(divide(costBasis, balance), places.pricePlaces) : null;`

    `costBasis` is used unrounded nowhere else, so rounding at definition is safe. Confirm with a grep.
  - **Units columns:** replace each `fmtUnits(X, symbolKey(account.symbolTicker, account.symbolCurrency))` in the opening row, the editing row's running cell and the read-only rows' Out/In/Balance cells with `<Amount value={X} code={unitsKey} kind="units" fracWidth={unitsWidth} />`. The header units figure stays `fmtUnits(...)`.
  - **Row sub-line:** `Cost {fmtPlain(r.runningCost, …)} · Worth {fmtPlain(r.runningValue, …)}` becomes `Cost {fmtPlain(round(r.runningCost, places.moneyPlaces), tradingCurrency)} · Worth {fmtPlain(round(r.runningValue, places.moneyPlaces), tradingCurrency)}`. `Value {fmtPlain(natural, …)}` stays: it's a stored value, so it's exact.
  - Add `round` to the decimal import if it's missing, and remove imports that become unused.

- [ ] **Step 4: `charts.jsx`.**
  - Import `round` from `../lib/decimal`; `maxPlaces`, `scaleForCurrency` and `scaleForSymbol` from `../lib/format`; `stockPlaces` from `../lib/stockMath`.
  - **In `BalanceChart`**, after `lines` is computed:

```js
  // Recharts hands floats back to the formatters; round to the most decimals
  // this account's own data uses, so labels never show float noise.
  const balancePlaces = maxPlaces(scaleForCurrency(account.currency), [account.openingBalance, ...lines.map((l) => l.amount)]);
  const formatMoney = (v) => fmt(round(fromNumber(v), balancePlaces), account.currency);
```

    Both the `YAxis tickFormatter` and the `ChartTooltip formatValue` become `formatMoney`.
  - **In `UnitsChart`**, after `rawLines`:

```js
  const places = stockPlaces(scaleForCurrency(tradingCurrency), account, rawLines);
  const unitsKey = symbolKey(account.symbolTicker, account.symbolCurrency);
  const unitLabelPlaces = Math.max(places.unitPlaces, scaleForSymbol(unitsKey));
  const formatMoney = (v) => fmt(round(fromNumber(v), places.moneyPlaces), tradingCurrency);
  const formatUnits = (v) => fmtUnits(round(fromNumber(v), unitLabelPlaces), unitsKey);
```

    Use `formatMoney`/`formatUnits` for both `YAxis` `tickFormatter`s. The stock tooltip component's `row(...)` lambdas are declared outside `UnitsChart`, so pass `formatMoney`/`formatUnits` down as props and use them (units rows keep their `` `${…} ${account.symbolTicker}` `` suffix). If `rawLines` is declared after a hook that needs `places`, order the declarations so it compiles. `rawLines` items are lines with `amount`/`cashValue`.

- [ ] **Step 5: Run** `yarn test && yarn build`. Expected: PASS and a successful build. `grep -n "fmtPlain(r.running\|fmtUnits(r.running" src/components/*.jsx` finds nothing.

- [ ] **Step 6: Commit** the four component files with the message "Align ledger columns on the decimal point; round computed stock and chart values adaptively".

---

### Task 4: List alignment, "minimum decimals" labels, unrestricted inputs

**Files:** Modify `src/components/SidebarGroupTree.jsx`, `OverviewGroupTree.jsx`, `AccountRow.jsx`, `IsaParentView.jsx`, `ReferenceDataView.jsx`, `AccountFormModal.jsx`, `AccountLedger.jsx`, `StockLedger.jsx`, `otherLines.jsx`

**Interfaces:**
- Consumes: `<Amount>` (Task 3) and `fracWidth` (Task 1).
- Produces: `AccountRow` accepts an optional `fracWidth` prop (default `0`).

- [ ] **Step 1: `SidebarGroupTree.jsx`.**
  - Import `Amount` from `./ui` and `fracWidth` from `../lib/format`.
  - Inside the `g.leaf` branch, before `g.items.map`, compute `const cashWidth = fracWidth(g.items.filter((a) => a.type !== "investment" && a.type !== "investment-parent").map((a) => ({ value: a.balance ?? "0", code: a.currency, kind: "currency" })));`. The leaf branch currently maps directly, so wrap it in a block (`g.leaf ? (() => { … return g.items.map(…); })() : …`) or hoist the computation.
  - The balance `span` renders `{a.type === "investment" || a.type === "investment-parent" ? accountDisplay(a) : <Amount value={a.balance ?? "0"} code={a.currency} kind="currency" fracWidth={cashWidth} />}`. Keep its existing style.

- [ ] **Step 2: `OverviewGroupTree.jsx` and `AccountRow.jsx`.**
  - In the leaf branch, compute the same `cashWidth` over `g.items` and pass `fracWidth={cashWidth}` to each `<AccountRow>`.
  - `AccountRow` takes `fracWidth = 0` in its props, and its cash-balance `span` renders `<Amount value={a.balance ?? "0"} code={a.currency} kind="currency" fracWidth={fracWidth} />` in place of `fmt(a.balance ?? "0", a.currency)`, keeping the span's colour/weight styles.
  - Investment/wrapper rows are unchanged.

- [ ] **Step 3: `IsaParentView.jsx`.** For the cash list, compute `const cashWidth = fracWidth(cashSubs.map((a) => ({ value: a.balance ?? "0", code: a.currency, kind: "currency" })));`, and render the balance span's content as `<Amount value={a.balance ?? "0"} code={a.currency} kind="currency" fracWidth={cashWidth} />`. The holdings list stays as it is (compound text).

- [ ] **Step 4: Labels.** `scale` now means the minimum number of decimals shown.
  - **ReferenceDataView.jsx:**
    - Both prompts: `` `Minimum decimals shown for ${currency.code} (currently ${currency.scale}):` ``, and the symbol equivalent `` `Minimum decimals shown for ${symbol.ticker} (${symbol.tradingCurrency}) units (currently ${symbol.scale}):` ``.
    - Both buttons: `Scale: {x.scale} — Change…` becomes `Min. decimals: {x.scale} — Change…`.
    - Both create inputs: `placeholder="Scale"` becomes `placeholder="Min. decimals"`.
    - Update the file's comments that describe scale as storage precision.
  - **AccountFormModal.jsx:** the new-symbol input's `placeholder="Unit scale, e.g. 6"` becomes `placeholder="Minimum decimals shown for units, e.g. 0"`.

- [ ] **Step 5: Unrestricted number inputs.** Amounts accept any precision, so every amount input's `step` becomes `"any"`. This covers `AccountLedger.jsx` (Out/In, exchange Out/In), `StockLedger.jsx` (units Out/In, value), `otherLines.jsx` (units, cost, amount) and `AccountFormModal.jsx` (opening balance). Leave the scale inputs (`min="0" step="1"`) alone. Then remove any variable that is now unused (e.g. `AccountLedger`'s `accountScale`/`scaleFor`, or `StockLedger`'s `unitScale`, if nothing else reads them; `StockLedger`'s `cashScale` is still used by `stockPlaces`).

- [ ] **Step 6: Run** `yarn test && yarn build`. Expected: PASS and a successful build. `grep -rn "step={10" src` finds nothing.

- [ ] **Step 7: Commit** all touched components with the message "Align list balances on the decimal point; 'minimum decimals' wording; unrestricted amount inputs".

---

### Task 5: CLAUDE.md and verification

**Files:** Modify `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md** (surgical, existing voice):
  - **"Amounts, currencies, and reference data":**
    - `scale` = minimum decimals shown; `fmt`/`fmtPlain`/`fmtUnits` never round, so callers round computed values first
    - `fmtParts`/`maxPlaces`/`fracWidth` and `<Amount>` in `ui.jsx`, with the list of where alignment applies and where it doesn't
    - remove "phase 3 changes this" / "rounds to exactly scale" statements
  - **"Stock valuation":**
    - the adaptive rule (money/units/price places), `stockPlaces`/`StockPrecision`, and the shared fixture's `stockPlaces` cases
    - the backend rounds `costBasis`/`portfolioValue` to money places
    - the ledger header, running sub-line and charts round with the same rule
  - **Reference data:** the UI calls `scale` "Min. decimals".
  - **The test lists** mention `stockMath.test.js` and `StockPrecisionTest`.
  - Commit with the message "Document phase 3: minimum-decimals display, alignment, adaptive precision".

- [ ] **Step 2: Real-data API unchanged.** Real data has no stock trades, so phase 3 must not change any real account's output:

```bash
printf "activeDatabase: 2023-2024.sqlite3\ngroupLevels: []\n" > backend/databases/app-settings.yaml
node backend/var/phase3-verify/capture.mjs http://127.0.0.1:8001 backend/var/phase3-verify/after-2023
printf "activeDatabase: 2025-2026.sqlite3\ngroupLevels: []\n" > backend/databases/app-settings.yaml
node backend/var/phase3-verify/capture.mjs http://127.0.0.1:8001 backend/var/phase3-verify/after-2025
printf "activeDatabase: 2024-2025.sqlite3\ngroupLevels: []\n" > backend/databases/app-settings.yaml
for y in 2023 2025; do node -e 'const fs=require("fs"),u=require("util");const[a,b]=process.argv.slice(1);let bad=0;for(const f of fs.readdirSync(a)){if(!u.isDeepStrictEqual(JSON.parse(fs.readFileSync(a+"/"+f)),JSON.parse(fs.readFileSync(b+"/"+f)))){bad++;console.log("MISMATCH",f)}}console.log(bad?bad+" differ":"all match")' backend/var/phase3-verify/baseline-$y backend/var/phase3-verify/after-$y; done
```

  Expected: `all match` twice.

- [ ] **Step 3: Browser verification** (the controller runs this on the 2024-25 copy, with a temporary `ledger-dev-worktree` entry in the main checkout's `.claude/launch.json`: `sh -c "cd <worktree> && LEDGER_API=http://127.0.0.1:8001 npm run dev -- --port 5174 --strictPort"`, removed afterwards). Take screenshots of:
  1. **Precision Cash (`tc1`):** Out/In/Balance show `20.00`, `20.50`, `123.4567` and running balances, all aligned on the decimal point, with 2-digit fractions padded with blank space to 4.
  2. **Test Stock (`ti1`, symbol scale 0):**
     - units `3`, `1`, `0.12345` aligned
     - header cost basis `£190.1234` equals the sidebar/Overview value
     - average price shown to 9 decimals
     - row sub-line Cost/Worth to 4 decimals
  3. **Stock chart and cash chart:** tooltips and axis labels show no float noise (such as `66.66666666666667`).
  4. **Sidebar and Overview:** cash balances in one group line up on the point.
  5. **Reference Data:** labels read "Min. decimals". Changing GBP to 3 shows `£20.000` everywhere with no data change; change it back to 2.
  6. **Phone width** (375 px): no horizontal overflow in the ledger table.
  7. No console errors.

- [ ] **Step 4: Final checks.** Run `yarn test && yarn build && (cd backend && php bin/phpunit)`: all green. Stop the worktree backend.
