<?php

namespace App\Service;

use App\Entity\Account;
use App\Entity\Line;
use App\Entity\Settings;
use App\Entity\Transaction;
use App\Repository\SettingsRepository;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Owns every read/write path for the ledger's data. Three kinds of caller:
 *
 *  - StateController's GET /api/state: readState(), a plain full read.
 *  - The discrete per-entity endpoints (AccountController,
 *    SettingsController, TransactionController): upsertAccount(),
 *    deleteAccount(), replaceSettings(), applyTransactionOperations() —
 *    each one a single, independently-atomic mutation. This is the live
 *    app's normal write path.
 *  - ImportLocalStorageCommand: writeState(), a wipe-and-rebuild of
 *    everything from one exported blob. This is intentionally *not* built
 *    out of the discrete methods above — a first-time import is genuinely
 *    a "replace everything" operation, so rebuilding from scratch avoids
 *    having to diff against whatever (if anything) is already there.
 *
 * Compound frontend actions — merging two entries, splitting a removed
 * line off into its own record, reordering several same-date rows —
 * become a single applyTransactionOperations() call carrying an ordered
 * list of upsert/delete operations, applied in one DB transaction. That's
 * the one place multiple entities still need to change atomically
 * together; accounts and settings never had that requirement.
 */
class LedgerStateService
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly SettingsRepository $settingsRepository,
    ) {
    }

    /** @return array{accounts: array<int, array<string, mixed>>, transactions: array<int, array<string, mixed>>, settings: array<string, mixed>} */
    public function readState(): array
    {
        $settings = $this->settingsRepository->getOrCreate();

        return [
            'accounts' => $this->accountsArray(),
            'transactions' => $this->transactionsArray(),
            'settings' => $this->settingsToArray($settings),
        ];
    }

    /**
     * Wipes and rebuilds the whole ledger from a plain array in the same
     * shape readState() returns. Only used for the one-time local-storage
     * import — see the class docblock.
     *
     * @param array<int, array<string, mixed>> $accountsData
     * @param array<int, array<string, mixed>> $transactionsData
     * @param array<string, mixed>             $settingsData
     */
    public function writeState(array $accountsData, array $transactionsData, array $settingsData): void
    {
        $this->em->wrapInTransaction(function () use ($accountsData, $transactionsData, $settingsData) {
            $connection = $this->em->getConnection();
            $connection->executeStatement('DELETE FROM line');
            $connection->executeStatement('DELETE FROM transactions');
            $connection->executeStatement('DELETE FROM account');

            $accountsById = [];
            foreach ($accountsData as $data) {
                $account = $this->hydrateAccount(new Account(), $data);
                $account->setId((string) $data['id']);
                $this->em->persist($account);
                $accountsById[$account->getId()] = $account;
            }

            foreach ($transactionsData as $data) {
                $transaction = new Transaction();
                $transaction->setId((string) $data['id']);
                $this->em->persist($transaction);

                foreach ($data['lines'] ?? [] as $lineData) {
                    $accountId = (string) $lineData['accountId'];
                    if (!isset($accountsById[$accountId])) {
                        // A line pointing at an account that isn't in this
                        // import is malformed input — skip rather than
                        // fail the whole import.
                        continue;
                    }
                    $line = $this->hydrateLine(new Line(), $lineData, $transaction, $accountsById[$accountId]);
                    $this->em->persist($line);
                }
            }

            $settings = $this->settingsRepository->getOrCreate();
            $this->hydrateSettings($settings, $settingsData);
            $this->em->persist($settings);
        });
    }

    /** @param array<string, mixed> $data */
    public function upsertAccount(string $id, array $data): array
    {
        $account = $this->em->getRepository(Account::class)->find($id) ?? new Account();
        $account->setId($id);
        $this->hydrateAccount($account, $data);
        $this->em->persist($account);
        $this->em->flush();

        return $this->accountToArray($account);
    }

    /**
     * Deletes one account. Never deletes the other side of anything
     * linked to it — a transaction that also has lines in other accounts
     * just loses this account's own line; only a transaction that becomes
     * completely empty as a result is removed. Same semantics the
     * frontend used to compute itself before persisting (see CLAUDE.md).
     *
     * @return array<int, array<string, mixed>> the fresh transactions list
     */
    public function deleteAccount(string $id): array
    {
        return $this->em->wrapInTransaction(function () use ($id) {
            $account = $this->em->getRepository(Account::class)->find($id);
            if ($account) {
                $lines = $this->em->getRepository(Line::class)->findBy(['account' => $account]);
                $touchedTransactionIds = [];
                foreach ($lines as $line) {
                    $touchedTransactionIds[$line->getTransaction()->getId()] = true;
                    $this->em->remove($line);
                }
                $this->em->remove($account);
                $this->em->flush();

                foreach (array_keys($touchedTransactionIds) as $transactionId) {
                    $this->deleteTransactionIfEmpty($transactionId);
                }
            }

            $this->em->clear();

            return $this->transactionsArray();
        });
    }

    /** @param array<string, mixed> $data */
    public function replaceSettings(array $data): array
    {
        $settings = $this->settingsRepository->getOrCreate();
        $this->hydrateSettings($settings, $data);
        $this->em->persist($settings);
        $this->em->flush();

        return $this->settingsToArray($settings);
    }

    /**
     * Applies an ordered list of transaction upserts/deletes atomically —
     * the shared path for a plain single save, a merge (upsert + delete
     * the absorbed record), a split-off (upsert + insert new standalone
     * records), and a same-date reorder (several upserts at once).
     *
     * Each "upsert" replaces that transaction's lines wholesale (delete
     * then reinsert) rather than diffing — the frontend already always
     * sends the complete new lines array for a transaction it's editing,
     * never a partial patch.
     *
     * @param array<int, array{op: string, id?: string, transaction?: array<string, mixed>}> $operations
     *
     * @return array<int, array<string, mixed>> the fresh transactions list
     */
    public function applyTransactionOperations(array $operations): array
    {
        return $this->em->wrapInTransaction(function () use ($operations) {
            foreach ($operations as $op) {
                $type = $op['op'] ?? null;

                if ('delete' === $type && isset($op['id'])) {
                    $this->deleteTransactionLines((string) $op['id']);
                    $transaction = $this->em->getRepository(Transaction::class)->find((string) $op['id']);
                    if ($transaction) {
                        $this->em->remove($transaction);
                        $this->em->flush();
                    }
                    continue;
                }

                if ('upsert' === $type && isset($op['transaction']['id'])) {
                    $data = $op['transaction'];
                    $txnId = (string) $data['id'];

                    $this->deleteTransactionLines($txnId);
                    $transaction = $this->em->getRepository(Transaction::class)->find($txnId) ?? new Transaction();
                    $transaction->setId($txnId);
                    $this->em->persist($transaction);

                    foreach ($data['lines'] ?? [] as $lineData) {
                        $account = $this->em->getRepository(Account::class)->find((string) $lineData['accountId']);
                        if (!$account) {
                            // Same reasoning as writeState(): a line
                            // pointing nowhere is malformed input, skip it
                            // rather than fail the whole batch.
                            continue;
                        }
                        $line = $this->hydrateLine(new Line(), $lineData, $transaction, $account);
                        $this->em->persist($line);
                    }
                    $this->em->flush();
                }
            }

            $this->em->clear();

            return $this->transactionsArray();
        });
    }

    /**
     * Bulk-deletes a transaction's lines via DQL rather than through its
     * (possibly not yet loaded, possibly stale) in-memory collection —
     * every caller here only cares that the rows are gone, not about
     * touching loaded entities.
     */
    private function deleteTransactionLines(string $transactionId): void
    {
        $this->em->createQuery('DELETE FROM App\Entity\Line l WHERE IDENTITY(l.transaction) = :id')
            ->setParameter('id', $transactionId)
            ->execute();
    }

    private function deleteTransactionIfEmpty(string $transactionId): void
    {
        $count = (int) $this->em->createQuery('SELECT COUNT(l.id) FROM App\Entity\Line l WHERE IDENTITY(l.transaction) = :id')
            ->setParameter('id', $transactionId)
            ->getSingleScalarResult();

        if (0 === $count) {
            $this->em->createQuery('DELETE FROM App\Entity\Transaction t WHERE t.id = :id')
                ->setParameter('id', $transactionId)
                ->execute();
        }
    }

    /** @param array<string, mixed> $data */
    private function hydrateAccount(Account $account, array $data): Account
    {
        $account->setName((string) $data['name']);
        $account->setType((string) $data['type']);
        $account->setCurrency($data['currency'] ?? null);
        $account->setOpeningBalance(isset($data['openingBalance']) ? (float) $data['openingBalance'] : null);
        $account->setSymbol($data['symbol'] ?? null);
        $account->setInstitution($data['institution'] ?? null);
        $account->setIsaKind($data['isaKind'] ?? null);
        $account->setIsaParentId($data['isaParentId'] ?? null);
        $account->setFlexible(isset($data['flexible']) ? (bool) $data['flexible'] : null);

        return $account;
    }

    /** @param array<string, mixed> $data */
    private function hydrateLine(Line $line, array $data, Transaction $transaction, Account $account): Line
    {
        $line->setTransaction($transaction);
        $line->setAccount($account);
        $line->setAmount((float) $data['amount']);
        $line->setDate((string) $data['date']);
        $line->setDescription((string) ($data['description'] ?? ''));
        $line->setLineOrder(isset($data['order']) ? (int) $data['order'] : null);
        $line->setCashValue(isset($data['cashValue']) ? (float) $data['cashValue'] : null);
        $line->setCashCurrency($data['cashCurrency'] ?? null);
        $line->setExchangeAmount(isset($data['exchangeAmount']) ? (float) $data['exchangeAmount'] : null);
        $line->setExchangeCurrency($data['exchangeCurrency'] ?? null);

        return $line;
    }

    /** @param array<string, mixed> $data */
    private function hydrateSettings(Settings $settings, array $data): Settings
    {
        $settings->setOver65((bool) ($data['over65'] ?? false));
        $settings->setGroupLevels($data['groupLevels'] ?? ['type']);
        $settings->setSavedGroupings($data['savedGroupings'] ?? []);

        return $settings;
    }

    /** @return array<int, array<string, mixed>> */
    private function accountsArray(): array
    {
        return array_map($this->accountToArray(...), $this->em->getRepository(Account::class)->findAll());
    }

    /** @return array<int, array<string, mixed>> */
    private function transactionsArray(): array
    {
        return array_map($this->transactionToArray(...), $this->em->getRepository(Transaction::class)->findAll());
    }

    /** @return array<string, mixed> */
    private function accountToArray(Account $a): array
    {
        return array_filter([
            'id' => $a->getId(),
            'name' => $a->getName(),
            'type' => $a->getType(),
            'currency' => $a->getCurrency(),
            'openingBalance' => $a->getOpeningBalance(),
            'symbol' => $a->getSymbol(),
            'institution' => $a->getInstitution(),
            'isaKind' => $a->getIsaKind(),
            'isaParentId' => $a->getIsaParentId(),
            'flexible' => $a->isFlexible(),
        ], static fn ($v) => null !== $v);
    }

    /** @return array<string, mixed> */
    private function transactionToArray(Transaction $t): array
    {
        return [
            'id' => $t->getId(),
            'lines' => array_map($this->lineToArray(...), $t->getLines()->toArray()),
        ];
    }

    /** @return array<string, mixed> */
    private function lineToArray(Line $l): array
    {
        return array_filter([
            'accountId' => $l->getAccount()->getId(),
            'amount' => $l->getAmount(),
            'date' => $l->getDate(),
            'description' => $l->getDescription(),
            'order' => $l->getLineOrder(),
            'cashValue' => $l->getCashValue(),
            'cashCurrency' => $l->getCashCurrency(),
            'exchangeAmount' => $l->getExchangeAmount(),
            'exchangeCurrency' => $l->getExchangeCurrency(),
        ], static fn ($v) => null !== $v);
    }

    /** @return array<string, mixed> */
    private function settingsToArray(Settings $s): array
    {
        return [
            'over65' => $s->isOver65(),
            'groupLevels' => $s->getGroupLevels(),
            'savedGroupings' => $s->getSavedGroupings(),
        ];
    }
}
