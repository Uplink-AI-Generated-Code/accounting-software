<?php

namespace App\Command;

use App\Service\NewYearService;
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
 * A thin wrapper — see NewYearService::createNextYear() for the actual
 * copy/wipe/carry-forward logic, shared with the in-app "start a new tax
 * year" action (DatabaseController::newYear(), POST
 * /api/databases/new-year) so both call exactly the same code.
 */
#[AsCommand(
    name: 'app:new-year',
    description: "Bootstrap a fresh tax year's database from the current one's closing balances",
)]
class NewYearCommand extends Command
{
    public function __construct(private readonly NewYearService $newYearService)
    {
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

        try {
            $result = $this->newYearService->createNextYear($newDbPath);
        } catch (\Throwable $e) {
            $io->error($e->getMessage());

            return Command::FAILURE;
        }

        $io->success(\sprintf('Created %s from %s.', $newDbPath, $result['sourcePath']));

        $table = [];
        foreach ($result['rows'] as [$a, $openingBalance, $openingBalanceCashValue]) {
            if ('investment' === $a['type']) {
                $unitsScale = $result['symbolScales'][$a['symbol'] ?? ''] ?? 6;
                $tradingCurrency = $result['symbolTradingCurrency'][$a['symbol'] ?? ''] ?? null;
                $costScale = $result['currencyScales'][$tradingCurrency] ?? 2;
                $table[] = [
                    $a['name'],
                    $a['type'],
                    $this->formatScaled($openingBalance, $unitsScale).' units',
                    $this->formatScaled($openingBalanceCashValue, $costScale).' cost',
                ];
            } else {
                $scale = $result['currencyScales'][$a['currency'] ?? ''] ?? 2;
                $table[] = [$a['name'], $a['type'], $this->formatScaled($openingBalance, $scale), '—'];
            }
        }

        if ($table) {
            $io->table(['Account', 'Type', 'Opening balance', 'Opening cost basis'], $table);
        }

        $investmentCount = \count(array_filter($result['rows'], static fn ($r) => 'investment' === $r[0]['type']));
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
