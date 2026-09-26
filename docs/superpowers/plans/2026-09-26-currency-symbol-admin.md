# Currency and Symbol admin capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `Currency` and `Symbol` real admin capabilities (create/edit-name/edit-scale-with-rescale/delete), and let the same ticker exist multiple times under different trading currencies by making `Symbol`'s identity the composite pair `(ticker, tradingCurrency)`.

**Architecture:** `Symbol` gets a Doctrine composite primary key (mirroring `Tag`'s existing `(dimension, value)` pattern); `Account` gets two columns (`symbol_ticker`/`symbol_currency`) replacing its single `symbol` column. New `PATCH`/`DELETE` endpoints on both `CurrencyController` and `SymbolController`, backed by a transactional rescale operation in `LedgerStateService` that rewrites every dependent stored amount when a `scale` changes, refusing outright if a decrease would lose precision. A new frontend admin view (`ReferenceDataView.jsx`) exposes all of this; every existing frontend spot that looked up a `Symbol` by ticker alone is updated to match on the pair instead.

**Tech Stack:** Symfony 8 / Doctrine ORM 3 / Doctrine DBAL 4 / SQLite / React.

**Spec:** `docs/superpowers/specs/2026-09-26-currency-symbol-admin-design.md`

## Global Constraints

- Single-user, no-auth personal app.
- `Currency.code` and `Symbol`'s identity `(ticker, tradingCurrency)` are never editable after creation — only `name` and `scale` can change. A different code/ticker/tradingCurrency is a new row, not a rename.
- A `scale` decrease that would lose precision on any existing stored amount is refused outright (`400`, naming the affected row count) — never silently rounded. A `scale` increase is always lossless and always allowed.
- Every rescale (the `scale` write itself, plus every dependent row it touches) commits in one transaction — all of it or none of it.
- Rescale only ever touches the currently active database.
- `Counterparty` stays completely out of scope.
- Delete safety already comes from the schema (every FK into `currency`/`symbol` is `NOT DEFERRABLE INITIALLY IMMEDIATE`, and `foreign_keys` enforcement is on everywhere via `ForeignKeysMiddleware`) — the new delete endpoints only need to catch `\Doctrine\DBAL\Exception\ForeignKeyConstraintViolationException` → `409`, matching `AccountController::delete()`'s existing pattern.
- Any migration containing a generated `DROP TABLE` must bracket the rebuild with `PRAGMA foreign_keys = OFF` / `PRAGMA foreign_key_check` / `PRAGMA foreign_keys = ON`, via `addSql()` (not `executeStatement()`), with `isTransactional(): bool { return false; }` on the migration class, and must be verified empirically against a copy of a real database's row counts before/after — this project's standing convention (CLAUDE.md), added after a real near-miss data-loss incident on this exact schema.
- Never mutate a real `backend/databases/*.sqlite3` file directly while testing — always copy it first (this project's own testing-isolation convention).

---

### Task 1: `Symbol`'s composite key, `Account`'s two symbol columns, migration

**Files:**
- Modify: `backend/src/Entity/Symbol.php`
- Modify: `backend/src/Entity/Account.php`
- Modify: `backend/src/Service/LedgerStateService.php`
- Modify: `backend/tests/Service/IsaAllowanceServiceTest.php`
- Create: `backend/migrations/VersionYYYYMMDDHHMMSS.php` (auto-generated timestamp)

**Interfaces:**
- Produces: `Symbol`'s primary key is `(ticker, tradingCurrency)` — no `setTicker()`/`setTradingCurrency()` remain callable after construction, only `getTicker()`/`getTradingCurrency()`. `Account::getSymbol(): ?Symbol`/`setSymbol(?Symbol $symbol): static` unchanged in shape (still a single `Symbol` object). `LedgerStateService::resolveSymbol(mixed $ticker, mixed $tradingCurrencyCode): ?Symbol` (was one-argument). API wire format: `Account`'s `symbol` field becomes `symbolTicker`/`symbolCurrency`.
- Consumes: nothing from other tasks (this is the foundation).

- [ ] **Step 1: Update `Symbol.php`'s primary key**

Replace the whole class body's identity section. Current:

```php
    #[ORM\Id]
    #[ORM\Column(length: 32)]
    private string $ticker;

    #[ORM\Column(length: 255)]
    private string $name;

    #[ORM\Column]
    private int $scale;

    #[ORM\ManyToOne(targetEntity: Currency::class)]
    #[ORM\JoinColumn(name: 'trading_currency', referencedColumnName: 'code', nullable: false)]
    private Currency $tradingCurrency;

    public function getTicker(): string
    {
        return $this->ticker;
    }

    public function setTicker(string $ticker): static
    {
        $this->ticker = $ticker;

        return $this;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function setName(string $name): static
    {
        $this->name = $name;

        return $this;
    }

    public function getScale(): int
    {
        return $this->scale;
    }

    public function setScale(int $scale): static
    {
        $this->scale = $scale;

        return $this;
    }

    public function getTradingCurrency(): Currency
    {
        return $this->tradingCurrency;
    }

    public function setTradingCurrency(Currency $tradingCurrency): static
    {
        $this->tradingCurrency = $tradingCurrency;

        return $this;
    }
```

Replace with:

```php
    #[ORM\Id]
    #[ORM\Column(length: 32)]
    private string $ticker;

    // Part of the identity, not an ordinary field — see the class
    // docblock. Set once via setTradingCurrency() immediately after
    // construction (before the first persist()); there is deliberately
    // no way to change it on an existing row. `nullable: false` since a
    // Symbol without a trading currency has no meaningful identity.
    #[ORM\Id]
    #[ORM\ManyToOne(targetEntity: Currency::class)]
    #[ORM\JoinColumn(name: 'trading_currency', referencedColumnName: 'code', nullable: false)]
    private Currency $tradingCurrency;

    #[ORM\Column(length: 255)]
    private string $name;

    #[ORM\Column]
    private int $scale;

    public function getTicker(): string
    {
        return $this->ticker;
    }

    public function setTicker(string $ticker): static
    {
        $this->ticker = $ticker;

        return $this;
    }

    public function getTradingCurrency(): Currency
    {
        return $this->tradingCurrency;
    }

    public function setTradingCurrency(Currency $tradingCurrency): static
    {
        $this->tradingCurrency = $tradingCurrency;

        return $this;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function setName(string $name): static
    {
        $this->name = $name;

        return $this;
    }

    public function getScale(): int
    {
        return $this->scale;
    }

    public function setScale(int $scale): static
    {
        $this->scale = $scale;

        return $this;
    }
```

(`setTicker()`/`setTradingCurrency()` still exist as plain setters — Doctrine's own construction/hydration calls them — but application code must never call either on an already-persisted `Symbol`; Task 2/3's controllers only ever call them on a `new Symbol()`.)

Update the class docblock's second paragraph (currently describing `ticker` as the sole primary key) to:

```php
 * Primary key is the pair `(ticker, tradingCurrency)`, not `ticker`
 * alone — mirroring `Tag`'s existing `(dimension, value)` composite key
 * (see CLAUDE.md's "Tags" section) — so the same ticker can exist more
 * than once, one row per trading currency it's actually traded in (e.g.
 * "AAPL" on Nasdaq in USD and "AAPL" as an LSE-listed line in GBP are two
 * separate Symbol rows). `tradingCurrency` is therefore immutable once
 * set: changing it would mean changing part of the row's own identity,
 * which is a new row, not an edit — see LedgerStateService's rescale
 * operation and the admin endpoints for what *is* editable (`name`,
 * `scale`).
```

- [ ] **Step 2: Update `Account.php`'s symbol association**

Replace:

```php
    #[ORM\ManyToOne(targetEntity: Symbol::class)]
    #[ORM\JoinColumn(name: 'symbol', referencedColumnName: 'ticker', nullable: true)]
    private ?Symbol $symbol = null;
```

with:

```php
    // Two join columns, not one — Symbol's primary key is now the pair
    // (ticker, tradingCurrency), so referencing one requires both. Kept
    // nullable together (an account either has a symbol or it doesn't —
    // see the CHECK constraint added in this same migration, which
    // enforces that in the database too).
    #[ORM\ManyToOne(targetEntity: Symbol::class)]
    #[ORM\JoinColumns([
        new ORM\JoinColumn(name: 'symbol_ticker', referencedColumnName: 'ticker', nullable: true),
        new ORM\JoinColumn(name: 'symbol_currency', referencedColumnName: 'trading_currency', nullable: true),
    ])]
    private ?Symbol $symbol = null;
```

`getSymbol()`/`setSymbol()` stay exactly as they are (unchanged signature — still a single `?Symbol` object in, `?Symbol` out).

- [ ] **Step 3: Update `LedgerStateService::resolveSymbol()`**

Replace:

```php
    private function resolveSymbol(mixed $ticker): ?Symbol
    {
        if (null === $ticker || '' === $ticker) {
            return null;
        }
        $symbol = $this->em->getRepository(Symbol::class)->find((string) $ticker);
        if (!$symbol) {
            throw new \InvalidArgumentException(sprintf('Unknown symbol "%s".', $ticker));
        }

        return $symbol;
    }
```

with:

```php
    private function resolveSymbol(mixed $ticker, mixed $tradingCurrencyCode): ?Symbol
    {
        if (null === $ticker || '' === $ticker) {
            return null;
        }
        $currency = $this->resolveCurrency($tradingCurrencyCode);
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

- [ ] **Step 4: Update `hydrateAccount()`'s call site**

Replace:

```php
        $account->setSymbol($this->resolveSymbol($data['symbol'] ?? null));
```

with:

```php
        $account->setSymbol($this->resolveSymbol($data['symbolTicker'] ?? null, $data['symbolCurrency'] ?? null));
```

- [ ] **Step 5: Update `accountToArray()`**

Replace:

```php
            'symbol' => $a->getSymbol()?->getTicker(),
```

with:

```php
            'symbolTicker' => $a->getSymbol()?->getTicker(),
            'symbolCurrency' => $a->getSymbol()?->getTradingCurrency()->getCode(),
```

(both keys are individually covered by the existing `array_filter(..., null !== $v)` — when there's no symbol, both are simply absent, same as today's single `symbol` key.)

- [ ] **Step 6: Fix `IsaAllowanceServiceTest.php`'s `ensureSymbol()` helper**

Replace:

```php
    private function ensureSymbol(string $ticker, string $tradingCurrency = 'GBP', int $scale = 1000000): Symbol
    {
        $symbol = $this->em->getRepository(Symbol::class)->find($ticker);
        if (!$symbol) {
            $symbol = (new Symbol())
                ->setTicker($ticker)
                ->setName($ticker)
                ->setScale($scale)
                ->setTradingCurrency($this->em->getRepository(Currency::class)->find($tradingCurrency));
            $this->em->persist($symbol);
            $this->em->flush();
        }

        return $symbol;
    }
```

with:

```php
    private function ensureSymbol(string $ticker, string $tradingCurrency = 'GBP', int $scale = 1000000): Symbol
    {
        $currency = $this->em->getRepository(Currency::class)->find($tradingCurrency);
        $symbol = $this->em->getRepository(Symbol::class)->find(['ticker' => $ticker, 'tradingCurrency' => $currency]);
        if (!$symbol) {
            $symbol = (new Symbol())
                ->setTicker($ticker)
                ->setName($ticker)
                ->setScale($scale)
                ->setTradingCurrency($currency);
            $this->em->persist($symbol);
            $this->em->flush();
        }

        return $symbol;
    }
```

(`find()` on a composite-key entity takes an associative array of identifier field → value — a bare scalar no longer resolves.)

- [ ] **Step 7: Generate the migration**

```bash
cd backend && php bin/console doctrine:migrations:diff
```

Expected: a new `migrations/VersionYYYYMMDDHHMMSS.php` whose `up()` rebuilds `symbol` (composite PK) and `account` (two new columns, `symbol` dropped) via the usual SQLite temp-table-rebuild pattern. Since every real database today has at most one row per ticker (the old schema already enforced that), the generated `INSERT INTO symbol (...) SELECT ... FROM __temp__symbol` and the `account` rebuild's `symbol_ticker`/`symbol_currency` columns populate correctly from the existing single `symbol`/its `trading_currency` with no hand-written data statement needed — confirm this by reading the generated SQL before proceeding; if it does *not* carry the old `symbol` column's value into both new `account` columns automatically, add two explicit `UPDATE account SET symbol_ticker = symbol, symbol_currency = (SELECT trading_currency FROM symbol WHERE ticker = account.symbol) WHERE symbol IS NOT NULL` (adjust to match whatever the generated rebuild's intermediate temp-table shape actually is) before the rebuild's `DROP TABLE account`, mirroring how the investment-parent migration's hand-added `UPDATE`s were placed.

- [ ] **Step 8: Hand-edit the generated migration for `foreign_keys` safety and the lockstep `CHECK`**

Per this project's standing convention (Global Constraints above): find every `DROP TABLE` in the generated `up()` (there will be two — `symbol` and `account`). Add, as the very first statement in `up()`:

```php
        $this->addSql('PRAGMA foreign_keys = OFF');
```

and, as the very last two statements (after every generated statement, including both table rebuilds):

```php
        $this->addSql('PRAGMA foreign_key_check');
        $this->addSql('PRAGMA foreign_keys = ON');
```

Add `isTransactional(): bool { return false; }` to the migration class (SQLite's `PRAGMA foreign_keys` is a documented no-op inside an active transaction). Mirror the same three `addSql()` pragma statements around `down()`'s rebuilds.

Find the generated `CREATE TABLE account (...)` statement and add the lockstep `CHECK` clause just before its closing parenthesis (same technique as the existing `CHECK (type != 'investment' OR parent_id IS NOT NULL)` from the last migration that touched this table):

```
, CHECK ((symbol_ticker IS NULL) = (symbol_currency IS NULL))
```

Update `getDescription()` to:

```php
    public function getDescription(): string
    {
        return 'Symbol gets a composite primary key (ticker, tradingCurrency); Account.symbol becomes symbol_ticker/symbol_currency — see docs/superpowers/specs/2026-09-26-currency-symbol-admin-design.md';
    }
```

- [ ] **Step 9: Migrate the test database, run the suite**

```bash
cd backend
php bin/console doctrine:migrations:migrate --env=test --no-interaction
php bin/phpunit
```

Expected: migration applies cleanly, all 6 tests pass (Step 6's fix resolves the one test that constructs a `Symbol` directly).

- [ ] **Step 10: Manual verification — real-database row-count safety**

Per this project's standing convention, verify the migration doesn't silently destroy data on a real file:

```bash
cd backend
cp databases/2020-2021.sqlite3 /tmp/verify-symbol-migration.sqlite3
sqlite3 /tmp/verify-symbol-migration.sqlite3 "SELECT count(*) FROM line; SELECT count(*) FROM account; SELECT count(*) FROM symbol;"
ACTIVE_DATABASE_PATH_OVERRIDE=/tmp/verify-symbol-migration.sqlite3 php bin/console doctrine:migrations:migrate --no-interaction
sqlite3 /tmp/verify-symbol-migration.sqlite3 "SELECT count(*) FROM line; SELECT count(*) FROM account; SELECT count(*) FROM symbol; SELECT symbol_ticker, symbol_currency FROM account WHERE symbol_ticker IS NOT NULL;"
rm /tmp/verify-symbol-migration.sqlite3
```

Expected: every `count(*)` identical before/after, and any investment account's `symbol_ticker`/`symbol_currency` correctly populated (non-null pair) if that database has one. Copy a second real file too if the first happens to have zero investment accounts, so at least one verification run exercises a real populated `symbol_ticker`/`symbol_currency` pair.

- [ ] **Step 11: Commit**

```bash
git add backend/src/Entity/Symbol.php backend/src/Entity/Account.php backend/src/Service/LedgerStateService.php backend/tests/Service/IsaAllowanceServiceTest.php backend/migrations/
git commit -m "Symbol gets a composite (ticker, tradingCurrency) primary key; Account.symbol becomes symbol_ticker/symbol_currency"
```

---

### Task 2: `Currency` admin endpoints and rescale

**Files:**
- Modify: `backend/src/Controller/CurrencyController.php`
- Modify: `backend/src/Service/LedgerStateService.php`
- Test: `backend/tests/Service/LedgerStateServiceRescaleTest.php` (new)

**Interfaces:**
- Consumes: `Currency` entity (unchanged), nothing from Task 1's `Symbol` change.
- Produces: `LedgerStateService::rescaleCurrency(string $code, int $newScale): int` (returns rows touched), used by no other task but exercised directly by this task's own test and its controller.

- [ ] **Step 1: Add `rescaleCurrency()` to `LedgerStateService.php`**

Add near the other `resolve*()`/mutation methods:

```php
    /**
     * Rewrites every stored amount denominated in this currency to the
     * new scale, in one transaction — see CLAUDE.md's "Amounts,
     * currencies, and reference data" for why `scale` isn't just a
     * display setting. A decrease that would lose precision on any
     * existing row is refused outright (nothing partially applies); an
     * increase is always lossless and always allowed. Returns how many
     * rows were touched (0 if $newScale equals the current scale — a
     * genuine no-op, not an error).
     */
    public function rescaleCurrency(string $code, int $newScale): int
    {
        $currency = $this->em->getRepository(Currency::class)->find($code);
        if (!$currency) {
            throw new \InvalidArgumentException(sprintf('Unknown currency code "%s".', $code));
        }
        $delta = $newScale - $currency->getScale();
        if (0 === $delta) {
            return 0;
        }

        return $this->em->wrapInTransaction(function () use ($currency, $code, $delta, $newScale) {
            $conn = $this->em->getConnection();
            $divisor = 10 ** abs($delta);
            $op = $delta > 0 ? '*' : '/';

            /** @var array<int, array{sql: string, params: array<int, mixed>}> $targets */
            $targets = [
                [
                    'sql' => "opening_balance IS NOT NULL AND currency = ? AND type != 'investment'",
                    'table' => 'account',
                    'column' => 'opening_balance',
                    'params' => [$code],
                ],
                [
                    'sql' => 'opening_balance_cash_value IS NOT NULL AND symbol_currency = ?',
                    'table' => 'account',
                    'column' => 'opening_balance_cash_value',
                    'params' => [$code],
                ],
                [
                    'sql' => "account_id IN (SELECT id FROM account WHERE currency = ? AND type != 'investment')",
                    'table' => 'line',
                    'column' => 'amount',
                    'params' => [$code],
                ],
                [
                    'sql' => 'cash_value IS NOT NULL AND cash_currency = ?',
                    'table' => 'line',
                    'column' => 'cash_value',
                    'params' => [$code],
                ],
                [
                    'sql' => 'exchange_amount IS NOT NULL AND exchange_currency = ?',
                    'table' => 'line',
                    'column' => 'exchange_amount',
                    'params' => [$code],
                ],
            ];

            if ($delta < 0) {
                $lossy = 0;
                foreach ($targets as $t) {
                    $lossy += (int) $conn->fetchOne(
                        "SELECT COUNT(*) FROM {$t['table']} WHERE {$t['column']} % ? != 0 AND ({$t['sql']})",
                        [$divisor, ...$t['params']]
                    );
                }
                if ($lossy > 0) {
                    throw new \InvalidArgumentException(sprintf('Decreasing %s\'s scale would lose precision on %d existing amount(s) — refused.', $code, $lossy));
                }
            }

            $rowsTouched = 0;
            foreach ($targets as $t) {
                $rowsTouched += $conn->executeStatement(
                    "UPDATE {$t['table']} SET {$t['column']} = {$t['column']} {$op} ? WHERE {$t['sql']}",
                    [$divisor, ...$t['params']]
                );
            }

            $currency->setScale($newScale);
            $this->em->persist($currency);
            $this->em->flush();

            return $rowsTouched;
        });
    }
```

- [ ] **Step 2: Write the failing test**

```php
<?php

namespace App\Tests\Service;

use App\Entity\Account;
use App\Entity\Currency;
use App\Entity\Line;
use App\Service\LedgerStateService;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;

class LedgerStateServiceRescaleTest extends KernelTestCase
{
    private EntityManagerInterface $em;
    private LedgerStateService $service;

    protected function setUp(): void
    {
        self::bootKernel();
        $this->em = self::getContainer()->get(EntityManagerInterface::class);
        $this->service = self::getContainer()->get(LedgerStateService::class);

        $conn = $this->em->getConnection();
        $conn->executeStatement('DELETE FROM line');
        $conn->executeStatement('DELETE FROM account');
        $conn->executeStatement('DELETE FROM currency');
    }

    private function makeCurrency(string $code, int $scale): Currency
    {
        $c = (new Currency())->setCode($code)->setScale($scale);
        $this->em->persist($c);
        $this->em->flush();

        return $c;
    }

    private function makeAccount(string $id, Currency $currency, int $openingBalance): Account
    {
        $a = (new Account())->setName($id)->setType('asset')->setCurrency($currency)->setOpeningBalance($openingBalance);
        $a->setId($id);
        $this->em->persist($a);
        $this->em->flush();

        return $a;
    }

    private function makeLine(Account $account, int $amount): Line
    {
        $l = (new Line())->setAccount($account)->setAmount($amount)->setDate('2024-01-01');
        $this->em->persist($l);
        $this->em->flush();

        return $l;
    }

    public function testIncreasingScaleAlwaysSucceedsAndMultiplies(): void
    {
        $gbp = $this->makeCurrency('GBP', 2);
        $acc = $this->makeAccount('a1', $gbp, 2000);
        $this->makeLine($acc, 1500);

        $touched = $this->service->rescaleCurrency('GBP', 3);

        $this->assertSame(2, $touched);
        $this->em->clear();
        $refreshedAcc = $this->em->getRepository(Account::class)->find('a1');
        $this->assertSame(20000, $refreshedAcc->getOpeningBalance());
        $lines = $this->em->getRepository(Line::class)->findBy(['account' => $refreshedAcc]);
        $this->assertSame(15000, $lines[0]->getAmount());
        $this->assertSame(3, $this->em->getRepository(Currency::class)->find('GBP')->getScale());
    }

    public function testDecreasingScaleSucceedsWhenEverythingDividesEvenly(): void
    {
        $gbp = $this->makeCurrency('GBP', 3);
        $acc = $this->makeAccount('a1', $gbp, 20000);
        $this->makeLine($acc, 15000);

        $touched = $this->service->rescaleCurrency('GBP', 2);

        $this->assertSame(2, $touched);
        $this->em->clear();
        $this->assertSame(2000, $this->em->getRepository(Account::class)->find('a1')->getOpeningBalance());
    }

    public function testDecreasingScaleIsRefusedWhenItWouldLosePrecision(): void
    {
        $gbp = $this->makeCurrency('GBP', 3);
        $acc = $this->makeAccount('a1', $gbp, 20001); // not divisible by 10

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessageMatches('/lose precision on 1 existing amount/');
        $this->service->rescaleCurrency('GBP', 2);

        $this->em->clear();
        $this->assertSame(20001, $this->em->getRepository(Account::class)->find('a1')->getOpeningBalance(), 'refused rescale must not partially apply');
        $this->assertSame(3, $this->em->getRepository(Currency::class)->find('GBP')->getScale(), 'refused rescale must not touch the scale itself');
    }

    public function testRescalingOneCurrencyLeavesAnotherUntouched(): void
    {
        $gbp = $this->makeCurrency('GBP', 2);
        $usd = $this->makeCurrency('USD', 2);
        $gbpAcc = $this->makeAccount('gbp-acc', $gbp, 2000);
        $usdAcc = $this->makeAccount('usd-acc', $usd, 5000);

        $this->service->rescaleCurrency('GBP', 3);

        $this->em->clear();
        $this->assertSame(20000, $this->em->getRepository(Account::class)->find('gbp-acc')->getOpeningBalance());
        $this->assertSame(5000, $this->em->getRepository(Account::class)->find('usd-acc')->getOpeningBalance(), 'USD must be untouched by a GBP rescale');
    }
}
```

- [ ] **Step 2b: Run test to verify it fails**

```bash
cd backend && php bin/phpunit tests/Service/LedgerStateServiceRescaleTest.php
```

Expected: FAIL — `rescaleCurrency()` doesn't exist yet if Step 1 wasn't applied first, or passes immediately if it was (Step 1 and Step 2 are listed in dependency order — write Step 1's method, then this test, then confirm it's genuinely exercising the new code by temporarily reverting Step 1 and re-running once to see a real failure, per TDD discipline, before moving on).

- [ ] **Step 3: Run test to verify it passes**

```bash
cd backend && php bin/phpunit tests/Service/LedgerStateServiceRescaleTest.php
```

Expected: 4/4 passing.

- [ ] **Step 4: Rewrite `CurrencyController.php`**

Replace the whole file:

```php
<?php

namespace App\Controller;

use App\Entity\Currency;
use App\Service\LedgerStateService;
use Doctrine\DBAL\Exception\ForeignKeyConstraintViolationException;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Full admin CRUD for Currency — see
 * docs/superpowers/specs/2026-09-26-currency-symbol-admin-design.md.
 * `code` is immutable once created (it's the primary key); only `name`
 * and `scale` can be edited via PATCH. A `scale` edit rewrites every
 * dependent stored amount transactionally — see
 * LedgerStateService::rescaleCurrency(). Delete relies on the schema's
 * own foreign-key enforcement to refuse a still-referenced currency;
 * this controller just translates that into a clean 409.
 */
#[Route('/api/currencies')]
class CurrencyController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly LedgerStateService $state,
    ) {
    }

    #[Route('', methods: ['GET'])]
    public function list(): JsonResponse
    {
        $currencies = $this->em->getRepository(Currency::class)->findAll();

        return new JsonResponse(array_map(
            static fn (Currency $c) => array_filter([
                'code' => $c->getCode(),
                'scale' => $c->getScale(),
                'name' => $c->getName(),
            ], static fn ($v) => null !== $v),
            $currencies
        ));
    }

    #[Route('', methods: ['POST'])]
    public function create(Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);
        if (!\is_array($body)) {
            return new JsonResponse(['error' => 'Invalid JSON body'], 400);
        }

        $code = strtoupper(trim((string) ($body['code'] ?? '')));
        $scale = $body['scale'] ?? null;
        $name = isset($body['name']) ? trim((string) $body['name']) : null;

        if ('' === $code) {
            return new JsonResponse(['error' => 'Code is required'], 400);
        }
        if (!\is_int($scale) && !(\is_string($scale) && ctype_digit($scale))) {
            return new JsonResponse(['error' => 'Scale must be a non-negative integer'], 400);
        }
        $scale = (int) $scale;
        if ($scale < 0) {
            return new JsonResponse(['error' => 'Scale must be a non-negative integer'], 400);
        }
        if (null !== $this->em->getRepository(Currency::class)->find($code)) {
            return new JsonResponse(['error' => sprintf('Currency "%s" already exists', $code)], 409);
        }

        $currency = (new Currency())->setCode($code)->setScale($scale)->setName($name);
        $this->em->persist($currency);
        $this->em->flush();

        return new JsonResponse(array_filter([
            'code' => $currency->getCode(),
            'scale' => $currency->getScale(),
            'name' => $currency->getName(),
        ], static fn ($v) => null !== $v), 201);
    }

    #[Route('/{code}', methods: ['PATCH'])]
    public function patch(string $code, Request $request): JsonResponse
    {
        $currency = $this->em->getRepository(Currency::class)->find($code);
        if (!$currency) {
            return new JsonResponse(['error' => sprintf('Unknown currency "%s"', $code)], 404);
        }

        $body = json_decode($request->getContent(), true);
        if (!\is_array($body)) {
            return new JsonResponse(['error' => 'Invalid JSON body'], 400);
        }

        $rowsTouched = 0;
        try {
            if (\array_key_exists('scale', $body)) {
                $scale = $body['scale'];
                if (!\is_int($scale) && !(\is_string($scale) && ctype_digit($scale))) {
                    return new JsonResponse(['error' => 'Scale must be a non-negative integer'], 400);
                }
                $rowsTouched = $this->state->rescaleCurrency($code, (int) $scale);
            }
            if (\array_key_exists('name', $body)) {
                $currency->setName(null === $body['name'] ? null : trim((string) $body['name']));
                $this->em->persist($currency);
                $this->em->flush();
            }
        } catch (\InvalidArgumentException $e) {
            return new JsonResponse(['error' => $e->getMessage()], 400);
        }

        return new JsonResponse([
            'currency' => array_filter([
                'code' => $currency->getCode(),
                'scale' => $currency->getScale(),
                'name' => $currency->getName(),
            ], static fn ($v) => null !== $v),
            'rowsRescaled' => $rowsTouched,
        ]);
    }

    #[Route('/{code}', methods: ['DELETE'])]
    public function delete(string $code): JsonResponse
    {
        $currency = $this->em->getRepository(Currency::class)->find($code);
        if (!$currency) {
            return new JsonResponse(['error' => sprintf('Unknown currency "%s"', $code)], 404);
        }

        try {
            $this->em->remove($currency);
            $this->em->flush();
        } catch (ForeignKeyConstraintViolationException) {
            return new JsonResponse(['error' => sprintf('Currency "%s" is still in use and can\'t be deleted.', $code)], 409);
        }

        return new JsonResponse(['ok' => true]);
    }
}
```

- [ ] **Step 5: Lint and full test run**

```bash
cd backend
php -l src/Controller/CurrencyController.php
php -l src/Service/LedgerStateService.php
php bin/phpunit
```

Expected: no syntax errors, all tests green (10/10 — the original 6 plus this task's new 4).

- [ ] **Step 6: Manual verification against a scratch copy**

```bash
cd backend
cp databases/2020-2021.sqlite3 /tmp/verify-currency-admin.sqlite3
DATABASE_URL="sqlite:////tmp/verify-currency-admin.sqlite3" true # placeholder to show intent; use the override below instead
rm -f databases/av-currency-test.sqlite3 2>/dev/null
cp /tmp/verify-currency-admin.sqlite3 databases/av-currency-test.sqlite3
php -r "
require 'vendor/autoload.php';
\$repo = new App\Service\AppSettingsRepository(getcwd());
\$repo->write(['activeDatabase' => 'av-currency-test.sqlite3']);
"
symfony server:start --port=8498 -d
curl -s -w "\n[%{http_code}]\n" -X POST http://127.0.0.1:8498/api/currencies -H "Content-Type: application/json" -d '{"code":"XTS","scale":2,"name":"Test currency"}'
curl -s -w "\n[%{http_code}]\n" -X PATCH http://127.0.0.1:8498/api/currencies/XTS -H "Content-Type: application/json" -d '{"name":"Renamed test currency"}'
curl -s -w "\n[%{http_code}]\n" -X PATCH http://127.0.0.1:8498/api/currencies/XTS -H "Content-Type: application/json" -d '{"scale":4}'
curl -s -w "\n[%{http_code}]\n" -X DELETE http://127.0.0.1:8498/api/currencies/XTS
curl -s -w "\n[%{http_code}]\n" -X DELETE http://127.0.0.1:8498/api/currencies/GBP
pgrep -f "port=8498" | xargs -r kill
rm -f databases/av-currency-test.sqlite3 /tmp/verify-currency-admin.sqlite3
```

Expected: create `201`; name patch `200` with the new name reflected; scale patch `200` with `"rowsRescaled": 0` (a brand-new currency with nothing referencing it); delete `200 {"ok":true}` (unreferenced); deleting `GBP` (heavily referenced in this real copy) `409` with the "still in use" message.

- [ ] **Step 7: Commit**

```bash
git add backend/src/Controller/CurrencyController.php backend/src/Service/LedgerStateService.php backend/tests/Service/LedgerStateServiceRescaleTest.php
git commit -m "Currency admin endpoints: create/edit-name/edit-scale-with-rescale/delete"
```

---

### Task 3: `Symbol` admin endpoints and rescale

**Files:**
- Modify: `backend/src/Controller/SymbolController.php`
- Modify: `backend/src/Service/LedgerStateService.php`
- Test: `backend/tests/Service/LedgerStateServiceRescaleTest.php` (extend Task 2's file)

**Interfaces:**
- Consumes: `Symbol`'s composite key (Task 1), `LedgerStateService::resolveSymbol()` (Task 1).
- Produces: `LedgerStateService::rescaleSymbol(string $ticker, string $tradingCurrencyCode, int $newScale): int`.

- [ ] **Step 1: Add `rescaleSymbol()` to `LedgerStateService.php`**

Add alongside `rescaleCurrency()`:

```php
    /**
     * Same shape as rescaleCurrency(), but only touches unit-denominated
     * amounts for this exact (ticker, tradingCurrency) variant — a
     * Symbol's own scale never affects cash-side amounts (those are
     * currency-scaled, via tradingCurrency, which can't change — see
     * Symbol's docblock).
     */
    public function rescaleSymbol(string $ticker, string $tradingCurrencyCode, int $newScale): int
    {
        $currency = $this->em->getRepository(Currency::class)->find($tradingCurrencyCode);
        if (!$currency) {
            throw new \InvalidArgumentException(sprintf('Unknown currency code "%s".', $tradingCurrencyCode));
        }
        $symbol = $this->em->getRepository(Symbol::class)->find(['ticker' => $ticker, 'tradingCurrency' => $currency]);
        if (!$symbol) {
            throw new \InvalidArgumentException(sprintf('Unknown symbol "%s" in %s.', $ticker, $tradingCurrencyCode));
        }
        $delta = $newScale - $symbol->getScale();
        if (0 === $delta) {
            return 0;
        }

        return $this->em->wrapInTransaction(function () use ($symbol, $ticker, $tradingCurrencyCode, $delta, $newScale) {
            $conn = $this->em->getConnection();
            $divisor = 10 ** abs($delta);
            $op = $delta > 0 ? '*' : '/';

            /** @var array<int, array{sql: string, table: string, column: string, params: array<int, mixed>}> $targets */
            $targets = [
                [
                    'sql' => 'opening_balance IS NOT NULL AND symbol_ticker = ? AND symbol_currency = ?',
                    'table' => 'account',
                    'column' => 'opening_balance',
                    'params' => [$ticker, $tradingCurrencyCode],
                ],
                [
                    'sql' => 'account_id IN (SELECT id FROM account WHERE symbol_ticker = ? AND symbol_currency = ?)',
                    'table' => 'line',
                    'column' => 'amount',
                    'params' => [$ticker, $tradingCurrencyCode],
                ],
            ];

            if ($delta < 0) {
                $lossy = 0;
                foreach ($targets as $t) {
                    $lossy += (int) $conn->fetchOne(
                        "SELECT COUNT(*) FROM {$t['table']} WHERE {$t['column']} % ? != 0 AND ({$t['sql']})",
                        [$divisor, ...$t['params']]
                    );
                }
                if ($lossy > 0) {
                    throw new \InvalidArgumentException(sprintf('Decreasing %s (%s)\'s scale would lose precision on %d existing amount(s) — refused.', $ticker, $tradingCurrencyCode, $lossy));
                }
            }

            $rowsTouched = 0;
            foreach ($targets as $t) {
                $rowsTouched += $conn->executeStatement(
                    "UPDATE {$t['table']} SET {$t['column']} = {$t['column']} {$op} ? WHERE {$t['sql']}",
                    [$divisor, ...$t['params']]
                );
            }

            $symbol->setScale($newScale);
            $this->em->persist($symbol);
            $this->em->flush();

            return $rowsTouched;
        });
    }
