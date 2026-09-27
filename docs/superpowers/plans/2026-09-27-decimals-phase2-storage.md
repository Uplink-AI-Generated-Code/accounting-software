# Decimal Amounts — Phase 2 (Storage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SQLite stores every amount as an exact canonical decimal string, and all backend arithmetic is exact decimal math. Phase 1's integer↔string shim and the precision limits it enforced are removed.

**Architecture:**
- **Storage:** five amount columns become `TEXT`, mapped by a custom Doctrine type (`decimal_text`) that refuses non-canonical writes. A migration rebuilds `account` and `line` and converts each stored integer with its own currency's or symbol's scale.
- **Backend math:** a static `App\Money\Decimal` helper over PHP 8.5's `BcMath\Number` mirrors `src/lib/decimal.js`, and the two are pinned together by the shared fixture.
- **Controllers:** they stop converting; services now produce and consume strings directly.
- **Legacy imports:** integer-amount JSON exports are upgraded by a small `LegacyIntegerAmounts` helper.
- **Frontend:** the phase-1 precision guards come out, and `stockMath.js` moves to 20-decimal-place division with no per-step rounding, matching the backend.

**Tech Stack:** PHP 8.5 (`BcMath\Number`, `RoundingMode::HalfAwayFromZero`), Symfony 8, Doctrine DBAL 4.4 / ORM 3.6, SQLite, PHPUnit; React 18 + Vite 5, big.js 7, Vitest 2.

**Spec:** `docs/superpowers/specs/2026-09-27-arbitrary-precision-decimals-design.md` (the "Decimal core" and "Phase 2" sections). Phase 1 is already on `main` (see `docs/superpowers/plans/2026-09-27-decimals-phase1-wire-format.md`).

## Global Constraints

- **Canonical form:** `^-?(0|[1-9]\d*)(\.\d*[1-9])?$`, with `"-0"` forbidden. No `+`, no leading zeros, no trailing fractional zeros; zero is `"0"`. String equality is numeric equality.
- **"Half-up" rounding** means *round half away from zero* throughout: `RoundingMode::HalfAwayFromZero` (PHP) and `Big.roundHalfUp` (JS).
- **Division:** `Decimal::divide()` / `divide()` work at 20 decimal places and return `"0"` for a zero divisor. They are the **only** division of amounts on each side.
- **Never use Doctrine's `decimal` type.** On SQLite it becomes `NUMERIC(p,s)`, and `NUMERIC` affinity silently turns `"20.50"` into a float. Amount columns must have `TEXT` affinity.
- **Amounts in PHP are canonical strings** outside `App\Money\Decimal`. Code may use `BcMath\Number` internally, but anything assigned to an entity, returned from a service, or put into JSON is a canonical string. PHP's `abs()`, `array_sum()`, `+=` on strings, and `(int)` casts are forbidden on amounts.
- **API wire format is unchanged from phase 1:** amounts are JSON strings, and `entryCount`/`imbalancedLineCount` are numbers. For phase 2 only, `costBasis`/`portfolioValue` are rounded to the trading currency's scale before being sent. Phase 3 replaces this with adaptive precision.
- **No precision limit on input** anywhere once this plan lands. `scale` no longer affects storage or validation.
- **Stock valuation, cost basis and value:** both walks (PHP `LedgerStateService`, JS `stockMath.js`) divide at 20 dp with **no per-step rounding**. Only the API output (backend) and display (`fmt`) round. *Numeric-behaviour note:* phase 1 rounded each sale's removed cost to minor units, so for a sale whose average-cost division isn't exact, the displayed cost basis may differ by ±1 minor unit from phase 1. None of the real databases contain stock trades (verified), so the snapshot comparison stays exact.
- **Never touch the user's live databases.** All verification runs in a worktree whose `backend/databases/` holds **copies**. Migrating the live files is a separate, user-run step after merge (Task 7 documents it).
- **Migration rules from CLAUDE.md:** a migration containing `DROP TABLE` must declare `isTransactional(): false` and wrap the rebuild in `PRAGMA foreign_keys = OFF` … `PRAGMA foreign_key_check` … `PRAGMA foreign_keys = ON`, all via `$this->addSql()`. Verify it empirically on copies by running the real `doctrine:migrations:migrate` and comparing row counts.
- Commit after every task. The `Co-Authored-By:` trailer names the model that actually wrote the commit (a standing ruling from phase 1).

## Execution notes

- Task 4 is the one large, atomic switch: once the entity types change, every consumer must change in the same commit for the suite to be green. Use the most capable model for it.
- `backend/var/` is gitignored. The verification scripts under `backend/var/phase2-verify/` are throwaway and never committed.
- The frontend works against the Task 4 backend unchanged, since the wire format is identical. Task 6 only removes phase-1-only code and changes stock math.

## File Structure

**Create:**
- `backend/src/Money/Decimal.php` — decimal core (PHP), mirroring `src/lib/decimal.js`.
- `backend/src/Doctrine/DecimalTextType.php` — Doctrine type `decimal_text` (SQL `TEXT`, canonical-only writes).
- `backend/src/Money/LegacyIntegerAmounts.php` — upgrades integer amounts in old JSON exports to decimal strings (used by import only).
- `backend/migrations/Version20260927120000.php` — rebuilds amount columns as `TEXT` and converts the data.
- `backend/tests/Money/DecimalTest.php`, `backend/tests/Doctrine/DecimalTextTypeTest.php`, `backend/tests/Money/LegacyIntegerAmountsTest.php`, `backend/tests/Service/LedgerStateServiceAmountsTest.php`
- `backend/var/phase2-verify/{capture.mjs,compare.mjs}` — throwaway.

**Modify:**
- `backend/config/packages/doctrine.yaml` — register `decimal_text`.
- Entities: `backend/src/Entity/Line.php`, `Account.php`.
- Services: `LedgerStateService.php`, `IsaAllowanceService.php`, `MatchingService.php`, `TagService.php`, `NewYearService.php`
- Commands: `NewYearCommand.php`, `ImportLocalStorageCommand.php`
- Controllers: `AccountController`, `LedgerController`, `MatchController`, `TagController`, `IsaAllowanceController`, `CurrencyController`, `SymbolController`
- `backend/src/Money/ScaledAmount.php` — `fromDecimal()` removed; `toDecimal()` stays for `LegacyIntegerAmounts`.
- `backend/tests/Money/ScaledAmountTest.php`, `backend/tests/Service/IsaAllowanceServiceTest.php`
- Frontend: `src/lib/format.js`, `format.test.js`, `stockMath.js`; `src/components/AccountLedger.jsx`, `StockLedger.jsx`, `AccountFormModal.jsx`, `otherLines.jsx`, `useMatchCandidates.js`, `charts.jsx`, `ReferenceDataView.jsx`
- `CLAUDE.md`

**Delete:** `backend/src/Money/WireAmounts.php`, `backend/src/Money/ScaleRegistry.php`, `backend/tests/Money/WireAmountsTest.php`, `backend/tests/Service/LedgerStateServiceRescaleTest.php`

---

### Task 0: Workspace, database copies, stock test data, baseline snapshots

**Files:**
- Create: `backend/var/phase2-verify/capture.mjs` (never committed)

**Interfaces:**
- Produces:
  - `backend/var/phase2-verify/baseline-2025/` and `baseline-2024/` — phase 1 API output that Task 5 compares against byte-for-byte.
  - A backend on :8001 serving the worktree's database copies.

- [ ] **Step 1: Create the worktree** `.claude/worktrees/decimals-phase2` on a new branch `decimals-phase2` from local `main` (per superpowers:using-git-worktrees). `main` may be ahead of `origin`, so branch from local `main`, not `origin/main`.

- [ ] **Step 2: Database copies only** (`$MAIN` = `/Users/radu/Code/Claude/ledger-project`, read-only):

```bash
mkdir -p backend/databases
cp "$MAIN/backend/databases/2025-2026.sqlite3" "$MAIN/backend/databases/2024-2025.sqlite3" backend/databases/
printf "activeDatabase: 2024-2025.sqlite3\ngroupLevels: []\n" > backend/databases/app-settings.yaml
yarn install
(cd backend && composer install && php bin/console doctrine:migrations:migrate --env=test --no-interaction)
(cd backend && symfony server:start -d --port=8001)
```

- [ ] **Step 3: Add stock test data to the 2024-25 copy** through the phase 1 API. Real data has no stock trades, and phase 2 changes stock math, so this is the fixture that proves it:

```bash
B=http://127.0.0.1:8001; H='Content-Type: application/json'
curl -s -X POST $B/api/symbols -H "$H" -d '{"ticker":"TEST","tradingCurrency":"GBP","scale":4,"name":"Test Co"}'
curl -s -X PUT $B/api/accounts/tp1 -H "$H" -d '{"name":"Test Wrapper","type":"investment-parent"}'
curl -s -X PUT $B/api/accounts/ti1 -H "$H" -d '{"name":"Test Stock","type":"investment","symbolTicker":"TEST","symbolCurrency":"GBP","parentId":"tp1"}'
curl -s -X POST $B/api/ledger/batch -H "$H" -d '{"operations":[{"op":"upsertLine","line":{"accountId":"ti1","amount":"3","date":"2024-06-01","description":"Buy","cashValue":"100","cashCurrency":"GBP"}},{"op":"upsertLine","line":{"accountId":"ti1","amount":"-1","date":"2024-07-01","description":"Sell","cashValue":"-40","cashCurrency":"GBP"}}]}'
```

Expected: the last call prints `{"ok":true}`.

- [ ] **Step 4: Write the capture script** at `backend/var/phase2-verify/capture.mjs`:

```js
// Usage: node capture.mjs <baseUrl> <outDir>
// Captures every API response carrying an amount. Phase 2 must reproduce
// phase 1's output byte-for-byte (compare.mjs). Throwaway; under var/.
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
save("match-buy", await get("/api/match-candidates?currency=GBP&amount=-100&date=2024-06-01&mode=mirrored"));
console.log(`Captured ${accounts.length} accounts into ${outDir}`);
```

- [ ] **Step 5: Capture both baselines.** The backend re-reads `app-settings.yaml` on every request, so switching the file switches the database:

```bash
node backend/var/phase2-verify/capture.mjs http://127.0.0.1:8001 backend/var/phase2-verify/baseline-2024
printf "activeDatabase: 2025-2026.sqlite3\ngroupLevels: []\n" > backend/databases/app-settings.yaml
node backend/var/phase2-verify/capture.mjs http://127.0.0.1:8001 backend/var/phase2-verify/baseline-2025
grep -c '"costBasis": "66.67"' backend/var/phase2-verify/baseline-2024/accounts.json
```

