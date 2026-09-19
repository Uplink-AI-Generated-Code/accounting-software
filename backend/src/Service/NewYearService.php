<?php

namespace App\Service;

use App\Doctrine\ActiveDatabasePathResolver;
use App\Entity\Currency;
use App\Entity\Symbol;
use Doctrine\DBAL\DriverManager;
use Doctrine\ORM\EntityManagerInterface;

/**
 * The copy/wipe/carry-forward logic behind `app:new-year`: copies the
 * live database wholesale, then in the copy only wipes lines/transactions
 * and carries each real account's closing balance/cost basis forward as
 * its opening balance. Pulled out of NewYearCommand into its own service,
 * following this app's existing convention of business logic living in
 * services (see LedgerStateService), so DatabaseController's in-app
 * "start a new tax year" action (POST /api/databases/new-year) can call
 * the exact same code the terminal command does — see CLAUDE.md's
 * "Backend" section.
 */
class NewYearService
{
    private const CARRY_FORWARD_TYPES = ['asset', 'liability', 'equity', 'investment'];

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly LedgerStateService $state,
        private readonly ActiveDatabasePathResolver $pathResolver,
    ) {
    }

    /**
     * Copies the current live database to $newDbPath and carries balances
     * forward in the copy — see class docblock. Throws
     * \InvalidArgumentException if $newDbPath already exists (an expected,
     * caller-fixable rejection), \RuntimeException for anything else that
     * stops this from completing (can't determine the source path, the
     * file copy itself failed, or the carry-forward write failed).
     *
     * @return array{sourcePath: string, rows: array<int, array{0: array<string, mixed>, 1: int, 2: ?int}>, currencyScales: array<string, int>, symbolScales: array<string, int>, symbolTradingCurrency: array<string, string>}
     */
    public function createNextYear(string $newDbPath): array
    {
        $sourcePath = $this->pathResolver->resolve();

        if (file_exists($newDbPath)) {
            throw new \InvalidArgumentException(\sprintf('%s already exists — remove or rename it first.', $newDbPath));
        }

        // Read every account's current closing balance/cost basis before
        // touching anything — accountsWithStats() is the same computation
        // GET /api/accounts uses, so this can never drift from what the
        // live app itself shows.
        $stats = $this->state->accountsWithStats();

        $currencyScales = [];
        foreach ($this->em->getRepository(Currency::class)->findAll() as $c) {
            $currencyScales[$c->getCode()] = $c->getScale();
        }
        $symbolScales = [];
        $symbolTradingCurrency = [];
        foreach ($this->em->getRepository(Symbol::class)->findAll() as $s) {
            $symbolScales[$s->getTicker()] = $s->getScale();
            $symbolTradingCurrency[$s->getTicker()] = $s->getTradingCurrency()->getCode();
            $currencyScales[$s->getTradingCurrency()->getCode()] ??= $s->getTradingCurrency()->getScale();
        }

        if (!copy($sourcePath, $newDbPath)) {
            throw new \RuntimeException(\sprintf('Could not copy %s to %s.', $sourcePath, $newDbPath));
        }

        $target = DriverManager::getConnection(['driver' => 'pdo_sqlite', 'path' => $newDbPath]);

        $target->beginTransaction();
        try {
            $target->executeStatement('DELETE FROM line_tag');
            $target->executeStatement('DELETE FROM line');
            $target->executeStatement('DELETE FROM transactions');

            $rows = [];
            foreach ($stats as $a) {
                $carry = \in_array($a['type'], self::CARRY_FORWARD_TYPES, true);
                $openingBalance = $carry ? $a['balance'] : null;
                $openingBalanceCashValue = $carry && 'investment' === $a['type'] ? ($a['costBasis'] ?? 0) : null;

                $target->executeStatement(
                    'UPDATE account SET opening_balance = ?, opening_balance_cash_value = ? WHERE id = ?',
                    [$openingBalance, $openingBalanceCashValue, $a['id']]
                );

                if ($carry && 0 !== $openingBalance) {
                    $rows[] = [$a, $openingBalance, $openingBalanceCashValue];
                }
            }

            $target->commit();
        } catch (\Throwable $e) {
            $target->rollBack();
            $target->close();

            throw new \RuntimeException(\sprintf('Failed to write %s: %s', $newDbPath, $e->getMessage()), 0, $e);
        }
        $target->close();

        return [
            'sourcePath' => $sourcePath,
            'rows' => $rows,
            'currencyScales' => $currencyScales,
            'symbolScales' => $symbolScales,
            'symbolTradingCurrency' => $symbolTradingCurrency,
        ];
    }
}
