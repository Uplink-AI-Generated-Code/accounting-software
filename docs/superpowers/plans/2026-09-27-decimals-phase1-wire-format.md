# Decimal Amounts — Phase 1 (Wire Format) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every amount crosses the API as a canonical decimal string, and the frontend holds and computes amounts as decimal strings. The SQLite storage stays scaled integers for now.

**Architecture:**
- **Frontend:** a new `src/lib/decimal.js` (big.js inside, canonical strings in and out) replaces `src/lib/scale.js` at every call site.
- **Backend:** internal code keeps working in integers. A temporary shim in `backend/src/Money/` (`ScaledAmount`, `ScaleRegistry`, `WireAmounts`) converts integers ↔ decimal strings at the controller boundary only. Phase 2 deletes the shim when storage becomes decimal.

**Tech Stack:** React 18 + Vite 5, big.js 7, Vitest 2; Symfony 8 / PHP 8.5, PHPUnit.

**Spec:** `docs/superpowers/specs/2026-09-27-arbitrary-precision-decimals-design.md` (read the "Decimal core" and "Phase 1" sections).

## Global Constraints

- **Canonical form:** `^-?(0|[1-9]\d*)(\.\d*[1-9])?$`, with `"-0"` forbidden. No `+`, no leading zeros, no trailing fractional zeros; zero is `"0"`.
- **"Half-up" rounding** means *round half away from zero* throughout: big.js `Big.roundHalfUp` (RM = 1), PHP `RoundingMode::HalfAwayFromZero`, and the existing `divRoundHalfUp`.
- **Division:** `divide()` works at 20 decimal places and returns `"0"` for a zero divisor. It is the only division of amounts in the frontend.
- **No floats for amounts.** `toNumber()`/`fromNumber()` are allowed only where a value is handed to, or read back from, a non-decimal renderer: Recharts series and tick values, a CSS width percentage, and `Intl` significant-digit formatting of a display-only FX rate.
- **Callers never hold big.js objects.** Every `decimal.js` export takes and returns canonical strings, except the predicates, which return booleans or numbers.
- **Phase 1 keeps today's precision limits.** Storage is still integer, so the backend returns `400` for a value with more decimals than its scale. The frontend checks this first so an edit isn't lost (`precisionError()` in `format.js`, deleted in phase 2).
- **Phase 1 changes representation only, not numeric behaviour.** Cost basis and portfolio value keep today's per-step rounding to the cash currency's scale (the decimal equivalent of `divRoundHalfUp` on minor units).
  - *Spec deviation, recorded for the phase 2 plan:* phase 2 switches both the backend walk **and** `stockMath.js` to 20-decimal-place internal division. The spec's "phase 2: frontend doesn't change" is therefore not quite true for `stockMath.js`.
- **Never touch the user's live databases.** All verification runs in a worktree whose `backend/databases/` holds **copies** only.
- Commit after every task. End each commit message with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Execution notes

- Between Task 4 (backend now sends strings) and Task 9 (frontend fully converted), **the app won't work in the browser.** That's expected. Tasks 1–5 verify with PHPUnit/Vitest and API snapshots; the browser pass is Task 10.
- `yarn build` is the frontend compile check: there's no linter. Run it at the end of every frontend task.

## File Structure

**Create:**
- `src/lib/decimal.js` — the frontend decimal core.
- `src/lib/decimal.test.js` — Vitest suite for `decimal.js`.
- `src/lib/format.test.js` — Vitest suite for `fmt`/`fmtPlain`/`fmtUnits` exactness.
- `tests/fixtures/decimal-cases.json` — shared edge-case fixture. JS reads it now; PHP reads it in phase 2.
- `backend/src/Money/ScaledAmount.php` — integer ↔ decimal-string conversion. Temporary.
- `backend/src/Money/ScaleRegistry.php` — scale lookups for currencies, symbols and accounts. Temporary.
- `backend/src/Money/WireAmounts.php` — converts API arrays in and out. Temporary.
- `backend/tests/Money/ScaledAmountTest.php`, `backend/tests/Money/WireAmountsTest.php`
- `backend/var/phase1-verify/capture.mjs`, `backend/var/phase1-verify/compare.mjs` — throwaway verification scripts. `var/` is gitignored, so they are never committed.

**Modify:**
- `package.json`, `vite.config.js` — add Vitest and a `test` script; allow overriding the API proxy target.
- Backend controllers: `AccountController`, `LedgerController`, `MatchController`, `TagController`, `IsaAllowanceController`.
- `src/lib/format.js`, `stockMath.js`, `chartSeries.js`, `matching.js`, `grouping.js`, `isa.js`
- `src/components/otherLines.jsx`, `AccountLedger.jsx`, `StockLedger.jsx`, `AccountFormModal.jsx`, `AllowanceView.jsx`, `charts.jsx`, `AccountRow.jsx`, `IsaParentView.jsx`, `Overview.jsx`, `SidebarGroupTree.jsx`, `TagsView.jsx`, `ui.jsx`
- `src/App.jsx`
- `CLAUDE.md`

**Delete:** `src/lib/scale.js`

---

### Task 0: Workspace, database copies, baseline snapshot

**Files:**
- Modify: `vite.config.js`
- Create: `backend/var/phase1-verify/capture.mjs`

**Interfaces:**
- Produces: `backend/var/phase1-verify/baseline/*.json`, the pre-change API snapshot that Task 5 compares against. Also `LEDGER_API` env support in `vite.config.js`.

- [ ] **Step 1: Create the worktree** (per superpowers:using-git-worktrees) on a new branch `decimals-phase1`, from `main` at the spec commit.

- [ ] **Step 2: Give the worktree database copies, never the live files**

`backend/databases/` is gitignored, so a fresh worktree has none. From the worktree root, with `$MAIN` being the main checkout (`/Users/radu/Code/Claude/ledger-project`):

```bash
mkdir -p backend/databases
cp "$MAIN/backend/databases/2025-2026.sqlite3" backend/databases/
printf "activeDatabase: 2025-2026.sqlite3\ngroupLevels: []\n" > backend/databases/app-settings.yaml
```

- [ ] **Step 3: Install dependencies and migrate the test database**

```bash
yarn install
(cd backend && composer install && php bin/console doctrine:migrations:migrate --env=test --no-interaction)
```

- [ ] **Step 4: Let Vite's proxy target a different backend port**

The user may have their own backend running on :8000, so the worktree's backend runs on :8001. In `vite.config.js`, replace `target: "http://127.0.0.1:8000",` with:

```js
        // LEDGER_API lets a second checkout (e.g. a worktree) point at its
        // own backend without colliding with one already on :8000.
        target: process.env.LEDGER_API ?? "http://127.0.0.1:8000",
```

- [ ] **Step 5: Write the capture script** at `backend/var/phase1-verify/capture.mjs`:

```js
// Usage: node capture.mjs <baseUrl> <outDir>
// Captures every API response that carries an amount, for phase 1's
// before/after comparison (compare.mjs). Throwaway; lives under var/.
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
save("currencies", await get("/api/currencies"));
save("symbols", await get("/api/symbols"));
for (const a of accounts) save(`ledger-${a.id}`, await get(`/api/accounts/${encodeURIComponent(a.id)}/ledger`));
const settings = await get("/api/settings");
if (settings.activeTaxYearStart != null) save("isa", await get(`/api/isa-allowance?taxYearStart=${settings.activeTaxYearStart}`));
const tags = await get("/api/tags");
for (const dim of [...new Set(tags.map((t) => t.dimension))]) {
  save(`tag-totals-${encodeURIComponent(dim)}`, await get(`/api/tag-totals?dimension=${encodeURIComponent(dim)}`));
}
console.log(`Captured ${accounts.length} accounts into ${outDir}`);
```

- [ ] **Step 6: Start the worktree backend and capture the baseline**

```bash
(cd backend && symfony server:start -d --port=8001)
node backend/var/phase1-verify/capture.mjs http://127.0.0.1:8001 backend/var/phase1-verify/baseline
```

Expected: `Captured N accounts into …`, where N is greater than 0. Check that `baseline/accounts.json` contains integer `balance` values.

- [ ] **Step 7: Commit** (only `vite.config.js`; `var/` and `databases/` are ignored)

```bash
git add vite.config.js
git commit -m "Allow overriding the dev proxy's API target via LEDGER_API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: `decimal.js` core with Vitest and the shared fixture

**Files:**
- Create: `src/lib/decimal.js`, `src/lib/decimal.test.js`, `tests/fixtures/decimal-cases.json`
- Modify: `package.json`

**Interfaces:**
- Produces (all exported from `src/lib/decimal.js`; `str` means a canonical decimal string):
  - `DIVISION_PLACES = 20`
  - `parseDecimal(input: string|null|undefined): str|null` — user input; `null` if invalid or blank
  - `parseOrZero(input): str` — `parseDecimal(input) ?? "0"`
  - `canonical(x: string): str` — throws `Error` on invalid input
  - `add(a, b)`, `sub(a, b)`, `mul(a, b)`, `neg(a)`, `abs(a)`, `min(a, b)`, `sum(list: str[])` → `str`
  - `divide(a, b): str` — 20 dp, half away from zero; `"0"` when `b` is zero
  - `round(x: str, places: number): str`
  - `cmp(a, b): -1|0|1`, `sign(a): -1|0|1`, `isZero(a): boolean`
  - `isNegative(x)`, `isPositive(x)`, `isNonZero(x)` → `boolean`; **these three accept `undefined`/`null` as zero**
  - `fractionDigits(x: str): number`
  - `toNumber(x: str): number` and `fromNumber(n: number): str` — renderer boundary only

- [ ] **Step 1: Add dependencies and the test script**

```bash
yarn add big.js@^7
yarn add -D vitest@^2
```

Then add `"test": "vitest run"` to `package.json`'s `scripts`.

- [ ] **Step 2: Write the shared fixture** at `tests/fixtures/decimal-cases.json`:

```json
{
  "canonical": [
    ["20.50", "20.5"],
    ["020", "20"],
    ["-0.00", "0"],
    ["-0", "0"],
    [".5", "0.5"],
    ["5.", "5"],
    ["+3", "3"],
    ["-0012.3400", "-12.34"],
    ["0", "0"],
    ["123456789012345678901234567890.000000000000000000001", "123456789012345678901234567890.000000000000000000001"]
  ],
  "invalid": ["", " ", "-", ".", "abc", "1e5", "1,000", "--1", "1.2.3", "0x10"],
  "divide": [
    ["100", "3", "33.33333333333333333333"],
    ["200", "3", "66.66666666666666666667"],
    ["-200", "3", "-66.66666666666666666667"],
    ["1", "0", "0"],
    ["10", "4", "2.5"],
    ["0.00000000000000000005", "1", "0.00000000000000000005"],
    ["0.000000000000000000005", "1", "0.00000000000000000001"],
    ["-0.000000000000000000005", "1", "-0.00000000000000000001"],
    ["0.000000000000000000004", "1", "0"],
    ["123456789012345678901234567890", "10", "12345678901234567890123456789"]
  ],
  "round": [
    ["2.345", 2, "2.35"],
    ["-2.345", 2, "-2.35"],
    ["2.344", 2, "2.34"],
    ["77.77777777777777777778", 2, "77.78"],
    ["-0.004", 2, "0"],
    ["5", 2, "5"],
    ["0.5", 0, "1"],
    ["-0.5", 0, "-1"]
  ]
}
```

- [ ] **Step 3: Write the failing tests** at `src/lib/decimal.test.js`:

```js
import { describe, it, expect } from "vitest";
import cases from "../../tests/fixtures/decimal-cases.json";
import * as d from "./decimal";

