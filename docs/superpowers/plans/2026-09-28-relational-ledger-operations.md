# Relational Ledger Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `POST /api/ledger/batch`'s `upsertLine`/`deleteLine`/`upsertTransaction`/`deleteTransaction` vocabulary with five relational primitives (`createLine`, `updateLine`, `deleteLine`, `linkLines`, `unlinkLine`) so the backend — not the frontend — owns Transaction lifecycle (creation, merging, dissolution, demotion to standalone), eliminating the current delete-and-recreate-everything pattern.

**Architecture:** `LedgerStateService::applyLedgerOperations()` keeps its existing shape (one ordered array, one Doctrine transaction, tax-year date validation up front) but dispatches to five new private handlers instead of four. A new in-call `tempIds` map lets one atomic batch create brand-new lines and immediately link them together before they have real database ids. A single shared cascade helper (`demoteOrDeleteTransactionIfBelowMinimum`) backs both `deleteLine` and `unlinkLine`. On the frontend, `src/lib/ledgerOperations.js`'s four builder functions are rewritten against the five primitives, and `src/lib/grouping.js`'s `reorderSameDate()` is simplified to match.

**Tech Stack:** Symfony 8 / Doctrine ORM / SQLite (backend, PHP 8), React + Vite (frontend, JS), PHPUnit (`KernelTestCase`), no frontend test coverage for this module (matches existing convention).

**Spec:** [docs/superpowers/specs/2026-09-27-relational-ledger-operations-design.md](../specs/2026-09-27-relational-ledger-operations-design.md)

## Global Constraints

- Amounts are canonical decimal strings everywhere (no floats, no scaled integers) — every op's `amount`/`cashValue`/`exchangeAmount` field must already be one; validation happens via the existing `App\Money\Decimal::parse()` / `amountOrNull()`, unchanged by this plan.
- `Line.transaction`'s foreign key is `ON DELETE CASCADE` at the database level (confirmed in every migration from `Version20260829184944.php` onward). **Any code that wants a line to survive as standalone must set its `transaction` to `null` and flush *before* the old Transaction row is deleted** — never rely on delete-then-recreate ordering.
- `Transaction::removeLine()` combined with `orphanRemoval: true` on its `lines` collection is destructive (removing from the collection schedules the Line for deletion) — never call it when the intent is to preserve a line as standalone. This plan's cascade code never calls `removeLine()`; it only ever mutates `Line::setTransaction()` directly and deletes the `Transaction` row via a bulk DQL `DELETE` (bypassing the ORM's cascade-on-remove semantics entirely), mirroring the existing `deleteTransactionLines()`/`deleteTransactionIfEmpty()` pattern already in the codebase.
- `Transaction` ids: per this plan's approved design decision, the **backend** now generates a fresh Transaction id (16 hex characters via `bin2hex(random_bytes(8))`) whenever `linkLines` creates a brand-new one — this is a deliberate, scoped exception to `CLAUDE.md`'s general "ids are frontend-provided" convention for `Account`/`Transaction`, made because the frontend never needs to know a Transaction's id in advance (it always refetches the full ledger after every write) and `linkLines`'s primitive contract doesn't want to carry an id-that's-usually-irrelevant on every call.
- This is a single-user local app with no external API consumers — the wire format changes in one PR, frontend and backend together, no dual-vocabulary transition period, no versioning.
- Existing entity methods to reuse, never reimplement: `Transaction::addLine(Line $line)` (idempotent — checks `contains()` before adding, also calls `$line->setTransaction($this)`), `Line::setTransaction(?Transaction $transaction)`.
- Match search (`MatchingService::findCandidates()`) only ever returns standalone lines (`WHERE l.transaction IS NULL`) — confirmed during design. This means `linkLines`'s "spans two different existing transactions" error path can't currently be triggered by any real user flow; it's a defensive invariant, not a restriction on today's UI.

---

## Task 1: `createLine` + `updateLine` primitives, temp-id resolution

**Files:**
- Modify: `backend/src/Service/LedgerStateService.php` (`applyLedgerOperations()` around line 685, `opDeleteLine`/`opDeleteTransaction`/`opUpsertLine`/`opUpsertTransaction` around lines 702–793 — leave the legacy three alone for now, only touch the dispatch `match` and add new private methods)
- Create: `backend/tests/Service/LedgerOperationsTest.php`

