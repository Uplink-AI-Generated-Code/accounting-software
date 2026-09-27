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