describe("canonical (shared fixture)", () => {
  it.each(cases.canonical)("%s → %s", (input, expected) => {
    expect(d.canonical(input)).toBe(expected);
  });
  it.each(cases.invalid)("rejects %j", (input) => {
    expect(() => d.canonical(input)).toThrow();
    expect(d.parseDecimal(input)).toBeNull();
  });
});

describe("divide (shared fixture)", () => {
  it.each(cases.divide)("%s / %s = %s", (a, b, expected) => {
    expect(d.divide(a, b)).toBe(expected);
  });
});

describe("round (shared fixture)", () => {
  it.each(cases.round)("round(%s, %i) = %s", (x, places, expected) => {
    expect(d.round(x, places)).toBe(expected);
  });
});

describe("arithmetic", () => {
  it("adds and subtracts exactly, beyond float range", () => {
    expect(d.add("0.1", "0.2")).toBe("0.3");
    expect(d.add("9007199254740993", "1")).toBe("9007199254740994");
    expect(d.sub("1", "1")).toBe("0");
    expect(d.sub("0", "0.5")).toBe("-0.5");
  });
  it("multiplies, negates, takes abs and min", () => {
    expect(d.mul("1.5", "-2")).toBe("-3");
    expect(d.neg("0")).toBe("0");
    expect(d.neg("-2.5")).toBe("2.5");
    expect(d.abs("-2.5")).toBe("2.5");
    expect(d.min("3", "2.99")).toBe("2.99");
  });
  it("sums a list", () => {
    expect(d.sum([])).toBe("0");
    expect(d.sum(["1.1", "2.2", "-0.3"])).toBe("3");
  });
});

describe("comparisons and predicates", () => {
  it("compares", () => {
    expect(d.cmp("2", "10")).toBe(-1);
    expect(d.cmp("-1", "-1")).toBe(0);
    expect(d.sign("-0.01")).toBe(-1);
    expect(d.isZero("0")).toBe(true);
  });
  it("treats missing values as zero in the tolerant predicates", () => {
    expect(d.isNegative(undefined)).toBe(false);
    expect(d.isPositive(null)).toBe(false);
    expect(d.isNonZero(undefined)).toBe(false);
    expect(d.isNonZero("0.001")).toBe(true);
    expect(d.isNegative("-3")).toBe(true);
  });
});

describe("parsing helpers", () => {
  it("parseOrZero falls back to zero", () => {
    expect(d.parseOrZero("")).toBe("0");
    expect(d.parseOrZero("abc")).toBe("0");
    expect(d.parseOrZero(" 12.50 ")).toBe("12.5");
  });
  it("counts fraction digits of a canonical string", () => {
    expect(d.fractionDigits("12")).toBe(0);
    expect(d.fractionDigits("-0.125")).toBe(3);
  });
});

describe("renderer boundary", () => {
  it("converts to and from numbers", () => {
    expect(d.toNumber("12.5")).toBe(12.5);
    expect(d.fromNumber(1500)).toBe("1500");
    expect(d.fromNumber(1e-7)).toBe("0.0000001");
    expect(d.fromNumber(NaN)).toBe("0");
  });
  it("refuses a raw Number anywhere else", () => {
    expect(() => d.add(1, "2")).toThrow();
  });
});
```

- [ ] **Step 4: Run the tests and confirm they fail**

Run: `yarn test`
Expected: FAIL, because `./decimal` doesn't exist yet.

- [ ] **Step 5: Implement** `src/lib/decimal.js`:

```js
import Big from "big.js";

// The one place amounts are parsed, normalized, and computed on — see
// CLAUDE.md's "Amounts". Every export takes and returns *canonical*
// decimal strings (no "+", no leading zeros, no trailing fractional
// zeros, never "-0"), so React state, props, === and JSON all stay plain
// strings and string equality is numeric equality. Nothing outside this
// file ever holds a big.js object.

// A private constructor so these settings can't leak into, or be changed
// by, any other importer of big.js.
const D = Big();
export const DIVISION_PLACES = 20;
D.DP = DIVISION_PLACES;
D.RM = Big.roundHalfUp; // half away from zero — same as the backend
D.strict = true; // a raw Number is always a bug here: amounts are strings

// What a person may type: optional sign, digits, optional point. No
// exponents, no thousands separators.
const INPUT_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function out(b) {
  const s = b.toFixed();
  return s === "-0" ? "0" : s;
}

export function parseDecimal(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!INPUT_RE.test(s)) return null;
  return out(new D(s.startsWith("+") ? s.slice(1) : s));
}

export function parseOrZero(input) {
  return parseDecimal(input) ?? "0";
}

export function canonical(x) {
  const c = parseDecimal(x);
  if (c === null) throw new Error(`Not a decimal amount: ${JSON.stringify(x)}`);
  return c;
}

export const add = (a, b) => out(new D(a).plus(b));
export const sub = (a, b) => out(new D(a).minus(b));
export const mul = (a, b) => out(new D(a).times(b));
export const neg = (a) => out(new D(a).neg());
export const abs = (a) => out(new D(a).abs());
export const cmp = (a, b) => new D(a).cmp(b);
export const sign = (a) => new D(a).cmp("0");
export const isZero = (a) => new D(a).eq("0");
export const min = (a, b) => (cmp(a, b) <= 0 ? a : b);
export const sum = (list) => list.reduce((acc, x) => add(acc, x), "0");

// The ONLY division of amounts in the frontend — keeping every division
// behind this one helper is what keeps a future switch to exact
// fractions cheap (see the spec). 20 dp, half away from zero; a zero
// divisor yields "0", same contract the old divRoundHalfUp() had.
export function divide(a, b) {
  if (isZero(b)) return "0";
  return out(new D(a).div(b));
}

export function round(x, places) {
  return out(new D(x).round(places, Big.roundHalfUp));
}

// Tolerant predicates for display code, where a missing field (an
// omitted nullable amount) just means zero.
export const isNegative = (x) => x != null && sign(x) < 0;
export const isPositive = (x) => x != null && sign(x) > 0;
export const isNonZero = (x) => x != null && !isZero(x);

export function fractionDigits(x) {
  const i = x.indexOf(".");
  return i === -1 ? 0 : x.length - i - 1;
}

// Renderer boundary ONLY (Recharts data/ticks, a CSS width, Intl
// significant-digit formatting of a display-only ratio). Never use these
// to do arithmetic on an amount.
export function toNumber(x) {
  return Number(x);
}
export function fromNumber(n) {
  return Number.isFinite(n) ? out(new D(String(n))) : "0";
}
```

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `yarn test`
Expected: PASS, all suites green.

- [ ] **Step 7: Commit**

```bash
git add package.json yarn.lock src/lib/decimal.js src/lib/decimal.test.js tests/fixtures/decimal-cases.json
git commit -m "Add decimal.js core (big.js) with Vitest and shared fixture

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `ScaledAmount` — backend integer ↔ decimal string

**Files:**
- Create: `backend/src/Money/ScaledAmount.php`, `backend/tests/Money/ScaledAmountTest.php`

**Interfaces:**
- Produces:
  - `App\Money\ScaledAmount::toDecimal(int $value, int $scale): string` — returns a canonical string
  - `App\Money\ScaledAmount::fromDecimal(string $value, int $scale): int` — throws `\InvalidArgumentException` if the input isn't decimal, has more than `$scale` decimals, or has more than 18 significant digits

- [ ] **Step 1: Write the failing test** at `backend/tests/Money/ScaledAmountTest.php`:

```php
<?php

namespace App\Tests\Money;

use App\Money\ScaledAmount;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class ScaledAmountTest extends TestCase
{
    /** @return array<int, array{int, int, string}> */
    public static function toDecimalCases(): array
    {
        return [
            [2000, 2, '20'],
            [2050, 2, '20.5'],
            [-5, 2, '-0.05'],
            [0, 8, '0'],
            [123, 0, '123'],
            [100000000, 8, '1'],
            [12345678, 8, '0.12345678'],
        ];
    }

    #[DataProvider('toDecimalCases')]
    public function testToDecimal(int $value, int $scale, string $expected): void
    {
        self::assertSame($expected, ScaledAmount::toDecimal($value, $scale));
    }

    /** @return array<int, array{string, int, int}> */
    public static function fromDecimalCases(): array
    {
        return [
            ['20', 2, 2000],
            ['20.5', 2, 2050],
            ['20.50', 2, 2050],
            ['-0.05', 2, -5],
            ['0', 8, 0],
            ['-0', 2, 0],
            ['0.12345678', 8, 12345678],
            ['123', 0, 123],
        ];
    }

    #[DataProvider('fromDecimalCases')]
    public function testFromDecimal(string $value, int $scale, int $expected): void
    {
        self::assertSame($expected, ScaledAmount::fromDecimal($value, $scale));
    }

    /** @return array<int, array{string, int}> */
    public static function rejectedCases(): array
    {
        return [
            ['20.555', 2],   // more decimals than the scale
            ['abc', 2],
            ['1e5', 2],
            ['', 2],
            ['12345678901234567', 2], // 19 digits once scaled
        ];
    }

    #[DataProvider('rejectedCases')]
    public function testFromDecimalRejects(string $value, int $scale): void
    {
        $this->expectException(\InvalidArgumentException::class);
        ScaledAmount::fromDecimal($value, $scale);
    }
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd backend && php bin/phpunit tests/Money/ScaledAmountTest.php`
Expected: FAIL with `Class "App\Money\ScaledAmount" not found`.

- [ ] **Step 3: Implement** `backend/src/Money/ScaledAmount.php`:

