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
     * The lightweight, always-loaded account list — GET /api/accounts.
     * No line-level data; each account carries its own computed balance
     * (and, for investment accounts, cost basis / portfolio value) so the
     * frontend never has to load every account's full transaction history
     * just to render the sidebar or Overview.
     *
     * @return array<int, array<string, mixed>>
     */
    public function accountsWithStats(): array
    {
        $accounts = $this->em->getRepository(Account::class)->findAll();

        return array_map(function (Account $a) {
            $arr = $this->accountToArray($a);
            $arr['balance'] = $this->balanceFor($a);
            $arr['entryCount'] = $this->entryCountFor($a);
            if ('investment' === $a->getType()) {
                ['cost' => $cost, 'value' => $value] = $this->stockStatsFor($a);
                $arr['costBasis'] = $cost;
                $arr['portfolioValue'] = $value;
            }

            return $arr;
        }, $accounts);
    }

    /**
     * Every transaction touching one account, complete with all of its
     * lines (not just this account's own) — the same shape as an entry in
     * readState()'s transactions array, just scoped to this account. This
     * is what a ledger screen loads on open and discards on navigating
     * away, instead of the whole ledger ever living in the frontend.
     *
     * @return array<int, array<string, mixed>>
     */
    public function accountLedger(string $id): array
    {
        $account = $this->em->getRepository(Account::class)->find($id);
        if (!$account) {
            return [];
        }

        $lines = $this->em->getRepository(Line::class)->findBy(['account' => $account]);
        $transactionIds = array_values(array_unique(array_map(static fn (Line $l) => $l->getTransaction()->getId(), $lines)));
        if (!$transactionIds) {
            return [];
        }

        $transactions = $this->em->getRepository(Transaction::class)->findBy(['id' => $transactionIds]);

        return array_map($this->transactionToArray(...), $transactions);
    }

    private function balanceFor(Account $a): float
    {
        $sum = (float) $this->em->getConnection()->fetchOne(
            'SELECT COALESCE(SUM(amount), 0) FROM line WHERE account_id = ?',
            [$a->getId()]
        );

        return ($a->getOpeningBalance() ?? 0.0) + $sum;
    }

    private function entryCountFor(Account $a): int
    {
        return (int) $this->em->getConnection()->fetchOne(
            'SELECT COUNT(*) FROM line WHERE account_id = ?',
            [$a->getId()]
        );
    }

    /**
     * Every line for one investment account, in the exact order the
     * frontend's own ledger rows use — date, then order (ties default to
     * 0), then transaction id as a final tiebreak — since cost basis and
     * portfolio value are both running computations where same-day
     * ordering can change the result (see lib/stockMath.js).
     *
     * @return Line[]
     */
    private function orderedLinesFor(Account $a): array
    {
        $lines = $this->em->getRepository(Line::class)->findBy(['account' => $a]);
        usort($lines, static function (Line $x, Line $y) {
            if ($x->getDate() !== $y->getDate()) {
                return $x->getDate() <=> $y->getDate();
            }
            $ox = $x->getLineOrder() ?? 0;
            $oy = $y->getLineOrder() ?? 0;
            if ($ox !== $oy) {
                return $ox <=> $oy;
            }

            return $x->getTransaction()->getId() <=> $y->getTransaction()->getId();
        });

        return $lines;
    }

    /**
     * Cost basis (average-cost method) and "mark to last trade" portfolio
     * value — ported from lib/stockMath.js's applyCostBasisLine /
     * applyPortfolioValueLine. Kept as a single walk over the account's
     * own ordered lines so the two numbers can never drift from what the
     * frontend would compute given the same data.
     *
     * @return array{cost: float, value: float}
     */
    private function stockStatsFor(Account $a): array
    {
        $costState = ['units' => 0.0, 'cost' => 0.0];
        $valueState = ['units' => 0.0, 'lastPrice' => 0.0, 'value' => 0.0];

        foreach ($this->orderedLinesFor($a) as $line) {
            $this->applyCostBasisLine($costState, $line);
            $this->applyPortfolioValueLine($valueState, $line);
        }

        return ['cost' => $costState['cost'], 'value' => $valueState['value']];
    }

    /** @param array{units: float, cost: float} $state */
    private function applyCostBasisLine(array &$state, Line $l): void
    {
        $amount = $l->getAmount();
        if ($amount > 0) {
            $state['units'] += $amount;
            $state['cost'] += $l->getCashValue() ?? 0.0;
        } elseif ($amount < 0) {
            $sold = min(-$amount, $state['units']);
            $avgCost = $state['units'] > 0 ? $state['cost'] / $state['units'] : 0.0;
            $state['cost'] -= $avgCost * $sold;
            $state['units'] -= $sold;
            if ($state['units'] < 1e-9) {
                $state['units'] = 0.0;
                $state['cost'] = 0.0;
            }
        }
    }

    /** @param array{units: float, lastPrice: float, value: float} $state */
    private function applyPortfolioValueLine(array &$state, Line $l): void
    {
        $state['units'] += $l->getAmount() ?? 0.0;
        if ($state['units'] < 1e-9) {
            $state['units'] = 0.0;
        }
        if ($l->getAmount() && null !== $l->getCashValue()) {
            $price = abs($l->getCashValue()) / abs($l->getAmount());
            if (is_finite($price)) {
                $state['lastPrice'] = $price;
            }
        }
        $state['value'] = $state['units'] * $state['lastPrice'];
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
     * Deleting an account always navigates the frontend away from it, so
     * there's no ledger view left on screen that needs the result —
     * callers just re-fetch the lightweight account list afterward. This
     * doesn't return the affected transactions the way it used to when
     * the frontend kept the whole ledger in memory.
     */
    public function deleteAccount(string $id): void
    {
        $this->em->wrapInTransaction(function () use ($id) {
            $account = $this->em->getRepository(Account::class)->find($id);
            if (!$account) {
                return;
            }
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
        });
    }

    /** @return array<string, mixed> */
    public function getSettings(): array
    {
        return $this->settingsToArray($this->settingsRepository->getOrCreate());
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
     * Doesn't return the fresh transactions list — nothing keeps a
     * ledger-wide array to patch anymore. The caller (whichever ledger
     * screen triggered this) re-fetches its own scoped
     * GET /api/accounts/{id}/ledger afterward, and the app separately
     * re-fetches the lightweight account list for updated balances.
     *
     * @param array<int, array{op: string, id?: string, transaction?: array<string, mixed>}> $operations
     */
    public function applyTransactionOperations(array $operations): void
    {
        $this->em->wrapInTransaction(function () use ($operations) {
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
        // addLine(), not setTransaction() directly — it also keeps the
        // Transaction's own in-memory $lines collection in sync. Without
        // that, a later read of this same Transaction's lines *within the
        // same request* (e.g. IsaAllowanceService reading a just-written
        // transaction back) sees Doctrine's stale, still-empty collection
        // from when the entity was constructed, even though the DB row
        // is correct — the identity map serves back the same PHP object
        // rather than re-querying.
        $transaction->addLine($line);
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
    public function accountToArray(Account $a): array
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
    public function transactionToArray(Transaction $t): array
    {
        return [
            'id' => $t->getId(),
            'lines' => array_map($this->lineToArray(...), $t->getLines()->toArray()),
        ];
    }

    /** @return array<string, mixed> */
    public function lineToArray(Line $l): array
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
