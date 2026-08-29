<?php

namespace App\Service;

use App\Entity\Account;
use App\Entity\Line;
use App\Entity\Settings;
use App\Entity\Transaction;
use App\Repository\SettingsRepository;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Reads and writes the whole ledger state as one plain-array shape —
 * exactly what the frontend's own persist(accounts, transactions,
 * settings) already works with (see App.jsx). Shared by StateController
 * (the live GET/PUT /api/state endpoints) and
 * App\Command\ImportLocalStorageCommand (the one-time import from an
 * exported localStorage JSON blob), so the two never drift apart.
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
        $accounts = $this->em->getRepository(Account::class)->findAll();
        $transactions = $this->em->getRepository(Transaction::class)->findAll();
        $settings = $this->settingsRepository->getOrCreate();

        return [
            'accounts' => array_map($this->accountToArray(...), $accounts),
            'transactions' => array_map($this->transactionToArray(...), $transactions),
            'settings' => $this->settingsToArray($settings),
        ];
    }

    /**
     * Wipes and rebuilds the whole ledger from a plain array in the same
     * shape readState() returns. Simplest correct approach for a bulk
     * "save the whole state" call: a single-user local app with a modest
     * amount of data doesn't need a surgical diff/merge, and a diff/merge
     * would have to handle exactly the same reference-integrity ordering
     * (accounts before lines, transactions before lines) that rebuilding
     * does for free.
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
                $account = $this->arrayToAccount($data);
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
                        // save is malformed input — skip rather than fail
                        // the whole save, since a partial/racing save
                        // shouldn't corrupt the rest of the state.
                        continue;
                    }
                    $line = $this->arrayToLine($lineData, $transaction, $accountsById[$accountId]);
                    $this->em->persist($line);
                }
            }

            $settings = $this->settingsRepository->getOrCreate();
            $settings->setOver65((bool) ($settingsData['over65'] ?? false));
            $settings->setGroupLevels($settingsData['groupLevels'] ?? ['type']);
            $settings->setSavedGroupings($settingsData['savedGroupings'] ?? []);
            $this->em->persist($settings);
        });
    }

    /** @param array<string, mixed> $data */
    private function arrayToAccount(array $data): Account
    {
        $account = new Account();
        $account->setId((string) $data['id']);
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
    private function arrayToLine(array $data, Transaction $transaction, Account $account): Line
    {
        $line = new Line();
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