```php
<?php

namespace App\Money;

/**
 * Phase 1 shim (docs/superpowers/specs/2026-09-27-arbitrary-precision-
 * decimals-design.md): storage is still scaled integers, while the API
 * speaks canonical decimal strings. Pure string manipulation — no floats,
 * no bcmath needed for a plain shift of the decimal point. Deleted in
 * phase 2, once storage itself is decimal.
 */
final class ScaledAmount
{
    public static function toDecimal(int $value, int $scale): string
    {
        if (0 === $value) {
            return '0';
        }
        $digits = (string) abs($value);
        if ($scale > 0) {
            $digits = str_pad($digits, $scale + 1, '0', \STR_PAD_LEFT);
            $whole = substr($digits, 0, -$scale);
            $frac = rtrim(substr($digits, -$scale), '0');
        } else {
            $whole = $digits;
            $frac = '';
        }

        return ($value < 0 ? '-' : '').$whole.('' !== $frac ? '.'.$frac : '');
    }

    public static function fromDecimal(string $value, int $scale): int
    {
        if (!preg_match('/^(-?)(\d+)(?:\.(\d+))?$/', $value, $m)) {
            throw new \InvalidArgumentException(sprintf('"%s" is not a decimal amount.', $value));
        }
        $frac = rtrim($m[3] ?? '', '0');
        if (\strlen($frac) > $scale) {
            throw new \InvalidArgumentException(sprintf('%s has more than %d decimal place(s), which isn\'t supported yet.', $value, $scale));
        }
        $digits = ltrim($m[2].str_pad($frac, $scale, '0'), '0');
        if ('' === $digits) {
            return 0;
        }
        if (\strlen($digits) > 18) {
            throw new \InvalidArgumentException(sprintf('%s is too large to store.', $value));
        }
        $n = (int) $digits;

        return '-' === $m[1] ? -$n : $n;
    }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd backend && php bin/phpunit tests/Money/ScaledAmountTest.php`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/Money/ScaledAmount.php backend/tests/Money/ScaledAmountTest.php
git commit -m "Add ScaledAmount shim for integer <-> decimal-string amounts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `ScaleRegistry` and `WireAmounts` — converting API arrays

**Files:**
- Create: `backend/src/Money/ScaleRegistry.php`, `backend/src/Money/WireAmounts.php`, `backend/tests/Money/WireAmountsTest.php`

**Interfaces:**
- Consumes: `ScaledAmount::toDecimal/fromDecimal` (Task 2).
- Produces:
  - `new ScaleRegistry(array $currencyScales, array $symbolScales, array $accounts)`
    - `$currencyScales` is `code => int`
    - `$symbolScales` is `"TICKER|CUR" => int`
    - `$accounts` is `id => ['type' => string, 'currency' => ?string, 'symbolTicker' => ?string, 'symbolCurrency' => ?string]`
  - `ScaleRegistry::fromEntityManager(EntityManagerInterface $em): ScaleRegistry`
  - `ScaleRegistry::currencyScale(?string $code): int` — throws `\InvalidArgumentException` if unknown
  - `ScaleRegistry::amountScaleFor(array $account): ?int` — symbol scale for an investment account, else the currency's scale, or `null` when neither is set (a wrapper)
  - `ScaleRegistry::cashScaleFor(array $account): ?int` — the trading currency's scale for an investment account, else the account currency's scale
  - `ScaleRegistry::account(string $id): array` — throws `\InvalidArgumentException` if unknown
  - Static, all taking a `ScaleRegistry $r` as the last argument:
    - Outgoing: `WireAmounts::accountOut(array $a, $r)`, `accountsOut(array $list, $r)`, `lineOut(array $l, $r)`, `recordsOut(array $records, $r)`, `candidatesOut(array $candidates, $r)`, `tagTotalsOut(array $totals, $r)`, `isaUsageOut(array $usage, $r)` — each returns an array
    - Incoming: `accountIn(array $data, $r)`, `lineIn(array $l, $r)`, `operationsIn(array $ops, $r)` return arrays; `amountIn(string $value, ?string $currency, $r): int`

**Field → scale mapping** (the heart of this task; `compare.mjs` in Task 5 re-derives it independently):

| Field | Scale |
|---|---|
| account `openingBalance`, `balance` | `amountScaleFor(account)` |
| account `openingBalanceCashValue`, `costBasis`, `portfolioValue`, `imbalanceIn`, `imbalanceOut` | `cashScaleFor(account)` |
| line `amount` | `amountScaleFor(account of line.accountId)` |
| line `cashValue` | `currencyScale(line.cashCurrency)` |
| line `exchangeAmount` | `currencyScale(line.exchangeCurrency)` |
| tag total `amount` | `currencyScale(total.currency)` |
| ISA `byKind.*`, `total` | `currencyScale('GBP')` |

- [ ] **Step 1: Write the failing test** at `backend/tests/Money/WireAmountsTest.php`:

```php
<?php

namespace App\Tests\Money;

use App\Money\ScaleRegistry;
use App\Money\WireAmounts;
use PHPUnit\Framework\TestCase;

class WireAmountsTest extends TestCase
{
    private ScaleRegistry $r;

    protected function setUp(): void
    {
        $this->r = new ScaleRegistry(
            ['GBP' => 2, 'USD' => 2, 'JPY' => 0, 'BTC' => 8],
            ['AAPL|USD' => 6],
            [
                'cash' => ['type' => 'asset', 'currency' => 'GBP', 'symbolTicker' => null, 'symbolCurrency' => null],
                'inv' => ['type' => 'investment', 'currency' => null, 'symbolTicker' => 'AAPL', 'symbolCurrency' => 'USD'],
                'wrap' => ['type' => 'investment-parent', 'currency' => null, 'symbolTicker' => null, 'symbolCurrency' => null],
            ],
        );
    }

    public function testCashAccountOut(): void
    {
        $out = WireAmounts::accountOut(
            ['id' => 'cash', 'type' => 'asset', 'currency' => 'GBP', 'openingBalance' => 2050, 'balance' => -5, 'entryCount' => 3, 'imbalancedLineCount' => 1, 'imbalanceIn' => 100, 'imbalanceOut' => 0],
            $this->r,
        );
        self::assertSame('20.5', $out['openingBalance']);
        self::assertSame('-0.05', $out['balance']);
        self::assertSame('1', $out['imbalanceIn']);
        self::assertSame('0', $out['imbalanceOut']);
        self::assertSame(3, $out['entryCount']);
        self::assertSame(1, $out['imbalancedLineCount']);
    }

    public function testInvestmentAccountOut(): void
    {
        $out = WireAmounts::accountOut(
            ['id' => 'inv', 'type' => 'investment', 'symbolTicker' => 'AAPL', 'symbolCurrency' => 'USD', 'openingBalance' => 1500000, 'openingBalanceCashValue' => 100, 'balance' => 2500000, 'costBasis' => 12345, 'portfolioValue' => 20000],
            $this->r,
        );
        self::assertSame('1.5', $out['openingBalance']);
        self::assertSame('1', $out['openingBalanceCashValue']);
        self::assertSame('2.5', $out['balance']);
        self::assertSame('123.45', $out['costBasis']);
        self::assertSame('200', $out['portfolioValue']);
    }

    public function testWrapperZeroBalanceNeedsNoScale(): void
    {
        $out = WireAmounts::accountOut(['id' => 'wrap', 'type' => 'investment-parent', 'balance' => 0], $this->r);
        self::assertSame('0', $out['balance']);
    }

    public function testLineOut(): void
    {
        $out = WireAmounts::lineOut(
            ['id' => 7, 'accountId' => 'inv', 'amount' => -250000, 'date' => '2025-05-01', 'description' => 'Sell', 'cashValue' => -9999, 'cashCurrency' => 'USD'],
            $this->r,
        );
        self::assertSame('-0.25', $out['amount']);
        self::assertSame('-99.99', $out['cashValue']);

        $fx = WireAmounts::lineOut(
            ['id' => 8, 'accountId' => 'cash', 'amount' => -1000, 'date' => '2025-05-01', 'description' => 'FX', 'exchangeAmount' => 1500, 'exchangeCurrency' => 'JPY'],
            $this->r,
        );
        self::assertSame('-10', $fx['amount']);
        self::assertSame('1500', $fx['exchangeAmount']);
    }

    public function testRecordsAndCandidatesOut(): void
    {
        $records = WireAmounts::recordsOut(
            [['transactionId' => null, 'lines' => [['id' => 1, 'accountId' => 'cash', 'amount' => 199, 'date' => '2025-05-01', 'description' => '']]]],
            $this->r,
        );
        self::assertSame('1.99', $records[0]['lines'][0]['amount']);

        $candidates = WireAmounts::candidatesOut(
            [['lineId' => 1, 'line' => ['id' => 1, 'accountId' => 'cash', 'amount' => 199, 'date' => '2025-05-01', 'description' => ''], 'account' => ['id' => 'cash', 'type' => 'asset', 'currency' => 'GBP', 'openingBalance' => 0]]],
            $this->r,
        );
        self::assertSame('1.99', $candidates[0]['line']['amount']);
        self::assertSame('0', $candidates[0]['account']['openingBalance']);
    }

    public function testTagTotalsAndIsaOut(): void
    {
        self::assertSame(
            [['value' => 'X', 'currency' => 'BTC', 'amount' => '0.5']],
            WireAmounts::tagTotalsOut([['value' => 'X', 'currency' => 'BTC', 'amount' => 50000000]], $this->r),
        );
        self::assertSame(
            ['byKind' => ['cash-isa' => '100'], 'total' => '100'],
            WireAmounts::isaUsageOut(['byKind' => ['cash-isa' => 10000], 'total' => 10000], $this->r),
        );
        self::assertSame(
            ['byKind' => [], 'total' => '0'],
            WireAmounts::isaUsageOut(['byKind' => [], 'total' => 0], $this->r),
        );
    }

    public function testAccountIn(): void
    {
        $cash = WireAmounts::accountIn(['type' => 'asset', 'currency' => 'GBP', 'openingBalance' => '20.5'], $this->r);
        self::assertSame(2050, $cash['openingBalance']);

        $inv = WireAmounts::accountIn(['type' => 'investment', 'symbolTicker' => 'AAPL', 'symbolCurrency' => 'USD', 'openingBalance' => '1.5', 'openingBalanceCashValue' => '100'], $this->r);
        self::assertSame(1500000, $inv['openingBalance']);
        self::assertSame(10000, $inv['openingBalanceCashValue']);

        $wrap = WireAmounts::accountIn(['type' => 'investment-parent', 'name' => 'W'], $this->r);
        self::assertArrayNotHasKey('openingBalance', $wrap);
    }

    public function testAccountInRejectsIntegers(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        WireAmounts::accountIn(['type' => 'asset', 'currency' => 'GBP', 'openingBalance' => 2050], $this->r);
    }

    public function testOperationsIn(): void
    {
        $ops = WireAmounts::operationsIn([
            ['op' => 'upsertLine', 'lineId' => 3, 'line' => ['accountId' => 'cash', 'amount' => '-12.3', 'date' => '2025-05-01', 'description' => '']],
            ['op' => 'upsertTransaction', 'transactionId' => 't1', 'lines' => [
                ['accountId' => 'cash', 'amount' => '-100', 'date' => '2025-05-01', 'description' => ''],
                ['accountId' => 'inv', 'amount' => '0.5', 'date' => '2025-05-01', 'description' => '', 'cashValue' => '100', 'cashCurrency' => 'USD'],
            ]],
            ['op' => 'deleteLine', 'lineId' => 9],
        ], $this->r);

        self::assertSame(-1230, $ops[0]['line']['amount']);
        self::assertSame(-10000, $ops[1]['lines'][0]['amount']);
        self::assertSame(500000, $ops[1]['lines'][1]['amount']);
        self::assertSame(10000, $ops[1]['lines'][1]['cashValue']);
        self::assertSame(['op' => 'deleteLine', 'lineId' => 9], $ops[2]);
    }

    public function testLineInRejectsExcessPrecisionAndUnknownAccounts(): void
    {
        try {
            WireAmounts::lineIn(['accountId' => 'cash', 'amount' => '1.234'], $this->r);
            self::fail('Expected excess precision to be rejected');
        } catch (\InvalidArgumentException) {
        }
        $this->expectException(\InvalidArgumentException::class);
        WireAmounts::lineIn(['accountId' => 'nope', 'amount' => '1'], $this->r);
    }

    public function testAmountIn(): void
    {
        self::assertSame(-1230, WireAmounts::amountIn('-12.3', 'GBP', $this->r));
    }
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd backend && php bin/phpunit tests/Money/WireAmountsTest.php`
Expected: FAIL with `Class "App\Money\ScaleRegistry" not found`.

