<?php

namespace App\Tests\Service;

use App\Entity\Currency;
use App\Service\LedgerStateService;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;

class LedgerOperationsTest extends KernelTestCase
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

        $this->state->upsertAccount('cash', ['name' => 'Cash', 'type' => 'asset', 'currency' => 'GBP']);
        $this->state->upsertAccount('savings', ['name' => 'Savings', 'type' => 'asset', 'currency' => 'GBP']);
        $this->state->upsertAccount('wages', ['name' => 'Wages', 'type' => 'income', 'currency' => 'GBP']);
    }

    private function createOp(string $tempId, string $accountId, string $amount, string $date, array $extra = []): array
    {
        return ['op' => 'createLine', 'tempId' => $tempId, 'accountId' => $accountId, 'amount' => $amount, 'date' => $date, 'description' => '', ...$extra];
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

    /** @return array<string, mixed> */
    private function lineRow(int $id): array
    {
        $row = $this->em->getConnection()->fetchAssociative('SELECT * FROM line WHERE id = ?', [$id]);
        self::assertIsArray($row, "no line row $id");

        return $row;
    }

    private function firstLineId(): int
    {
        return (int) $this->em->getConnection()->fetchOne('SELECT id FROM line ORDER BY id DESC LIMIT 1');
    }

    public function testCreateLineCreatesAStandaloneLine(): void
    {
        $this->state->applyLedgerOperations([$this->createOp('a', 'cash', '10', '2026-05-01')]);

        $row = $this->lineRow($this->firstLineId());
        self::assertNull($row['transaction_id']);
        self::assertSame('10', $row['amount']);
    }

    public function testCreateLineWithUnknownAccountThrowsAndWritesNothing(): void
    {
        $before = $this->rowCounts();

        try {
            $this->state->applyLedgerOperations([$this->createOp('a', 'does-not-exist', '10', '2026-05-01')]);
            self::fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $e) {
            self::assertSame('Unknown account "does-not-exist".', $e->getMessage());
        }

        self::assertSame($before, $this->rowCounts());
    }

    public function testUpdateLineChangesFieldsOfAStandaloneLine(): void
    {
        $this->state->applyLedgerOperations([$this->createOp('a', 'cash', '10', '2026-05-01')]);
        $lineId = $this->firstLineId();

        $this->state->applyLedgerOperations([
            ['op' => 'updateLine', 'lineId' => $lineId, 'accountId' => 'cash', 'amount' => '20', 'date' => '2026-05-02', 'description' => 'edited'],
        ]);

        $row = $this->lineRow($lineId);
        self::assertSame('20', $row['amount']);
        self::assertSame('2026-05-02', $row['date']);
        self::assertSame('edited', $row['description']);
        self::assertNull($row['transaction_id']);
    }

    public function testUpdateLineWithUnknownLineIdThrowsAndWritesNothing(): void
    {
        $before = $this->rowCounts();

        try {
            $this->state->applyLedgerOperations([
                ['op' => 'updateLine', 'lineId' => 999999, 'accountId' => 'cash', 'amount' => '10', 'date' => '2026-05-01', 'description' => ''],
            ]);
            self::fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $e) {
            self::assertSame('Unknown line id "999999".', $e->getMessage());
        }

        self::assertSame($before, $this->rowCounts());
    }

    private function linkOp(array $ids): array
    {
        return ['op' => 'linkLines', 'lineIds' => $ids];
    }

    public function testDeleteLineOnAStandaloneLineJustRemovesIt(): void
    {
        $this->state->applyLedgerOperations([$this->createOp('a', 'cash', '10', '2026-05-01')]);
        $lineId = $this->firstLineId();

        $this->state->applyLedgerOperations([['op' => 'deleteLine', 'lineId' => $lineId]]);

        self::assertSame(['lines' => 0, 'transactions' => 0], $this->rowCounts());
    }

    public function testDeleteLineOnATwoLineTransactionDissolvesItAndDemotesTheSurvivor(): void
    {
        $this->state->applyLedgerOperations([
            $this->createOp('a', 'cash', '10', '2026-05-01'),
            $this->createOp('b', 'savings', '-10', '2026-05-01'),
            $this->linkOp(['a', 'b']),
        ]);
        $conn = $this->em->getConnection();
        $cashId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'cash'");
        $savingsId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'savings'");

        $this->state->applyLedgerOperations([['op' => 'deleteLine', 'lineId' => $cashId]]);

        self::assertSame(['lines' => 1, 'transactions' => 0], $this->rowCounts());
        self::assertNull($this->lineRow($savingsId)['transaction_id']);
    }

    public function testDeleteLineOnAThreeLineTransactionLeavesItIntact(): void
    {
        $this->state->applyLedgerOperations([
            $this->createOp('a', 'cash', '10', '2026-05-01'),
            $this->createOp('b', 'savings', '-6', '2026-05-01'),
            $this->createOp('c', 'wages', '-4', '2026-05-01'),
            $this->linkOp(['a', 'b', 'c']),
        ]);
        $conn = $this->em->getConnection();
        $wagesId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'wages'");
        $savingsId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'savings'");
        $transactionIdBefore = $conn->fetchOne('SELECT transaction_id FROM line WHERE id = ?', [$savingsId]);

        $this->state->applyLedgerOperations([['op' => 'deleteLine', 'lineId' => $wagesId]]);

        self::assertSame(['lines' => 2, 'transactions' => 1], $this->rowCounts());
        self::assertSame($transactionIdBefore, $this->lineRow($savingsId)['transaction_id']);
    }

    public function testDeleteLineWithUnknownLineIdThrows(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->state->applyLedgerOperations([['op' => 'deleteLine', 'lineId' => 999999]]);
    }
}