```

- [ ] **Step 2: Write the failing tests**

Append to `backend/tests/Service/LedgerStateServiceRescaleTest.php` (inside the same class, reusing `$this->em`/`$this->service` from `setUp()`):

```php
    private function makeSymbol(string $ticker, Currency $tradingCurrency, int $scale): \App\Entity\Symbol
    {
        $s = (new \App\Entity\Symbol())->setTicker($ticker)->setName($ticker)->setScale($scale)->setTradingCurrency($tradingCurrency);
        $this->em->persist($s);
        $this->em->flush();

        return $s;
    }

    private function makeInvestmentAccount(string $id, \App\Entity\Symbol $symbol, int $openingBalance): Account
    {
        $a = (new Account())->setName($id)->setType('investment')->setSymbol($symbol)->setOpeningBalance($openingBalance);
        $a->setId($id);
        $this->em->persist($a);
        $this->em->flush();

        return $a;
    }

    public function testRescalingASymbolOnlyTouchesThatExactTradingCurrencyVariant(): void
    {
        $usd = $this->makeCurrency('USD', 2);
        $gbp = $this->makeCurrency('GBP', 2);
        $aaplUsd = $this->makeSymbol('AAPL', $usd, 6);
        $aaplGbp = $this->makeSymbol('AAPL', $gbp, 6);
        $usdAcc = $this->makeInvestmentAccount('aapl-usd-acc', $aaplUsd, 1500000);
        $gbpAcc = $this->makeInvestmentAccount('aapl-gbp-acc', $aaplGbp, 2500000);
        $this->makeLine($usdAcc, 500000);

        $touched = $this->service->rescaleSymbol('AAPL', 'USD', 3);

        $this->assertSame(2, $touched); // usdAcc's opening balance + its one line
        $this->em->clear();
        $this->assertSame(15000000, $this->em->getRepository(Account::class)->find('aapl-usd-acc')->getOpeningBalance());
        $this->assertSame(2500000, $this->em->getRepository(Account::class)->find('aapl-gbp-acc')->getOpeningBalance(), 'the GBP variant of the same ticker must be untouched');
        $line = $this->em->getRepository(Line::class)->findBy(['account' => $this->em->getRepository(Account::class)->find('aapl-usd-acc')])[0];
        $this->assertSame(5000000, $line->getAmount());
    }

    public function testRescalingASymbolLeavesCashValueUntouched(): void
    {
        $usd = $this->makeCurrency('USD', 2);
        $aapl = $this->makeSymbol('AAPL', $usd, 6);
        $acc = $this->makeInvestmentAccount('aapl-acc', $aapl, 1000000);
        $line = $this->makeLine($acc, 500000);
        $line->setCashValue(750000);
        $this->em->persist($line);
        $this->em->flush();

        $this->service->rescaleSymbol('AAPL', 'USD', 8);

        $this->em->clear();
        $refreshed = $this->em->getRepository(Line::class)->find($line->getId());
        $this->assertSame(750000, $refreshed->getCashValue(), 'cashValue is currency-scaled, not symbol-scaled — a Symbol rescale must never touch it');
        $this->assertSame(50000000, $refreshed->getAmount());
    }