- [ ] **Step 3: Implement** `backend/src/Money/ScaleRegistry.php`:

```php
<?php

namespace App\Money;

use App\Entity\Account;
use App\Entity\Currency;
use App\Entity\Symbol;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Phase 1 shim: every scale WireAmounts needs, looked up once per request
 * from the reference data. Plain arrays in the constructor so tests can
 * build one by hand. Deleted in phase 2 along with WireAmounts.
 */
final class ScaleRegistry
{
    /**
     * @param array<string, int> $currencyScales code => scale
     * @param array<string, int> $symbolScales   "TICKER|CUR" => scale
     * @param array<string, array{type: string, currency: ?string, symbolTicker: ?string, symbolCurrency: ?string}> $accounts
     */
    public function __construct(
        private readonly array $currencyScales,
        private readonly array $symbolScales,
        private readonly array $accounts,
    ) {
    }

    public static function fromEntityManager(EntityManagerInterface $em): self
    {
        $currencies = [];
        foreach ($em->getRepository(Currency::class)->findAll() as $c) {
            $currencies[$c->getCode()] = $c->getScale();
        }
        $symbols = [];
        foreach ($em->getRepository(Symbol::class)->findAll() as $s) {
            $symbols[$s->getTicker().'|'.$s->getTradingCurrency()->getCode()] = $s->getScale();
        }
        $accounts = [];
        foreach ($em->getRepository(Account::class)->findAll() as $a) {
            $accounts[$a->getId()] = [
                'type' => $a->getType(),
                'currency' => $a->getCurrency()?->getCode(),
                'symbolTicker' => $a->getSymbol()?->getTicker(),
                'symbolCurrency' => $a->getSymbol()?->getTradingCurrency()->getCode(),
            ];
        }

        return new self($currencies, $symbols, $accounts);
    }

    public function currencyScale(?string $code): int
    {
        if (null === $code || !isset($this->currencyScales[$code])) {
            throw new \InvalidArgumentException(sprintf('Unknown currency "%s".', $code ?? ''));
        }

        return $this->currencyScales[$code];
    }

    /** @param array<string, mixed> $account an account array or an account PUT payload */
    public function amountScaleFor(array $account): ?int
    {
        if ('investment' === ($account['type'] ?? null)) {
            $key = ($account['symbolTicker'] ?? '').'|'.($account['symbolCurrency'] ?? '');
            if (!isset($this->symbolScales[$key])) {
                throw new \InvalidArgumentException(sprintf('Unknown symbol "%s".', $key));
            }

            return $this->symbolScales[$key];
        }

        return isset($account['currency']) ? $this->currencyScale($account['currency']) : null;
    }

    /** @param array<string, mixed> $account */
    public function cashScaleFor(array $account): ?int
    {
        $code = 'investment' === ($account['type'] ?? null) ? ($account['symbolCurrency'] ?? null) : ($account['currency'] ?? null);

        return null === $code ? null : $this->currencyScale($code);
    }

    /** @return array{type: string, currency: ?string, symbolTicker: ?string, symbolCurrency: ?string} */
    public function account(string $id): array
    {
        if (!isset($this->accounts[$id])) {
            throw new \InvalidArgumentException(sprintf('Unknown account "%s".', $id));
        }

        return $this->accounts[$id];
    }
}
```

- [ ] **Step 4: Implement** `backend/src/Money/WireAmounts.php`:

```php
<?php

namespace App\Money;

/**
 * Phase 1 shim: converts amount fields between the integer arrays the
 * services still produce/consume and the canonical decimal strings the
 * API now speaks — applied only in controllers. See the field → scale
 * table in docs/superpowers/plans/2026-09-27-decimals-phase1-wire-format.md.
 * Deleted in phase 2.
 */
final class WireAmounts
{
    private const ACCOUNT_AMOUNT_FIELDS = ['openingBalance', 'balance'];
    private const ACCOUNT_CASH_FIELDS = ['openingBalanceCashValue', 'costBasis', 'portfolioValue', 'imbalanceIn', 'imbalanceOut'];

    /** @param array<string, mixed> $a @return array<string, mixed> */
    public static function accountOut(array $a, ScaleRegistry $r): array
    {
        foreach (self::ACCOUNT_AMOUNT_FIELDS as $k) {
            if (isset($a[$k])) {
                $a[$k] = self::out($a[$k], $r->amountScaleFor($a), $k);
            }
        }
        foreach (self::ACCOUNT_CASH_FIELDS as $k) {
            if (isset($a[$k])) {
                $a[$k] = self::out($a[$k], $r->cashScaleFor($a), $k);
            }
        }

        return $a;
    }

    /** @param array<int, array<string, mixed>> $list @return array<int, array<string, mixed>> */
    public static function accountsOut(array $list, ScaleRegistry $r): array
    {
        return array_map(static fn (array $a) => self::accountOut($a, $r), $list);
    }

    /** @param array<string, mixed> $l @return array<string, mixed> */
    public static function lineOut(array $l, ScaleRegistry $r): array
    {
        $l['amount'] = self::out($l['amount'], $r->amountScaleFor($r->account((string) $l['accountId'])), 'amount');
        if (isset($l['cashValue'])) {
            $l['cashValue'] = self::out($l['cashValue'], $r->currencyScale($l['cashCurrency'] ?? null), 'cashValue');
        }
        if (isset($l['exchangeAmount'])) {
            $l['exchangeAmount'] = self::out($l['exchangeAmount'], $r->currencyScale($l['exchangeCurrency'] ?? null), 'exchangeAmount');
        }

        return $l;
    }

    /** @param array<int, array{transactionId: ?string, lines: array<int, array<string, mixed>>}> $records @return array<int, array<string, mixed>> */
    public static function recordsOut(array $records, ScaleRegistry $r): array
    {
        return array_map(static fn (array $rec) => [
            ...$rec,
            'lines' => array_map(static fn (array $l) => self::lineOut($l, $r), $rec['lines']),
        ], $records);
    }

    /** @param array<int, array{lineId: int, line: array<string, mixed>, account: array<string, mixed>}> $candidates @return array<int, array<string, mixed>> */
    public static function candidatesOut(array $candidates, ScaleRegistry $r): array
    {
        return array_map(static fn (array $c) => [
            ...$c,
            'line' => self::lineOut($c['line'], $r),
            'account' => self::accountOut($c['account'], $r),
        ], $candidates);
    }

    /** @param array<int, array{value: string, currency: string, amount: int}> $totals @return array<int, array<string, mixed>> */
    public static function tagTotalsOut(array $totals, ScaleRegistry $r): array
    {
        return array_map(static fn (array $t) => [
            ...$t,
            'amount' => self::out($t['amount'], $r->currencyScale($t['currency']), 'amount'),
        ], $totals);
    }

    /** @param array{byKind: array<string, int>, total: int} $usage @return array<string, mixed> */
    public static function isaUsageOut(array $usage, ScaleRegistry $r): array
    {
        $scale = $r->currencyScale('GBP');

        return [
            'byKind' => array_map(static fn ($v) => self::out($v, $scale, 'byKind'), $usage['byKind']),
            'total' => self::out($usage['total'], $scale, 'total'),
        ];
    }

    /** @param array<string, mixed> $data @return array<string, mixed> */
    public static function accountIn(array $data, ScaleRegistry $r): array
    {
        if (isset($data['openingBalance'])) {
            $data['openingBalance'] = self::in($data['openingBalance'], $r->amountScaleFor($data), 'openingBalance');
        }
        if (isset($data['openingBalanceCashValue'])) {
            $data['openingBalanceCashValue'] = self::in($data['openingBalanceCashValue'], $r->cashScaleFor($data), 'openingBalanceCashValue');
        }

        return $data;
    }

    /** @param array<string, mixed> $l @return array<string, mixed> */
    public static function lineIn(array $l, ScaleRegistry $r): array
    {
        $l['amount'] = self::in($l['amount'] ?? null, $r->amountScaleFor($r->account((string) ($l['accountId'] ?? ''))), 'amount');
        if (isset($l['cashValue'])) {
            $l['cashValue'] = self::in($l['cashValue'], $r->currencyScale($l['cashCurrency'] ?? null), 'cashValue');
        }
        if (isset($l['exchangeAmount'])) {
            $l['exchangeAmount'] = self::in($l['exchangeAmount'], $r->currencyScale($l['exchangeCurrency'] ?? null), 'exchangeAmount');
        }

        return $l;
    }

    /** @param array<int, array<string, mixed>> $ops @return array<int, array<string, mixed>> */
    public static function operationsIn(array $ops, ScaleRegistry $r): array
    {
        return array_map(static function (array $op) use ($r) {
            if ('upsertLine' === ($op['op'] ?? null) && \is_array($op['line'] ?? null)) {
                $op['line'] = self::lineIn($op['line'], $r);
            }
            if ('upsertTransaction' === ($op['op'] ?? null) && \is_array($op['lines'] ?? null)) {
                $op['lines'] = array_map(static fn (array $l) => self::lineIn($l, $r), $op['lines']);
            }

            return $op;
        }, $ops);
    }

    public static function amountIn(string $value, ?string $currency, ScaleRegistry $r): int
    {
        return ScaledAmount::fromDecimal($value, $r->currencyScale($currency));
    }

    private static function out(mixed $value, ?int $scale, string $field): string
    {
        $v = (int) $value;
        if (0 === $v) {
            return '0';
        }
        if (null === $scale) {
            throw new \LogicException(sprintf('No scale known for nonzero %s.', $field));
        }

        return ScaledAmount::toDecimal($v, $scale);
    }

    private static function in(mixed $value, ?int $scale, string $field): int
    {
        if (!\is_string($value)) {
            throw new \InvalidArgumentException(sprintf('%s must be a decimal string.', $field));
        }
        if (null === $scale) {
            throw new \InvalidArgumentException(sprintf('Can\'t determine the scale for %s.', $field));
        }

        return ScaledAmount::fromDecimal($value, $scale);
    }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `cd backend && php bin/phpunit tests/Money`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/Money/ScaleRegistry.php backend/src/Money/WireAmounts.php backend/tests/Money/WireAmountsTest.php
git commit -m "Add ScaleRegistry/WireAmounts to convert API amounts at the boundary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Apply `WireAmounts` in the controllers

**Files:**
- Modify: `backend/src/Controller/AccountController.php`, `LedgerController.php`, `MatchController.php`, `TagController.php`, `IsaAllowanceController.php`

**Interfaces:**
- Consumes: `ScaleRegistry::fromEntityManager()` and the `WireAmounts::*` methods (Task 3).
- Produces: the new wire format. Every amount field listed in the Task 3 table is a string, in both directions.

Each controller gains `private readonly EntityManagerInterface $em` as a constructor parameter (`use Doctrine\ORM\EntityManagerInterface;`), plus `use App\Money\ScaleRegistry;` and `use App\Money\WireAmounts;`. Symfony autowires the new parameter; no `services.yaml` change is needed.

- [ ] **Step 1: `AccountController`.** Change the constructor to `public function __construct(private readonly LedgerStateService $state, private readonly EntityManagerInterface $em)`, then:

```php
    #[Route('', methods: ['GET'])]
    public function list(): JsonResponse
    {
        return new JsonResponse(WireAmounts::accountsOut($this->state->accountsWithStats(), ScaleRegistry::fromEntityManager($this->em)));
    }

    #[Route('/{id}/ledger', methods: ['GET'])]
    public function ledger(string $id): JsonResponse
    {
        return new JsonResponse(['records' => WireAmounts::recordsOut($this->state->accountLedger($id), ScaleRegistry::fromEntityManager($this->em))]);
    }
