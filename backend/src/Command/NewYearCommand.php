<?php

namespace App\Command;

use App\Entity\Currency;
use App\Entity\Symbol;
use App\Service\LedgerStateService;
use Doctrine\DBAL\DriverManager;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Bootstraps a fresh tax year's database from the current, live one — see
 * CLAUDE.md's "The active tax year": a ledger-project database belongs to
 * exactly one UK tax year for its whole lifetime, and switching years
 * means pointing DATABASE_URL at a new file, not something the app does
 * itself. This is the "one file per tax year" convention documented in
 * .env.local, ported from the sibling Nucleware/Accounts project.
 *
 * Copies the live SQLite file wholesale to the given path (so every
 * Currency/Symbol/Counterparty/Tag/Account definition, and the settings
 * row, come along exactly as they are — no re-derivation), then, in the
 * copy only: wipes every line/transaction, and sets each account's
 * `openingBalance`/`openingBalanceCashValue` to its *current* closing
 * balance/cost basis for asset/liability/equity/investment accounts
 * (real, balance-carrying accounts), or resets them to null for
 * income/isa-income/expense/isa-parent accounts (period-specific flows
 * that don't carry a balance across tax years — an isa-parent never held
 * one anyway).
 *
 * Operates on whatever's live in the database right now — there's no
 * "as of" cutoff date; run it once the current year's data entry is
 * done. The new file's own tax year isn't set here either — with zero
 * lines, LedgerStateService::determinedTaxYearStart() naturally computes
 * null until the first real entry is saved into it, same as any other
 * blank database (see CLAUDE.md) — nothing special to do.
 */
#[AsCommand(
    name: 'app:new-year',
    description: "Bootstrap a fresh tax year's database from the current one's closing balances",
)]
class NewYearCommand extends Command
{
    private const CARRY_FORWARD_TYPES = ['asset', 'liability', 'equity', 'investment'];

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly LedgerStateService $state,
    ) {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addArgument('newDbPath', InputArgument::REQUIRED, 'Path to write the new tax year\'s SQLite file to (must not already exist)')
            ->setHelp(<<<'HELP'
                Copies the current database to a new file, wipes every line and
                transaction in the copy, and carries each real account's current
                closing balance forward as its opening balance in the new file:

                    php bin/console app:new-year databases/2025-2026.sqlite3

                Point DATABASE_URL (see .env.local) at the new file once you're
                ready to start using it.
                HELP);
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $newDbPath = (string) $input->getArgument('newDbPath');

        $sourcePath = $this->em->getConnection()->getParams()['path'] ?? null;
        if (!\is_string($sourcePath) || '' === $sourcePath) {
            $io->error('Could not determine the current database\'s file path — app:new-year only supports SQLite.');

            return Command::FAILURE;
        }

        if (file_exists($newDbPath)) {
            $io->error(\sprintf('%s already exists — remove or rename it first.', $newDbPath));

            return Command::FAILURE;
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
            $io->error(\sprintf('Could not copy %s to %s.', $sourcePath, $newDbPath));

            return Command::FAILURE;
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
            $io->error(\sprintf('Failed to write %s: %s', $newDbPath, $e->getMessage()));

            return Command::FAILURE;
        } finally {
            $target->close();
        }

        $io->success(\sprintf('Created %s from %s.', $newDbPath, $sourcePath));

        $table = [];
        foreach ($rows as [$a, $openingBalance, $openingBalanceCashValue]) {
            if ('investment' === $a['type']) {
                $unitsScale = $symbolScales[$a['symbol'] ?? ''] ?? 6;
                $tradingCurrency = $symbolTradingCurrency[$a['symbol'] ?? ''] ?? null;
                $costScale = $currencyScales[$tradingCurrency] ?? 2;
                $table[] = [
                    $a['name'],
                    $a['type'],
                    $this->formatScaled($openingBalance, $unitsScale).' units',
                    $this->formatScaled($openingBalanceCashValue, $costScale).' cost',
                ];
            } else {
                $scale = $currencyScales[$a['currency'] ?? ''] ?? 2;
                $table[] = [$a['name'], $a['type'], $this->formatScaled($openingBalance, $scale), '—'];
            }
        }

        if ($table) {
            $io->table(['Account', 'Type', 'Opening balance', 'Opening cost basis'], $table);
        }

        $investmentCount = \count(array_filter($rows, static fn ($r) => 'investment' === $r[0]['type']));
        if ($investmentCount > 0) {
            $io->note(\sprintf(
                '%d investment account(s) carried forward: portfolio value will read as the carried cost basis until the first new trade re-marks it — there\'s no live price feed (see CLAUDE.md\'s "Stock valuation").',
                $investmentCount
            ));
        }

        $io->text('The new file has no lines yet, so its tax year is undetermined until the first entry is saved — same as any blank database.');

        return Command::SUCCESS;
    }

    private function formatScaled(int $value, int $scale): string
    {
        if (0 === $scale) {
            return (string) $value;
        }
        $divisor = 10 ** $scale;
        $sign = $value < 0 ? '-' : '';
        $abs = abs($value);

        return \sprintf('%s%d.%0'.$scale.'d', $sign, intdiv($abs, $divisor), $abs % $divisor);
    }
}
