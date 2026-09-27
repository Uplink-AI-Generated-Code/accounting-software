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

    /** @return array{lines: int, transactions: int} */
    private function rowCounts(): array
    {
        $conn = $this->em->getConnection();

        return [
            'lines' => (int) $conn->fetchOne('SELECT COUNT(*) FROM line'),
            'transactions' => (int) $conn->fetchOne('SELECT COUNT(*) FROM transactions'),
        ];
    }

    public function testUpsertLineWithUnknownAccountThrowsAndWritesNothing(): void
    {
        $this->state->upsertAccount('cash', ['name' => 'Cash', 'type' => 'asset', 'currency' => 'GBP']);
        $before = $this->rowCounts();

        try {
            $this->state->applyLedgerOperations([
                $this->line('does-not-exist', '10', '2026-05-01'),
            ]);
            self::fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $e) {
            self::assertSame('Unknown account "does-not-exist".', $e->getMessage());
        }

        self::assertSame($before, $this->rowCounts(), 'batch must not persist anything when a line targets an unknown account');
    }

    public function testUpsertTransactionWithUnknownAccountOnOneLegThrowsAndWritesNothing(): void
    {
        $this->state->upsertAccount('cash', ['name' => 'Cash', 'type' => 'asset', 'currency' => 'GBP']);
        $before = $this->rowCounts();

        try {
            $this->state->applyLedgerOperations([[
                'op' => 'upsertTransaction',
                'transactionId' => 'txn-1',
                'lines' => [
                    ['accountId' => 'cash', 'amount' => '10', 'date' => '2026-05-01', 'description' => ''],
                    ['accountId' => 'does-not-exist', 'amount' => '-10', 'date' => '2026-05-01', 'description' => ''],
                ],
            ]]);
            self::fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $e) {
            self::assertSame('Unknown account "does-not-exist".', $e->getMessage());
        }

        // In particular: the first (valid) leg must not have been left
        // behind as an orphan 1-line Transaction.
        self::assertSame($before, $this->rowCounts(), 'batch must not persist a partial transaction when one leg targets an unknown account');
    }

    public function testStockWalkWithRepeatingQuotientDividesAtTwentyDpAndRoundsOnlyOnOutput(): void
    {
        $this->state->upsertAccount('wrap', ['name' => 'W', 'type' => 'investment-parent']);
        $this->state->upsertAccount('inv', ['name' => 'S', 'type' => 'investment', 'symbolTicker' => 'TST', 'symbolCurrency' => 'GBP', 'parentId' => 'wrap']);
        $this->state->applyLedgerOperations([
            // Buy 3 units for cashValue 100 (average cost 100/3 = 33.33333333333333333333... per unit, non-terminating in base 10).
            $this->line('inv', '3', '2026-05-01', ['cashValue' => '100', 'cashCurrency' => 'GBP']),
            // Sell 1 unit at a sale price of 50 per unit → cashValue -50.
            $this->line('inv', '-1', '2026-06-01', ['cashValue' => '-50', 'cashCurrency' => 'GBP']),
        ]);

        $s = $this->stats('inv');
        self::assertSame('2', $s['balance']);
        // Cost basis, average-cost method (applyCostBasisLine):
        //   costRemoved = divide(cost * sold, units) = divide(100 * 1, 3) = divide(100, 3).
        //   100/3 = 33.333... repeating. Decimal::divide computes to 21dp
        //   (33.333333333333333333, 21 threes) then rounds half-away-from-zero
        //   to 20dp: the 21st digit (3) rounds down, giving
        //   costRemoved = 33.33333333333333333 (20 threes).
        //   remaining cost = 100 - 33.33333333333333333 = 66.66666666666666667
        //   (100.00000000000000000 minus 33.33333333333333333, borrowing
        //   through every place: integer part 100-1=99 borrowed→ "66", and
        //   1.00000000000000000 - 0.33333333333333333 = 0.66666666666666667).
        //   Rounded to GBP's scale (2dp) for the API output: 66.67.
        self::assertSame('66.67', $s['costBasis']);
        // Portfolio value ("mark to last trade", applyPortfolioValueLine):
        // the last trade's implied price is abs(-50)/abs(-1) = 50 per unit,
        // applied to the whole remaining holding of 2 units:
        // divide(2 * 50, 1) = divide(100, 1) = 100.
        self::assertSame('100', $s['portfolioValue']);
    }

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
        // value: units 2.12345 × (123.4567 / 0.12345) = 2123.56524597…; → 4 dp
        self::assertSame('2123.5652', $s['portfolioValue']);
    }
}
