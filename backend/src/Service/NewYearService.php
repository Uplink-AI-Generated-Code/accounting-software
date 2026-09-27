<?php

namespace App\Service;

use App\Doctrine\ActiveDatabasePathResolver;
use App\Money\Decimal;
use Doctrine\DBAL\DriverManager;

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
     * Each row is `[account, openingBalance, openingBalanceCashValue]`,
     * both amounts canonical decimal strings (see App\Money\Decimal).
     *
     * @return array{sourcePath: string, rows: array<int, array{0: array<string, mixed>, 1: string, 2: ?string}>}
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
                $openingBalanceCashValue = $carry && 'investment' === $a['type'] ? ($a['costBasis'] ?? '0') : null;

                $target->executeStatement(
                    'UPDATE account SET opening_balance = ?, opening_balance_cash_value = ? WHERE id = ?',
                    [$openingBalance, $openingBalanceCashValue, $a['id']]
                );

                if ($carry && !Decimal::isZero($openingBalance)) {
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
        ];
    }
}