Expected: both captures print an account count greater than 0, and the grep prints `1`.

- [ ] **Step 6:** Nothing to commit.

---

### Task 1: `App\Money\Decimal` — the PHP decimal core

**Files:**
- Create: `backend/src/Money/Decimal.php`, `backend/tests/Money/DecimalTest.php`

**Interfaces:**
- Produces (all static on `App\Money\Decimal`; "str" = canonical decimal string):
  - Constants: `DIVISION_PLACES = 20`
  - Parsing:
    - `parse(string $input): ?string` — lenient user/JSON input → canonical, or `null`
    - `canonical(string|int $x): string` — throws `\InvalidArgumentException`
    - `isCanonical(string $x): bool`
  - Arithmetic: `add`, `sub`, `mul`, `neg`, `abs`, `min`, `max` → str; `sum(iterable $xs): string`
  - Division and rounding: `divide(string $a, string $b): string`, `round(string $x, int $places): string`
  - Comparison: `cmp(string $a, string $b): int` (−1/0/1), `sign(string $x): int`, `isZero(string $x): bool`
  - `fractionDigits(string $x): int`
- Consumes: `tests/fixtures/decimal-cases.json` at the repo root (created in phase 1).

- [ ] **Step 1: Write the failing test** at `backend/tests/Money/DecimalTest.php`:

```php
<?php

namespace App\Tests\Money;

use App\Money\Decimal;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class DecimalTest extends TestCase
{
    /** @return array<string, mixed> */
    private static function fixture(): array
    {
        return json_decode((string) file_get_contents(\dirname(__DIR__, 3).'/tests/fixtures/decimal-cases.json'), true, flags: \JSON_THROW_ON_ERROR);
    }

    public static function canonicalCases(): iterable
    {
        foreach (self::fixture()['canonical'] as [$in, $out]) {
            yield $in => [$in, $out];
        }
    }

    #[DataProvider('canonicalCases')]
    public function testCanonicalMatchesSharedFixture(string $in, string $out): void
    {
        self::assertSame($out, Decimal::canonical($in));
        self::assertTrue(Decimal::isCanonical($out));
    }

    public static function invalidCases(): iterable
    {
        foreach (self::fixture()['invalid'] as $in) {
            yield json_encode($in) => [$in];
        }
    }

    #[DataProvider('invalidCases')]
    public function testInvalidMatchesSharedFixture(string $in): void
    {
        self::assertNull(Decimal::parse($in));
        $this->expectException(\InvalidArgumentException::class);
        Decimal::canonical($in);
    }

    public static function divideCases(): iterable
    {
        foreach (self::fixture()['divide'] as [$a, $b, $out]) {
            yield "$a / $b" => [$a, $b, $out];
        }
    }

    #[DataProvider('divideCases')]
    public function testDivideMatchesSharedFixture(string $a, string $b, string $out): void
    {
        self::assertSame($out, Decimal::divide($a, $b));
    }

    public static function roundCases(): iterable
    {
        foreach (self::fixture()['round'] as [$x, $places, $out]) {
            yield "$x @ $places" => [$x, $places, $out];
        }
    }

    #[DataProvider('roundCases')]
    public function testRoundMatchesSharedFixture(string $x, int $places, string $out): void
    {
        self::assertSame($out, Decimal::round($x, $places));
    }

    public function testArithmeticIsExactAndCanonical(): void
    {
        self::assertSame('0.3', Decimal::add('0.1', '0.2'));
        self::assertSame('9007199254740994', Decimal::add('9007199254740993', '1'));
        self::assertSame('0', Decimal::sub('1.5', '1.5'));
        self::assertSame('-3', Decimal::mul('1.5', '-2'));
        self::assertSame('0', Decimal::neg('0'));
        self::assertSame('2.5', Decimal::abs('-2.5'));
        self::assertSame('2.99', Decimal::min('3', '2.99'));
        self::assertSame('3', Decimal::max('3', '2.99'));
        self::assertSame('3', Decimal::sum(['1.1', '2.2', '-0.3']));
        self::assertSame('0', Decimal::sum([]));
    }

    public function testComparisons(): void
    {
        self::assertSame(-1, Decimal::cmp('2', '10'));
        self::assertSame(0, Decimal::cmp('-1', '-1'));
        self::assertSame(-1, Decimal::sign('-0.01'));
        self::assertTrue(Decimal::isZero('0'));
        self::assertSame(3, Decimal::fractionDigits('-0.125'));
        self::assertSame(0, Decimal::fractionDigits('12'));
    }

    public function testCanonicalAcceptsIntsAndRejectsNonCanonicalInIsCanonical(): void
    {
        self::assertSame('-42', Decimal::canonical(-42));
        self::assertFalse(Decimal::isCanonical('20.50'));
        self::assertFalse(Decimal::isCanonical('-0'));
        self::assertFalse(Decimal::isCanonical('+1'));
        self::assertFalse(Decimal::isCanonical('01'));
    }
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd backend && php bin/phpunit tests/Money/DecimalTest.php`
Expected: FAIL with `Class "App\Money\Decimal" not found`.

- [ ] **Step 3: Implement** `backend/src/Money/Decimal.php`:

```php
<?php

namespace App\Money;

use BcMath\Number;

/**
 * The backend's decimal core — mirrors src/lib/decimal.js function for
 * function, and both are pinned to tests/fixtures/decimal-cases.json.
 * Every public method takes and returns *canonical* decimal strings (no
 * "+", no leading zeros, no trailing fractional zeros, never "-0"), so
 * string equality is numeric equality. BcMath\Number does the arithmetic;
 * it never escapes this class — its own string form keeps trailing zeros
 * ("41.0"), which is exactly why callers get canonical strings instead.
 */
final class Decimal
{
    public const DIVISION_PLACES = 20;

    private const CANONICAL_RE = '/^-?(0|[1-9]\d*)(\.\d*[1-9])?$/';

    /** Lenient input (user or JSON text) → canonical, or null if it isn't a plain decimal. */
    public static function parse(string $input): ?string
    {
        $s = trim($input);
        if (!preg_match('/^([+-]?)(\d*)(?:\.(\d*))?$/', $s, $m) || ('' === $m[2] && '' === ($m[3] ?? ''))) {
            return null;
        }
        $int = ltrim($m[2], '0');
        $frac = rtrim($m[3] ?? '', '0');
        $body = ('' === $int ? '0' : $int).('' !== $frac ? '.'.$frac : '');

        return ('-' === $m[1] && '0' !== $body) ? '-'.$body : $body;
    }

    public static function canonical(string|int $x): string
    {
        if (\is_int($x)) {
            return (string) $x;
        }
        $c = self::parse($x);
        if (null === $c) {
            throw new \InvalidArgumentException(sprintf('"%s" is not a decimal amount.', $x));
        }

        return $c;
    }

    public static function isCanonical(string $x): bool
    {
        return '-0' !== $x && 1 === preg_match(self::CANONICAL_RE, $x);
    }

    public static function add(string $a, string $b): string
    {
        return self::out(new Number($a) + new Number($b));
    }

    public static function sub(string $a, string $b): string
    {
        return self::out(new Number($a) - new Number($b));
    }

    public static function mul(string $a, string $b): string
    {
        return self::out(new Number($a) * new Number($b));
    }

    public static function neg(string $a): string
    {
        return self::out(-new Number($a));
    }

    public static function abs(string $a): string
    {
        return self::sign($a) < 0 ? self::neg($a) : $a;
    }

    public static function min(string $a, string $b): string
    {
        return self::cmp($a, $b) <= 0 ? $a : $b;
    }

    public static function max(string $a, string $b): string
    {
        return self::cmp($a, $b) >= 0 ? $a : $b;
    }

    /** @param iterable<string> $xs */
    public static function sum(iterable $xs): string
    {
        $total = '0';
        foreach ($xs as $x) {
            $total = self::add($total, $x);
        }

        return $total;
    }

    /**
     * The ONLY division of amounts in the backend — keeping every division
     * behind this one method is what keeps a future switch to exact
     * fractions cheap (see the spec). 20 dp, half away from zero; a zero
     * divisor yields "0". Number::div() truncates, so divide one extra
     * place and round that away — truncation can't move a value across
     * the half-way point of the 20th place.
     */
    public static function divide(string $a, string $b): string
    {
        if (self::isZero($b)) {
            return '0';
        }

        return self::out((new Number($a))->div($b, self::DIVISION_PLACES + 1)->round(self::DIVISION_PLACES, \RoundingMode::HalfAwayFromZero));
    }

    public static function round(string $x, int $places): string
    {
        return self::out((new Number($x))->round($places, \RoundingMode::HalfAwayFromZero));
    }

    public static function cmp(string $a, string $b): int
    {
        return (new Number($a))->compare($b);
    }

    public static function sign(string $x): int
    {
        return self::cmp($x, '0');
    }

    public static function isZero(string $x): bool
    {
        return 0 === self::sign($x);
    }

    public static function fractionDigits(string $x): int
    {
        $i = strpos($x, '.');

        return false === $i ? 0 : \strlen($x) - $i - 1;
    }

    private static function out(Number $n): string
    {
        return self::parse((string) $n) ?? '0';
    }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd backend && php bin/phpunit tests/Money/DecimalTest.php`
Expected: PASS. If a fixture case fails, fix `Decimal.php`, never the fixture: the fixture is shared with the JS suite and is the spec.

- [ ] **Step 5: Commit** `backend/src/Money/Decimal.php` and `backend/tests/Money/DecimalTest.php` with the message "Add App\Money\Decimal, pinned to the shared decimal fixture".

---

### Task 2: `decimal_text` Doctrine type

**Files:**
- Create: `backend/src/Doctrine/DecimalTextType.php`, `backend/tests/Doctrine/DecimalTextTypeTest.php`
- Modify: `backend/config/packages/doctrine.yaml`

**Interfaces:**
- Consumes: `Decimal::isCanonical()` (Task 1).
- Produces: the Doctrine column type name `decimal_text` (constant `DecimalTextType::NAME`), registered and usable as `#[ORM\Column(type: 'decimal_text')]`.

- [ ] **Step 1: Write the failing test** at `backend/tests/Doctrine/DecimalTextTypeTest.php`:

```php
<?php

namespace App\Tests\Doctrine;

use App\Doctrine\DecimalTextType;
use Doctrine\DBAL\Platforms\SQLitePlatform;
use PHPUnit\Framework\TestCase;

class DecimalTextTypeTest extends TestCase
{
    private DecimalTextType $type;
    private SQLitePlatform $platform;

    protected function setUp(): void
    {
        $this->type = new DecimalTextType();
        $this->platform = new SQLitePlatform();
    }

    public function testDeclaresTextAffinityNotNumeric(): void
    {
        self::assertSame('TEXT', $this->type->getSQLDeclaration([], $this->platform));
    }

    public function testStoresCanonicalStringsVerbatim(): void
    {
        self::assertSame('20.5', $this->type->convertToDatabaseValue('20.5', $this->platform));
        self::assertNull($this->type->convertToDatabaseValue(null, $this->platform));
    }

    public function testRefusesNonCanonicalValues(): void
    {
        foreach (['20.50', '-0', 20.5, 2050, '1e3', ''] as $bad) {
            try {
                $this->type->convertToDatabaseValue($bad, $this->platform);
                self::fail('Expected rejection of '.var_export($bad, true));
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
            }
        }
    }

    public function testReadsBackAsString(): void
    {
        self::assertSame('7', $this->type->convertToPHPValue(7, $this->platform));
        self::assertSame('0.25', $this->type->convertToPHPValue('0.25', $this->platform));
        self::assertNull($this->type->convertToPHPValue(null, $this->platform));
    }
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd backend && php bin/phpunit tests/Doctrine/DecimalTextTypeTest.php`
Expected: FAIL with `Class "App\Doctrine\DecimalTextType" not found`.

- [ ] **Step 3: Implement** `backend/src/Doctrine/DecimalTextType.php`:

```php
<?php

namespace App\Doctrine;

use App\Money\Decimal;
use Doctrine\DBAL\Platforms\AbstractPlatform;
use Doctrine\DBAL\Types\Type;

/**
 * An exact decimal amount, stored as a canonical decimal string in a
 * TEXT column. Deliberately NOT Doctrine's `decimal` type: on SQLite that
 * becomes NUMERIC(p,s), whose NUMERIC affinity silently converts "20.50"
 * into a float — the exact drift this type exists to prevent. Refuses to
 * write anything but a canonical string (see App\Money\Decimal), so a
 * stray float or "20.50" can never reach storage.
 */
final class DecimalTextType extends Type
{
    public const NAME = 'decimal_text';

    public function getSQLDeclaration(array $column, AbstractPlatform $platform): string
    {
        return 'TEXT';
    }

    public function convertToDatabaseValue(mixed $value, AbstractPlatform $platform): ?string
    {
        if (null === $value) {
            return null;
        }
        if (!\is_string($value) || !Decimal::isCanonical($value)) {
            throw new \InvalidArgumentException(sprintf('Refusing to store non-canonical decimal amount %s.', var_export($value, true)));
        }

        return $value;
    }

    public function convertToPHPValue(mixed $value, AbstractPlatform $platform): ?string
    {
        return null === $value ? null : (string) $value;
    }
}
```

- [ ] **Step 4: Register the type** in `backend/config/packages/doctrine.yaml`, under `doctrine.dbal`, directly after the `url:` line:

```yaml
        types:
            decimal_text: App\Doctrine\DecimalTextType
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && php bin/phpunit tests/Doctrine/DecimalTextTypeTest.php && php bin/console debug:container --env=test >/dev/null && php bin/phpunit`
Expected: PASS, and the full suite is still green. The type is registered but not yet used.

- [ ] **Step 6: Commit** the type, the test and `doctrine.yaml` with the message "Add decimal_text Doctrine type (TEXT affinity, canonical-only writes)".

---

### Task 3: `LegacyIntegerAmounts` — upgrading old integer exports

**Files:**
- Create: `backend/src/Money/LegacyIntegerAmounts.php`, `backend/tests/Money/LegacyIntegerAmountsTest.php`

**Interfaces:**
- Consumes: `ScaledAmount::toDecimal(int $value, int $scale): string` (phase 1, unchanged).
- Produces: `LegacyIntegerAmounts::upgrade(array $accounts, array $records, array $currencyScales, array $symbolScales): array`
  - Returns `['accounts' => array, 'records' => array]`.
  - `$currencyScales` is `code => int`; `$symbolScales` is `"TICKER|CUR" => int`.
  - A JSON **int** in an amount field is treated as a legacy scaled integer and converted with its own scale. A **string** is left untouched (`writeState` validates it). A **float** throws `\InvalidArgumentException`: it's ambiguous.
  - A nonzero int whose scale can't be determined throws `\InvalidArgumentException`.