```

In `put()`, replace the `try` block with:

```php
        try {
            $registry = ScaleRegistry::fromEntityManager($this->em);

            return new JsonResponse(WireAmounts::accountOut($this->state->upsertAccount($id, WireAmounts::accountIn($body, $registry)), $registry));
        } catch (\InvalidArgumentException $e) {
            return new JsonResponse(['error' => $e->getMessage()], 400);
        }
```

- [ ] **Step 2: `LedgerController`.** Change the constructor the same way. Inside the existing `try`, replace `$this->state->applyLedgerOperations($operations);` with:

```php
            $this->state->applyLedgerOperations(WireAmounts::operationsIn($operations, ScaleRegistry::fromEntityManager($this->em)));
```

The existing `catch (\InvalidArgumentException $e)` now also covers amount-format rejections. Update its comment to mention both.

- [ ] **Step 3: `MatchController`.** Change the constructor to `(private readonly MatchingService $matching, private readonly EntityManagerInterface $em)`. Replace the final `return` with:

```php
        $registry = ScaleRegistry::fromEntityManager($this->em);
        try {
            $amountInt = WireAmounts::amountIn((string) $amount, $currency, $registry);
        } catch (\InvalidArgumentException $e) {
            return new JsonResponse(['error' => $e->getMessage()], 400);
        }

        return new JsonResponse(WireAmounts::candidatesOut($this->matching->findCandidates($currency, $amountInt, $date, $excludeAccountIds, $mode), $registry));
```

- [ ] **Step 4: `TagController`.** Change the constructor to `(private readonly TagService $tags, private readonly EntityManagerInterface $em)`. In `lines()`, return:

```php
        return new JsonResponse(WireAmounts::candidatesOut($this->tags->findLinesByTag($dimension, $value), ScaleRegistry::fromEntityManager($this->em)));
```

In `totals()`, return:

```php
        return new JsonResponse(WireAmounts::tagTotalsOut($this->tags->computeTagTotals($dimension, $excludeDimension, $excludeValue), ScaleRegistry::fromEntityManager($this->em)));
```

`listTags()` carries no amounts, so it stays unchanged.

- [ ] **Step 5: `IsaAllowanceController`.** Change the constructor to `(private readonly IsaAllowanceService $isa, private readonly EntityManagerInterface $em)`, and return:

```php
        return new JsonResponse(WireAmounts::isaUsageOut($this->isa->computeUsage((int) $startYear), ScaleRegistry::fromEntityManager($this->em)));
```

- [ ] **Step 6: Run the backend suite**

Run: `cd backend && php bin/phpunit`
Expected: PASS. The service tests are untouched because services still speak integers.

- [ ] **Step 7: Smoke-test the running backend (:8001, database copy)**

```bash
curl -s http://127.0.0.1:8001/api/accounts | head -c 400
```

Expected: `"balance":"…"` values are JSON **strings**, and `entryCount` is still a number.

- [ ] **Step 8: Commit**

```bash
git add backend/src/Controller
git commit -m "Send and accept amounts as decimal strings at the API boundary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Verify the backend against the baseline snapshot

**Files:**
- Create: `backend/var/phase1-verify/compare.mjs` (never committed)

**Interfaces:**
- Consumes: `baseline/` from Task 0, and the running :8001 backend with Task 4 applied.

- [ ] **Step 1: Write the comparison script** at `backend/var/phase1-verify/compare.mjs`. It re-derives the field → scale mapping independently (BigInt-based) rather than reusing `WireAmounts`, so it can catch a mapping mistake there:

```js
// Usage: node compare.mjs <baselineDir> <newDir>
// Converts every integer amount in the pre-change snapshot to a decimal
// string using its own scale, then requires the post-change API output
// to match exactly. Throwaway; lives under var/.
import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const [baseDir, newDir] = process.argv.slice(2);
const load = (dir, f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));

const currencies = Object.fromEntries(load(baseDir, "currencies.json").map((c) => [c.code, c.scale]));
const symbols = Object.fromEntries(load(baseDir, "symbols.json").map((s) => [`${s.ticker}|${s.tradingCurrency}`, s.scale]));
const accounts = Object.fromEntries(load(baseDir, "accounts.json").map((a) => [a.id, a]));

function dec(v, scale) {
  const n = BigInt(v);
  if (n === 0n) return "0";
  const neg = n < 0n;
  let d = (neg ? -n : n).toString();
  if (scale > 0) {
    d = d.padStart(scale + 1, "0");
    const f = d.slice(-scale).replace(/0+$/, "");
    d = d.slice(0, -scale) + (f ? "." + f : "");
  }
  return (neg ? "-" : "") + d;
}
const amountScale = (a) => (a.type === "investment" ? symbols[`${a.symbolTicker}|${a.symbolCurrency}`] : currencies[a.currency]) ?? 0;
const cashScale = (a) => currencies[a.type === "investment" ? a.symbolCurrency : a.currency] ?? 0;

function convAccount(a) {
  const o = { ...a };
  for (const k of ["openingBalance", "balance"]) if (k in o) o[k] = dec(o[k], amountScale(a));
  for (const k of ["openingBalanceCashValue", "costBasis", "portfolioValue", "imbalanceIn", "imbalanceOut"]) if (k in o) o[k] = dec(o[k], cashScale(a));
  return o;
}
function convLine(l) {
  const o = { ...l, amount: dec(l.amount, amountScale(accounts[l.accountId])) };
  if ("cashValue" in o) o.cashValue = dec(o.cashValue, currencies[o.cashCurrency]);
  if ("exchangeAmount" in o) o.exchangeAmount = dec(o.exchangeAmount, currencies[o.exchangeCurrency]);
  return o;
}
function convert(file, data) {
  if (file === "accounts.json") return data.map(convAccount);
  if (file === "currencies.json" || file === "symbols.json") return data;
  if (file === "isa.json") {
    return {
      byKind: Array.isArray(data.byKind) ? data.byKind : Object.fromEntries(Object.entries(data.byKind).map(([k, v]) => [k, dec(v, currencies.GBP)])),
      total: dec(data.total, currencies.GBP),
    };
  }
  if (file.startsWith("ledger-")) return { records: data.records.map((r) => ({ ...r, lines: r.lines.map(convLine) })) };
  if (file.startsWith("tag-totals-")) return data.map((t) => ({ ...t, amount: dec(t.amount, currencies[t.currency]) }));
  throw new Error(`No converter for ${file}`);
}

let failures = 0;
const files = readdirSync(baseDir);
for (const f of files) {
  const expected = convert(f, load(baseDir, f));
  const actual = load(newDir, f);
  if (!isDeepStrictEqual(expected, actual)) {
    failures++;
    console.log(`MISMATCH ${f}\n  expected: ${JSON.stringify(expected).slice(0, 400)}\n  actual:   ${JSON.stringify(actual).slice(0, 400)}`);
  }
}
console.log(failures ? `${failures} of ${files.length} file(s) differ` : `All ${files.length} files match`);
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Capture the post-change snapshot and compare**

```bash
node backend/var/phase1-verify/capture.mjs http://127.0.0.1:8001 backend/var/phase1-verify/after
node backend/var/phase1-verify/compare.mjs backend/var/phase1-verify/baseline backend/var/phase1-verify/after
```

Expected: `All N files match`. On a mismatch, fix `WireAmounts` (not the script) unless the script's mapping is provably wrong against the spec's field table, then re-run. There's nothing to commit in this task.

---

### Task 6: Frontend `lib/` modules speak decimal strings

**Files:**
- Create: `src/lib/format.test.js`
- Modify: `src/lib/format.js`, `stockMath.js`, `chartSeries.js`, `matching.js`, `grouping.js`, `isa.js`

**Interfaces:**
- Consumes: `decimal.js` (Task 1).
- Produces:
  - `fmt(amount: str|undefined, code)`, `fmtPlain(amount, code)`, `fmtUnits(n, symbolKeyString)` — same shape as before, now taking strings; `undefined` formats as zero.
  - `precisionError(lines: object[], accounts: object[]): string|null` — phase 1 only.
  - `scaleForCurrency(code)` is still exported, and a new `scaleForSymbol(key)` is exported too (it was module-private before).
  - `stockMath` state objects hold strings plus `cashPlaces: number`. `buildCostBasisSeries`/`buildPortfolioValueSeries` take `opening = { units?: str, cost?: str, cashPlaces?: number }` and return points with `value: str`.
  - `buildDailySeries(opening: str, …)` returns points with `value: str`.
  - `subtotalsForItems(items)` returns `{ [currency]: str }`.
  - `ISA_RULE_TABLE` caps (`total`, `subCaps.*`) become strings.

- [ ] **Step 1: Write a failing test** for exact formatting at `src/lib/format.test.js`:

```js
import { describe, it, expect, beforeAll } from "vitest";
import { fmt, fmtPlain, fmtUnits, setCurrencyScales, setSymbolScales, precisionError } from "./format";

beforeAll(() => {
  setCurrencyScales([{ code: "GBP", scale: 2 }, { code: "JPY", scale: 0 }]);
  setSymbolScales([{ ticker: "AAPL", tradingCurrency: "USD", scale: 6 }]);
});

describe("fmt family (phase 1: exactly `scale` places)", () => {
  it("formats strings without going through a float", () => {
    expect(fmt("20", "GBP")).toBe("£20.00");
    expect(fmt("-0.05", "GBP")).toBe("-£0.05");
    expect(fmtPlain("1234567890123456789.5", "GBP")).toBe("1,234,567,890,123,456,789.50");
    expect(fmt(undefined, "GBP")).toBe("£0.00");
    expect(fmtPlain("1500", "JPY")).toBe("1,500");
  });
  it("trims units to the symbol's scale", () => {
    expect(fmtUnits("1.5", "AAPL:USD")).toBe("1.5");
  });
});

