<?php

namespace App\Tests\Service;

use App\Entity\Account;
use App\Entity\Currency;
use App\Entity\Line;
use App\Entity\Symbol;
use App\Entity\Transaction;
use App\Service\IsaAllowanceService;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;

/**
 * Covers the specific behaviors CLAUDE.md flags as easy to get wrong —
 * particularly the flexible-ISA lot tracking, which was once "simplified"
 * back to deposits-minus-withdrawals and produced wrong (negative)
 * numbers. These tests exist to catch that regression, not to exhaustively
 * cover every rule.
 */
class IsaAllowanceServiceTest extends KernelTestCase
{
    private EntityManagerInterface $em;
    private IsaAllowanceService $isa;

    protected function setUp(): void
    {
        self::bootKernel();
        $container = static::getContainer();
        $this->em = $container->get(EntityManagerInterface::class);
        $this->isa = $container->get(IsaAllowanceService::class);

        // Start each test from an empty database. Reference data
        // (currency/symbol/institution) isn't wiped here — it's shared,
        // not owned per-test the way account/line/transactions are — so
        // ensureCurrency() below only inserts GBP once, the first time.
        $connection = $this->em->getConnection();
        $connection->executeStatement('DELETE FROM line');
        $connection->executeStatement('DELETE FROM transactions');
        $connection->executeStatement('DELETE FROM account');
        $this->ensureCurrency('GBP', 2);
    }

    private function ensureCurrency(string $code, int $scale): Currency
    {
        $currency = $this->em->getRepository(Currency::class)->find($code);
        if (!$currency) {
            $currency = (new Currency())->setCode($code)->setScale($scale);
            $this->em->persist($currency);
            $this->em->flush();
        }

        return $currency;
    }

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

    private function makeAccount(string $id, array $overrides = []): Account
    {
        $a = new Account();
        $a->setId($id);
        $a->setName($overrides['name'] ?? $id);
        $a->setType($overrides['type'] ?? 'asset');
        $a->setCurrency($this->em->getRepository(Currency::class)->find($overrides['currency'] ?? 'GBP'));
        $a->setOpeningBalance($overrides['openingBalance'] ?? 0);
        $a->setIsaKind($overrides['isaKind'] ?? null);
        $a->setIsaParentId($overrides['isaParentId'] ?? null);
        $a->setFlexible($overrides['flexible'] ?? null);
        $this->em->persist($a);

        return $a;
    }

    /** @param array<int, array{account: Account, amount: int, date: string}> $lines */
    private function makeTransaction(string $id, array $lines): void
    {
        $t = new Transaction();
        $t->setId($id);
        $this->em->persist($t);
        foreach ($lines as $i => $spec) {
            $l = new Line();
            $t->addLine($l); // keeps Transaction's in-memory collection in sync — see LedgerStateService::hydrateLine()
            $l->setAccount($spec['account']);
            $l->setAmount($spec['amount']);
            $l->setDate($spec['date']);
            $l->setDescription($spec['description'] ?? '');
            $this->em->persist($l);
        }
    }

    // A standalone line — no Transaction at all, the actual shape an
    // unmatched deposit/withdrawal has under the current model (unlike
    // makeTransaction(), which wraps even a single line in a real
    // Transaction — still useful for exercising the "somehow a 1-line
    // Transaction exists anyway" case, since isExternalLine() treats the
    // two identically).
    private function makeStandaloneLine(Account $account, int $amount, string $date): void
    {
        $l = new Line();
        $l->setAccount($account);
        $l->setAmount($amount);
        $l->setDate($date);
        $l->setDescription('');
        $this->em->persist($l);
    }

    // A standalone line on an investment account, tagged with a
    // `cashValue` — the shape a directly-bought (not linked to a cash
    // leg) holding inside a Stocks & Shares ISA takes. `amount` here is
    // units, not cash, so the pool tracking must read `cashValue` instead.
    private function makeStandaloneInvestmentLine(Account $account, int $units, int $cashValue, string $date): void
    {
        $l = new Line();
        $l->setAccount($account);
        $l->setAmount($units);
        $l->setCashValue($cashValue);
        $l->setDate($date);
        $l->setDescription('');
        $this->em->persist($l);
    }

    public function testStandaloneInvestmentLineInsideIsaWrapperUsesCashValueNotUnits(): void
    {
        $wrapper = $this->makeAccount('isaWrapper', ['type' => 'isa-parent', 'flexible' => false]);
        $symbol = $this->ensureSymbol('ACME');
        $holding = $this->makeAccount('isaHolding', [
            'type' => 'investment',
            'isaParentId' => 'isaWrapper',
        ]);
        $holding->setSymbol($symbol);

        // 1.5 units (symbol scale 1,000,000) bought for 3000 (£30.00 at
        // GBP scale 2) — a standalone line, no linked cash counterpart.
        // Using raw `amount` (1500000) instead of `cashValue` (3000) would
        // produce a wildly wrong allowance figure.
        $this->makeStandaloneInvestmentLine($holding, 1500000, 3000, '2026-05-01');
        $this->em->flush();

        $usage = $this->isa->computeUsage(2026);

        self::assertSame(3000, $usage['byKind']['stocks-shares-isa']);
        self::assertSame(3000, $usage['total']);
    }