Field → scale mapping (the same as phase 1's):

| Field | Scale from |
|---|---|
| account `openingBalance` | the symbol for an investment account, else the account's currency |
| account `openingBalanceCashValue` | the account's `symbolCurrency` |
| line `amount` | its account, looked up by `accountId` in `$accounts` (symbol for investment, else currency) |
| line `cashValue` | `cashCurrency` |
| line `exchangeAmount` | `exchangeCurrency` |

- [ ] **Step 1: Write the failing test** at `backend/tests/Money/LegacyIntegerAmountsTest.php`:

```php
<?php

namespace App\Tests\Money;

use App\Money\LegacyIntegerAmounts;
use PHPUnit\Framework\TestCase;

class LegacyIntegerAmountsTest extends TestCase
{
    private const CURRENCIES = ['GBP' => 2, 'USD' => 2, 'JPY' => 0];
    private const SYMBOLS = ['AAPL|USD' => 6];

    private static function accounts(): array
    {
        return [
            ['id' => 'cash', 'type' => 'asset', 'currency' => 'GBP', 'openingBalance' => 2050],
            ['id' => 'inv', 'type' => 'investment', 'symbolTicker' => 'AAPL', 'symbolCurrency' => 'USD', 'openingBalance' => 1500000, 'openingBalanceCashValue' => 12345],
            ['id' => 'wrap', 'type' => 'investment-parent'],
        ];
    }

    public function testConvertsIntegerAmountsWithTheirOwnScale(): void
    {
        $out = LegacyIntegerAmounts::upgrade(self::accounts(), [
            ['transactionId' => 't1', 'lines' => [
                ['accountId' => 'cash', 'amount' => -1000, 'exchangeAmount' => 1500, 'exchangeCurrency' => 'JPY'],
                ['accountId' => 'inv', 'amount' => 250000, 'cashValue' => 999, 'cashCurrency' => 'USD'],
            ]],
        ], self::CURRENCIES, self::SYMBOLS);

        self::assertSame('20.5', $out['accounts'][0]['openingBalance']);
        self::assertSame('1.5', $out['accounts'][1]['openingBalance']);
        self::assertSame('123.45', $out['accounts'][1]['openingBalanceCashValue']);
        self::assertArrayNotHasKey('openingBalance', $out['accounts'][2]);
        [$cashLine, $invLine] = $out['records'][0]['lines'];
        self::assertSame('-10', $cashLine['amount']);
        self::assertSame('1500', $cashLine['exchangeAmount']);
        self::assertSame('0.25', $invLine['amount']);
        self::assertSame('9.99', $invLine['cashValue']);
    }

    public function testLeavesDecimalStringsAlone(): void
    {
        $out = LegacyIntegerAmounts::upgrade(
            [['id' => 'cash', 'type' => 'asset', 'currency' => 'GBP', 'openingBalance' => '20.505']],
            [['transactionId' => null, 'lines' => [['accountId' => 'cash', 'amount' => '0.001']]]],
            self::CURRENCIES,
            self::SYMBOLS,
        );
        self::assertSame('20.505', $out['accounts'][0]['openingBalance']);
        self::assertSame('0.001', $out['records'][0]['lines'][0]['amount']);
    }

    public function testRejectsFloats(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        LegacyIntegerAmounts::upgrade([['id' => 'cash', 'type' => 'asset', 'currency' => 'GBP', 'openingBalance' => 20.5]], [], self::CURRENCIES, self::SYMBOLS);
    }

    public function testRejectsNonzeroIntegerWithUnknownScale(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        LegacyIntegerAmounts::upgrade([], [['transactionId' => null, 'lines' => [['accountId' => 'missing', 'amount' => 5]]]], self::CURRENCIES, self::SYMBOLS);
    }

    public function testZeroNeedsNoScale(): void
    {
        $out = LegacyIntegerAmounts::upgrade([['id' => 'wrap', 'type' => 'investment-parent', 'openingBalance' => 0]], [], self::CURRENCIES, self::SYMBOLS);
        self::assertSame('0', $out['accounts'][0]['openingBalance']);
    }
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd backend && php bin/phpunit tests/Money/LegacyIntegerAmountsTest.php`
Expected: FAIL with `Class "App\Money\LegacyIntegerAmounts" not found`.

- [ ] **Step 3: Implement** `backend/src/Money/LegacyIntegerAmounts.php`:

```php
<?php

namespace App\Money;

/**
 * Upgrades amounts in a JSON export written before phase 2 of the
 * decimal migration (docs/superpowers/specs/2026-09-27-arbitrary-
 * precision-decimals-design.md), when amounts were scaled integers
 * (2050 = £20.50 at GBP's scale of 2). A JSON integer is converted with
 * its own currency's/symbol's scale; a decimal string (the current
 * format) passes through untouched; a float is ambiguous and rejected.
 * Used only by app:import-local-storage — live API traffic always sends
 * decimal strings.
 */
final class LegacyIntegerAmounts
{
    /**
     * @param array<int, array<string, mixed>> $accounts
     * @param array<int, array<string, mixed>> $records
     * @param array<string, int>               $currencyScales code => scale
     * @param array<string, int>               $symbolScales   "TICKER|CUR" => scale
     *
     * @return array{accounts: array<int, array<string, mixed>>, records: array<int, array<string, mixed>>}
     */
    public static function upgrade(array $accounts, array $records, array $currencyScales, array $symbolScales): array
    {
        $byId = [];
        foreach ($accounts as $a) {
            $byId[(string) ($a['id'] ?? '')] = $a;
        }
        $amountScale = static function (?array $acc) use ($currencyScales, $symbolScales): ?int {
            if (null === $acc) {
                return null;
            }
            if ('investment' === ($acc['type'] ?? null)) {
                return $symbolScales[($acc['symbolTicker'] ?? '').'|'.($acc['symbolCurrency'] ?? '')] ?? null;
            }

            return isset($acc['currency']) ? ($currencyScales[$acc['currency']] ?? null) : null;
        };
        $currencyScale = static fn (mixed $code): ?int => \is_string($code) ? ($currencyScales[$code] ?? null) : null;

        $accounts = array_map(static function (array $a) use ($amountScale, $currencyScale) {
            $a = self::convertField($a, 'openingBalance', $amountScale($a), 'account '.($a['id'] ?? '?'));

            return self::convertField($a, 'openingBalanceCashValue', $currencyScale($a['symbolCurrency'] ?? null), 'account '.($a['id'] ?? '?'));
        }, $accounts);

        $records = array_map(static function (array $r) use ($byId, $amountScale, $currencyScale) {
            $r['lines'] = array_map(static function (array $l) use ($byId, $amountScale, $currencyScale) {
                $where = 'line on account '.($l['accountId'] ?? '?');
                $l = self::convertField($l, 'amount', $amountScale($byId[(string) ($l['accountId'] ?? '')] ?? null), $where);
                $l = self::convertField($l, 'cashValue', $currencyScale($l['cashCurrency'] ?? null), $where);

                return self::convertField($l, 'exchangeAmount', $currencyScale($l['exchangeCurrency'] ?? null), $where);
            }, $r['lines'] ?? []);

            return $r;
        }, $records);

        return ['accounts' => $accounts, 'records' => $records];
    }

    /** @param array<string, mixed> $row @return array<string, mixed> */
    private static function convertField(array $row, string $field, ?int $scale, string $where): array
    {
        if (!\array_key_exists($field, $row) || null === $row[$field] || \is_string($row[$field])) {
            return $row;
        }
        $v = $row[$field];
        if (\is_float($v)) {
            throw new \InvalidArgumentException(sprintf('%s: %s is a JSON float (%s) — ambiguous; export amounts as decimal strings or legacy scaled integers.', $where, $field, $v));
        }
        if (!\is_int($v)) {
            throw new \InvalidArgumentException(sprintf('%s: %s must be a decimal string.', $where, $field));
        }
        if (0 === $v) {
            $row[$field] = '0';

            return $row;
        }
        if (null === $scale) {
            throw new \InvalidArgumentException(sprintf('%s: can\'t determine the scale to upgrade legacy integer %s %d.', $where, $field, $v));
        }
        $row[$field] = ScaledAmount::toDecimal($v, $scale);

        return $row;
    }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd backend && php bin/phpunit tests/Money/LegacyIntegerAmountsTest.php && php bin/phpunit`
Expected: PASS, and the full suite is green.

- [ ] **Step 5: Commit** both files with the message "Add LegacyIntegerAmounts to upgrade pre-phase-2 integer exports".

---

### Task 4: The backend storage switch (atomic)

This task is one commit: the entity types, the migration and every consumer change together. The full suite is only expected to pass at Step 12.

**Files:**
- Create: `backend/migrations/Version20260927120000.php`, `backend/tests/Service/LedgerStateServiceAmountsTest.php`
- Modify:
  - Entities: `backend/src/Entity/Line.php`, `Account.php`
  - Services: `LedgerStateService.php`, `IsaAllowanceService.php`, `MatchingService.php`, `TagService.php`, `NewYearService.php`
  - Commands: `NewYearCommand.php`, `ImportLocalStorageCommand.php`
  - The seven controllers listed under File Structure
  - `backend/src/Money/ScaledAmount.php`, `backend/tests/Money/ScaledAmountTest.php`, `backend/tests/Service/IsaAllowanceServiceTest.php`
- Delete: `backend/src/Money/WireAmounts.php`, `ScaleRegistry.php`, `backend/tests/Money/WireAmountsTest.php`, `backend/tests/Service/LedgerStateServiceRescaleTest.php`

**Interfaces:**
- Consumes: `Decimal` (Task 1), `decimal_text` (Task 2), `LegacyIntegerAmounts::upgrade()` (Task 3).
- Produces:
  - Entity accessors typed `string` / `?string`:
    - `Line::getAmount(): string` / `setAmount(string)`, and `getCashValue()`, `getExchangeAmount()`: `?string`
    - `Account::getOpeningBalance()`, `getOpeningBalanceCashValue()`: `?string`
  - Every service returns canonical strings for amounts.
  - `IsaAllowanceService::computeUsage()` returns `array{byKind: array<string,string>, total: string}`.
  - `MatchingService::findCandidates(string $currency, string $targetAmount, ...)`.
  - `NewYearService::createNextYear()` returns `array{sourcePath: string, rows: array<int, array{0: array, 1: string, 2: ?string}>}`.
  - The API wire format is unchanged.

- [ ] **Step 1: Entities.** In `Line.php`:
  - `#[ORM\Column]` over `private int $amount;` becomes `#[ORM\Column(type: 'decimal_text')]` over `private string $amount;`.
  - The same for `cashValue` and `exchangeAmount` (`nullable: true`, `?string`).
  - Update their getters and setters to `string`/`?string`.

  In `Account.php`, do the same for `openingBalance` and `openingBalanceCashValue` (`#[ORM\Column(type: 'decimal_text', nullable: true)]`, `?string`). Update any docblock that says these are scaled integers: they're canonical decimal strings, see `App\Money\Decimal`.

- [ ] **Step 2: Write the migration** at `backend/migrations/Version20260927120000.php`. It is hand-written from the current schema (`sqlite3 <db> ".schema account" ".schema line"`), changing only the five columns' types. Step 13 proves it matches the entity mapping.

```php
<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Phase 2 of docs/superpowers/specs/2026-09-27-arbitrary-precision-
 * decimals-design.md: the five amount columns become TEXT holding
 * canonical decimal strings. Each stored integer is converted with its
 * own scale (line amount: the account's currency, or its Symbol's scale
 * for an investment account; cash_value/exchange_amount: their own
 * currency; account opening_balance: as line amount; opening_balance_
 * cash_value: the account's symbol_currency). Values are read in up()
 * — before any queued SQL runs — and written back as per-row UPDATEs
 * after the rebuild. Self-contained on purpose: no App\ classes, since
 * those evolve and a migration must not.
 *
 * DROP TABLE rebuilds ⇒ isTransactional() false and the foreign_keys
 * pragma bracket, all via addSql() — see CLAUDE.md's migration rules.
 */
final class Version20260927120000 extends AbstractMigration
{
    private const ACCOUNT_COLUMNS = 'id, name, type, currency, opening_balance, symbol_ticker, counterparty, isa_kind, parent_id, flexible, subtype, opening_balance_cash_value, symbol_currency';
    private const LINE_COLUMNS = 'id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id';

    public function getDescription(): string
    {
        return 'Amounts become exact decimal TEXT (canonical strings) instead of scaled integers — see docs/superpowers/specs/2026-09-27-arbitrary-precision-decimals-design.md';
    }

    public function isTransactional(): bool
    {
        return false;
    }

    public function up(Schema $schema): void
    {
        [$accountUpdates, $lineUpdates] = $this->convertedValues(static fn (mixed $v, ?int $scale, string $what): ?string => self::toDecimal($v, $scale, $what));

        $this->addSql('PRAGMA foreign_keys = OFF');
        $this->rebuildAccount('TEXT');
        $this->rebuildLine('TEXT');
        foreach ($accountUpdates as $u) {
            $this->addSql('UPDATE account SET opening_balance = ?, opening_balance_cash_value = ? WHERE id = ?', $u);
        }
        foreach ($lineUpdates as $u) {
            $this->addSql('UPDATE line SET amount = ?, cash_value = ?, exchange_amount = ? WHERE id = ?', $u);
        }
        $this->addSql('PRAGMA foreign_key_check');
        $this->addSql('PRAGMA foreign_keys = ON');
    }

    public function down(Schema $schema): void
    {
        [$accountUpdates, $lineUpdates] = $this->convertedValues(static fn (mixed $v, ?int $scale, string $what): ?int => self::toScaledInt($v, $scale, $what));

        $this->addSql('PRAGMA foreign_keys = OFF');
        $this->rebuildAccount('INTEGER');
        $this->rebuildLine('INTEGER');
        foreach ($accountUpdates as $u) {
            $this->addSql('UPDATE account SET opening_balance = ?, opening_balance_cash_value = ? WHERE id = ?', $u);
        }
        foreach ($lineUpdates as $u) {
            $this->addSql('UPDATE line SET amount = ?, cash_value = ?, exchange_amount = ? WHERE id = ?', $u);
        }
        $this->addSql('PRAGMA foreign_key_check');
        $this->addSql('PRAGMA foreign_keys = ON');
    }

    /**
     * Reads every amount with its governing scale and converts it with
     * $convert. Returns [accountUpdates, lineUpdates], each row being the
     * UPDATE's parameter list.
     *
     * @return array{0: array<int, array<int, mixed>>, 1: array<int, array<int, mixed>>}
     */
    private function convertedValues(callable $convert): array
    {
        $currencyScales = [];
        foreach ($this->connection->fetchAllAssociative('SELECT code, scale FROM currency') as $r) {
            $currencyScales[$r['code']] = (int) $r['scale'];
        }
        $symbolScales = [];
        foreach ($this->connection->fetchAllAssociative('SELECT ticker, trading_currency, scale FROM symbol') as $r) {
            $symbolScales[$r['ticker'].'|'.$r['trading_currency']] = (int) $r['scale'];
        }
        $currencyScale = static fn (?string $code): ?int => null === $code ? null : ($currencyScales[$code] ?? null);
        $accounts = [];
        foreach ($this->connection->fetchAllAssociative('SELECT id, type, currency, symbol_ticker, symbol_currency, opening_balance, opening_balance_cash_value FROM account') as $r) {
            $accounts[$r['id']] = $r;
        }
        $amountScale = static function (?array $acc) use ($symbolScales, $currencyScale): ?int {
            if (null === $acc) {
                return null;
            }
            if ('investment' === $acc['type']) {
                return $symbolScales[$acc['symbol_ticker'].'|'.$acc['symbol_currency']] ?? null;
            }

            return $currencyScale($acc['currency']);
        };

        $accountUpdates = [];
        foreach ($accounts as $acc) {
            if (null === $acc['opening_balance'] && null === $acc['opening_balance_cash_value']) {
                continue;
            }
            $accountUpdates[] = [
                $convert($acc['opening_balance'], $amountScale($acc), "account {$acc['id']} opening_balance"),
                $convert($acc['opening_balance_cash_value'], $currencyScale($acc['symbol_currency']), "account {$acc['id']} opening_balance_cash_value"),
                $acc['id'],
            ];
        }

        $lineUpdates = [];
        foreach ($this->connection->fetchAllAssociative('SELECT id, account_id, amount, cash_value, cash_currency, exchange_amount, exchange_currency FROM line') as $r) {
            $lineUpdates[] = [
                $convert($r['amount'], $amountScale($accounts[$r['account_id']] ?? null), "line {$r['id']} amount"),
                $convert($r['cash_value'], $currencyScale($r['cash_currency']), "line {$r['id']} cash_value"),
                $convert($r['exchange_amount'], $currencyScale($r['exchange_currency']), "line {$r['id']} exchange_amount"),
                (int) $r['id'],
            ];
        }

        return [$accountUpdates, $lineUpdates];
    }

    private function rebuildAccount(string $amountType): void
    {
        $this->addSql('CREATE TEMPORARY TABLE __temp__account AS SELECT '.self::ACCOUNT_COLUMNS.' FROM account');
        $this->addSql('DROP TABLE account');
        $this->addSql("CREATE TABLE account (id VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL, currency VARCHAR(8) DEFAULT NULL, opening_balance {$amountType} DEFAULT NULL, symbol_ticker VARCHAR(32) DEFAULT NULL, counterparty VARCHAR(255) DEFAULT NULL, isa_kind VARCHAR(32) DEFAULT NULL, parent_id VARCHAR(32) DEFAULT NULL, flexible BOOLEAN DEFAULT NULL, subtype VARCHAR(255) DEFAULT NULL, opening_balance_cash_value {$amountType} DEFAULT NULL, symbol_currency VARCHAR(8) DEFAULT NULL, PRIMARY KEY (id), CONSTRAINT FK_ACCOUNT_CURRENCY FOREIGN KEY (currency) REFERENCES currency (code) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_ACCOUNT_INSTITUTION FOREIGN KEY (counterparty) REFERENCES counterparty (name) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_7D3656A4727ACA70 FOREIGN KEY (parent_id) REFERENCES account (id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_7D3656A4E1F92935A015E871 FOREIGN KEY (symbol_ticker, symbol_currency) REFERENCES symbol (ticker, trading_currency) NOT DEFERRABLE INITIALLY IMMEDIATE, CHECK ((symbol_ticker IS NULL) = (symbol_currency IS NULL)))");
        $this->addSql('INSERT INTO account ('.self::ACCOUNT_COLUMNS.') SELECT '.self::ACCOUNT_COLUMNS.' FROM __temp__account');
        $this->addSql('DROP TABLE __temp__account');
        $this->addSql('CREATE INDEX IDX_7D3656A4727ACA70 ON account (parent_id)');
        $this->addSql('CREATE INDEX IDX_7D3656A46956883F ON account (currency)');
        $this->addSql('CREATE INDEX IDX_7D3656A49B3DE79C ON account (counterparty)');
        $this->addSql('CREATE INDEX IDX_7D3656A4E1F92935A015E871 ON account (symbol_ticker, symbol_currency)');
    }

    private function rebuildLine(string $amountType): void
    {
        $this->addSql('CREATE TEMPORARY TABLE __temp__line AS SELECT '.self::LINE_COLUMNS.' FROM line');
        $this->addSql('DROP TABLE line');
        $this->addSql("CREATE TABLE line (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, amount {$amountType} NOT NULL, date VARCHAR(10) NOT NULL, description VARCHAR(255) NOT NULL, line_order INTEGER DEFAULT NULL, cash_value {$amountType} DEFAULT NULL, cash_currency VARCHAR(8) DEFAULT NULL, exchange_amount {$amountType} DEFAULT NULL, exchange_currency VARCHAR(8) DEFAULT NULL, transaction_id VARCHAR(32) DEFAULT NULL, account_id VARCHAR(32) NOT NULL, CONSTRAINT FK_D114B4F62FC0CB0F FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_D114B4F69B6B5FBA FOREIGN KEY (account_id) REFERENCES account (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_LINE_CASH_CURRENCY FOREIGN KEY (cash_currency) REFERENCES currency (code) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_LINE_EXCHANGE_CURRENCY FOREIGN KEY (exchange_currency) REFERENCES currency (code) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE)");
        $this->addSql('INSERT INTO line ('.self::LINE_COLUMNS.') SELECT '.self::LINE_COLUMNS.' FROM __temp__line');
        $this->addSql('DROP TABLE __temp__line');
        $this->addSql('CREATE INDEX IDX_D114B4F62FC0CB0F ON line (transaction_id)');
        $this->addSql('CREATE INDEX IDX_D114B4F69B6B5FBA ON line (account_id)');
        $this->addSql('CREATE INDEX IDX_D114B4F6BD579F2 ON line (cash_currency)');
        $this->addSql('CREATE INDEX IDX_D114B4F6F3AEF15F ON line (exchange_currency)');
    }

    /** Scaled integer (as stored before this migration) → canonical decimal string. */
    private static function toDecimal(mixed $v, ?int $scale, string $what): ?string
    {
        if (null === $v) {
            return null;
        }
        if (!preg_match('/^-?\d+$/', (string) $v)) {
            throw new \RuntimeException(sprintf('%s: expected a stored integer, found "%s".', $what, $v));
        }
        $n = (int) $v;
        if (0 === $n) {
            return '0';
        }
        if (null === $scale) {
            throw new \RuntimeException(sprintf('%s: can\'t determine its scale (unknown currency/symbol) — fix the data before migrating.', $what));
        }
        $digits = str_pad((string) abs($n), $scale + 1, '0', \STR_PAD_LEFT);
        $whole = 0 === $scale ? $digits : substr($digits, 0, -$scale);
        $frac = 0 === $scale ? '' : rtrim(substr($digits, -$scale), '0');

        return ($n < 0 ? '-' : '').$whole.('' !== $frac ? '.'.$frac : '');
    }

    /** Canonical decimal string → scaled integer; refuses anything that wouldn't round-trip. */
    private static function toScaledInt(mixed $v, ?int $scale, string $what): ?int
    {
        if (null === $v) {
            return null;
        }
        if (!preg_match('/^(-?)(\d+)(?:\.(\d+))?$/', (string) $v, $m)) {
            throw new \RuntimeException(sprintf('%s: "%s" is not a decimal amount.', $what, $v));
        }
        $frac = rtrim($m[3] ?? '', '0');
        if ('' === ltrim($m[2].$frac, '0')) {
            return 0;
        }
        if (null === $scale) {
            throw new \RuntimeException(sprintf('%s: can\'t determine its scale.', $what));
        }
        if (\strlen($frac) > $scale) {
            throw new \RuntimeException(sprintf('%s: %s has more than %d decimal place(s) — can\'t go back to scaled integers without losing precision.', $what, $v, $scale));
        }
        $digits = ltrim($m[2].str_pad($frac, $scale, '0'), '0');
        if (\strlen($digits) > 18) {
            throw new \RuntimeException(sprintf('%s: %s is too large for a 64-bit scaled integer.', $what, $v));
        }

        return ('-' === $m[1] ? -1 : 1) * (int) $digits;
    }
}
```

- [ ] **Step 3: `ScaledAmount`.**
  - Delete `fromDecimal()` and its tests (`fromDecimalCases`, `testFromDecimal`, `rejectedCases`, `testFromDecimalRejects`) from `ScaledAmountTest.php`.
  - Update the class docblock: "Converts a legacy scaled integer to a canonical decimal string — used by `LegacyIntegerAmounts` to upgrade pre-phase-2 exports."
  - Delete `WireAmounts.php`, `ScaleRegistry.php` and `WireAmountsTest.php`.

- [ ] **Step 4: `LedgerStateService` — hydration and serialization.**

1. Add `use App\Money\Decimal;` and this private helper:

```php
    /**
     * An amount field from a JSON payload → canonical decimal string (null
     * if absent). Must be a JSON *string*: a bare JSON number is ambiguous
     * (a legacy scaled integer, or a float?) — app:import-local-storage
     * upgrades legacy integers via App\Money\LegacyIntegerAmounts before
     * they ever reach here.
     *
     * @param array<string, mixed> $data
     */
    private static function amountOrNull(array $data, string $key): ?string
    {
        if (!isset($data[$key])) {
            return null;
        }
        if (!\is_string($data[$key])) {
            throw new \InvalidArgumentException(sprintf('%s must be a decimal string.', $key));
        }
        $c = Decimal::parse($data[$key]);
        if (null === $c) {
            throw new \InvalidArgumentException(sprintf('%s "%s" is not a decimal amount.', $key, $data[$key]));
        }

        return $c;
    }
```

2. In `hydrateAccount()`:
   - `setOpeningBalance(...)` becomes `setOpeningBalance(self::amountOrNull($data, 'openingBalance'))`.
   - `setOpeningBalanceCashValue(...)` becomes `setOpeningBalanceCashValue(self::amountOrNull($data, 'openingBalanceCashValue'))`.
   - Update the ISA comment that mentions "raw scaled integer" to say "amount".

3. In `hydrateLine()`:
   - `setAmount((int) $data['amount'])` becomes `setAmount(self::amountOrNull($data, 'amount') ?? throw new \InvalidArgumentException('amount is required.'))`.
   - `setCashValue(...)` becomes `setCashValue(self::amountOrNull($data, 'cashValue'))`, and the same for `exchangeAmount`.

4. `lineToArray()`/`accountToArray()` need no code change, since the getters now return strings.

- [ ] **Step 5: `LedgerStateService` — balances, imbalance and stock math.**

1. Replace `balanceFor()` with a per-request map, and use it in `accountsWithStats()`:

```php
    /**
     * Sum of every line's amount per account, exact — replaces the old SQL
     * SUM(amount), which on TEXT would coerce to floats. One query for all
     * accounts; a ledger's line count is small enough (thousands) that
     * summing in PHP is trivial.
     *
     * @return array<string, string> accountId => canonical sum
     */
    private function lineSumsByAccount(): array
    {
        $sums = [];
        foreach ($this->em->getConnection()->fetchAllNumeric('SELECT account_id, amount FROM line') as [$accountId, $amount]) {
            $sums[$accountId] = Decimal::add($sums[$accountId] ?? '0', (string) $amount);
        }

        return $sums;
    }
```

In `accountsWithStats()`, compute `$sums = $this->lineSumsByAccount();` before the `array_map`, pass it in with `use ($imbalance, $sums)`, and set:

```php
            $arr['balance'] = Decimal::add($a->getOpeningBalance() ?? '0', $sums[$a->getId()] ?? '0');
```

Then delete `balanceFor()`.

2. `accumulateImbalance()`:
   - `if (null === $bv || 0 === $bv['value'])` becomes `if (null === $bv || Decimal::isZero($bv['value']))`.
   - The stats seed becomes `['count' => 0, 'in' => '0', 'out' => '0']`.
   - The in/out branch becomes:

```php
            if (Decimal::sign($e['value']) > 0) {
                $stats[$e['accountId']]['in'] = Decimal::add($stats[$e['accountId']]['in'], $e['value']);
            } else {
                $stats[$e['accountId']]['out'] = Decimal::add($stats[$e['accountId']]['out'], Decimal::neg($e['value']));
            }
```

   Update `@param`/`@return` types from `int` to `string` for `in`/`out`/`value`.

3. `lineBalanceValue()`: `(int) $line['cashValue']` becomes `(string) $line['cashValue']`, and `(int) ($line['amount'] ?? 0)` becomes `(string) ($line['amount'] ?? '0')`.

4. `enrichedIsBalanced()`:
   - `$byCur[...] = ($byCur[...] ?? 0) + $e['value']` becomes `$byCur[$e['currency']] = Decimal::add($byCur[$e['currency']] ?? '0', $e['value'])`.
   - Both `0 === $byCur[...]` become `Decimal::isZero($byCur[...])`.
   - `($a['value'] > 0) !== ($b['value'] > 0)` becomes `(Decimal::sign($a['value']) > 0) !== (Decimal::sign($b['value']) > 0)`.

5. Replace `stockStatsFor()`, `applyCostBasisLine()` and `applyPortfolioValueLine()`, and delete `divRoundHalfUp()`. Rewrite the `stockStatsFor` docblock: exact decimals, `Decimal::divide()` at 20 dp, no per-step rounding, and the output rounded to the trading currency's scale for phase 2 (phase 3 makes it adaptive). Mirror `src/lib/stockMath.js` after Task 6.

```php
    /** @return array{cost: string, value: string} */
    private function stockStatsFor(Account $a): array
    {
        $openingUnits = $a->getOpeningBalance() ?? '0';
        $openingCost = $a->getOpeningBalanceCashValue() ?? '0';
        $costState = ['units' => $openingUnits, 'cost' => $openingCost];
        $valueState = ['units' => $openingUnits, 'lastCashValue' => $openingCost, 'lastUnits' => $openingUnits];

        foreach ($this->orderedLinesFor($a) as $line) {
            $this->applyCostBasisLine($costState, $line);
            $this->applyPortfolioValueLine($valueState, $line);
        }

        $value = Decimal::isZero($valueState['lastUnits'])
            ? '0'
            : Decimal::divide(Decimal::mul($valueState['units'], $valueState['lastCashValue']), $valueState['lastUnits']);
        // Phase 2: API output rounded to the trading currency's scale, exactly
        // what phase 1 sent. Phase 3 replaces this with adaptive precision.
        $cashScale = $a->getSymbol()?->getTradingCurrency()->getScale() ?? 2;

        return ['cost' => Decimal::round($costState['cost'], $cashScale), 'value' => Decimal::round($value, $cashScale)];
    }

    /** @param array{units: string, cost: string} $state */
    private function applyCostBasisLine(array &$state, Line $l): void
    {
        $amount = $l->getAmount();
        $s = Decimal::sign($amount);
        if ($s > 0) {
            $state['units'] = Decimal::add($state['units'], $amount);
            $state['cost'] = Decimal::add($state['cost'], $l->getCashValue() ?? '0');
        } elseif ($s < 0) {
            $sold = Decimal::min(Decimal::neg($amount), $state['units']);
            $costRemoved = Decimal::sign($state['units']) > 0
                ? Decimal::divide(Decimal::mul($state['cost'], $sold), $state['units'])
                : '0';
            $state['cost'] = Decimal::sub($state['cost'], $costRemoved);
            $state['units'] = Decimal::sub($state['units'], $sold);
            if (Decimal::isZero($state['units'])) {
                // Fully sold: cost is exactly 0 by construction (cost×units÷units);
                // this only guards against 20-dp division dust.
                $state['cost'] = '0';
            }
        }
    }

    /** @param array{units: string, lastCashValue: string, lastUnits: string} $state */
    private function applyPortfolioValueLine(array &$state, Line $l): void
    {
        $state['units'] = Decimal::add($state['units'], $l->getAmount());
        if (!Decimal::isZero($l->getAmount()) && null !== $l->getCashValue()) {
            $state['lastCashValue'] = Decimal::abs($l->getCashValue());
            $state['lastUnits'] = Decimal::abs($l->getAmount());
        }
    }
```

6. Delete `rescaleCurrency()`, `rescaleSymbol()` and the `JS_MAX_SAFE_INTEGER` constant with its docblock. Also delete the class-docblock line mentioning rescale, if any.

- [ ] **Step 6: `IsaAllowanceService` — exact decimals, same algorithm.** Keep the structure and variable names; convert the arithmetic to `BcMath\Number` (`use BcMath\Number;`, `use App\Money\Decimal;`). Its operators (`+ - < > <=`, unary `-`, `min()`/`max()`) work on `Number`.
   - `contributionAmount()` returns `?Number`:

```php
    private function contributionAmount(array $line, array $accounts): ?Number
    {
        $acc = $this->findAccount($accounts, $line['accountId']);
        $raw = $acc && 'investment' === $acc['type'] ? ($line['cashValue'] ?? null) : $line['amount'];

        return null === $raw ? null : new Number($raw);
    }
```

   - **Zero literals:** every `0` used as an amount becomes `new Number(0)`. That covers `array_fill_keys(self::ISA_KINDS, new Number(0))`, `$deposits`, `'priorReplaceable'`, `'thisYearBalance'`, `$globalReplaceable` and `$pool`. The `?? 0` fallbacks become `?? new Number(0)`.
   - **Object truthiness:** `!$amount` is always false for an object, so it's a real bug here. Replace both `null === $amount || !$amount` with `null === $amount || 0 === $amount->compare(0)`.
   - **Opening pool:** `$pool += $acc['openingBalance'] ?? 0;` becomes `$pool += new Number($acc['openingBalance'] ?? '0');`.
   - **Clamping:** `max(0, $pool)` becomes `max(new Number(0), $pool)`. The byKind line's `max(0, $s['thisYearBalance'])` becomes `max(new Number(0), $s['thisYearBalance'])`.
   - **Return value:** return canonical strings. Replace both `return` statements with:

```php
        $byKindOut = array_map(static fn (Number $n) => Decimal::canonical((string) $n), $byKind);

        return ['byKind' => $byKindOut, 'total' => Decimal::sum($byKindOut)];
```

     The early `if (!$isaAccountIds)` return uses the same two lines. Update the `@return` to `array{byKind: array<string, string>, total: string}`, and change `priorPoolEntering(): int` to `: Number`.

- [ ] **Step 7: `MatchingService`, `TagService`, `NewYearService`.**
   - **MatchingService:**
     - `findCandidates(... int $targetAmount ...)` becomes `string $targetAmount`; the comparison `$comparable !== $targetAmount` stays (canonical strings).
     - `comparableAmount(): ?int` becomes `?string`, and `return $direct ? -$line->getCashValue() : $line->getCashValue();` becomes `return $direct ? Decimal::neg($line->getCashValue()) : $line->getCashValue();`.
     - Update docblocks mentioning integers.
   - **TagService::computeTagTotals():**
     - `($totals[...][...] ?? 0) + $line->getAmount()` becomes `Decimal::add($totals[$tag->getValue()][$currency] ?? '0', $line->getAmount())`.
     - The `@return` becomes `amount: string`.
     - The comment "same posture as accountsWithStats()'s own balance SUM" should say "exact, server-side".
   - **NewYearService:**
     - Delete the `$currencyScales`/`$symbolScales`/`$symbolTradingCurrency` loops and those three return keys; drop the unused `Currency`/`Symbol` imports.
     - `($a['costBasis'] ?? 0)` becomes `($a['costBasis'] ?? '0')`, and `0 !== $openingBalance` becomes `!Decimal::isZero($openingBalance)`.
     - The `@return` becomes `array{sourcePath: string, rows: array<int, array{0: array<string, mixed>, 1: string, 2: ?string}>}`.
     - Raw `UPDATE account SET opening_balance = ?` now binds canonical strings into `TEXT` columns, which is correct.
   - **NewYearCommand:** delete `formatScaled()`. In the table loop, print the strings directly:
     - investment rows: `$openingBalance.' units'`, `($openingBalanceCashValue ?? '0').' cost'`
     - other rows: `$openingBalance`

     Delete the `$result['symbolScales']`/`currencyScales`/`symbolTradingCurrency` lookups.

- [ ] **Step 8: `ImportLocalStorageCommand` — the legacy integer upgrade.** Add `use App\Entity\Currency;` if missing, plus `use App\Money\LegacyIntegerAmounts;`. Directly before the `$linkedCount = …` line, insert:

```php
        // Exports written before phase 2 of the decimal migration carry
        // amounts as scaled integers — upgrade them with each amount's own
        // scale (the file's declared currencies win over this database's).
        $currencyScales = [];
        foreach ($this->em->getRepository(Currency::class)->findAll() as $c) {
            $currencyScales[$c->getCode()] = $c->getScale();
        }
        foreach ($currencies as $c) {
            if (isset($c['code'], $c['scale'])) {
                $currencyScales[(string) $c['code']] = (int) $c['scale'];
            }
        }
        $symbolScales = [];
        foreach ($this->em->getRepository(Symbol::class)->findAll() as $s) {
            $symbolScales[$s->getTicker().'|'.$s->getTradingCurrency()->getCode()] = $s->getScale();
        }
        try {
            ['accounts' => $accounts, 'records' => $records] = LegacyIntegerAmounts::upgrade($accounts, $records, $currencyScales, $symbolScales);
        } catch (\InvalidArgumentException $e) {
            $io->error($e->getMessage());

            return Command::FAILURE;
        }
```

Also update the class docblock: amounts in the file may be decimal strings (current) or legacy scaled integers (upgraded).

- [ ] **Step 9: Controllers.**
   - **Account, Ledger, Tag, IsaAllowance:** remove every `WireAmounts::…(…)`/`ScaleRegistry::fromEntityManager(…)` wrapper, restoring the plain service call. Remove the `EntityManagerInterface $em` constructor parameter and the `use` lines where they're now unused. `AccountController::put()` keeps its `try/catch (\InvalidArgumentException)`. `LedgerController`'s catch comment: the batch rejects bad dates and malformed amounts.
   - **MatchController:** replace the phase-1 conversion block with:

```php
        $amountDecimal = Decimal::parse((string) $amount);
        if (null === $amountDecimal) {
            return new JsonResponse(['error' => 'amount must be a decimal number'], 400);
        }

        return new JsonResponse($this->matching->findCandidates($currency, $amountDecimal, $date, $excludeAccountIds, $mode));
```

   - **CurrencyController::patch():** replace `$rowsTouched = $this->state->rescaleCurrency($code, $scale);` with `$currency->setScale($scale); $this->em->persist($currency); $this->em->flush();`. Delete `$rowsTouched` and the `'rowsRescaled'` response key. Rewrite the class docblock's scale paragraph: `scale` is the minimum number of decimals displayed; changing it never touches stored amounts.
   - **SymbolController::patch():** the same (`$symbol->setScale($scale)` …). Also drop the `LedgerStateService` constructor dependency from either controller if nothing else uses it.
   - Delete `backend/tests/Service/LedgerStateServiceRescaleTest.php`.

- [ ] **Step 10: Update `IsaAllowanceServiceTest` to natural decimal strings.** Same scenarios; only the representation changes:
   - Helper signatures: `makeStandaloneLine(Account $account, string $amount, …)`, `makeStandaloneInvestmentLine(Account $account, string $units, string $cashValue, …)`, `@param … amount: string`, and `setOpeningBalance($overrides['openingBalance'] ?? '0')`.
   - **Every literal:** GBP amounts are divided by 100 (the test's GBP scale is 2), and ACME units by 1,000,000 (the test's symbol "scale"). Examples: `500000` → `'5000'`, `-100000` → `'-1000'`, `3000` → `'30'`, `1500000` units → `'1.5'`. Apply the same conversion to `openingBalance` overrides.
   - **Assertions:** `assertSame(3000, …)` → `assertSame('30', …)`, `assertSame(0, …)` → `assertSame('0', …)`, and so on, with the same /100 conversion.
   - **Comments:** update the ones quoting scaled integers ("3000 (£30.00 at GBP scale 2)" → "£30").

- [ ] **Step 11: Write the new service test** at `backend/tests/Service/LedgerStateServiceAmountsTest.php`. It covers exact balances, precision beyond scale, and the stock walk through the real `accountsWithStats()` and `applyLedgerOperations()`:

```php
<?php

namespace App\Tests\Service;

use App\Entity\Currency;
use App\Entity\Symbol;
use App\Service\LedgerStateService;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;

class LedgerStateServiceAmountsTest extends KernelTestCase
{
    private EntityManagerInterface $em;
    private LedgerStateService $state;

    protected function setUp(): void
    {
        self::bootKernel();
        $c = static::getContainer();
        $this->em = $c->get(EntityManagerInterface::class);
        $this->state = $c->get(LedgerStateService::class);
        $conn = $this->em->getConnection();
        foreach (['line_tag', 'line', 'transactions'] as $t) {
            $conn->executeStatement("DELETE FROM $t");
        }
        $conn->executeStatement('DELETE FROM account WHERE parent_id IS NOT NULL');
        $conn->executeStatement('DELETE FROM account');
        $gbp = $this->em->getRepository(Currency::class)->find('GBP') ?? (new Currency())->setCode('GBP')->setScale(2);
        $this->em->persist($gbp);
        $this->em->flush();
        if (!$this->em->getRepository(Symbol::class)->find(['ticker' => 'TST', 'tradingCurrency' => $gbp])) {
            $this->em->persist((new Symbol())->setTicker('TST')->setName('Test')->setScale(4)->setTradingCurrency($gbp));
            $this->em->flush();
        }
    }

    /** @return array<string, mixed> */
    private function stats(string $id): array
    {
        foreach ($this->state->accountsWithStats() as $a) {
            if ($a['id'] === $id) {
                return $a;
            }
        }
        self::fail("no account $id");
    }

    private function line(string $accountId, string $amount, string $date, array $extra = []): array
    {
        return ['op' => 'upsertLine', 'line' => ['accountId' => $accountId, 'amount' => $amount, 'date' => $date, 'description' => '', ...$extra]];
    }

    public function testBalancesAreExactAndAllowPrecisionBeyondScale(): void
    {
        $this->state->upsertAccount('cash', ['name' => 'Cash', 'type' => 'asset', 'currency' => 'GBP', 'openingBalance' => '0.1']);
        $this->state->applyLedgerOperations([
            $this->line('cash', '0.2', '2026-05-01'),
            $this->line('cash', '-0.0001', '2026-05-02'),
        ]);

        self::assertSame('0.2999', $this->stats('cash')['balance']);
        $amounts = array_column(array_merge(...array_column($this->state->accountLedger('cash'), 'lines')), 'amount');
        sort($amounts);
        self::assertSame(['-0.0001', '0.2'], $amounts);
    }

    public function testStockWalkDividesExactlyAndRoundsOnlyTheOutput(): void
    {
        $this->state->upsertAccount('wrap', ['name' => 'W', 'type' => 'investment-parent']);
        $this->state->upsertAccount('inv', ['name' => 'S', 'type' => 'investment', 'symbolTicker' => 'TST', 'symbolCurrency' => 'GBP', 'parentId' => 'wrap']);
        $this->state->applyLedgerOperations([
            $this->line('inv', '3', '2026-05-01', ['cashValue' => '100.005', 'cashCurrency' => 'GBP']),
            $this->line('inv', '-1', '2026-06-01', ['cashValue' => '-40', 'cashCurrency' => 'GBP']),
        ]);

        $s = $this->stats('inv');
        self::assertSame('2', $s['balance']);
        // cost: 100.005 − 100.005/3 = 66.67 exactly → '66.67'; value: 2 × 40/1 = 80
        self::assertSame('66.67', $s['costBasis']);
        self::assertSame('80', $s['portfolioValue']);
    }

    public function testRejectsNumericJsonAmounts(): void
    {
        $this->state->upsertAccount('cash', ['name' => 'Cash', 'type' => 'asset', 'currency' => 'GBP']);
        $this->expectException(\InvalidArgumentException::class);
        $this->state->applyLedgerOperations([['op' => 'upsertLine', 'line' => ['accountId' => 'cash', 'amount' => 2050, 'date' => '2026-05-01', 'description' => '']]]);
    }
}
```

   If the `DELETE FROM account` pair trips a foreign key, delete child accounts first (`parent_id IS NOT NULL`, as written). If `upsertAccount`'s signature differs from `(string $id, array $data)`, adapt the calls and say so in the report.

- [ ] **Step 12: Migrate the test database and run the whole suite.**

```bash
cd backend && php bin/console doctrine:migrations:migrate --env=test --no-interaction && php bin/phpunit
```

Expected: every test passes (Decimal, DecimalTextType, LegacyIntegerAmounts, ScaledAmount, IsaAllowance, LedgerStateServiceAmounts), with pristine output.

- [ ] **Step 13: Prove the mapping and the migration agree.**

```bash
cd backend && php bin/console doctrine:schema:validate --env=test && php bin/console doctrine:migrations:diff --env=test --no-interaction
```

Expected:
- `schema:validate` reports "[OK] The database schema is in sync with the mapping files".
- `migrations:diff` reports "No changes detected".

If `diff` does generate a migration, don't commit it. Read what it changes. If it's a pure type-name difference for the five columns (for example `CLOB` vs `TEXT`), make `DecimalTextType::getSQLDeclaration()` return exactly what DBAL introspects for a `TEXT` column, re-run until clean, and delete the generated file. Report what you found.

- [ ] **Step 14: Sweep for leftovers.**

```bash
cd backend && grep -rnE "WireAmounts|ScaleRegistry|fromDecimal|divRoundHalfUp|rescale|JS_MAX_SAFE_INTEGER|\(int\) \\\$data\['(amount|openingBalance)" src tests
```

Expected: no hits, apart from the migration file's own `toScaledInt` name, if the pattern catches it.

- [ ] **Step 15: Commit everything from this task as one commit** with the message "Store amounts as exact decimal TEXT; backend math on App\Money\Decimal". Run `git status` first and make sure no generated migration or `var/` file is staged.

---

### Task 5: Verify the migration and the API on database copies

**Files:**
- Create: `backend/var/phase2-verify/compare.mjs` (never committed)

**Interfaces:**
- Consumes: the Task 0 baselines; the Task 4 code with the worktree backend on :8001.

- [ ] **Step 1: Write the comparison script** at `backend/var/phase2-verify/compare.mjs`. Phase 2 must reproduce phase 1's output exactly, so it's a plain deep equality with no conversion:

```js
// Usage: node compare.mjs <baselineDir> <newDir>
import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const [a, b] = process.argv.slice(2);
let failures = 0;
const files = readdirSync(a);
for (const f of files) {
  const expected = JSON.parse(readFileSync(`${a}/${f}`, "utf8"));
  const actual = JSON.parse(readFileSync(`${b}/${f}`, "utf8"));
  if (!isDeepStrictEqual(expected, actual)) {
    failures++;
    console.log(`MISMATCH ${f}\n  expected: ${JSON.stringify(expected).slice(0, 400)}\n  actual:   ${JSON.stringify(actual).slice(0, 400)}`);
  }
}
console.log(failures ? `${failures} of ${files.length} file(s) differ` : `All ${files.length} files match`);
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Record row counts, then migrate both copies** with the real command, one file at a time:

```bash
cd backend
for f in 2024-2025 2025-2026; do
  echo "$f before: $(sqlite3 databases/$f.sqlite3 'select (select count(*) from account)||"/"||(select count(*) from line)||"/"||(select count(*) from transactions)||"/"||(select count(*) from line_tag)')"
  ACTIVE_DATABASE_PATH_OVERRIDE="$PWD/databases/$f.sqlite3" php bin/console doctrine:migrations:migrate --no-interaction
  echo "$f after:  $(sqlite3 databases/$f.sqlite3 'select (select count(*) from account)||"/"||(select count(*) from line)||"/"||(select count(*) from transactions)||"/"||(select count(*) from line_tag)')"
  sqlite3 databases/$f.sqlite3 "select typeof(amount), count(*) from line group by 1; select amount, cash_value from line where cash_value is not null limit 3;"
done
```

Expected, for each file:
- identical account/line/transactions/line_tag counts before and after
- `typeof(amount)` is `text` for every row
- the 2024-25 copy's test trades read `3|100` and `-1|-40`

- [ ] **Step 3: Compare the API against both baselines.**

```bash
printf "activeDatabase: 2024-2025.sqlite3\ngroupLevels: []\n" > databases/app-settings.yaml
node var/phase2-verify/capture.mjs http://127.0.0.1:8001 var/phase2-verify/after-2024
node var/phase2-verify/compare.mjs var/phase2-verify/baseline-2024 var/phase2-verify/after-2024
printf "activeDatabase: 2025-2026.sqlite3\ngroupLevels: []\n" > databases/app-settings.yaml
node var/phase2-verify/capture.mjs http://127.0.0.1:8001 var/phase2-verify/after-2025
node var/phase2-verify/compare.mjs var/phase2-verify/baseline-2025 var/phase2-verify/after-2025
```

Expected: `All N files match` twice. On a mismatch, report it and fix the backend; never edit the baseline.

- [ ] **Step 4: Round-trip precision beyond scale through the API** (on the 2024-25 copy):

```bash
printf "activeDatabase: 2024-2025.sqlite3\ngroupLevels: []\n" > databases/app-settings.yaml
B=http://127.0.0.1:8001; H='Content-Type: application/json'
curl -s -X POST $B/api/ledger/batch -H "$H" -d '{"operations":[{"op":"upsertLine","line":{"accountId":"ti1","amount":"0.12345","date":"2024-08-01","description":"deep","cashValue":"123.4567","cashCurrency":"GBP"}}]}'
curl -s $B/api/accounts/ti1/ledger | grep -o '"amount":"0.12345"[^}]*'
curl -s -X PATCH $B/api/currencies/GBP -H "$H" -d '{"scale":3}'
curl -s $B/api/accounts/ti1/ledger | grep -c '"cashValue":"123.4567"'
curl -s -X PATCH $B/api/currencies/GBP -H "$H" -d '{"scale":2}'
```

Expected:
- the batch returns `{"ok":true}`
- the ledger shows `"amount":"0.12345"` with `"cashValue":"123.4567"`
- the scale PATCH returns the currency with no `rowsRescaled`, and the grep still prints `1`, because stored values are untouched by a scale change

- [ ] **Step 5: Exercise `down()` on a throwaway copy, never on either verification copy:**

```bash
cp databases/2025-2026.sqlite3 var/phase2-verify/down-test.sqlite3
ACTIVE_DATABASE_PATH_OVERRIDE="$PWD/var/phase2-verify/down-test.sqlite3" php bin/console doctrine:migrations:migrate prev --no-interaction
sqlite3 var/phase2-verify/down-test.sqlite3 "select typeof(amount), count(*) from line group by 1"
ACTIVE_DATABASE_PATH_OVERRIDE="$PWD/var/phase2-verify/down-test.sqlite3" php bin/console doctrine:migrations:migrate --no-interaction
sqlite3 var/phase2-verify/down-test.sqlite3 "select typeof(amount), count(*) from line group by 1"
```

Expected: `integer` after going down, `text` after going back up, and the same counts both times.

- [ ] **Step 6:** Nothing to commit. Report every command's output in the report file.

---

### Task 6: Frontend — remove the phase-1 guards; exact stock math

**Files:**
- Modify:
  - lib: `src/lib/format.js`, `src/lib/format.test.js`, `src/lib/stockMath.js`
  - components: `src/components/AccountLedger.jsx`, `StockLedger.jsx`, `AccountFormModal.jsx`, `otherLines.jsx`, `useMatchCandidates.js`, `charts.jsx`, `ReferenceDataView.jsx`

**Interfaces:**
- Consumes: the backend from Task 4 (no precision limit, same wire format).
- Produces: `stockMath.js` state objects without `cashPlaces`. The builders take `opening = { units?: str, cost?: str }`.

- [ ] **Step 1: `format.js`.**
  - Delete `precisionError()` and its PHASE-1 comment block.
  - Delete the `fractionDigits` import if nothing else in the file uses it.
  - Update the comment on `fmt` that says "Phase 1: exactly `scale` places": still true until phase 3, but drop "Phase 1".

  In `format.test.js`, delete the `describe("precisionError (phase 1 only)", …)` block and its import.

- [ ] **Step 2: Remove the guards.**
  - **AccountLedger.jsx and StockLedger.jsx:** delete the `precisionError` import and the `const precisionMsg = precisionError(…); if (precisionMsg) { … }` block in `commit()`.
  - **useMatchCandidates.js and otherLines.jsx:** delete the PHASE-1-ONLY "skip the search when the amount is deeper than the currency's scale" checks and any imports only they used.
  - **AccountFormModal.jsx:** delete the scale part of the opening-balance guard (the `openingScale` lookup, and the "at most N decimal places" branch and message). **Keep** the unparseable-input check and its "Enter a valid opening balance." message: that isn't phase-specific.

- [ ] **Step 3: `stockMath.js` — divide at 20 dp, no per-step rounding.** The imports become `import { add, sub, mul, neg, abs, min, sign, isZero, divide } from "./decimal";`. Replace the two apply functions and remove `cashPlaces` from both builders' `state` initializers. Rewrite the comment above `applyCostBasisLine`: exact decimal arithmetic with `divide()` at 20 dp and no per-step rounding, mirroring `LedgerStateService::applyCostBasisLine()`; display rounds via `fmt`.

```js
export function applyCostBasisLine(state, l) {
  const s = sign(l.amount ?? "0");
  if (s > 0) {
    state.units = add(state.units, l.amount);
    state.cost = add(state.cost, l.cashValue ?? "0");
  } else if (s < 0) {
    const sold = min(neg(l.amount), state.units);
    const costRemoved = sign(state.units) > 0 ? divide(mul(state.cost, sold), state.units) : "0";
    state.cost = sub(state.cost, costRemoved);
    state.units = sub(state.units, sold);
    // Fully sold: exactly 0 by construction; guards against 20-dp division dust.
    if (isZero(state.units)) state.cost = "0";
  }
}
```

```js
export function applyPortfolioValueLine(state, l) {
  state.units = add(state.units, l.amount ?? "0");
  if (!isZero(l.amount ?? "0") && l.cashValue !== undefined) {
    state.lastCashValue = abs(l.cashValue);
    state.lastUnits = abs(l.amount);
  }
  state.value = isZero(state.lastUnits) ? "0" : divide(mul(state.units, state.lastCashValue), state.lastUnits);
}
```

- [ ] **Step 4: Stop threading `cashPlaces`.**
  - **StockLedger.jsx:** remove `cashPlaces: cashScale` from `costState` and `valueState`. Keep `cashScale`: `avgCost`'s `round(…, cashScale)` and the input `step` still use it.
  - **charts.jsx:** remove `cashPlaces: …` from the stock chart's `opening`, and remove the `scaleForCurrency` import if nothing else in the file uses it.

- [ ] **Step 5: `ReferenceDataView.jsx`.** Delete both `if (!window.confirm(\`Changing … will rescale every existing amount …\`)) return;` lines: a scale change no longer touches stored amounts. Relabelling the field is phase 3.

- [ ] **Step 6: Sweep and build.**

```bash
grep -rnE "precisionError|cashPlaces|PHASE 1 ONLY|rescale" src
yarn test && yarn build
```

Expected: no grep hits (a `rescale` in an unrelated word is fine; judge each hit), tests passing, and the build succeeding.

- [ ] **Step 7: Commit** everything under `src/` with the message "Frontend: drop phase-1 precision guards; exact 20-dp stock math".

---

### Task 7: CLAUDE.md, the live-migration procedure, and browser verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md for phase 2.** Edit surgically in the existing voice:
  - **"Amounts, currencies, and reference data":**
    - storage is `TEXT` via the `decimal_text` Doctrine type (canonical-only writes)
    - the `NUMERIC`-affinity warning (never Doctrine's `decimal`)
    - `App\Money\Decimal` mirrors `decimal.js`, pinned by `tests/fixtures/decimal-cases.json` in both suites
    - no precision limit
    - `scale` affects display only; a scale edit never touches stored amounts
    - rescaling is gone
  - **Remove** everything about: `WireAmounts`/`ScaleRegistry`/the phase-1 shim; `rescaleCurrency`/`rescaleSymbol`, `rowsRescaled` and the safe-integer cap; `precisionError` and the other phase-1 guards; `SUM(amount)` for balances (now summed exactly in PHP, see `lineSumsByAccount()`); `divRoundHalfUp` (gone from both sides).
  - **"Stock valuation":** both sides divide at 20 dp via `Decimal::divide()`/`divide()` with no per-step rounding. The backend rounds `costBasis`/`portfolioValue` to the trading currency's scale on output (until phase 3); `cashPlaces` is gone.
  - **Commands:**
    - `app:import-local-storage` accepts decimal-string amounts, and upgrades legacy scaled-integer exports via `LegacyIntegerAmounts` (floats are rejected)
    - `app:export-state` writes decimal strings
  - **Migrating every tax-year database after pulling this change.** Add this procedure under Commands:

```bash
cd backend
mkdir -p ../db-backups && cp databases/*.sqlite3 ../db-backups/
for f in databases/*.sqlite3; do ACTIVE_DATABASE_PATH_OVERRIDE="$PWD/$f" php bin/console doctrine:migrations:migrate --no-interaction || break; done
```

    Explain it: `MigrationStatusListener` refuses the app for any unmigrated file; the backup is the undo; and `down()` refuses once any value has more decimals than its scale.
  - **Endpoints:** `PATCH /api/currencies|symbols` scale is now a plain field update.

- [ ] **Step 2: Commit** `CLAUDE.md` with the message "Document phase 2: decimal TEXT storage, exact backend math, live migration procedure".

- [ ] **Step 3: Browser verification** (the controller does this; the worktree backend is on :8001 against the migrated 2024-25 copy). Start the worktree's Vite with `LEDGER_API=http://127.0.0.1:8001` on port 5174. The preview tool reads the **main** checkout's `.claude/launch.json`: add a temporary `ledger-dev-worktree` entry there (`sh -c "cd <worktree> && LEDGER_API=http://127.0.0.1:8001 npm run dev -- --port 5174 --strictPort"`), and remove it afterwards. Check:
  1. Overview totals are unchanged from phase 1.
  2. **Test Stock (`ti1`):** header, rows and chart agree with the sidebar (cost basis and worth); the Task 5 "deep" line shows units `0.1235` (display rounds to the symbol's scale 4) and its value rounded to GBP's 2 places. *Display showing fewer digits than stored is expected until phase 3.*
  3. **Entering beyond scale:** add a cash line of `1.234` GBP. It saves (no error), and re-opening the row shows `1.234` in the input.
  4. **The two flows phase 1 never exercised:**
     - a **split leg** typed with the natural amount of a stock trade finds that trade (direct-mode search)
     - **reordering** two same-date entries with the up/down arrows persists after a reload
  5. **Reference Data:** change GBP's scale to 3 and back. There's no confirm dialog, and balances are unchanged.
  6. No console errors.

- [ ] **Step 4: Final checks:** `yarn test && yarn build && (cd backend && php bin/phpunit)`, all green. Stop the worktree backend (`symfony server:stop` in `backend/`). **Do not migrate the live databases**: that's the user's step after merge, using the Step 1 procedure.