```

- [ ] **Step 3: Run test to verify it passes**

```bash
cd backend && php bin/phpunit tests/Service/LedgerStateServiceRescaleTest.php
```

Expected: 6/6 passing (Task 2's 4 plus this task's 2).

- [ ] **Step 4: Rewrite `SymbolController.php`**

Replace the whole file:

```php
<?php

namespace App\Controller;

use App\Entity\Currency;
use App\Entity\Symbol;
use App\Service\LedgerStateService;
use Doctrine\DBAL\Exception\ForeignKeyConstraintViolationException;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Full admin CRUD for Symbol — see
 * docs/superpowers/specs/2026-09-26-currency-symbol-admin-design.md.
 * Identity is the pair (ticker, tradingCurrency) — the same ticker can
 * exist more than once, one row per trading currency, so the duplicate
 * check on create and the routes on PATCH/DELETE both key on the pair,
 * not the ticker alone. tradingCurrency itself is never editable (it's
 * part of the identity) — only name and scale can change via PATCH.
 */
#[Route('/api/symbols')]
class SymbolController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly LedgerStateService $state,
    ) {
    }

    #[Route('', methods: ['GET'])]
    public function list(): JsonResponse
    {
        $symbols = $this->em->getRepository(Symbol::class)->findAll();

        return new JsonResponse(array_map(
            static fn (Symbol $s) => [
                'ticker' => $s->getTicker(),
                'name' => $s->getName(),
                'scale' => $s->getScale(),
                'tradingCurrency' => $s->getTradingCurrency()->getCode(),
            ],
            $symbols
        ));
    }

    #[Route('', methods: ['POST'])]
    public function create(Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);
        if (!\is_array($body)) {
            return new JsonResponse(['error' => 'Invalid JSON body'], 400);
        }

        $ticker = strtoupper(trim((string) ($body['ticker'] ?? '')));
        $name = trim((string) ($body['name'] ?? ''));
        $scale = $body['scale'] ?? null;
        $tradingCurrencyCode = (string) ($body['tradingCurrency'] ?? '');

        if ('' === $ticker) {
            return new JsonResponse(['error' => 'Ticker is required'], 400);
        }
        if ('' === $name) {
            return new JsonResponse(['error' => 'Name is required'], 400);
        }
        if (!\is_int($scale) && !(\is_string($scale) && ctype_digit($scale))) {
            return new JsonResponse(['error' => 'Scale must be a non-negative integer'], 400);
        }
        $scale = (int) $scale;
        if ($scale < 0) {
            return new JsonResponse(['error' => 'Scale must be a non-negative integer'], 400);
        }

        $tradingCurrency = $this->em->getRepository(Currency::class)->find($tradingCurrencyCode);
        if (!$tradingCurrency) {
            return new JsonResponse(['error' => sprintf('Unknown trading currency "%s"', $tradingCurrencyCode)], 400);
        }

        if (null !== $this->em->getRepository(Symbol::class)->find(['ticker' => $ticker, 'tradingCurrency' => $tradingCurrency])) {
            return new JsonResponse(['error' => sprintf('Symbol "%s" in %s already exists', $ticker, $tradingCurrencyCode)], 409);
        }

        $symbol = (new Symbol())
            ->setTicker($ticker)
            ->setName($name)
            ->setScale($scale)
            ->setTradingCurrency($tradingCurrency);
        $this->em->persist($symbol);
        $this->em->flush();

        return new JsonResponse([
            'ticker' => $symbol->getTicker(),
            'name' => $symbol->getName(),
            'scale' => $symbol->getScale(),
            'tradingCurrency' => $symbol->getTradingCurrency()->getCode(),
        ], 201);
    }

    #[Route('/{ticker}/{tradingCurrency}', methods: ['PATCH'])]
    public function patch(string $ticker, string $tradingCurrency, Request $request): JsonResponse
    {
        $currency = $this->em->getRepository(Currency::class)->find($tradingCurrency);
        $symbol = $currency ? $this->em->getRepository(Symbol::class)->find(['ticker' => $ticker, 'tradingCurrency' => $currency]) : null;
        if (!$symbol) {
            return new JsonResponse(['error' => sprintf('Unknown symbol "%s" in %s', $ticker, $tradingCurrency)], 404);
        }

        $body = json_decode($request->getContent(), true);
        if (!\is_array($body)) {
            return new JsonResponse(['error' => 'Invalid JSON body'], 400);
        }

        $rowsTouched = 0;
        try {
            if (\array_key_exists('scale', $body)) {
                $scale = $body['scale'];
                if (!\is_int($scale) && !(\is_string($scale) && ctype_digit($scale))) {
                    return new JsonResponse(['error' => 'Scale must be a non-negative integer'], 400);
                }
                $rowsTouched = $this->state->rescaleSymbol($ticker, $tradingCurrency, (int) $scale);
            }
            if (\array_key_exists('name', $body)) {
                $name = trim((string) $body['name']);
                if ('' === $name) {
                    return new JsonResponse(['error' => 'Name is required'], 400);
                }
                $symbol->setName($name);
                $this->em->persist($symbol);
                $this->em->flush();
            }
        } catch (\InvalidArgumentException $e) {
            return new JsonResponse(['error' => $e->getMessage()], 400);
        }

        return new JsonResponse([
            'symbol' => [
                'ticker' => $symbol->getTicker(),
                'name' => $symbol->getName(),
                'scale' => $symbol->getScale(),
                'tradingCurrency' => $symbol->getTradingCurrency()->getCode(),
            ],
            'rowsRescaled' => $rowsTouched,
        ]);
    }

    #[Route('/{ticker}/{tradingCurrency}', methods: ['DELETE'])]
    public function delete(string $ticker, string $tradingCurrency): JsonResponse
    {
        $currency = $this->em->getRepository(Currency::class)->find($tradingCurrency);
        $symbol = $currency ? $this->em->getRepository(Symbol::class)->find(['ticker' => $ticker, 'tradingCurrency' => $currency]) : null;
        if (!$symbol) {
            return new JsonResponse(['error' => sprintf('Unknown symbol "%s" in %s', $ticker, $tradingCurrency)], 404);
        }

        try {
            $this->em->remove($symbol);
            $this->em->flush();
        } catch (ForeignKeyConstraintViolationException) {
            return new JsonResponse(['error' => sprintf('Symbol "%s" in %s is still in use and can\'t be deleted.', $ticker, $tradingCurrency)], 409);
        }

        return new JsonResponse(['ok' => true]);
    }
}
```

- [ ] **Step 5: Lint and full test run**

```bash
cd backend
php -l src/Controller/SymbolController.php
php -l src/Service/LedgerStateService.php
php bin/phpunit
```

Expected: no syntax errors, 12/12 tests green (6 original + 4 from Task 2 + 2 from this task).

- [ ] **Step 6: Manual verification against a scratch copy**

```bash
cd backend
rm -f databases/av-symbol-test.sqlite3
cp databases/2020-2021.sqlite3 databases/av-symbol-test.sqlite3
php -r "
require 'vendor/autoload.php';
\$repo = new App\Service\AppSettingsRepository(getcwd());
\$repo->write(['activeDatabase' => 'av-symbol-test.sqlite3']);
"
symfony server:start --port=8499 -d
curl -s -w "\n[%{http_code}]\n" -X POST http://127.0.0.1:8499/api/symbols -H "Content-Type: application/json" -d '{"ticker":"ZZZT","name":"Test Co","scale":6,"tradingCurrency":"USD"}'
curl -s -w "\n[%{http_code}]\n" -X POST http://127.0.0.1:8499/api/symbols -H "Content-Type: application/json" -d '{"ticker":"ZZZT","name":"Test Co (GBP line)","scale":6,"tradingCurrency":"GBP"}'
curl -s -w "\n[%{http_code}]\n" -X POST http://127.0.0.1:8499/api/symbols -H "Content-Type: application/json" -d '{"ticker":"ZZZT","name":"dup","scale":6,"tradingCurrency":"USD"}'
curl -s -w "\n[%{http_code}]\n" -X PATCH http://127.0.0.1:8499/api/symbols/ZZZT/USD -H "Content-Type: application/json" -d '{"name":"Test Co Renamed"}'
curl -s -w "\n[%{http_code}]\n" -X DELETE http://127.0.0.1:8499/api/symbols/ZZZT/USD
curl -s -w "\n[%{http_code}]\n" -X DELETE http://127.0.0.1:8499/api/symbols/ZZZT/GBP
pgrep -f "port=8499" | xargs -r kill
rm -f databases/av-symbol-test.sqlite3
```

Expected: first two creates `201` each (same ticker, different currency — both succeed); the third `409` (exact duplicate pair); the name patch `200`; both deletes `200` (nothing references this scratch symbol).

- [ ] **Step 7: Commit**

```bash
git add backend/src/Controller/SymbolController.php backend/src/Service/LedgerStateService.php backend/tests/Service/LedgerStateServiceRescaleTest.php
git commit -m "Symbol admin endpoints: create/edit-name/edit-scale-with-rescale/delete, composite duplicate check"
```

---

### Task 4: Frontend logic layer — `lib/symbolKey.js`, `lib/format.js`, `api.js`

**Files:**
- Create: `src/lib/symbolKey.js`
- Modify: `src/lib/format.js`
- Modify: `src/api.js`

**Interfaces:**
- Produces: `symbolKey(ticker, tradingCurrency): string`, `parseSymbolKey(key): {ticker, tradingCurrency}`; `fmtUnits(n, symbolKeyString)` (was `fmtUnits(n, ticker)` — same 2-arg shape, the second argument's *meaning* changes); `api.createCurrency(data)`, `api.patchCurrency(code, data)`, `api.deleteCurrency(code)`, `api.patchSymbol(ticker, tradingCurrency, data)`, `api.deleteSymbol(ticker, tradingCurrency)`.
- Consumes: nothing from other tasks (pure logic + thin API wrappers).

- [ ] **Step 1: Create `src/lib/symbolKey.js`**

```javascript
// A Symbol's real identity is (ticker, tradingCurrency) now — the same
// ticker can exist more than once, one row per trading currency (see
// CLAUDE.md's "Amounts, currencies, and reference data"). This is the
// one place that encodes/decodes that pair as a single string, for
// spots that need exactly one value — a <select>'s value, the
// fmtUnits()/scale-cache lookup key (see lib/format.js). Never sent over
// the wire: the API always carries the two parts separately
// (symbolTicker/symbolCurrency on an Account, ticker/tradingCurrency on
// a Symbol) — this key is a client-side-only convenience.
export function symbolKey(ticker, tradingCurrency) {
  return `${ticker}:${tradingCurrency}`;
}
export function parseSymbolKey(key) {
  const i = key.indexOf(":");
  return { ticker: key.slice(0, i), tradingCurrency: key.slice(i + 1) };
}
```

- [ ] **Step 2: Update `lib/format.js`'s symbol-scale cache**

Replace:

```javascript
export function setSymbolScales(symbols) {
  symbolScales = Object.fromEntries((symbols || []).map((s) => [s.ticker, s.scale]));
}
```

with:

```javascript
export function setSymbolScales(symbols) {
  symbolScales = Object.fromEntries((symbols || []).map((s) => [symbolKey(s.ticker, s.tradingCurrency), s.scale]));
}
```

Add the import at the top of the file:

```javascript
import { symbolKey } from "./symbolKey";
```

Replace:

```javascript
function scaleForSymbol(ticker) {
  return symbolScales[ticker] ?? 6;
}
```

with:

```javascript
function scaleForSymbol(key) {
  return symbolScales[key] ?? 6;
}
```

Update `fmtUnits()`'s docblock comment (currently `` `symbol` is the ticker (a plain string, e.g. "AAPL") ``) to:

```javascript
// Trims trailing zeros but keeps up to the symbol's own scale of decimal
// places, for fractional share counts. `symbolKeyString` is the composite
// key from lib/symbolKey.js's symbolKey(ticker, tradingCurrency) — not a
// bare ticker, since the same ticker can now exist under more than one
// trading currency, each with its own scale.
export function fmtUnits(n, symbolKeyString) {
  const scale = scaleForSymbol(symbolKeyString);
```

(only the parameter name changes for clarity — the function body's `scaleForSymbol(symbolKeyString)` call already matches.)

- [ ] **Step 3: Add admin functions to `api.js`**

Replace:

```javascript
export function getCurrencies() {
  return request("/api/currencies");
}
export function getSymbols() {
  return request("/api/symbols");
}
// The one write endpoint among these three — see SymbolController's
// docblock for why: a blank database has no symbols at all, so without
// this there'd be no way to create the very first investment account.
export function createSymbol(symbol) {
  return request("/api/symbols", { method: "POST", ...jsonBody(symbol) });
}
```

with:

```javascript
export function getCurrencies() {
  return request("/api/currencies");
}
export function createCurrency(currency) {
  return request("/api/currencies", { method: "POST", ...jsonBody(currency) });
}
export function patchCurrency(code, patch) {
  return request(`/api/currencies/${encodeURIComponent(code)}`, { method: "PATCH", ...jsonBody(patch) });
}
export function deleteCurrency(code) {
  return request(`/api/currencies/${encodeURIComponent(code)}`, { method: "DELETE" });
}
export function getSymbols() {
  return request("/api/symbols");
}
// createSymbol() predates full admin CRUD — see SymbolController's
// docblock for why it exists on its own: a blank database has no symbols
// at all, so without it there'd be no way to create the very first
// investment account. patchSymbol()/deleteSymbol() key on the pair
// (ticker, tradingCurrency), not the ticker alone, since the same ticker
// can exist more than once now.
export function createSymbol(symbol) {
  return request("/api/symbols", { method: "POST", ...jsonBody(symbol) });
}
export function patchSymbol(ticker, tradingCurrency, patch) {
  return request(`/api/symbols/${encodeURIComponent(ticker)}/${encodeURIComponent(tradingCurrency)}`, { method: "PATCH", ...jsonBody(patch) });
}
export function deleteSymbol(ticker, tradingCurrency) {
  return request(`/api/symbols/${encodeURIComponent(ticker)}/${encodeURIComponent(tradingCurrency)}`, { method: "DELETE" });
}
```

- [ ] **Step 4: Build**

```bash
cd /Users/radu/Code/Claude/ledger-project && yarn build
```

Expected: clean build (Task 5 hasn't run yet, so every existing call site still passes a bare ticker into `fmtUnits`/reads `.symbol` — this won't break the *build*, since JS doesn't type-check that, but note in your report that display will be visually wrong for symbol-scale lookups until Task 5 lands; this is expected, not a regression to chase down now).

- [ ] **Step 5: Commit**

```bash
git add src/lib/symbolKey.js src/lib/format.js src/api.js
git commit -m "Frontend logic: symbolKey() composite-key helper, rekeyed symbol-scale cache, admin API functions"
```

---

### Task 5: Frontend ripple — every symbol lookup becomes `(ticker, tradingCurrency)`

**Files:**
- Modify: `src/components/AccountFormModal.jsx`
- Modify: `src/components/otherLines.jsx`
- Modify: `src/components/StockLedger.jsx`
- Modify: `src/components/IsaParentView.jsx`
- Modify: `src/components/AccountRow.jsx`
- Modify: `src/components/SidebarGroupTree.jsx`
- Modify: `src/components/AccountPicker.jsx`
- Modify: `src/components/TagsView.jsx`
- Modify: `src/components/charts.jsx`
- Modify: `src/lib/matching.js`
- Modify: `src/lib/grouping.js`
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `symbolKey()`/`parseSymbolKey()` (Task 4), the wire rename `symbol` → `symbolTicker`/`symbolCurrency` on every `Account` object (Task 1's backend change — every account the frontend already receives from `GET /api/accounts` now carries these two fields instead of one).
- Produces: nothing later tasks depend on.

Every site below follows one of two patterns:
- **A trading-currency lookup that used to search `symbols` by ticker** (`symbols.find((s) => s.ticker === X.symbol)?.tradingCurrency`) **simplifies to a direct field read** (`X.symbolCurrency`) — no search needed, since the account object already carries its own trading-currency code directly once `symbol` is renamed to `symbolTicker`/`symbolCurrency`.
- **A scale lookup or a `<select>` value that genuinely needs to identify one specific `Symbol` row** uses `symbolKey(ticker, tradingCurrency)` from Task 4.

- [ ] **Step 1: `AccountFormModal.jsx`**

Add the import:

```javascript
import { symbolKey, parseSymbolKey } from "../lib/symbolKey";
```

Replace:

```javascript
  const [symbol, setSymbol] = useState(initial.symbol || "");
```

with:

```javascript
  const [symbol, setSymbol] = useState(initial.symbolTicker && initial.symbolCurrency ? symbolKey(initial.symbolTicker, initial.symbolCurrency) : "");
```

Replace:

```javascript
  const tradingCurrency = symbols.find((s) => s.ticker === symbol)?.tradingCurrency;
```

with:

```javascript
  const tradingCurrency = symbol ? parseSymbolKey(symbol).tradingCurrency : undefined;
```

In `submitNewSymbol()`, replace:

```javascript
        onSymbolCreated(created);
        setSymbol(created.ticker);
```

with:

```javascript
        onSymbolCreated(created);
        setSymbol(symbolKey(created.ticker, created.tradingCurrency));
```

In `submit()`, replace:

```javascript
      ...(type === "investment" ? { symbol: symbol.trim().toUpperCase() } : { currency }),
```

with:

```javascript
      ...(type === "investment" ? { symbolTicker: parseSymbolKey(symbol).ticker, symbolCurrency: parseSymbolKey(symbol).tradingCurrency } : { currency }),
```

Replace the symbol `<select>`'s options:

```javascript
                <select value={symbol} onChange={(e) => setSymbol(e.target.value)} style={inputStyle}>
                  <option value="">Select symbol…</option>
                  {symbols.map((s) => <option key={s.ticker} value={s.ticker}>{s.ticker} — {s.name}</option>)}
                </select>
```

with:

```javascript
                <select value={symbol} onChange={(e) => setSymbol(e.target.value)} style={inputStyle}>
                  <option value="">Select symbol…</option>
                  {symbols.map((s) => <option key={symbolKey(s.ticker, s.tradingCurrency)} value={symbolKey(s.ticker, s.tradingCurrency)}>{s.ticker} — {s.name} ({s.tradingCurrency})</option>)}
                </select>
```

- [ ] **Step 2: `otherLines.jsx`**

Add the import:

```javascript
import { symbolKey } from "../lib/symbolKey";
```

Replace:

```javascript
  function tradingCurrencyFor(acc) {
    return symbols.find((s) => s.ticker === acc?.symbol)?.tradingCurrency;
  }
```

with:

```javascript
  function tradingCurrencyFor(acc) {
    return acc?.symbolCurrency;
  }
```

Replace:

```javascript
  function scaleForSymbol(ticker) {
    return symbols.find((s) => s.ticker === ticker)?.scale ?? 6;
  }
```

with:

```javascript
  function scaleForSymbol(ticker, tradingCurrency) {
    return symbols.find((s) => s.ticker === ticker && s.tradingCurrency === tradingCurrency)?.scale ?? 6;
  }
```

Replace (in `otherLineFromLine()`):

```javascript
      base.unitsStr = fromMinorUnits(Math.abs(o.amount), scaleForSymbol(oAcc.symbol));
```

with:

```javascript
      base.unitsStr = fromMinorUnits(Math.abs(o.amount), scaleForSymbol(oAcc.symbolTicker, oAcc.symbolCurrency));
```

Replace (in `resolveOtherLine()`):

```javascript
      const unitsMag = Math.abs(toMinorUnits(ol.unitsStr, scaleForSymbol(olAcc.symbol)));
```

with:

```javascript
      const unitsMag = Math.abs(toMinorUnits(ol.unitsStr, scaleForSymbol(olAcc.symbolTicker, olAcc.symbolCurrency)));
```

In `OtherLinesEditor`, replace:

```javascript
            const olTradingCurrency = isStock ? symbols.find((s) => s.ticker === olAcc.symbol)?.tradingCurrency : null;
```

with:

```javascript
            const olTradingCurrency = isStock ? olAcc.symbolCurrency : null;
```

(the `symbols` prop is still used elsewhere in this file's callers/`AccountPicker` — don't remove the prop itself, just these two now-unnecessary lookups.)

- [ ] **Step 3: `StockLedger.jsx`**

Replace:

```javascript
  const unitScale = symbols.find((s) => s.ticker === account.symbol)?.scale ?? 6;
  const tradingCurrency = symbols.find((s) => s.ticker === account.symbol)?.tradingCurrency;
```

with:

```javascript
  const unitScale = symbols.find((s) => s.ticker === account.symbolTicker && s.tradingCurrency === account.symbolCurrency)?.scale ?? 6;
  const tradingCurrency = account.symbolCurrency;
```

Add the import:

```javascript
import { symbolKey } from "../lib/symbolKey";
```

Replace every one of the following `fmtUnits(X, account.symbol)` call sites — there are 6 in this file — with `fmtUnits(X, symbolKey(account.symbolTicker, account.symbolCurrency))`, keeping everything else about each line identical:

```javascript
            {fmtUnits(balance, account.symbol)} <span style={{ fontSize: 14, color: C.inkFaint }}>units</span>
```
→
```javascript
            {fmtUnits(balance, symbolKey(account.symbolTicker, account.symbolCurrency))} <span style={{ fontSize: 14, color: C.inkFaint }}>units</span>
```

```javascript
              <div className="ll-mono text-right">{account.openingBalance < 0 ? fmtUnits(-account.openingBalance, account.symbol) : "—"}</div>
              <div className="ll-mono text-right">{account.openingBalance > 0 ? fmtUnits(account.openingBalance, account.symbol) : "—"}</div>
              <div className="ll-mono text-right" style={{ fontWeight: 600 }}>{fmtUnits(account.openingBalance, account.symbol)}</div>
```
→
```javascript
              <div className="ll-mono text-right">{account.openingBalance < 0 ? fmtUnits(-account.openingBalance, symbolKey(account.symbolTicker, account.symbolCurrency)) : "—"}</div>
              <div className="ll-mono text-right">{account.openingBalance > 0 ? fmtUnits(account.openingBalance, symbolKey(account.symbolTicker, account.symbolCurrency)) : "—"}</div>
              <div className="ll-mono text-right" style={{ fontWeight: 600 }}>{fmtUnits(account.openingBalance, symbolKey(account.symbolTicker, account.symbolCurrency))}</div>
```

```javascript
                  <div className="ll-mono text-right" style={{ fontWeight: 600, fontSize: 13.5 }}>{fmtUnits(r.running, account.symbol)}</div>
```
→
```javascript
                  <div className="ll-mono text-right" style={{ fontWeight: 600, fontSize: 13.5 }}>{fmtUnits(r.running, symbolKey(account.symbolTicker, account.symbolCurrency))}</div>
```

```javascript
                <div className="ll-mono text-right" style={{ color: unitsOut ? C.debit : C.inkFaint }}>{unitsOut ? fmtUnits(unitsOut, account.symbol) : "—"}</div>
                <div className="ll-mono text-right" style={{ color: unitsIn ? C.credit : C.inkFaint }}>{unitsIn ? fmtUnits(unitsIn, account.symbol) : "—"}</div>
                <div className="ll-mono text-right" style={{ fontWeight: 600 }}>{fmtUnits(r.running, account.symbol)}</div>
```
→
```javascript
                <div className="ll-mono text-right" style={{ color: unitsOut ? C.debit : C.inkFaint }}>{unitsOut ? fmtUnits(unitsOut, symbolKey(account.symbolTicker, account.symbolCurrency)) : "—"}</div>
                <div className="ll-mono text-right" style={{ color: unitsIn ? C.credit : C.inkFaint }}>{unitsIn ? fmtUnits(unitsIn, symbolKey(account.symbolTicker, account.symbolCurrency)) : "—"}</div>
                <div className="ll-mono text-right" style={{ fontWeight: 600 }}>{fmtUnits(r.running, symbolKey(account.symbolTicker, account.symbolCurrency))}</div>
```

Replace the ticker *display* (not a `fmtUnits` call):

```javascript
          <h2 className="ll-serif" style={{ fontSize: 24, marginTop: 2 }}>{displayAccountName(account)} <span style={{ color: C.gold }}>{account.symbol}</span></h2>
```

with:

```javascript
          <h2 className="ll-serif" style={{ fontSize: 24, marginTop: 2 }}>{displayAccountName(account)} <span style={{ color: C.gold }}>{account.symbolTicker}</span></h2>
```

Replace:

```javascript
      line1.cashCurrency = tradingCurrency;
```

— no change needed here, `tradingCurrency` is already the local variable simplified above.

- [ ] **Step 4: `IsaParentView.jsx`**

Add the import:

```javascript
import { symbolKey } from "../lib/symbolKey";
```

Replace:

```javascript
              const tradingCurrency = symbols.find((s) => s.ticker === a.symbol)?.tradingCurrency;
```

with:

```javascript
              const tradingCurrency = a.symbolCurrency;
```

Replace:

```javascript
                  <span style={{ fontSize: 13.5 }}>{displayAccountName(a)} <span style={{ color: C.gold, fontSize: 12 }}>{a.symbol}</span></span>
                  <span className="ll-mono" style={{ fontSize: 13.5 }}>{fmtUnits(a.balance || 0, a.symbol)} units · {fmt(a.portfolioValue || 0, tradingCurrency)}</span>
```

with:

```javascript
                  <span style={{ fontSize: 13.5 }}>{displayAccountName(a)} <span style={{ color: C.gold, fontSize: 12 }}>{a.symbolTicker}</span></span>
                  <span className="ll-mono" style={{ fontSize: 13.5 }}>{fmtUnits(a.balance || 0, symbolKey(a.symbolTicker, a.symbolCurrency))} units · {fmt(a.portfolioValue || 0, tradingCurrency)}</span>
```

- [ ] **Step 5: `AccountRow.jsx`**

Add the import:

```javascript
import { symbolKey } from "../lib/symbolKey";
```

Replace:

```javascript
  const tradingCurrency = symbols.find((s) => s.ticker === a.symbol)?.tradingCurrency;
```

with:

```javascript
  const tradingCurrency = a.symbolCurrency;
```

Replace:

```javascript
    "investment" === a.type ? a.symbol : null,
```

with:

```javascript
    "investment" === a.type ? a.symbolTicker : null,
```

Replace:

```javascript
            <span style={{ color: C.inkFaint }}>{fmtUnits(a.balance || 0, a.symbol)} units</span>
```

with:

```javascript
            <span style={{ color: C.inkFaint }}>{fmtUnits(a.balance || 0, symbolKey(a.symbolTicker, a.symbolCurrency))} units</span>
```

- [ ] **Step 6: `SidebarGroupTree.jsx`**

Replace:

```javascript
          const imbalanceCurrency = a.type === "investment" ? symbols.find((s) => s.ticker === a.symbol)?.tradingCurrency : a.currency;
```

with:

```javascript
          const imbalanceCurrency = a.type === "investment" ? a.symbolCurrency : a.currency;
```

(the `symbols` prop may now be unused in this file — if so, remove it from the function signature and its call site in `App.jsx`/wherever it's passed, but only if nothing else in this file still uses it; check before removing.)

- [ ] **Step 7: `AccountPicker.jsx`**

Replace:

```javascript
function accountLabel(a) {
  return `${displayAccountName(a)} (${a.type === "investment" ? a.symbol : a.currency})`;
}
```

with:

```javascript
function accountLabel(a) {
  return `${displayAccountName(a)} (${a.type === "investment" ? a.symbolTicker : a.currency})`;
}
```

- [ ] **Step 8: `TagsView.jsx`**

Add the import:

```javascript
import { symbolKey } from "../lib/symbolKey";
```

Replace:

```javascript
                        ? `${fmtUnits(l.line.amount, l.account.symbol)} units`
```

with:

```javascript
                        ? `${fmtUnits(l.line.amount, symbolKey(l.account.symbolTicker, l.account.symbolCurrency))} units`
```

- [ ] **Step 9: `charts.jsx`**

Add the import:

```javascript
import { symbolKey } from "../lib/symbolKey";
```

Replace:

```javascript
      {row(C.gold, "Units", byKey.units && byKey.units.value, (v) => `${fmtUnits(v, account.symbol)} ${account.symbol}`)}
```
and
```javascript
          {row(C.goldDim, "Units, last year", byKey.unitsPrev && byKey.unitsPrev.value, (v) => `${fmtUnits(v, account.symbol)} ${account.symbol}`)}
```

with:

```javascript
      {row(C.gold, "Units", byKey.units && byKey.units.value, (v) => `${fmtUnits(v, symbolKey(account.symbolTicker, account.symbolCurrency))} ${account.symbolTicker}`)}
```
and
```javascript
          {row(C.goldDim, "Units, last year", byKey.unitsPrev && byKey.unitsPrev.value, (v) => `${fmtUnits(v, symbolKey(account.symbolTicker, account.symbolCurrency))} ${account.symbolTicker}`)}
```

Replace:

```javascript
            <YAxis yAxisId="units" tickFormatter={(v) => fmtUnits(v, account.symbol)} tick={{ fontSize: 11, fill: C.gold }} axisLine={false} tickLine={false} width={55} />
```

with:

```javascript
            <YAxis yAxisId="units" tickFormatter={(v) => fmtUnits(v, symbolKey(account.symbolTicker, account.symbolCurrency))} tick={{ fontSize: 11, fill: C.gold }} axisLine={false} tickLine={false} width={55} />
```

Replace:

```javascript
            <Bar yAxisId="units" dataKey="units" name={`${account.symbol} units`} fill={C.gold} fillOpacity={0.3} isAnimationActive={false} />
```

with:

```javascript
            <Bar yAxisId="units" dataKey="units" name={`${account.symbolTicker} units`} fill={C.gold} fillOpacity={0.3} isAnimationActive={false} />
```

- [ ] **Step 10: `lib/matching.js`**

Add the import:

```javascript
import { symbolKey } from "./symbolKey";
```

Replace:

```javascript
    return `${fmtUnits(c.line.amount, c.account.symbol)} units · ${fmt(natural, c.line.cashCurrency)}`;
```

with:

```javascript
    return `${fmtUnits(c.line.amount, symbolKey(c.account.symbolTicker, c.account.symbolCurrency))} units · ${fmt(natural, c.line.cashCurrency)}`;
```

- [ ] **Step 11: `lib/grouping.js`**

Replace both occurrences of:

```javascript
    const cur = (a.type === "investment" ? symbols.find((s) => s.ticker === a.symbol)?.tradingCurrency : a.currency) || "—";
```

(in `bucketBy()`) and:

```javascript
    const currency = (a.type === "investment" ? symbols.find((s) => s.ticker === a.symbol)?.tradingCurrency : a.currency) || "—";
```

(in `flattenAllAccounts()`) with, respectively:

```javascript
    const cur = (a.type === "investment" ? a.symbolCurrency : a.currency) || "—";
```

```javascript
    const currency = (a.type === "investment" ? a.symbolCurrency : a.currency) || "—";
```

(the `symbols` parameter of both functions may become unused after this — check every other line in each function before removing it from the signature; `buildNestedGroups()` and any other caller passing `symbols` through should keep doing so unless you've confirmed nothing in `grouping.js` still needs it.)

- [ ] **Step 12: `App.jsx`**

Replace (in `accountDisplay()`):

```javascript
      const tradingCurrency = symbols.find((s) => s.ticker === a.symbol)?.tradingCurrency;
      return `${fmtUnits(bal, a.symbol)} ${a.symbol} · ${fmt(a.portfolioValue || 0, tradingCurrency)}`;
```

with:

```javascript
      const tradingCurrency = a.symbolCurrency;
      return `${fmtUnits(bal, symbolKey(a.symbolTicker, a.symbolCurrency))} ${a.symbolTicker} · ${fmt(a.portfolioValue || 0, tradingCurrency)}`;
```

Add the import alongside the existing `lib/format.js` import line:

```javascript
import { symbolKey } from "./lib/symbolKey";
```

- [ ] **Step 13: Build**

```bash
cd /Users/radu/Code/Claude/ledger-project && yarn build
```

Expected: clean build.

- [ ] **Step 14: Manual browser verification**

Set up a scratch backend exactly as prior sessions' verification steps do (fresh migrated + currency-seeded `.sqlite3` file, `app-settings.yaml` pointed at it, `vite.config.js`'s dev proxy temporarily pointed at the scratch backend's port, `yarn dev` restarted). In the browser:

1. Create a symbol `AAPL` traded in `USD`, then a second symbol `AAPL` traded in `GBP` via the "+ Add a new symbol" flow — confirm both succeed and both appear as distinct options (`AAPL — Apple Inc (USD)` / `AAPL — Apple Inc (GBP)`) in a new investment account's Symbol picker.
2. Create an investment wrapper, then an investment account using the `USD` variant — confirm it saves, and its ledger page shows the right ticker, units, and `$`-denominated cost basis/portfolio value.
3. Create a second investment account under the same (or a new) wrapper using the `GBP` variant of `AAPL` — confirm it's treated as a fully independent holding (its own units/cost basis, `£`-denominated).
4. Add a trade to each and confirm the running units/cost-basis columns and the chart both display correctly for each independently.
5. Reopen each account's edit form — confirm the Symbol picker correctly re-selects the right variant (not just any `AAPL`).

Revert `vite.config.js` and stop/clean up the scratch backend afterward.

- [ ] **Step 15: Commit**

```bash
git add src/components/AccountFormModal.jsx src/components/otherLines.jsx src/components/StockLedger.jsx src/components/IsaParentView.jsx src/components/AccountRow.jsx src/components/SidebarGroupTree.jsx src/components/AccountPicker.jsx src/components/TagsView.jsx src/components/charts.jsx src/lib/matching.js src/lib/grouping.js src/App.jsx
git commit -m "Frontend: every symbol lookup keys on (ticker, tradingCurrency), not ticker alone"
```

---

### Task 6: Frontend UI — `ReferenceDataView.jsx` admin screen

**Files:**
- Create: `src/components/ReferenceDataView.jsx`
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `api.createCurrency`/`patchCurrency`/`deleteCurrency`/`createSymbol`/`patchSymbol`/`deleteSymbol` (Task 4), `symbolKey()` (Task 4).
- Produces: nothing later tasks depend on — this is the last code task.

- [ ] **Step 1: Create `src/components/ReferenceDataView.jsx`**

```javascript
import { useState } from "react";
import { Trash2, Plus } from "lucide-react";
import { C } from "../lib/theme";
import * as api from "../api";
import { inputStyle } from "./ui";

// Full admin CRUD for Currency/Symbol — see
// docs/superpowers/specs/2026-09-26-currency-symbol-admin-design.md.
// None of these writes are optimistic: every mutation awaits its
// response, then triggers onRefresh() (App.jsx's currencies/symbols
// refetch) so every other view (pickers, fmt/fmtUnits's scale cache,
// grouping) picks up the change — same "wait for the response" posture
// CLAUDE.md documents for everything except the plain account/settings
// save.
export function ReferenceDataView({ currencies, symbols, onRefresh }) {
  const [error, setError] = useState("");

  function withErrorHandling(fn) {
    return (...args) =>
      fn(...args)
        .then(() => { setError(""); return onRefresh(); })
        .catch((e) => setError(e.message));
  }

  return (
    <div className="flex flex-col gap-8">
      <h2 className="ll-serif" style={{ fontSize: 20 }}>Reference data</h2>
      {error && (
        <div className="px-3 py-2 rounded" style={{ background: C.debitBg, color: C.debit, fontSize: 13 }}>{error}</div>
      )}
      <CurrencySection currencies={currencies} onMutate={withErrorHandling} />
      <SymbolSection symbols={symbols} currencies={currencies} onMutate={withErrorHandling} />
    </div>
  );
}

function CurrencySection({ currencies, onMutate }) {
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newScale, setNewScale] = useState("2");

  const create = onMutate(() => api.createCurrency({ code: newCode.trim().toUpperCase(), name: newName.trim() || undefined, scale: parseInt(newScale, 10) }));
  const patchName = onMutate((code, name) => api.patchCurrency(code, { name }));
  const changeScale = onMutate((code, scale) => api.patchCurrency(code, { scale }));
  const remove = onMutate((code) => api.deleteCurrency(code));

  function submitNew() {
    if (!newCode.trim()) return;
    create().then(() => { setNewCode(""); setNewName(""); setNewScale("2"); });
  }

  return (
    <section>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: C.inkSoft, marginBottom: 8 }}>Currencies</h3>
      <div className="flex flex-col gap-1.5">
        {currencies.map((c) => (
          <CurrencyRow key={c.code} currency={c} onPatchName={(name) => patchName(c.code, name)} onChangeScale={(scale) => changeScale(c.code, scale)} onDelete={() => remove(c.code)} />
        ))}
      </div>
      <div className="flex items-center gap-2 mt-3">
        <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="Code, e.g. NZD" style={{ ...inputStyle, width: 90 }} />
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name (optional)" style={{ ...inputStyle, width: 200 }} />
        <input type="number" min="0" step="1" value={newScale} onChange={(e) => setNewScale(e.target.value)} placeholder="Scale" style={{ ...inputStyle, width: 70 }} />
        <button type="button" onClick={submitNew} className="flex items-center gap-1" style={{ fontSize: 12.5, color: C.gold }}><Plus size={13} /> Add currency</button>
      </div>
    </section>
  );
}