describe("precisionError (phase 1 only)", () => {
  const accounts = [
    { id: "c", type: "asset", currency: "GBP", name: "Cash" },
    { id: "i", type: "investment", symbolTicker: "AAPL", symbolCurrency: "USD", name: "Apple" },
  ];
  it("accepts values within scale", () => {
    expect(precisionError([{ accountId: "c", amount: "1.25" }], accounts)).toBeNull();
  });
  it("flags an amount deeper than its account's scale", () => {
    expect(precisionError([{ accountId: "c", amount: "1.255" }], accounts)).toMatch(/Cash/);
  });
});
```

The `"AAPL:USD"` key is `symbolKey("AAPL", "USD")` (see `src/lib/symbolKey.js`).

- [ ] **Step 2: Run the test and confirm it fails**

Run: `yarn test`
Expected: FAIL, because `precisionError` isn't exported and `fmt("20", …)` yields `£0.00` (the old code treats non-finite input as 0).

- [ ] **Step 3: Rewrite the amount parts of `src/lib/format.js`**

1. Replace `import { fromMinorUnits } from "./scale";` with `import { round, fractionDigits } from "./decimal";`.
2. Rewrite the header comment above `currencyScales`: amounts are canonical decimal strings, and the scale registries exist so `fmt`/`fmtUnits` know how many places to show.
3. Make `scaleForSymbol` exported (`export function scaleForSymbol`).
4. Replace `fmt`, `fmtPlain` and `fmtUnits` with:

```js
// Intl.NumberFormat formats a *string* as an exact decimal (ES2023), so
// no amount ever passes through a float here. Phase 1: exactly `scale`
// places (phase 3 changes this to "at least").
function padFraction(v, places) {
  if (places === 0) return v;
  const [whole, frac = ""] = v.split(".");
  return `${whole}.${frac.padEnd(places, "0")}`;
}
export function fmt(amount, currency) {
  const scale = scaleForCurrency(currency);
  const v = round(amount ?? "0", scale);
  try {
    // Intl doesn't reject an unrecognized-but-well-formed currency code
    // (e.g. "BTC") — it would silently use its own default 2 digits, so
    // force this currency's registered scale instead.
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: scale, maximumFractionDigits: scale }).format(v);
  } catch (e) {
    return `${padFraction(v, scale)} ${currency}`;
  }
}
// Same as fmt() without the currency prefix — see its original comment
// about per-row ledger display.
export function fmtPlain(amount, currency) {
  const scale = scaleForCurrency(currency);
  return new Intl.NumberFormat("en-GB", { minimumFractionDigits: scale, maximumFractionDigits: scale }).format(round(amount ?? "0", scale));
}
```

Put this new `fmtUnits` where the old one was, keeping its existing comment:

```js
export function fmtUnits(n, symbolKeyString) {
  const scale = scaleForSymbol(symbolKeyString);
  return new Intl.NumberFormat("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: scale }).format(round(n ?? "0", scale));
}
```

5. Append the phase-1-only guard:

```js
// PHASE 1 ONLY — delete in phase 2 (docs/superpowers/specs/2026-09-27-
// arbitrary-precision-decimals-design.md). Storage is still scaled
// integers, so the backend 400s on a value deeper than its scale; this
// catches it before the save, so the edit isn't lost to a failed batch.
export function precisionError(lines, accounts) {
  for (const l of lines) {
    const acc = accounts.find((a) => a.id === l.accountId);
    if (!acc) continue;
    const amountScale = acc.type === "investment" ? scaleForSymbol(symbolKey(acc.symbolTicker, acc.symbolCurrency)) : scaleForCurrency(acc.currency);
    const checks = [
      [l.amount, amountScale],
      [l.cashValue, scaleForCurrency(l.cashCurrency)],
      [l.exchangeAmount, scaleForCurrency(l.exchangeCurrency)],
    ];
    for (const [value, scale] of checks) {
      if (value !== undefined && fractionDigits(value) > scale) {
        return `${displayAccountName(acc)}: ${value} has more than ${scale} decimal place${scale === 1 ? "" : "s"}.`;
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `yarn test`
Expected: PASS.

- [ ] **Step 5: Rewrite `src/lib/stockMath.js`'s arithmetic**

Replace the import line with `import { add, sub, mul, neg, abs, min, sign, isZero, divide, round } from "./decimal";`. Replace the two `apply*` functions and the state initialization in both builders as below, leaving the date-walking loops unchanged. Update the comment above `applyCostBasisLine`: amounts are decimal strings, and each division is rounded to `state.cashPlaces`, which reproduces the old integer `divRoundHalfUp` on minor units exactly (phase 2 changes this).

```js
export function applyCostBasisLine(state, l) {
  const s = sign(l.amount ?? "0");
  if (s > 0) {
    state.units = add(state.units, l.amount);
    state.cost = add(state.cost, l.cashValue ?? "0");
  } else if (s < 0) {
    const sold = min(neg(l.amount), state.units);
    const costRemoved = sign(state.units) > 0 ? round(divide(mul(state.cost, sold), state.units), state.cashPlaces) : "0";
    state.cost = sub(state.cost, costRemoved);
    state.units = sub(state.units, sold);
    if (isZero(state.units)) {
      // Absorbs ±1-minor-unit rounding dust from the per-step rounding above.
      state.cost = "0";
    }
  }
}
```

In `buildCostBasisSeries`:

```js
  const state = { units: opening.units ?? "0", cost: opening.cost ?? "0", cashPlaces: opening.cashPlaces ?? 2 };
```

```js
export function applyPortfolioValueLine(state, l) {
  state.units = add(state.units, l.amount ?? "0");
  if (!isZero(l.amount ?? "0") && l.cashValue !== undefined) {
    state.lastCashValue = abs(l.cashValue);
    state.lastUnits = abs(l.amount);
  }
  state.value = isZero(state.lastUnits) ? "0" : round(divide(mul(state.units, state.lastCashValue), state.lastUnits), state.cashPlaces);
}
```

In `buildPortfolioValueSeries`:

```js
  const openingUnits = opening.units ?? "0";
  const openingCost = opening.cost ?? "0";
  const state = { units: openingUnits, lastCashValue: openingCost, lastUnits: openingUnits, value: isZero(openingUnits) ? "0" : openingCost, cashPlaces: opening.cashPlaces ?? 2 };
```

- [ ] **Step 6: `src/lib/chartSeries.js`.** Add `import { add } from "./decimal";`. In `buildDailySeries`, replace both `value += sortedLines[idx].amount || 0;` with `value = add(value, sortedLines[idx].amount ?? "0");`. Update the comment above it: `opening` and the point values are decimal strings.

- [ ] **Step 7: `src/lib/matching.js`**

1. Replace the three imports with:

```js
import { fmt, fmtUnits } from "./format";
import { neg, abs, add, sign, isZero, divide, isNegative, toNumber } from "./decimal";
import { symbolKey } from "./symbolKey";
```

2. In `formatCandidateAmount`: `const natural = c.line.cashValue !== undefined ? neg(c.line.cashValue) : "0";`
3. `candidateIsNegative`:

```js
export function candidateIsNegative(c) {
  if (c.account.type === "investment") return isNegative(c.line.cashValue !== undefined ? neg(c.line.cashValue) : "0");
  return isNegative(c.line.amount);
}
```

4. Replace `impliedRateStr` and its comment:

```js
// Display-only FX rate between two currencies' natural decimal values.
// Both sides are already real decimals (no per-currency scale to undo),
// so the ratio is one divide(); only the final significant-digit
// formatting goes through a Number — a renderer boundary, never stored.
function impliedRateStr(valueA, currencyA, valueB, currencyB) {
  if (isZero(valueA)) return null;
  const rate = abs(divide(valueB, valueA));
  // Significant figures stay informative at any magnitude (BTC/GBP), and
  // toLocaleString never drops into exponential notation.
  return toNumber(rate).toLocaleString("en-GB", { maximumSignificantDigits: 6, minimumSignificantDigits: 1 });
}
```

5. In `balanceHint`:
   - Change `if (!bv || !Number.isFinite(bv.value) || bv.value === 0) return null;` to `if (!bv || bv.value === undefined || isZero(bv.value)) return null;`
   - Change `byCur[x.currency] = (byCur[x.currency] || 0) + x.value;` to `byCur[x.currency] = add(byCur[x.currency] ?? "0", x.value);`
   - Change `if (diff === 0)` to `if (isZero(diff))`, and `fmt(Math.abs(diff), curs[0])` to `fmt(abs(diff), curs[0])`
   - Change `Math.sign(a.value) !== Math.sign(b.value)` to `sign(a.value) !== sign(b.value)`
   - Change `curs.every((c) => byCur[c] === 0)` to `curs.every((c) => isZero(byCur[c]))`

- [ ] **Step 8: `src/lib/grouping.js`.** Add `import { add } from "./decimal";`, and change `subtotalsForItems`'s body line to:

```js
  items.filter((a) => a.type !== "investment" && a.type !== "investment-parent").forEach((a) => { sub[a.currency] = add(sub[a.currency] ?? "0", a.balance ?? "0"); });
```

- [ ] **Step 9: `src/lib/isa.js`.** In `ISA_RULE_TABLE` and any other rule rows in that file, make every cap a string (`total: "20000"`, `"lifetime-isa": "4000"`, `"cash-isa": "12000"`, and so on). Run `grep -rn "rules\.total\|subCaps" src` and confirm the only numeric consumer is `AllowanceView.jsx` (converted in Task 9).

- [ ] **Step 10: Build and test**

Run: `yarn test && yarn build`
Expected: tests PASS. The build may still fail on components importing `../lib/scale`; that's fine until Task 10 deletes the file. It must **not** fail on anything in `src/lib/`.

- [ ] **Step 11: Commit**

```bash
git add src/lib
git commit -m "Convert lib/ amount handling to decimal strings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `otherLines.jsx`, `AccountLedger.jsx`, `AccountFormModal.jsx`

**Files:**
- Modify: `src/components/otherLines.jsx`, `AccountLedger.jsx`, `AccountFormModal.jsx`

**Interfaces:**
- Consumes: `decimal.js` (Task 1), and `precisionError` from `format.js` (Task 6).
- Produces: `useOtherLines(account, accounts, draft, setDraft, smartDefaultForFirst)`. The `currencies`/`symbols` parameters are **removed**, because parsing no longer needs a scale. `StockLedger` is updated in Task 8.

- [ ] **Step 1: `otherLines.jsx` imports.** Replace `import { toMinorUnits, fromMinorUnits } from "../lib/scale";` with:

```js
import { parseDecimal, parseOrZero, neg, abs, isZero, isNegative } from "../lib/decimal";
```

- [ ] **Step 2: `useOtherLines`'s signature and scale helpers.** Change the signature to `useOtherLines(account, accounts, draft, setDraft, smartDefaultForFirst)`, and delete the `scaleForCurrency` and `scaleForSymbol` inner functions. `tradingCurrencyFor` and `primaryCurrency` stay.

- [ ] **Step 3: `otherLineFromLine`'s body** (after `base.snapshot = …`):

```js
    if (oAcc && oAcc.type === "investment") {
      const naturalCash = o.cashValue !== undefined ? neg(o.cashValue) : "0";
      base.unitsIsOut = isNegative(o.amount);
      base.unitsStr = abs(o.amount);
      base.cashIsOut = isNegative(naturalCash);
      base.cashStr = isZero(naturalCash) ? "" : abs(naturalCash);
    } else {
      base.isOut = isNegative(o.amount);
      base.amountStr = abs(o.amount);
    }
    return base;
```

- [ ] **Step 4: `resolveOtherLine`'s arithmetic**

Investment branch:

```js
      const unitsMag = abs(parseOrZero(ol.unitsStr));
      const units = ol.unitsIsOut ? neg(unitsMag) : unitsMag;
      const base = unchanged ? { ...ol.snapshot } : { accountId: ol.accountId, date: d.date || todayISO(), description: d.description };
      base.amount = units;
      const olTradingCurrency = tradingCurrencyFor(olAcc);
      const cashParsed = parseDecimal(ol.cashStr);
      if (ol.cashStr !== "" && cashParsed !== null) {
        const cashMag = abs(cashParsed);
        const cashNatural = ol.cashIsOut ? neg(cashMag) : cashMag;
        base.cashValue = neg(cashNatural);
        base.cashCurrency = olTradingCurrency;
      } else {
        delete base.cashValue;
        delete base.cashCurrency;
      }
      return base;
```

Cash branch:

```js
    const mag = abs(parseOrZero(ol.amountStr));
    const amt = ol.isOut ? neg(mag) : mag;
```

- [ ] **Step 5: The per-leg match search.** Change the `pending` filter's body to:

```js
      if (ol.accountId || ol.matchedLineId) return false;
      const mag = parseDecimal(ol.amountStr);
      return mag !== null && !isZero(mag);
```

and in the `Promise.all` map:

```js
          const mag = parseDecimal(ol.amountStr);
          const targetAmount = ol.isOut ? neg(mag) : mag;
```

- [ ] **Step 6: `AccountLedger.jsx` imports.** Replace `import { toMinorUnits, fromMinorUnits } from "../lib/scale";` with:

```js
import { parseOrZero, add, sub, neg, abs, isZero, isNegative, isPositive, isNonZero } from "../lib/decimal";
```

Add `precisionError` to the existing `../lib/format` import. Keep `accountScale` and `scaleFor`: they're still used for the inputs' `step` attributes.

- [ ] **Step 7: `AccountLedger.jsx` delta helpers and the smart default**

```js
  // If both In and Out are filled, the saved line is their difference —
  // e.g. In 50 / Out 20 saves as an increase of 30. Amounts are canonical
  // decimal strings (see CLAUDE.md); blank or unparseable counts as zero.
  function draftDelta(d) {
    return sub(parseOrZero(d.inAmountStr), parseOrZero(d.outAmountStr));
  }

  function exchangeDelta(d) {
    return sub(parseOrZero(d.exchangeInStr), parseOrZero(d.exchangeOutStr));
  }

  const { otherLineFromLine, resolveOtherLine, addOtherLine, removeOtherLine, updateOtherLine, otherLineCandidates, selectMatchForOtherLine } = useOtherLines(
    account, accounts, draft, setDraft,
    (d) => {
      const delta = draftDelta(d);
      return !isZero(delta) ? { isOut: isPositive(delta), amountStr: abs(delta) } : null;
    }
  );
```

- [ ] **Step 8: The rest of `AccountLedger.jsx`**
  - `draftHint`: `if (!draft || isZero(draftDelta(draft))) return null;`
  - `matchParams`: `if (isZero(delta) || !draft.date) return null;`, `let targetAmount = neg(delta);`, and `targetAmount = neg(exchangeDelta(draft));`
  - `rows` memo: `let running = account.openingBalance ?? "0";` and `running = add(running, line.amount ?? "0");`
  - `buildDraftFromRecord`:

```js
      inAmountStr: isPositive(line.amount) ? line.amount : "",
      outAmountStr: isNegative(line.amount) ? neg(line.amount) : "",
      exchangeChecked: line.exchangeAmount !== undefined,
      exchangeOutStr: isNegative(line.exchangeAmount) ? neg(line.exchangeAmount) : "",
      exchangeInStr: isPositive(line.exchangeAmount) ? line.exchangeAmount : "",
```

  - `commit()`: change `if (delta === 0)` to `if (isZero(delta))`. Right after the existing `offender` block (before `absorbedLineIds`), add:

```js
    const precisionMsg = precisionError(newLines, accounts);
    if (precisionMsg) {
      setDraftError(precisionMsg);
      return false;
    }
```

  - Header balance: `color: isNegative(balance) ? C.debit : C.ink`
  - Opening-balance row: `{loaded && isNonZero(account.openingBalance) && (`. For its three cells, use `isNegative(account.openingBalance) ? fmtPlain(neg(account.openingBalance), account.currency) : "—"`, then `isPositive(account.openingBalance) ? fmtPlain(account.openingBalance, account.currency) : "—"`, and leave the third cell unchanged.
  - Row values: `const out = isNegative(r.line.amount) ? neg(r.line.amount) : null;` and `const inn = isPositive(r.line.amount) ? r.line.amount : null;`
  - Both `color: r.running < 0 ? …` become `color: isNegative(r.running) ? …`
  - Run `grep -n "< 0\|> 0\|=== 0\|!== 0\|Math\.\|isNaN" src/components/AccountLedger.jsx` and check every remaining hit is about lengths, indices or pixels, not amounts.

- [ ] **Step 9: `AccountFormModal.jsx`**
  1. Replace the scale import with `import { parseDecimal } from "../lib/decimal";`.
  2. Delete `openingScale` and its comment block. Move the part of the comment about the value round-tripping unchanged for investment accounts onto the `opening` state line.
  3. Change the `opening` state to `useState(initial.openingBalance ?? "0")`.
  4. In the save payload, use `openingBalance: parseDecimal(opening) ?? "0",`.

- [ ] **Step 10: Build**

Run: `yarn build`
Expected: the only failures left come from files converted in Tasks 8–9 (for example `StockLedger.jsx` still passing extra arguments or importing `../lib/scale`).

- [ ] **Step 11: Commit**

```bash
git add src/components/otherLines.jsx src/components/AccountLedger.jsx src/components/AccountFormModal.jsx
git commit -m "Convert the cash ledger, split legs and account form to decimal strings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `StockLedger.jsx`

**Files:**
- Modify: `src/components/StockLedger.jsx`

**Interfaces:**
- Consumes: `decimal.js`, `precisionError`, the new `useOtherLines` signature (Task 7), and the `stockMath` state shape with `cashPlaces` (Task 6).

- [ ] **Step 1: Imports.** Replace `import { toMinorUnits, fromMinorUnits, divRoundHalfUp } from "../lib/scale";` with:

```js
import { parseDecimal, parseOrZero, add, sub, neg, abs, isZero, isNegative, isPositive, isNonZero, divide, round } from "../lib/decimal";
```

Add `precisionError` to the `../lib/format` import. Keep `unitScale`/`cashScale`: they're still needed for `step` attributes and `cashPlaces`.

- [ ] **Step 2: The delta helpers and `useOtherLines` call**

```js
  function unitsDeltaOf(d) {
    return sub(parseOrZero(d.unitsInStr), parseOrZero(d.unitsOutStr));
  }
  // (keep the existing comment about the cash side's sign)
  function cashDeltaOf(d) {
    const mag = parseDecimal(d.valueStr);
    if (mag === null) return "0";
    const delta = unitsDeltaOf(d);
    if (isPositive(delta)) return neg(mag);
    if (isNegative(delta)) return mag;
    if (d.unitsInStr !== "") return neg(mag);
    if (d.unitsOutStr !== "") return mag;
    return "0";
  }

  const { otherLineFromLine, resolveOtherLine, addOtherLine, removeOtherLine, updateOtherLine, otherLineCandidates, selectMatchForOtherLine } = useOtherLines(
    account, accounts, draft, setDraft,
    (d) => {
      const natural = cashDeltaOf(d);
      return !isZero(natural) ? { isOut: isNegative(natural), amountStr: abs(natural) } : null;
    }
  );
```

- [ ] **Step 3: `draftLines` and `matchParams`**
  - In `draftLines`: `line1.cashValue = neg(cashNatural);`
  - In `matchParams`: `if (isZero(unitsDeltaOf(draft)) || !draft.date) return null;`

- [ ] **Step 4: The `rows` memo seeding and running totals**

```js
    let running = account.openingBalance ?? "0";
    // (keep the existing comment about seeding from the opening position)
    const openingUnits = account.openingBalance ?? "0";
    const openingCost = account.openingBalanceCashValue ?? "0";
    const costState = { units: openingUnits, cost: openingCost, cashPlaces: cashScale };
    const valueState = { units: openingUnits, lastCashValue: openingCost, lastUnits: openingUnits, value: isZero(openingUnits) ? "0" : openingCost, cashPlaces: cashScale };
    return sorted.map(({ record, line }) => {
      running = add(running, line.amount ?? "0");
```

The rest of the map body stays unchanged.

- [ ] **Step 5: The header figures**

```js
  const costBasis = rows.length ? rows[rows.length - 1].runningCost : account.openingBalanceCashValue ?? "0";
  const portfolioValue = rows.length ? rows[rows.length - 1].runningValue : account.openingBalanceCashValue ?? "0";
  // Cost per whole unit, rounded to the trading currency's scale — the
  // same result the old divRoundHalfUp(costBasis × 10^unitScale, balance)
  // produced on minor units.
  const avgCost = isPositive(balance) ? round(divide(costBasis, balance), cashScale) : null;
```

- [ ] **Step 6: `buildDraftFromRecord`**

```js
    const naturalCash = line.cashValue !== undefined ? neg(line.cashValue) : "0";
```

```js
      unitsInStr: isPositive(line.amount) ? line.amount : "",
      unitsOutStr: isNegative(line.amount) ? neg(line.amount) : "",
      valueStr: line.cashValue !== undefined ? abs(naturalCash) : "",
```

- [ ] **Step 7: `commit()`.** Change `if (unitsDeltaOf(draft) === 0)` to `if (isZero(unitsDeltaOf(draft)))`. After the `offender` block, add the same `precisionError` guard as in Task 7 Step 8.

- [ ] **Step 8: Display code**
  - Opening row condition: `{loaded && isNonZero(account.openingBalance) && (`
  - Its cells: `isNegative(account.openingBalance) ? fmtUnits(neg(account.openingBalance), …) : "—"` and `isPositive(account.openingBalance) ? fmtUnits(account.openingBalance, …) : "—"`
  - Cost/Worth line: `fmtPlain(account.openingBalanceCashValue ?? "0", tradingCurrency)` (both places)
  - Row values: `const unitsOut = isNegative(r.line.amount) ? neg(r.line.amount) : null;`, `const unitsIn = isPositive(r.line.amount) ? r.line.amount : null;`, and `const natural = r.line.cashValue !== undefined ? neg(r.line.cashValue) : null;`
  - Run `grep -n "< 0\|> 0\|=== 0\|!== 0\|Math\.\|isNaN\|10 \*\*" src/components/StockLedger.jsx`. Only `step={10 ** -…}` attributes and non-amount comparisons may remain.

- [ ] **Step 9: Build**

Run: `yarn build`
Expected: remaining failures only in files covered by Task 9, if any.

- [ ] **Step 10: Commit**

```bash
git add src/components/StockLedger.jsx
git commit -m "Convert the stock ledger to decimal strings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Display components, charts, ISA allowance, App

**Files:**
- Modify: `src/components/charts.jsx`, `AllowanceView.jsx`, `AccountRow.jsx`, `IsaParentView.jsx`, `Overview.jsx`, `SidebarGroupTree.jsx`, `TagsView.jsx`, `ui.jsx`, and `src/App.jsx`

**Interfaces:**
- Consumes: `decimal.js`, `format.js`'s `scaleForCurrency`, `subtotalsForItems`, and the stockMath opening shape `{units, cost, cashPlaces}`.

- [ ] **Step 1: `charts.jsx`**
  1. Add `import { toNumber, fromNumber } from "../lib/decimal";` and add `scaleForCurrency` to the `../lib/format` import.
  2. In all three series hooks (`useChartSeries`, `useCostBasisSeries`, `usePortfolioValueSeries`), change `current: p.value,` to `current: toNumber(p.value),` and `previousSeries[i].value : undefined` to `toNumber(previousSeries[i].value) : undefined`. These are the Recharts boundary.
  3. Change every `account.openingBalance || 0` to `account.openingBalance ?? "0"`.
  4. Change the stock chart's opening to:
     `const opening = { units: account.openingBalance ?? "0", cost: account.openingBalanceCashValue ?? "0", cashPlaces: scaleForCurrency(tradingCurrency) };`
     Declare it after `tradingCurrency`; move that `const` up if needed.
  5. Every formatter receives Recharts numbers. Replace `fmt(v, ` with `fmt(fromNumber(v), ` and `fmtUnits(v, ` with `fmtUnits(fromNumber(v), ` throughout the file: the YAxis `tickFormatter`s, the `ChartTooltip` `formatValue` lambdas, and the stock tooltip's `row(…)` lambdas.

- [ ] **Step 2: `AllowanceView.jsx`**
  1. Replace `import { toMinorUnits } from "../lib/scale";` with `import { mul, divide, cmp, isZero, toNumber } from "../lib/decimal";`.
  2. Delete the `gbpScale`/`toPence` lines and their comment. Replace it with one line saying the caps in `lib/isa.js` are decimal strings in pounds, the same unit the API's usage figures now use.
  3. Change both `{ byKind: {}, total: 0 }` to `{ byKind: {}, total: "0" }`.
  4. Replace the `pct` line in `Bar` with:

```js
    // A CSS width is a renderer boundary — the one place this becomes a Number.
    const pct = cap ? Math.min(100, toNumber(divide(mul(used, "100"), cap))) : 0;
```

  5. In the Overall row, remove every `toPence(...)` wrapper: `fmt(rules.total, "GBP")`, `cap={rules.total}`, `color={cmp(usage.total, rules.total) > 0 ? C.debit : C.gold}`.
  6. In the kinds loop:

```js
          const used = usage.byKind[k.key] ?? "0";
          const cap = rules.subCaps[k.key];
          const holders = productsByKind[k.key] || [];
          if (isZero(used) && holders.length === 0) return null;
```

  and `color={cmp(used, cap) > 0 ? C.debit : C.goldDim}`.

- [ ] **Step 3: `ui.jsx`'s `ImbalanceBadge`.** Add `import { isPositive } from "../lib/decimal";`. Change `account.imbalanceOut > 0` to `isPositive(account.imbalanceOut)`, and the same for `imbalanceIn`.

- [ ] **Step 4: `AccountRow.jsx`.** Add `import { isPositive, isNegative } from "../lib/decimal";`. Change `a.imbalanceOut > 0` to `isPositive(a.imbalanceOut)` (and the same for `imbalanceIn`), `a.balance || 0` to `a.balance ?? "0"` (all three), `a.portfolioValue || 0` to `a.portfolioValue ?? "0"`, and `(a.balance || 0) < 0` to `isNegative(a.balance)`.

- [ ] **Step 5: `SidebarGroupTree.jsx`.** Add the same import. Change `a.imbalanceOut > 0` to `isPositive(a.imbalanceOut)` (and the same for `imbalanceIn`), and `(a.balance || 0) < 0` to `isNegative(a.balance)`.

- [ ] **Step 6: `IsaParentView.jsx`.** Add `import { isNegative } from "../lib/decimal";`. Change `(a.balance || 0) < 0` to `isNegative(a.balance)`, `a.balance || 0` to `a.balance ?? "0"`, and `a.portfolioValue || 0` to `a.portfolioValue ?? "0"`.

- [ ] **Step 7: `TagsView.jsx`.** Add `import { isNegative } from "../lib/decimal";`. Change `t.amount < 0` to `isNegative(t.amount)`, and `l.line.amount < 0` to `isNegative(l.line.amount)`.

- [ ] **Step 8: `Overview.jsx`.** Add `subtotalsForItems` to the `../lib/grouping` import. Replace the two `totalsByCurrency` lines with:

```js
  const totalsByCurrency = subtotalsForItems(accounts);
```

- [ ] **Step 9: `App.jsx`.** In `accountDisplay`, change `const bal = a.balance || 0;` to `const bal = a.balance ?? "0";` and `a.portfolioValue || 0` to `a.portfolioValue ?? "0"`. Change both `balance={selected.balance || 0}` to `balance={selected.balance ?? "0"}`.

- [ ] **Step 10: Sweep for leftovers**

Run: `grep -rnE "\|\| 0\)|\|\| 0\b|toMinorUnits|fromMinorUnits|divRoundHalfUp" src --include='*.js' --include='*.jsx'`

Expected: no amount-related hits outside `src/lib/scale.js`. Non-amount `|| 0` hits (counts, `line.order`, pixels) are fine. Check each one.

- [ ] **Step 11: Build**

Run: `yarn build`
Expected: SUCCESS. If something still imports `../lib/scale`, fix it here.

- [ ] **Step 12: Commit**

```bash
git add src
git commit -m "Convert display components, charts and ISA allowance to decimal strings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Remove `scale.js`, update CLAUDE.md, verify in the browser

**Files:**
- Delete: `src/lib/scale.js`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Delete `src/lib/scale.js`, then run** `yarn test && yarn build`. Expected: both pass.

- [ ] **Step 2: Update `CLAUDE.md`.** Scope: phase 1 only. Say plainly that storage is still integer until phase 2.
  - In "Amounts, currencies, and reference data", replace the paragraph saying scaled integers cross the API boundary. Amounts are now canonical decimal strings on the wire and in the frontend, while the database still stores scaled integers; `backend/src/Money/` (`ScaledAmount`, `ScaleRegistry`, `WireAmounts`) converts at the controller boundary only; services still speak integers; this is phase 1 of `docs/superpowers/specs/2026-09-27-arbitrary-precision-decimals-design.md`.
  - Replace the `src/lib/scale.js` bullet with a `src/lib/decimal.js` bullet: the four rules from the spec's "Rules" section, plus `parseDecimal`/`parseOrZero` replacing `toMinorUnits`, and "never hold a big.js object outside decimal.js".
  - `divRoundHalfUp` bullet: the JS copy is gone (`divide()` + `round()` replaced it); the PHP copy remains until phase 2.
  - The `fmt`/`fmtUnits` bullet: they take strings; `precisionError()` is a phase-1-only guard.
  - The `useOtherLines` signature in "Matching and linking": drop `currencies, symbols`, and drop the sentence saying they're needed for scale-aware parsing.
  - The file list at the top: `scale.js` → `decimal.js`, and mention the Vitest suite (`yarn test`). Also update "no test suite … on the frontend" in Commands.
  - Commands: add `yarn test`, and the `LEDGER_API` override for `yarn dev`.

- [ ] **Step 3: Start the frontend against the worktree backend and open it**

Add a launch entry `ledger-dev-worktree` to the worktree's `.claude/launch.json`: `"runtimeExecutable": "env"`, `"runtimeArgs": ["LEDGER_API=http://127.0.0.1:8001", "npm", "run", "dev"]`, `"port": 5173`. Then start it with `preview_start` using that name. If :5173 is taken by the user's own dev server, use `"runtimeArgs": ["LEDGER_API=http://127.0.0.1:8001", "npm", "run", "dev", "--", "--port", "5174"]` and `"port": 5174`.

- [ ] **Step 4: Browser checks** (worktree database copy only). Record each result, and check `read_console_messages` for errors after each one:
  1. The sidebar and Overview show balances, per-currency subtotals and imbalance badges identical to before (compare a few against `baseline/accounts.json`, converted by hand).
  2. **Plain edit:** open a cash row, change `12.34` to `12.35`, save. The row and running balance update, and the sidebar balance moves by 0.01.
  3. **Precision guard:** type `1.234` in a GBP row, save. The inline error names the account and the edit stays open.
  4. **Two-way cash↔stock match (mirrored):** add a new cash line whose Out equals an unmatched stock buy's value. The candidate appears; select it and save.
  5. **Split leg finding a stock trade (direct):** add a split leg with the natural amount of a stock trade. The candidate appears.
  6. Unlink a linked row (both sides survive as standalone lines), then reorder two same-date rows.
  7. **FX:** a line with an exchange tag shows the implied-rate hint.
  8. **Stock ledger:** units, the running Cost/Worth line, the header's avg cost and cost basis all render; the header cost basis equals the sidebar's.
  9. **ISA allowance view:** figures and bars render.
  10. **Charts:** open balance and stock charts; tooltips and axes show formatted amounts, not `NaN` or `£0.00` everywhere.
  11. Take a screenshot of the stock ledger and of the cash ledger as proof.

- [ ] **Step 5: Re-run the snapshot comparison.** The browser edits changed the data, so first restore a fresh copy of the database:

```bash
(cd backend && symfony server:stop)
cp "$MAIN/backend/databases/2025-2026.sqlite3" backend/databases/
(cd backend && symfony server:start -d --port=8001)
node backend/var/phase1-verify/capture.mjs http://127.0.0.1:8001 backend/var/phase1-verify/final
node backend/var/phase1-verify/compare.mjs backend/var/phase1-verify/baseline backend/var/phase1-verify/final
```

Expected: `All N files match`.

- [ ] **Step 6: Run the full suites one more time**

Run: `yarn test && yarn build && (cd backend && php bin/phpunit)`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src CLAUDE.md
git commit -m "Remove scale.js; document the phase 1 decimal wire format

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Stop the worktree backend** (`cd backend && symfony server:stop`), then hand off to superpowers:finishing-a-development-branch.