    public function testNonFlexibleDepositCountsAndWithdrawalNeverReducesUsage(): void
    {
        // Standalone lines — no Transaction wrapper — specifically to
        // exercise IsaAllowanceService's own standalone-line branch
        // (transactionsTouching() has to go find these separately from
        // real Transactions).
        $isa = $this->makeAccount('isa1', ['isaKind' => 'cash-isa', 'flexible' => false]);
        $this->makeStandaloneLine($isa, 500000, '2026-05-01');
        $this->makeStandaloneLine($isa, -100000, '2026-06-01');
        $this->em->flush();

        $usage = $this->isa->computeUsage(2026);

        self::assertSame(500000, $usage['byKind']['cash-isa']);
        self::assertSame(500000, $usage['total']);
    }

    public function testTransferBetweenOwnIsasDoesNotCountAsNewSubscription(): void
    {
        $isaA = $this->makeAccount('isaA', ['isaKind' => 'cash-isa', 'flexible' => false]);
        $isaB = $this->makeAccount('isaB', ['isaKind' => 'innovative-finance-isa', 'flexible' => false]);
        // A single transaction moving money from isaA to isaB — both legs
        // are ISA-tagged, so isExternalLine must treat this as a transfer,
        // not a subscription, on either side.
        $this->makeTransaction('t1', [
            ['account' => $isaA, 'amount' => -200000, 'date' => '2026-05-01'],
            ['account' => $isaB, 'amount' => 200000, 'date' => '2026-05-01'],
        ]);
        $this->em->flush();

        $usage = $this->isa->computeUsage(2026);

        self::assertSame(0, $usage['byKind']['cash-isa']);
        self::assertSame(0, $usage['byKind']['innovative-finance-isa']);
        self::assertSame(0, $usage['total']);
    }

    public function testFlexibleWithdrawalThisYearIsReplaceableIntoAnyFlexibleIsa(): void
    {
        $isaA = $this->makeAccount('isaA', ['isaKind' => 'cash-isa', 'flexible' => true]);
        $isaB = $this->makeAccount('isaB', ['isaKind' => 'innovative-finance-isa', 'flexible' => true]);
        $external = $this->makeAccount('bank', ['type' => 'asset']);

        // Deposit 5000 into isaA, withdraw 2000 from isaA, then deposit
        // 2000 into the *different* flexible ISA (isaB). The withdrawal
        // was this year's own money, so it's replaceable anywhere — this
        // must NOT be double-counted as a fresh subscription.
        $this->makeTransaction('t1', [
            ['account' => $isaA, 'amount' => 500000, 'date' => '2026-05-01'],
            ['account' => $external, 'amount' => -500000, 'date' => '2026-05-01'],
        ]);
        $this->makeTransaction('t2', [
            ['account' => $isaA, 'amount' => -200000, 'date' => '2026-06-01'],
            ['account' => $external, 'amount' => 200000, 'date' => '2026-06-01'],
        ]);
        $this->makeTransaction('t3', [
            ['account' => $isaB, 'amount' => 200000, 'date' => '2026-07-01'],
            ['account' => $external, 'amount' => -200000, 'date' => '2026-07-01'],
        ]);
        $this->em->flush();

        $usage = $this->isa->computeUsage(2026);

        // Net new money is still just the original 5000 — none of it
        // should ever go negative or double-count.
        self::assertSame(300000, $usage['byKind']['cash-isa']);
        self::assertSame(200000, $usage['byKind']['innovative-finance-isa']);
        self::assertSame(500000, $usage['total']);
    }

    public function testFlexiblePriorYearMoneyIsOnlyReplaceableIntoTheSameIsa(): void
    {
        $isaA = $this->makeAccount('isaA', ['isaKind' => 'cash-isa', 'flexible' => true, 'openingBalance' => 1000000]);
        $isaB = $this->makeAccount('isaB', ['isaKind' => 'innovative-finance-isa', 'flexible' => true]);
        $external = $this->makeAccount('bank', ['type' => 'asset']);

        // isaA's 10000 opening balance predates this tax year entirely
        // (no deposit transaction in-year for it). Withdraw 3000 from it,
        // then deposit 3000 into a *different* flexible ISA — prior-year
        // money is only replaceable back into the same ISA, so this must
        // count as a brand new subscription for isaB, and isaA's own
        // usage must stay at 0 (nothing new went back into isaA itself).
        $this->makeTransaction('t1', [
            ['account' => $isaA, 'amount' => -300000, 'date' => '2026-05-01'],
            ['account' => $external, 'amount' => 300000, 'date' => '2026-05-01'],
        ]);
        $this->makeTransaction('t2', [
            ['account' => $isaB, 'amount' => 300000, 'date' => '2026-06-01'],
            ['account' => $external, 'amount' => -300000, 'date' => '2026-06-01'],
        ]);
        $this->em->flush();

        $usage = $this->isa->computeUsage(2026);

        self::assertSame(0, $usage['byKind']['cash-isa']);
        self::assertSame(300000, $usage['byKind']['innovative-finance-isa']);
        self::assertSame(300000, $usage['total']);

        // Replacing it back into the *same* ISA instead must NOT count as
        // a new subscription.
        $this->makeTransaction('t3', [
            ['account' => $isaA, 'amount' => 300000, 'date' => '2026-07-01'],
            ['account' => $external, 'amount' => -300000, 'date' => '2026-07-01'],
        ]);
        $this->em->flush();

        $usage2 = $this->isa->computeUsage(2026);
        self::assertSame(0, $usage2['byKind']['cash-isa']);
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        unset($this->em, $this->isa);
    }
}