**Interfaces:**
- Produces: `private function resolveLineRef(mixed $ref, array $tempIds): int` — resolves a raw op value (a real numeric line id, or a `tempId` string registered earlier in the same batch) to a real `Line` id, or throws `InvalidArgumentException`. Consumed by every later task's op handlers (`opDeleteLine`, `opLinkLines`, `opUnlinkLine`).
- Produces: `private function opCreateLine(array $op, array &$tempIds): void` and `private function opUpdateLine(array $op, array &$tempIds): void`.
- Produces (test-only convention other tasks' tests reuse): `LedgerOperationsTest::createOp(string $tempId, string $accountId, string $amount, string $date, array $extra = []): array`, `::rowCounts(): array`, `::lineRow(int $id): array`, `::firstLineId(): int`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/Service/LedgerOperationsTest.php`:

```php
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
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && php bin/phpunit tests/Service/LedgerOperationsTest.php`
Expected: all 4 tests FAIL (or error) — `createLine`/`updateLine` aren't dispatched yet, so `applyLedgerOperations()` silently no-ops (`default => null`) and the assertions about resulting rows/exceptions fail.

- [ ] **Step 3: Implement `resolveLineRef`, `opCreateLine`, `opUpdateLine`, and wire the dispatch**

In `backend/src/Service/LedgerStateService.php`, replace the `applyLedgerOperations()` method (currently around line 685):

```php
public function applyLedgerOperations(array $operations): void
{
    $this->em->wrapInTransaction(function () use ($operations) {
        $this->assertOperationDatesInActiveTaxYear($operations);
        $tempIds = [];
        foreach ($operations as $op) {
            match ($op['op'] ?? null) {
                'createLine' => $this->opCreateLine($op, $tempIds),
                'updateLine' => $this->opUpdateLine($op, $tempIds),
                'deleteLine' => $this->opDeleteLine($op),
                'deleteTransaction' => $this->opDeleteTransaction($op),
                'upsertLine' => $this->opUpsertLine($op),
                'upsertTransaction' => $this->opUpsertTransaction($op),
                default => null,
            };
        }
    });
}
```

(This keeps the four legacy cases dispatching to their unchanged existing handlers for now — `LedgerStateServiceAmountsTest` still passes untouched. `deleteLine`/`deleteTransaction` are rewired in Tasks 2–4.)

Add these three new private methods directly after `applyLedgerOperations()`:

```php
/** @param array<string, mixed> $op */
private function opCreateLine(array $op, array &$tempIds): void
{
    if (!isset($op['accountId'])) {
        throw new \InvalidArgumentException('createLine requires accountId.');
    }
    $accountId = (string) $op['accountId'];
    $account = $this->em->getRepository(Account::class)->find($accountId);
    if (!$account) {
        throw new \InvalidArgumentException(sprintf('Unknown account "%s".', $accountId));
    }
    $line = $this->hydrateLine(new Line(), $op, null, $account);
    $this->em->persist($line);
    $this->em->flush();

    if (isset($op['tempId'])) {
        $tempId = (string) $op['tempId'];
        if (isset($tempIds[$tempId])) {
            throw new \InvalidArgumentException(sprintf('Duplicate tempId "%s".', $tempId));
        }
        $tempIds[$tempId] = $line->getId();
    }
}

/** @param array<string, mixed> $op */
private function opUpdateLine(array $op, array &$tempIds): void
{
    $lineId = $this->resolveLineRef($op['lineId'] ?? null, $tempIds);
    $line = $this->em->getRepository(Line::class)->find($lineId);
    if (!$line) {
        throw new \InvalidArgumentException(sprintf('Unknown line id "%s".', $lineId));
    }
    if (!isset($op['accountId'])) {
        throw new \InvalidArgumentException('updateLine requires accountId.');
    }
    $accountId = (string) $op['accountId'];
    $account = $this->em->getRepository(Account::class)->find($accountId);
    if (!$account) {
        throw new \InvalidArgumentException(sprintf('Unknown account "%s".', $accountId));
    }
    // Passing the line's *current* transaction preserves membership —
    // updateLine never links or unlinks anything (see linkLines/unlinkLine).
    $this->hydrateLine($line, $op, $line->getTransaction(), $account);
    $this->em->persist($line);
    $this->em->flush();
}

/**
 * Resolves an op's line reference — either a real numeric Line id, or a
 * `tempId` string registered by an earlier `createLine` in this same
 * batch — to a real Line id. Every op that names a line
 * (updateLine/deleteLine/linkLines/unlinkLine) goes through this rather
 * than casting to int directly, so a bad or unresolved reference is a
 * clear 400 instead of silently becoming line id 0.
 *
 * @param array<string, int> $tempIds
 */
private function resolveLineRef(mixed $ref, array $tempIds): int
{
    if (null === $ref) {
        throw new \InvalidArgumentException('A line reference is required.');
    }
    $key = (string) $ref;
    if (isset($tempIds[$key])) {
        return $tempIds[$key];
    }
    if (!is_numeric($ref)) {
        throw new \InvalidArgumentException(sprintf('Unresolved line reference "%s".', $key));
    }

    return (int) $ref;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && php bin/phpunit tests/Service/LedgerOperationsTest.php`
Expected: PASS (4/4)

- [ ] **Step 5: Run the full backend suite to confirm nothing else broke**

Run: `cd backend && php bin/phpunit`
Expected: PASS (all existing tests, including `LedgerStateServiceAmountsTest`, still green — they still use the untouched legacy `upsertLine`/`upsertTransaction` ops)

- [ ] **Step 6: Commit**

```bash
cd backend && git add src/Service/LedgerStateService.php tests/Service/LedgerOperationsTest.php
git commit -m "Add createLine/updateLine ledger-batch primitives

Foundation for the relational ledger-operations rewrite (see
docs/superpowers/specs/2026-09-27-relational-ledger-operations-design.md).
Introduces resolveLineRef() for temp-id resolution within one atomic
batch. Legacy upsertLine/upsertTransaction/deleteLine/deleteTransaction
still dispatch unchanged — replaced task by task.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: `deleteLine` cascade rewrite

**Files:**
- Modify: `backend/src/Service/LedgerStateService.php` (replaces the old `opDeleteLine` at ~line 702; adds `demoteOrDeleteTransactionIfBelowMinimum`)
- Modify: `backend/tests/Service/LedgerOperationsTest.php`

**Interfaces:**
- Consumes: `resolveLineRef()` (Task 1).
- Produces: `private function demoteOrDeleteTransactionIfBelowMinimum(?string $transactionId): void` — consumed by Task 4's `unlinkLine`.
- Produces (test-only): a `linkOp(array $ids): array` test helper (`{ op: 'linkLines', lineIds: $ids }`) reused by every later task's tests.

- [ ] **Step 1: Write the failing tests**

Add to `LedgerOperationsTest.php` (a `linkOp` helper plus the deleteLine tests — `linkLines` doesn't exist yet, so these tests build the *pre-existing linked state* using two `createLine`s and a manually-constructed `linkLines` op array; that op is inert until Task 3, so these tests intentionally fail at Step 2 for two different reasons and get fixed together once Task 3 lands — see the note in Step 2):

```php
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && php bin/phpunit tests/Service/LedgerOperationsTest.php`
Expected: `testDeleteLineOnAStandaloneLineJustRemovesIt` and `testDeleteLineWithUnknownLineIdThrows` FAIL/ERROR (old `opDeleteLine` silently no-ops on an unknown id instead of throwing, and doesn't take a `$tempIds` param yet so this step's dispatch line doesn't even compile-match — see Step 3, which fixes the dispatch too). `testDeleteLineOnATwoLineTransactionDissolvesItAndDemotesTheSurvivor` and `testDeleteLineOnAThreeLineTransactionLeavesItIntact` FAIL because `linkLines` isn't dispatched yet (`default => null`), so no transaction is ever created — expected; Task 3 will make the `linkOp` setup in these two tests actually work, so re-run them after Task 3 too if they're still red for a different reason at that point.

- [ ] **Step 3: Replace `opDeleteLine` and add the cascade helper**

In `backend/src/Service/LedgerStateService.php`, replace the existing `opDeleteLine` method (currently ~line 702):

```php
/** @param array<string, mixed> $op */
private function opDeleteLine(array $op, array &$tempIds): void
{
    $lineId = $this->resolveLineRef($op['lineId'] ?? null, $tempIds);
    $line = $this->em->getRepository(Line::class)->find($lineId);
    if (!$line) {
        throw new \InvalidArgumentException(sprintf('Unknown line id "%s".', $lineId));
    }
    $transactionId = $line->getTransaction()?->getId();
    $this->em->remove($line);
    $this->em->flush();
    $this->demoteOrDeleteTransactionIfBelowMinimum($transactionId);
}

/**
 * Shared by deleteLine and unlinkLine: after a line leaves a Transaction
 * (removed outright, or detached to standalone), checks whether that
 * Transaction now has fewer than the 2 lines a real linked Transaction
 * always requires (see CLAUDE.md's "Data model"). At exactly 1 remaining
 * line, that survivor is demoted to standalone *before* the Transaction
 * row is removed — Line.transaction is ON DELETE CASCADE at the database
 * level, so removing the Transaction first would delete the survivor too.
 * The Transaction itself is always removed via a bulk DQL DELETE, never
 * $em->remove() on the loaded entity — that would trigger the ORM's own
 * cascade/orphanRemoval semantics against its (possibly stale) in-memory
 * `lines` collection, which is exactly the trap Transaction::removeLine()
 * sets (see this plan's Global Constraints).
 */
private function demoteOrDeleteTransactionIfBelowMinimum(?string $transactionId): void
{
    if (null === $transactionId) {
        return;
    }
    $remainingIds = $this->em->getConnection()->fetchFirstColumn(
        'SELECT id FROM line WHERE transaction_id = ?',
        [$transactionId]
    );
    if (\count($remainingIds) >= 2) {
        return;
    }
    foreach ($remainingIds as $survivorId) {
        $survivor = $this->em->getRepository(Line::class)->find((int) $survivorId);
        if ($survivor) {
            $survivor->setTransaction(null);
            $this->em->persist($survivor);
        }
    }
    $this->em->flush();
    $this->em->createQuery('DELETE FROM App\Entity\Transaction t WHERE t.id = :id')
        ->setParameter('id', $transactionId)
        ->execute();
}
```

Update the `applyLedgerOperations()` dispatch line for `deleteLine` (added in Task 1) to pass `$tempIds`:

```php
                'deleteLine' => $this->opDeleteLine($op, $tempIds),
```

- [ ] **Step 4: Run tests to verify they pass (deleteLine-specific ones; linkLines-dependent ones stay red until Task 3)**

Run: `cd backend && php bin/phpunit tests/Service/LedgerOperationsTest.php`
Expected: `testDeleteLineOnAStandaloneLineJustRemovesIt` and `testDeleteLineWithUnknownLineIdThrows` PASS. The two transaction-cascade tests remain FAIL until Task 3 adds `linkLines` — confirm the failure is specifically "transaction never created" (0 transactions), not a new error, before moving on.

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && php bin/phpunit`
Expected: no new failures beyond the two known-pending `linkLines`-dependent tests from this file.

- [ ] **Step 6: Commit**

```bash
cd backend && git add src/Service/LedgerStateService.php tests/Service/LedgerOperationsTest.php
git commit -m "Rewrite deleteLine with a transaction-cascade helper

deleteLine now demotes a lone survivor to standalone and dissolves its
Transaction when a delete drops it below 2 lines, instead of leaving
that decision to the frontend. Adds demoteOrDeleteTransactionIfBelowMinimum(),
shared with unlinkLine (Task 4).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: `linkLines` primitive

**Files:**
- Modify: `backend/src/Service/LedgerStateService.php`
- Modify: `backend/tests/Service/LedgerOperationsTest.php`

**Interfaces:**
- Consumes: `resolveLineRef()` (Task 1), `Transaction::addLine()` (existing entity method).
- Produces: `private function opLinkLines(array $op, array &$tempIds): void`. This is what makes the `linkOp()` helper used by Task 2's tests actually create a Transaction — re-run the full test file at the end of this task and confirm those two tests now pass for real.

- [ ] **Step 1: Write the failing tests**

Add to `LedgerOperationsTest.php`:

```php
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && php bin/phpunit tests/Service/LedgerOperationsTest.php`
Expected: every new test FAILs (`linkLines` isn't dispatched — `default => null`, so nothing happens and no exception is thrown where one's expected).

- [ ] **Step 3: Implement `opLinkLines`**

Add to `backend/src/Service/LedgerStateService.php`, and update the `linkLines` dispatch line:

```php
                'linkLines' => $this->opLinkLines($op, $tempIds),
```

```php
/**
 * Puts 2+ lines in one Transaction, creating a fresh one only if none of
 * them already has one. Never merges two *different* pre-existing
 * Transactions — a caller that genuinely needs that unlinks first (see
 * the design spec's "linkLines" section). Idempotent when every given
 * line already belongs to the one target Transaction.
 *
 * @param array<string, mixed> $op
 */
private function opLinkLines(array $op, array &$tempIds): void
{
    $rawIds = $op['lineIds'] ?? null;
    if (!\is_array($rawIds) || \count($rawIds) < 2) {
        throw new \InvalidArgumentException('linkLines requires at least 2 line ids.');
    }
    $resolvedIds = array_map(fn ($ref) => $this->resolveLineRef($ref, $tempIds), $rawIds);
    if (\count($resolvedIds) !== \count(array_unique($resolvedIds))) {
        throw new \InvalidArgumentException('linkLines given duplicate line ids.');
    }

    $lines = [];
    foreach ($resolvedIds as $id) {
        $line = $this->em->getRepository(Line::class)->find($id);
        if (!$line) {
            throw new \InvalidArgumentException(sprintf('Unknown line id "%s".', $id));
        }
        $lines[] = $line;
    }

    $existingTransactionIds = [];
    foreach ($lines as $line) {
        $t = $line->getTransaction();
        if ($t) {
            $existingTransactionIds[$t->getId()] = true;
        }
    }
    if (\count($existingTransactionIds) > 1) {
        throw new \InvalidArgumentException('linkLines cannot span two different existing transactions.');
    }

    if (1 === \count($existingTransactionIds)) {
        $transaction = $this->em->getRepository(Transaction::class)->find(array_key_first($existingTransactionIds));
    } else {
        $transaction = new Transaction();
        $transaction->setId(bin2hex(random_bytes(8)));
        $this->em->persist($transaction);
    }

    foreach ($lines as $line) {
        $transaction->addLine($line);
        $this->em->persist($line);
    }
    $this->em->flush();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && php bin/phpunit tests/Service/LedgerOperationsTest.php`
Expected: PASS, including the two `deleteLine` cascade tests from Task 2 that depended on `linkLines` actually working.

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && php bin/phpunit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd backend && git add src/Service/LedgerStateService.php tests/Service/LedgerOperationsTest.php
git commit -m "Add linkLines ledger-batch primitive

Creates a new Transaction from standalone lines, or extends an
existing one; hard-errors on lines spanning two different existing
Transactions, or on any duplicate id, rather than silently merging or
deduping. See docs/superpowers/specs/2026-09-27-relational-ledger-operations-design.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: `unlinkLine` primitive

**Files:**
- Modify: `backend/src/Service/LedgerStateService.php`
- Modify: `backend/tests/Service/LedgerOperationsTest.php`

**Interfaces:**
- Consumes: `resolveLineRef()` (Task 1), `demoteOrDeleteTransactionIfBelowMinimum()` (Task 2).
- Produces: `private function opUnlinkLine(array $op, array &$tempIds): void`.

- [ ] **Step 1: Write the failing tests**

Add to `LedgerOperationsTest.php`:

```php
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && php bin/phpunit tests/Service/LedgerOperationsTest.php`
Expected: the new `unlinkLine`-based tests FAIL (`default => null`, nothing happens).

- [ ] **Step 3: Implement `opUnlinkLine`**

Add to `backend/src/Service/LedgerStateService.php`, and add the dispatch line:

```php
                'unlinkLine' => $this->opUnlinkLine($op, $tempIds),
```

```php
/**
 * Removes one line from its Transaction, making it standalone. Idempotent
 * — a line that's already standalone (whether from before this batch, or
 * demoted by an earlier cascade within this same batch) is a no-op, not
 * an error. This is what lets a full unlink send unlinkLine for every
 * line of a record without the caller needing to hold one back for the
 * cascade that demotes the last survivor automatically.
 *
 * @param array<string, mixed> $op
 */
private function opUnlinkLine(array $op, array &$tempIds): void
{
    $lineId = $this->resolveLineRef($op['lineId'] ?? null, $tempIds);
    $line = $this->em->getRepository(Line::class)->find($lineId);
    if (!$line) {
        throw new \InvalidArgumentException(sprintf('Unknown line id "%s".', $lineId));
    }
    $transaction = $line->getTransaction();
    if (!$transaction) {
        return;
    }
    $transactionId = $transaction->getId();
    $line->setTransaction(null);
    $this->em->persist($line);
    $this->em->flush();
    $this->demoteOrDeleteTransactionIfBelowMinimum($transactionId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && php bin/phpunit tests/Service/LedgerOperationsTest.php`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && php bin/phpunit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd backend && git add src/Service/LedgerStateService.php tests/Service/LedgerOperationsTest.php
git commit -m "Add unlinkLine ledger-batch primitive

Idempotent on an already-standalone line, so a full unlink can send
unlinkLine for every line of a record instead of holding one back for
the cascade. All five new primitives (createLine/updateLine/deleteLine/
linkLines/unlinkLine) are now implemented alongside the legacy four.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Backend cutover — remove the legacy vocabulary

**Files:**
- Modify: `backend/src/Service/LedgerStateService.php` (remove `opDeleteTransaction`, `opUpsertLine`, `opUpsertTransaction`, `deleteTransactionLines`, `deleteLineTagsForLines`; update `applyLedgerOperations()`'s dispatch and `assertOperationDatesInActiveTaxYear()`)
- Modify: `backend/tests/Service/LedgerStateServiceAmountsTest.php` (migrate `line()` helper off `upsertLine`; remove the two tests that exist solely to cover the removed ops)
- Modify: `backend/src/Controller/LedgerController.php` (docblock only)

**Interfaces:**
- No new interfaces — this task only removes dead code and repoints existing test helpers at the primitives from Tasks 1–4.

- [ ] **Step 1: Update `LedgerStateServiceAmountsTest.php`'s `line()` helper**

In `backend/tests/Service/LedgerStateServiceAmountsTest.php`, replace:

```php
    private function line(string $accountId, string $amount, string $date, array $extra = []): array
    {
        return ['op' => 'upsertLine', 'line' => ['accountId' => $accountId, 'amount' => $amount, 'date' => $date, 'description' => '', ...$extra]];
    }
```

with:

```php
    private function line(string $accountId, string $amount, string $date, array $extra = []): array
    {
        return ['op' => 'createLine', 'accountId' => $accountId, 'amount' => $amount, 'date' => $date, 'description' => '', ...$extra];
    }
```

Delete `testUpsertLineWithUnknownAccountThrowsAndWritesNothing()` and `testUpsertTransactionWithUnknownAccountOnOneLegThrowsAndWritesNothing()` entirely (their coverage is superseded by `LedgerOperationsTest::testCreateLineWithUnknownAccountThrowsAndWritesNothing` and `::testLinkLinesWithAnUnresolvedTempIdThrowsAndWritesNothing`, added in Tasks 1 and 3).

- [ ] **Step 2: Run the amounts test file to confirm the migrated helper still works**

Run: `cd backend && php bin/phpunit tests/Service/LedgerStateServiceAmountsTest.php`
Expected: PASS (5 remaining tests — the balance/stock-math ones never needed linking, so `createLine` alone reproduces their setup exactly)

- [ ] **Step 3: Remove the legacy op handlers and dead helpers**

In `backend/src/Service/LedgerStateService.php`:

1. In `applyLedgerOperations()`, remove the three legacy dispatch lines, leaving:

```php
public function applyLedgerOperations(array $operations): void
{
    $this->em->wrapInTransaction(function () use ($operations) {
        $this->assertOperationDatesInActiveTaxYear($operations);
        $tempIds = [];
        foreach ($operations as $op) {
            match ($op['op'] ?? null) {
                'createLine' => $this->opCreateLine($op, $tempIds),
                'updateLine' => $this->opUpdateLine($op, $tempIds),
                'deleteLine' => $this->opDeleteLine($op, $tempIds),
                'linkLines' => $this->opLinkLines($op, $tempIds),
                'unlinkLine' => $this->opUnlinkLine($op, $tempIds),
                default => null,
            };
        }
    });
}
```

2. Delete these four methods entirely: `opDeleteTransaction()`, `opUpsertLine()`, `opUpsertTransaction()`, `deleteTransactionLines()`, `deleteLineTagsForLines()`. (Confirm none of them are referenced elsewhere first: `grep -n "opDeleteTransaction\|opUpsertLine\|opUpsertTransaction\|deleteTransactionLines\|deleteLineTagsForLines" backend/src -r` should, after this edit, return no matches — `deleteTransactionIfEmpty()`, used by the unrelated `deleteAccount()` path, is a different method and must NOT be touched.)

3. Update `assertOperationDatesInActiveTaxYear()`'s date-extraction `match` (the new op shapes carry line fields flat, not nested under `line`/`lines`):

```php
    private function assertOperationDatesInActiveTaxYear(array $operations): void
    {
        $dates = [];
        foreach ($operations as $op) {
            $lines = match ($op['op'] ?? null) {
                'createLine', 'updateLine' => [$op],
                default => [],
            };
            foreach ($lines as $line) {
                if (\is_array($line) && \is_string($line['date'] ?? null)) {
                    $dates[] = $line['date'];
                }
            }
        }
        // ...unchanged from here down
```

- [ ] **Step 4: Update `LedgerController`'s docblock**

In `backend/src/Controller/LedgerController.php`, update the class docblock:

```php
/**
 * One endpoint for every ledger write that isn't a plain account/settings
 * change — a standalone line's own create/edit/delete, and every compound
 * action built from them (merge, split-off, unlink, same-date reorder) —
 * applied atomically as an ordered list of operations. See
 * LedgerStateService::applyLedgerOperations() for the five primitives
 * (createLine, updateLine, deleteLine, linkLines, unlinkLine) and how
 * each frontend action maps to a short sequence of them.
 */
```

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && php bin/phpunit`
Expected: PASS — all tests in `LedgerOperationsTest.php` and the migrated `LedgerStateServiceAmountsTest.php`, plus every unrelated test file (`IsaAllowanceServiceTest`, `DecimalTest`, etc.), unaffected.

- [ ] **Step 6: Confirm no remaining references to the removed op names anywhere in the backend**

Run: `cd backend && grep -rn "'upsertLine'\|'upsertTransaction'\|'deleteTransaction'" src/`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
cd backend && git add src/Service/LedgerStateService.php src/Controller/LedgerController.php tests/Service/LedgerStateServiceAmountsTest.php
git commit -m "Remove the legacy upsert/replace ledger-batch vocabulary

POST /api/ledger/batch now speaks only createLine/updateLine/
deleteLine/linkLines/unlinkLine. Migrates LedgerStateServiceAmountsTest
off upsertLine and drops the two tests whose sole purpose was covering
the removed ops (superseded by LedgerOperationsTest).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Rewrite `src/lib/ledgerOperations.js` and its call sites

**Files:**
- Modify: `src/lib/ledgerOperations.js` (full rewrite of all four builders)
- Modify: `src/components/AccountLedger.jsx` (`commit()`, `unlinkNow()`)
- Modify: `src/components/StockLedger.jsx` (`commit()`, `unlinkNow()`)

**Interfaces:**
- Produces: `buildSaveOperations({ primaryLineId, newLines, splitOffLineIds })`, `buildUnlinkOperations(lines)`, `buildDeleteOperations(record, accountId)` (signature unchanged), `buildReorderOperations(patches)` where `patches` is `{ lineId, line }[]` (consumed from Task 7's `reorderSameDate()`).
- Consumes: nothing new — these are pure functions over plain objects, called from `AccountLedger.jsx`/`StockLedger.jsx`.

No backend interaction to test against from the frontend (no dev server needed for this task — it's pure JS with no unit test coverage in this codebase, matching the existing convention for this file). Verification is manual, in Task 8, once both ledgers compile against the new signatures.

- [ ] **Step 1: Rewrite `src/lib/ledgerOperations.js`**

Replace the entire file:

```js
// Builds the operations array for POST /api/ledger/batch — see
// backend/src/Service/LedgerStateService.php's applyLedgerOperations()
// docblock for the five primitives these compose. Shared by
// AccountLedger.jsx and StockLedger.jsx so the standalone-vs-linked
// transition logic exists in exactly one place.
//
// A record is `{ transactionId: string|null, lines: [...] }` — standalone
// (transactionId null) or linked (2+ lines). Transaction lifecycle
// (creating one, extending one, dissolving one, demoting a lone survivor
// back to standalone) is decided entirely by the backend now — this
// module only ever expresses intent: create this line, edit that one,
// put these lines together, take this one out of its group, delete this
// one outright. Line ids never need to be invented client-side any more:
// a brand-new line is given a `tempId` and referenced by it within the
// same batch, resolved to its real id by the backend before the batch
// commits.

let tempIdCounter = 0;
function nextTempId() {
  return `tmp${++tempIdCounter}`;
}

// Builds the ops for saving one record's full edit: the primary line
// (this account's own leg, always present in `newLines[0]`), any other
// legs still active, and any legs explicitly split off this save.
// `primaryLineId` is this account's own existing line id — whether it was
// standalone or already linked — or null for a brand-new entry. Each
// other line in `newLines` (index >= 1) carries its own `id` already if
// it has a backing row (a pre-existing unchanged leg, or one selected via
// match search) — see otherLines.jsx's `resolveOtherLine`.
export function buildSaveOperations({ primaryLineId, newLines, splitOffLineIds = [] }) {
  const ops = splitOffLineIds.map((lineId) => ({ op: "unlinkLine", lineId }));

  const refs = newLines.map((line, i) => {
    const existingId = i === 0 ? primaryLineId : (line.id ?? null);
    if (existingId) {
      ops.push({ op: "updateLine", lineId: existingId, ...line });
      return existingId;
    }
    const tempId = nextTempId();
    ops.push({ op: "createLine", tempId, ...line });
    return tempId;
  });

  if (refs.length >= 2) {
    ops.push({ op: "linkLines", lineIds: refs });
  }

  return ops;
}

// Splits an already-linked record back into N fully separate, unlinked
// standalone lines — the reverse of a merge. No side's data (including
// its own date) is touched; each just goes back to standing alone.
// unlinkLine is idempotent, so every line of the record is sent — no need
// to hold one back for the cascade that demotes the last survivor.
export function buildUnlinkOperations(lines) {
  return lines.map((line) => ({ op: "unlinkLine", lineId: line.id }));
}

// Deletes only the calling account's own leg(s) of a record. A standalone
// line just goes. A linked transaction never has any other account's
// line(s) discarded with it — mirroring removeOtherLine()'s "removing a
// leg never deletes the other side's data" rule (see CLAUDE.md's
// "Matching and linking"). The backend's deleteLine cascade demotes a
// lone survivor to standalone, or dissolves the transaction entirely, on
// its own.
export function buildDeleteOperations(record, accountId) {
  return record.lines.filter((l) => l.accountId === accountId).map((l) => ({ op: "deleteLine", lineId: l.id }));
}

// One updateLine per patched line — see lib/grouping.js's
// reorderSameDate(), which returns `{ lineId, line }` patches directly in
// this shape (the full line, minus its own id, plus its new order).
export function buildReorderOperations(patches) {
  return patches.map(({ lineId, line }) => ({ op: "updateLine", lineId, ...line }));
}
```

- [ ] **Step 2: Update `AccountLedger.jsx`'s `commit()` and `unlinkNow()`**

In `src/components/AccountLedger.jsx`, add a small helper right above `commit()` (around line 269):

```js
  // This account's own line's existing id — whether the record was
  // already standalone (draft.lineId) or already linked (not tracked on
  // draft directly; found from the original record's own lines) — or
  // null for a brand-new entry.
  function primaryLineIdOf(d) {
    if (d.mode !== "edit") return null;
    if (d.lineId) return d.lineId;
    const line = d.originalRecord.lines.find((l) => l.accountId === account.id);
    return line ? line.id : null;
  }
```

Replace the body of `commit()` (currently lines 269–297):

```js
  function commit() {
    if (!draft) return false;
    const delta = draftDelta(draft);
    if (isZero(delta)) { setDraftError("Enter an amount in In or Out."); return false; }
    const newLines = draftLines(draft);
    const offender = newLines.find((l) => dateOutsideTaxYear(l.date, activeTaxYearStart));
    if (offender) {
      setDraftError(`${fmtDate(offender.date)} is outside the ${taxYearBounds(activeTaxYearStart).label} tax year.`);
      return false;
    }
    const operations = buildSaveOperations({
      primaryLineId: primaryLineIdOf(draft),
      newLines,
      splitOffLineIds: draft.splitOffLines.map((l) => l.id),
    });
    onLedgerOperations(operations).then(reload);
    setDraft(null);
    setDraftError("");
    return true;
  }
```

Replace `unlinkNow()` (currently lines 255–260):

```js
  function unlinkNow() {
    if (!draft || !draft.originalRecord || draft.originalRecord.lines.length < 2) return;
    onLedgerOperations(buildUnlinkOperations(draft.originalRecord.lines)).then(reload);
    setDraft(null);
    setDraftError("");
  }
```

`deleteEntry()` and `moveRow()` are unchanged (`buildDeleteOperations`'s signature is identical; `buildReorderOperations`'s call site doesn't change shape, only what `reorderSameDate()` hands it — see Task 7).

- [ ] **Step 3: Apply the identical change to `StockLedger.jsx`**

In `src/components/StockLedger.jsx`, add the same `primaryLineIdOf(d)` helper above `commit()` (around line 271), and replace `commit()` (currently lines 271–294) and `unlinkNow()` (currently lines 257–262) with the same bodies as Step 2 (only `draftDelta`/`isZero(delta)` in `commit()`'s guard stays as `StockLedger.jsx` already has it — `if (isZero(unitsDeltaOf(draft))) { ... }` — don't copy `AccountLedger.jsx`'s guard line, only the `buildSaveOperations`/`primaryLineIdOf` parts change):

```js
  function primaryLineIdOf(d) {
    if (d.mode !== "edit") return null;
    if (d.lineId) return d.lineId;
    const line = d.originalRecord.lines.find((l) => l.accountId === account.id);
    return line ? line.id : null;
  }
```

```js
  function commit() {
    if (!draft) return false;
    if (isZero(unitsDeltaOf(draft))) { setDraftError("Enter units in or out."); return false; }
    const newLines = draftLines(draft);
    const offender = newLines.find((l) => dateOutsideTaxYear(l.date, activeTaxYearStart));
    if (offender) {
      setDraftError(`${fmtDate(offender.date)} is outside the ${taxYearBounds(activeTaxYearStart).label} tax year.`);
      return false;
    }
    const operations = buildSaveOperations({
      primaryLineId: primaryLineIdOf(draft),
      newLines,
      splitOffLineIds: draft.splitOffLines.map((l) => l.id),
    });
    onLedgerOperations(operations).then(reload);
    setDraft(null);
    setDraftError("");
    return true;
  }
```

```js
  function unlinkNow() {
    if (!draft || !draft.originalRecord || draft.originalRecord.lines.length < 2) return;
    onLedgerOperations(buildUnlinkOperations(draft.originalRecord.lines)).then(reload);
    setDraft(null);
    setDraftError("");
  }
```

- [ ] **Step 4: Confirm the frontend still builds**

Run: `yarn build`
Expected: build succeeds with no errors (this catches any leftover reference to the old `buildSaveOperations`/`buildUnlinkOperations` parameter shapes, e.g. a stray `oldTransactionId`/`absorbedLineIds` that would now just be silently ignored rather than erroring — a plain build won't catch that; Task 8's manual verification is what actually proves behavior, this step only proves the app still compiles and runs).

- [ ] **Step 5: Run the existing Vitest suite (unaffected, but confirms nothing else broke)**

Run: `yarn test`
Expected: PASS (this suite only covers `decimal.js`/`format.js`/`stockMath.js`, none of which this task touches — a regression here would mean an unrelated mistake)

- [ ] **Step 6: Commit**

```bash
git add src/lib/ledgerOperations.js src/components/AccountLedger.jsx src/components/StockLedger.jsx
git commit -m "Rewrite ledgerOperations.js against the five new primitives

buildSaveOperations/buildUnlinkOperations/buildDeleteOperations no
longer compute a record's final shape or track transaction ids — they
express intent (create/update/link/unlink/delete a line) and let the
backend derive transaction lifecycle, matching the relational rewrite
in backend/src/Service/LedgerStateService.php.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Simplify `reorderSameDate()`

**Files:**
- Modify: `src/lib/grouping.js` (`reorderSameDate()`, currently lines 140–161)

**Interfaces:**
- Produces: `reorderSameDate(rows, idx, dir)` now returns `{ lineId, line }[]` instead of `{ transactionId, lineId, lines }[]` — consumed by `buildReorderOperations` (Task 6, already updated to expect this shape) and `moveRow()` in `AccountLedger.jsx`/`StockLedger.jsx` (unchanged call sites — they just pass the result straight through).

- [ ] **Step 1: Replace the return statement**

In `src/lib/grouping.js`, replace the final `return` of `reorderSameDate()`:

```js
  return newOrderArr.map((absIdx, seq) => {
    const r = rows[absIdx];
    return {
      transactionId: r.record.transactionId,
      lineId: r.record.transactionId ? null : r.line.id,
      lines: r.record.lines.map((l) => (l === r.line ? { ...l, order: seq } : l)),
    };
  });
```

with:

```js
  return newOrderArr.map((absIdx, seq) => {
    const r = rows[absIdx];
    const { id: lineId, ...line } = r.line;
    return { lineId, line: { ...line, order: seq } };
  });
```

(This only ever touches the moved row's own line — a same-date reorder never needs to resend a linked record's other legs any more, since `updateLine` edits one line without disturbing its transaction membership.)

- [ ] **Step 2: Confirm the frontend still builds**

Run: `yarn build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/lib/grouping.js
git commit -m "Simplify reorderSameDate() to patch one line, not a whole record

updateLine edits a line without touching transaction membership, so a
same-date reorder no longer needs to resend a linked record's other
legs — see the ledgerOperations.js rewrite in the previous commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: End-to-end manual verification

**Files:** none (verification only — no code changes expected; if a bug surfaces, fix it in the relevant file from Tasks 6–7 and re-run this task's steps from the top).

**Interfaces:** none — this task exercises the full stack through the browser.

- [ ] **Step 1: Start the backend**

Run (in a background/separate terminal): `cd backend && symfony server:start --port=8000`
Expected: server starts, listening on :8000.

- [ ] **Step 2: Start the frontend dev server via the preview tool**

Use `preview_start` with `{name: "<the dev server config in .claude/launch.json>"}` (create the config first if it doesn't exist: `runtimeExecutable: "yarn"`, `runtimeArgs: ["dev"]`, `port: 5173`). Confirm the account list loads.

- [ ] **Step 3: Plain edit, no shape change**

Open an existing standalone entry in any cash account, change its description, save. Confirm: the row updates in place, the running balance is unchanged, no new row appears, `read_network_requests` shows a `POST /api/ledger/batch` body containing exactly one `updateLine` op (no `createLine`, no `linkLines`).

- [ ] **Step 4: New standalone entry**

Click "Add entry", fill in date/description/an In or Out amount, no other-account leg, save. Confirm: a new row appears; the batch body is exactly one `createLine` op.

- [ ] **Step 5: New linked entry (2 new legs)**

Click "Add entry" on account A, fill in an amount, add one other-account leg pointing at account B with its own amount, save. Confirm: both accounts now show a linked row (with a transfer arrow/other-account name); the batch body has two `createLine` ops (with distinct `tempId`s) followed by one `linkLines` op referencing both `tempId`s.

- [ ] **Step 6: Merge via match**

Create a standalone entry in account C, then open a new entry in account D with the exact opposite amount/date so it appears under "Possible matches"; click it. Save. Confirm: both entries now show as one linked row; the batch body has one `createLine` (or `updateLine` if D's own leg already existed) plus one `linkLines` referencing the new line and the matched line's real id (no `createLine` for the matched side).

- [ ] **Step 7: Edit an already-linked entry's other leg**

Open the linked entry from Step 5 or 6, change the other leg's amount, save. Confirm: both sides update; the batch body has `updateLine` calls only — no `linkLines` needed since nothing about membership changed (or, if `linkLines` is still sent redundantly per the plan's simpler frontend logic, confirm it causes no error and no row/id churn — check the other leg's row still shows its original id-derived key, not a new one).

- [ ] **Step 8: Split one leg off a 3-way entry**

Build a 3-way split (one primary + two other-account legs) via "Add entry" + two other-lines, save. Re-open it, click the X on one other-account leg (not the primary). Confirm the "N removed line(s) will be saved as separate, unlinked entries" note appears, then save. Confirm: the removed leg now shows as its own standalone row in its own account; the remaining 2-line entry stays linked; the batch body includes exactly one `unlinkLine` for the removed leg's real id.

- [ ] **Step 9: Full unlink**

Open the remaining 2-line linked entry from Step 8, click "Unlink all". Confirm: both sides now show as separate standalone rows; the batch body has one `unlinkLine` per line of the record (per this plan's design, the frontend no longer holds one back).

- [ ] **Step 10: Delete a leg from a multi-line record**

Build a fresh 3-way split, save, then open it from one of the non-primary accounts and click Delete. Confirm: that account's own leg is gone; the other two accounts' legs remain linked to each other (2-line transaction survives); the batch body has one `deleteLine` for the deleted leg's own id.

- [ ] **Step 11: Same-date reorder**

Find (or create) two same-date entries in one account, use the up/down chevrons to reorder them. Confirm the order visibly swaps and persists after a page reload; the batch body has one `updateLine` op (not two, and not carrying any other line's data).

- [ ] **Step 12: Stock ledger — new linked trade**

In an investment account, add a new entry with units + value filled in (creating an implicit cash leg via the smart-default), or manually add an other-account leg for the cash side, save. Confirm: the trade appears with correct cost basis/portfolio value in the header; the cash account shows the matching leg; the batch body follows the same `createLine`×2 + `linkLines` pattern as Step 5.

- [ ] **Step 13: Check the browser console and network tab for errors across all of the above**

Use `read_console_messages` (onlyErrors: true) and `read_network_requests` (filtered to `/api/ledger/batch`) after the full pass. Expected: no console errors, every batch call returned `{"ok": true}` with a `200` status (or a clear `400` with a sensible message for anything intentionally invalid tried along the way).

- [ ] **Step 14: Final full-suite check on both sides**

Run: `cd backend && php bin/phpunit && cd .. && yarn test && yarn build`
Expected: everything PASSes/builds.

No commit for this task (verification only) — if any step surfaces a bug, fix it in the appropriate file from Tasks 1–7, add/update a test proving the fix, and re-run this task's steps from the top before considering the plan complete.