function CurrencyRow({ currency, onPatchName, onChangeScale, onDelete }) {
  const [name, setName] = useState(currency.name || "");

  function changeScale() {
    const next = window.prompt(`New scale for ${currency.code} (currently ${currency.scale}):`, String(currency.scale));
    if (null === next || next.trim() === "") return;
    const parsed = parseInt(next, 10);
    if (!Number.isInteger(parsed) || parsed < 0) return;
    if (parsed === currency.scale) return;
    if (!window.confirm(`Changing ${currency.code}'s scale from ${currency.scale} to ${parsed} will rescale every existing amount using it and cannot be undone. Continue?`)) return;
    onChangeScale(parsed);
  }

  return (
    <div className="flex items-center gap-2" style={{ padding: "4px 0" }}>
      <span className="ll-mono" style={{ width: 50, fontWeight: 600 }}>{currency.code}</span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name !== (currency.name || "") && onPatchName(name)}
        placeholder="Name"
        style={{ ...inputStyle, width: 200 }}
      />
      <button type="button" onClick={changeScale} style={{ fontSize: 12, color: C.inkSoft, background: "none", border: `1px solid ${C.line}`, borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>
        Scale: {currency.scale} — Change…
      </button>
      <button type="button" onClick={onDelete} title="Delete"><Trash2 size={14} color={C.debit} /></button>
    </div>
  );
}

function SymbolSection({ symbols, currencies, onMutate }) {
  const [newTicker, setNewTicker] = useState("");
  const [newName, setNewName] = useState("");
  const [newScale, setNewScale] = useState("6");
  const [newTradingCurrency, setNewTradingCurrency] = useState(currencies[0]?.code || "");

  const create = onMutate(() => api.createSymbol({ ticker: newTicker.trim().toUpperCase(), name: newName.trim(), scale: parseInt(newScale, 10), tradingCurrency: newTradingCurrency }));
  const patchName = onMutate((ticker, tradingCurrency, name) => api.patchSymbol(ticker, tradingCurrency, { name }));
  const changeScale = onMutate((ticker, tradingCurrency, scale) => api.patchSymbol(ticker, tradingCurrency, { scale }));
  const remove = onMutate((ticker, tradingCurrency) => api.deleteSymbol(ticker, tradingCurrency));

  function submitNew() {
    if (!newTicker.trim() || !newName.trim() || !newTradingCurrency) return;
    create().then(() => { setNewTicker(""); setNewName(""); setNewScale("6"); });
  }

  return (
    <section>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: C.inkSoft, marginBottom: 8 }}>Symbols</h3>
      <div className="flex flex-col gap-1.5">
        {symbols.map((s) => (
          <SymbolRow
            key={`${s.ticker}:${s.tradingCurrency}`}
            symbol={s}
            onPatchName={(name) => patchName(s.ticker, s.tradingCurrency, name)}
            onChangeScale={(scale) => changeScale(s.ticker, s.tradingCurrency, scale)}
            onDelete={() => remove(s.ticker, s.tradingCurrency)}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 mt-3">
        <input value={newTicker} onChange={(e) => setNewTicker(e.target.value)} placeholder="Ticker, e.g. AAPL" style={{ ...inputStyle, width: 100 }} />
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name" style={{ ...inputStyle, width: 180 }} />
        <input type="number" min="0" step="1" value={newScale} onChange={(e) => setNewScale(e.target.value)} placeholder="Scale" style={{ ...inputStyle, width: 70 }} />
        <select value={newTradingCurrency} onChange={(e) => setNewTradingCurrency(e.target.value)} style={{ ...inputStyle, width: 90 }}>
          {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
        </select>
        <button type="button" onClick={submitNew} className="flex items-center gap-1" style={{ fontSize: 12.5, color: C.gold }}><Plus size={13} /> Add symbol</button>
      </div>
    </section>
  );
}

function SymbolRow({ symbol, onPatchName, onChangeScale, onDelete }) {
  const [name, setName] = useState(symbol.name);

  function changeScale() {
    const next = window.prompt(`New scale for ${symbol.ticker} (${symbol.tradingCurrency}) (currently ${symbol.scale}):`, String(symbol.scale));
    if (null === next || next.trim() === "") return;
    const parsed = parseInt(next, 10);
    if (!Number.isInteger(parsed) || parsed < 0) return;
    if (parsed === symbol.scale) return;
    if (!window.confirm(`Changing ${symbol.ticker} (${symbol.tradingCurrency})'s scale from ${symbol.scale} to ${parsed} will rescale every existing amount using it and cannot be undone. Continue?`)) return;
    onChangeScale(parsed);
  }

  return (
    <div className="flex items-center gap-2" style={{ padding: "4px 0" }}>
      <span className="ll-mono" style={{ width: 70, fontWeight: 600 }}>{symbol.ticker}</span>
      <span className="ll-mono" style={{ width: 40, color: C.inkFaint }}>{symbol.tradingCurrency}</span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name !== symbol.name && onPatchName(name)}
        placeholder="Name"
        style={{ ...inputStyle, width: 180 }}
      />
      <button type="button" onClick={changeScale} style={{ fontSize: 12, color: C.inkSoft, background: "none", border: `1px solid ${C.line}`, borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>
        Scale: {symbol.scale} — Change…
      </button>
      <button type="button" onClick={onDelete} title="Delete"><Trash2 size={14} color={C.debit} /></button>
    </div>
  );
}
```

- [ ] **Step 2: Wire into `App.jsx`**

Add the import:

```javascript
import { ReferenceDataView } from "./components/ReferenceDataView";
```

Add a new piece of state alongside `showAllowance`/`showTags`:

```javascript
  const [showReferenceData, setShowReferenceData] = useState(false);
```

Add a navigation function alongside `goToAllowance()`/`goToTags()`:

```javascript
  function goToReferenceData() {
    attemptNavigation(() => { setSelectedIdRaw(null); setShowAllowance(false); setShowTags(false); setShowReferenceData(true); });
  }
```

Update `goToAllowance()`/`goToTags()`/`setSelectedId()` to also reset the new flag, so only one of the three "special" views is ever showing at once — replace:

```javascript
  function setSelectedId(id) {
    attemptNavigation(() => selectAccount(id));
  }
  function goToAllowance() {
    attemptNavigation(() => { setSelectedIdRaw(null); setShowAllowance(true); setShowTags(false); });
  }
  function goToTags() {
    attemptNavigation(() => { setSelectedIdRaw(null); setShowAllowance(false); setShowTags(true); });
  }
```

with:

```javascript
  function setSelectedId(id) {
    attemptNavigation(() => { setShowAllowance(false); setShowTags(false); setShowReferenceData(false); selectAccount(id); });
  }
  function goToAllowance() {
    attemptNavigation(() => { setSelectedIdRaw(null); setShowAllowance(true); setShowTags(false); setShowReferenceData(false); });
  }
  function goToTags() {
    attemptNavigation(() => { setSelectedIdRaw(null); setShowAllowance(false); setShowTags(true); setShowReferenceData(false); });
  }
  function goToReferenceData() {
    attemptNavigation(() => { setSelectedIdRaw(null); setShowAllowance(false); setShowTags(false); setShowReferenceData(true); });
  }
```

Add a `refreshReferenceData()` function near `refreshAccounts()`:

```javascript
  function refreshReferenceData() {
    return Promise.all([api.getCurrencies(), api.getSymbols()]).then(([cur, sym]) => {
      setCurrencies(cur);
      setSymbols(sym);
      setCurrencyScales(cur);
      setSymbolScales(sym);
    });
  }
```

Add a nav button after the existing Tags button:

```javascript
          <button
            onClick={goToTags}
            className="w-full text-left px-2 py-1.5 rounded mb-3"
            style={{ background: showTags ? C.paperDim : "transparent", fontSize: 13, fontWeight: 600, color: C.inkSoft }}
          >
            Tags
          </button>
```

becomes:

```javascript
          <button
            onClick={goToTags}
            className="w-full text-left px-2 py-1.5 rounded mb-1"
            style={{ background: showTags ? C.paperDim : "transparent", fontSize: 13, fontWeight: 600, color: C.inkSoft }}
          >
            Tags
          </button>
          <button
            onClick={goToReferenceData}
            className="w-full text-left px-2 py-1.5 rounded mb-3"
            style={{ background: showReferenceData ? C.paperDim : "transparent", fontSize: 13, fontWeight: 600, color: C.inkSoft }}
          >
            Reference Data
          </button>
```

(note `mb-3`→`mb-1` on the Tags button, moving the bottom-margin spacer onto the new last button, matching how this sidebar's existing buttons are spaced.)

Add the render branch — replace:

```javascript
          {showTags ? (
            <TagsView knownTags={knownTags} onSelect={setSelectedId} />
          ) : showAllowance ? (
```

with:

```javascript
          {showReferenceData ? (
            <ReferenceDataView currencies={currencies} symbols={symbols} onRefresh={refreshReferenceData} />
          ) : showTags ? (
            <TagsView knownTags={knownTags} onSelect={setSelectedId} />
          ) : showAllowance ? (
```

Update the very first nav button's "active" check (currently `selectedId === null && !showAllowance && !showTags`) to also exclude the new view:

```javascript
          <button onClick={() => setSelectedId(null)} className="w-full text-left px-2 py-1.5 rounded mb-1" style={{ background: selectedId === null && !showAllowance && !showTags ? C.paperDim : "transparent", fontSize: 13, fontWeight: 600, color: C.inkSoft }}>
            Overview
          </button>
```

with:

```javascript
          <button onClick={() => setSelectedId(null)} className="w-full text-left px-2 py-1.5 rounded mb-1" style={{ background: selectedId === null && !showAllowance && !showTags && !showReferenceData ? C.paperDim : "transparent", fontSize: 13, fontWeight: 600, color: C.inkSoft }}>
            Overview
          </button>
```

- [ ] **Step 3: Build**

```bash
cd /Users/radu/Code/Claude/ledger-project && yarn build
```

Expected: clean build.

- [ ] **Step 4: Manual browser verification**

Using the same scratch-backend setup as Task 5's Step 14 (or a fresh one):

1. Navigate to "Reference Data" — confirm both Currencies and Symbols list correctly, including any symbols with a shared ticker (from Task 5's verification) shown as separate rows.
2. Add a new currency — confirm it appears immediately (no manual reload) and is now selectable everywhere a currency picker appears (e.g. `AccountFormModal`'s Currency field).
3. Edit a currency's name inline — confirm it saves on blur.
4. Click "Change scale…" on a currency with no data yet — confirm the confirmation prompt appears, and after confirming, the change applies with `rowsRescaled: 0` reflected sensibly (no visible count needed in the UI, just confirm no error).
5. Attempt to decrease the scale of a currency you know has non-evenly-divisible amounts against it (e.g. GBP in a database with real cents) to something smaller — confirm the `400` error surfaces inline instead of silently doing nothing or corrupting data.
6. Attempt to delete a currency that's referenced by an existing account — confirm the `409` "still in use" message surfaces inline.
7. Repeat the name-edit/scale-change/delete-blocked checks for a Symbol row.
8. Confirm navigating away from Reference Data to Overview and back doesn't lose or duplicate any row.

Revert `vite.config.js` and stop/clean up the scratch backend afterward.

- [ ] **Step 5: Commit**

```bash
git add src/components/ReferenceDataView.jsx src/App.jsx
git commit -m "Frontend UI: Reference Data admin view for Currency/Symbol create/edit/delete"
```

---

### Task 7: Final verification and documentation

**Files:** none — verification and `CLAUDE.md` only.

- [ ] **Step 1: Full test suite and build**

```bash
cd backend && php bin/phpunit
cd .. && yarn build
```

Expected: both clean (backend: 12/12; frontend: no errors).

- [ ] **Step 2: Real-database migration note**

Per this project's standing precedent (see CLAUDE.md, and every prior plan's migration section), each real tax-year file picks up Task 1's migration the next time it's switched into and migrated — no bulk action is required now. Do not run a bulk-migration loop against every real `backend/databases/*.sqlite3` file as part of this task; that's an operational choice for later, outside this plan's scope, exactly as the investment-parent plan's own Task 6 treated it.

- [ ] **Step 3: Update CLAUDE.md**

In the "Amounts, currencies, and reference data" section, find the paragraph describing `Currency`/`Symbol`/`Counterparty` as natural-key entities and the sentence `` `Symbol` additionally carries `name`, `scale` (unit precision — *not* a currency scale), and `tradingCurrency` (FK to `Currency`). `` — replace that sentence and the surrounding paragraph's `Account.currency`/`Account.symbol` reference with:

```
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
  column, not a reference entity**...
```

(keep the rest of that paragraph, starting from "Account.subtype, by contrast" onward, exactly as it already reads — only the sentences up to that point change.)

Add a new bullet to the same section, after the existing `resolveCurrency()`/`resolveSymbol()`/`resolveCounterparty()` bullet:

```
- **`Currency`/`Symbol` now have full admin CRUD** (`CurrencyController`,
  `SymbolController`, `src/components/ReferenceDataView.jsx`) — `POST`
  create, `PATCH` edit `name`/`scale`, `DELETE`. `code`/`(ticker,
  tradingCurrency)` are immutable once created — a different one is a new
  row, not a rename. Editing `scale` runs
  `LedgerStateService::rescaleCurrency()`/`rescaleSymbol()`, which
  rewrites every stored amount denominated in that currency/symbol to the
  new scale in one transaction; a decrease that would lose precision on
  any existing row is refused outright (`400`, naming how many rows would
  be affected), never silently rounded — see
  docs/superpowers/specs/2026-09-26-currency-symbol-admin-design.md.
  Deleting a still-referenced currency/symbol already fails at the
  database level (every FK into `currency`/`symbol` is `NOT DEFERRABLE
  INITIALLY IMMEDIATE`, and `foreign_keys` enforcement is on everywhere)
  — both controllers just translate that into a clean `409`, the same
  pattern `AccountController::delete()` already uses for a wrapper
  account with subaccounts. `Counterparty` stays free-text/find-or-create
  and out of this admin surface entirely.
```

```bash
git add CLAUDE.md
git commit -m "Document Currency/Symbol admin CRUD and Symbol's composite key in CLAUDE.md"
```
