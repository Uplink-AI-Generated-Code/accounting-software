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

    public function testUnknownOpNameThrowsAndWritesNothing(): void
    {
        $before = $this->rowCounts();

        try {
            $this->state->applyLedgerOperations([
                ['op' => 'upsertLine', 'accountId' => 'cash', 'amount' => '10', 'date' => '2026-05-01', 'description' => ''],
            ]);
            self::fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $e) {
            self::assertSame('Unknown operation "upsertLine".', $e->getMessage());
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

    public function testLinkLinesCreatesANewTransactionFromTwoStandaloneLines(): void
    {
        $this->state->applyLedgerOperations([
            $this->createOp('a', 'cash', '10', '2026-05-01'),
            $this->createOp('b', 'savings', '-10', '2026-05-01'),
            $this->linkOp(['a', 'b']),
        ]);

        self::assertSame(['lines' => 2, 'transactions' => 1], $this->rowCounts());
    }

    public function testLinkLinesExtendsAnExistingTransactionWithAStandaloneLine(): void
    {
        $this->state->applyLedgerOperations([
            $this->createOp('a', 'cash', '10', '2026-05-01'),
            $this->createOp('b', 'savings', '-6', '2026-05-01'),
            $this->linkOp(['a', 'b']),
            $this->createOp('c', 'wages', '-4', '2026-05-01'),
        ]);
        $conn = $this->em->getConnection();
        $cashId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'cash'");
        $wagesId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'wages'");
        $transactionId = $conn->fetchOne('SELECT transaction_id FROM line WHERE id = ?', [$cashId]);

        $this->state->applyLedgerOperations([$this->linkOp([$cashId, $wagesId])]);

        self::assertSame(['lines' => 3, 'transactions' => 1], $this->rowCounts());
        self::assertSame($transactionId, $this->lineRow($wagesId)['transaction_id']);
    }

    public function testLinkLinesIsANoOpWhenAllGivenLinesAlreadyShareTheSameTransaction(): void
    {
        $this->state->applyLedgerOperations([
            $this->createOp('a', 'cash', '10', '2026-05-01'),
            $this->createOp('b', 'savings', '-10', '2026-05-01'),
            $this->linkOp(['a', 'b']),
        ]);
        $conn = $this->em->getConnection();
        $cashId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'cash'");
        $savingsId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'savings'");

        $this->state->applyLedgerOperations([$this->linkOp([$cashId, $savingsId])]);

        self::assertSame(['lines' => 2, 'transactions' => 1], $this->rowCounts());
    }

    // Regression coverage for updateLine (Task 1) now that linkLines
    // makes a genuinely-linked line constructible: editing one leg's own
    // fields must never disturb its Transaction membership.
    public function testUpdateLineOnAnAlreadyLinkedLineDoesNotChangeItsTransaction(): void
    {
        $this->state->applyLedgerOperations([
            $this->createOp('a', 'cash', '10', '2026-05-01'),
            $this->createOp('b', 'savings', '-10', '2026-05-01'),
            $this->linkOp(['a', 'b']),
        ]);
        $conn = $this->em->getConnection();
        $cashId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'cash'");
        $transactionIdBefore = $conn->fetchOne('SELECT transaction_id FROM line WHERE id = ?', [$cashId]);
        self::assertNotNull($transactionIdBefore);

        $this->state->applyLedgerOperations([
            ['op' => 'updateLine', 'lineId' => $cashId, 'accountId' => 'cash', 'amount' => '15', 'date' => '2026-05-01', 'description' => 'edited'],
        ]);

        $row = $this->lineRow($cashId);
        self::assertSame('15', $row['amount']);
        self::assertSame($transactionIdBefore, $row['transaction_id']);
        self::assertSame(['lines' => 2, 'transactions' => 1], $this->rowCounts());
    }

    public function testLinkLinesAcrossTwoDifferentExistingTransactionsThrowsAndWritesNothing(): void
    {
        $this->state->applyLedgerOperations([
            $this->createOp('a', 'cash', '10', '2026-05-01'),
            $this->createOp('b', 'savings', '-10', '2026-05-01'),
            $this->linkOp(['a', 'b']),
            $this->createOp('c', 'cash', '5', '2026-05-02'),
            $this->createOp('d', 'wages', '-5', '2026-05-02'),
            $this->linkOp(['c', 'd']),
        ]);
        $conn = $this->em->getConnection();
        $lineAId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'cash' AND date = '2026-05-01'");
        $lineCId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'cash' AND date = '2026-05-02'");
        $before = $this->rowCounts();

        try {
            $this->state->applyLedgerOperations([$this->linkOp([$lineAId, $lineCId])]);
            self::fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $e) {
            self::assertSame('linkLines cannot span two different existing transactions.', $e->getMessage());
        }

        self::assertSame($before, $this->rowCounts());
    }

    public function testLinkLinesGivenFewerThanTwoIdsThrows(): void
    {
        $this->state->applyLedgerOperations([$this->createOp('a', 'cash', '10', '2026-05-01')]);

        $this->expectException(\InvalidArgumentException::class);
        $this->state->applyLedgerOperations([$this->linkOp(['a'])]);
    }

    public function testLinkLinesGivenADuplicateIdThrows(): void
    {
        $this->state->applyLedgerOperations([$this->createOp('a', 'cash', '10', '2026-05-01')]);
        $lineId = $this->firstLineId();

        $this->expectException(\InvalidArgumentException::class);
        $this->state->applyLedgerOperations([$this->linkOp([$lineId, $lineId])]);
    }

    public function testLinkLinesWithAnUnresolvedTempIdThrowsAndWritesNothing(): void
    {
        $before = $this->rowCounts();

        try {
            $this->state->applyLedgerOperations([
                $this->createOp('a', 'cash', '10', '2026-05-01'),
                $this->linkOp(['a', 'never-created']),
            ]);
            self::fail('expected InvalidArgumentException');
        } catch (\InvalidArgumentException $e) {
            self::assertSame('Unresolved line reference "never-created".', $e->getMessage());
        }

        self::assertSame($before, $this->rowCounts());
    }

    public function testUnlinkLineOnATwoLineTransactionDissolvesItAndDemotesTheSurvivor(): void
    {
        $this->state->applyLedgerOperations([
            $this->createOp('a', 'cash', '10', '2026-05-01'),
            $this->createOp('b', 'savings', '-10', '2026-05-01'),
            $this->linkOp(['a', 'b']),
        ]);
        $conn = $this->em->getConnection();
        $cashId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'cash'");
        $savingsId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'savings'");

        $this->state->applyLedgerOperations([['op' => 'unlinkLine', 'lineId' => $cashId]]);

        self::assertSame(['lines' => 2, 'transactions' => 0], $this->rowCounts());
        self::assertNull($this->lineRow($cashId)['transaction_id']);
        self::assertNull($this->lineRow($savingsId)['transaction_id']);
    }

    public function testUnlinkLineOnAThreeLineTransactionJustDetachesTheOneLine(): void
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

        $this->state->applyLedgerOperations([['op' => 'unlinkLine', 'lineId' => $wagesId]]);

        self::assertSame(['lines' => 3, 'transactions' => 1], $this->rowCounts());
        self::assertNull($this->lineRow($wagesId)['transaction_id']);
        self::assertSame($transactionIdBefore, $this->lineRow($savingsId)['transaction_id']);
    }

    public function testUnlinkLineOnEveryLineOfARecordInOneBatchSucceeds(): void
    {
        $this->state->applyLedgerOperations([
            $this->createOp('a', 'cash', '10', '2026-05-01'),
            $this->createOp('b', 'savings', '-10', '2026-05-01'),
            $this->linkOp(['a', 'b']),
        ]);
        $conn = $this->em->getConnection();
        $cashId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'cash'");
        $savingsId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'savings'");

        $this->state->applyLedgerOperations([
            ['op' => 'unlinkLine', 'lineId' => $cashId],
            ['op' => 'unlinkLine', 'lineId' => $savingsId],
        ]);

        self::assertSame(['lines' => 2, 'transactions' => 0], $this->rowCounts());
        self::assertNull($this->lineRow($cashId)['transaction_id']);
        self::assertNull($this->lineRow($savingsId)['transaction_id']);
    }

    public function testUnlinkLineOnALineThatWasAlreadyStandaloneIsANoOp(): void
    {
        $this->state->applyLedgerOperations([$this->createOp('a', 'cash', '10', '2026-05-01')]);
        $lineId = $this->firstLineId();

        $this->state->applyLedgerOperations([['op' => 'unlinkLine', 'lineId' => $lineId]]);

        self::assertSame(['lines' => 1, 'transactions' => 0], $this->rowCounts());
        self::assertNull($this->lineRow($lineId)['transaction_id']);
    }

    public function testUnlinkLineWithUnknownLineIdThrows(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        $this->state->applyLedgerOperations([['op' => 'unlinkLine', 'lineId' => 999999]]);
    }

    public function testAMixedBatchOfEveryPrimitiveAppliesAtomically(): void
    {
        $this->state->applyLedgerOperations([
            $this->createOp('a', 'cash', '10', '2026-05-01'),
            $this->createOp('b', 'savings', '-6', '2026-05-01'),
            $this->createOp('c', 'wages', '-4', '2026-05-01'),
            $this->linkOp(['a', 'b', 'c']),
        ]);
        $conn = $this->em->getConnection();
        $cashId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'cash'");
        $savingsId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'savings'");
        $wagesId = (int) $conn->fetchOne("SELECT id FROM line WHERE account_id = 'wages'");

        // Second batch: add a new unrelated line, edit cash's own fields,
        // delete wages (transaction drops to {cash, savings} = 2, no
        // cascade yet), then unlink savings too (drops to {cash} = 1,
        // which cascades: transaction dissolved, cash demoted).
        $this->state->applyLedgerOperations([
            $this->createOp('d', 'cash', '-1', '2026-05-03'),
            ['op' => 'updateLine', 'lineId' => $cashId, 'accountId' => 'cash', 'amount' => '11', 'date' => '2026-05-01', 'description' => 'topped up'],
            ['op' => 'deleteLine', 'lineId' => $wagesId],
            ['op' => 'unlinkLine', 'lineId' => $savingsId],
        ]);

        self::assertSame(['lines' => 3, 'transactions' => 0], $this->rowCounts());
        $cashRow = $this->lineRow($cashId);
        self::assertSame('11', $cashRow['amount']);
        self::assertSame('topped up', $cashRow['description']);
        self::assertNull($cashRow['transaction_id']);
        self::assertNull($this->lineRow($savingsId)['transaction_id']);
    }
}
