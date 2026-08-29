<?php

namespace App\Command;

use App\Service\LedgerStateService;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * One-time migration path for existing users: the browser app's whole
 * localStorage state (under the "ledger-data" key — see storageShim.js
 * and App.jsx's persist()) is copied out via devtools into a JSON file,
 * and this command loads it straight into the database using the same
 * LedgerStateService::writeState() the export command's counterpart
 * reads with — so importing behaves exactly like a fresh install seeded
 * with that data, wipe-and-rebuild included.
 *
 * Accepts either shape: the current one (`records: [{transactionId,
 * lines}]`, `transactionId: null` for a standalone line — see
 * LedgerStateService's class docblock) or an older export's
 * `transactions: [{id, lines}]`, where every entry — including a lone,
 * unmatched one — was a "transaction". upgradeLegacyShape() converts the
 * latter: a `lines` array with 2+ entries keeps its `id` as
 * `transactionId`; a single-entry one becomes a standalone line
 * (`transactionId: null`), the old id discarded since a fresh row gets
 * its own backend-assigned id anyway. This is what lets an export from
 * before this app supported standalone lines — or a similarly-shaped
 * database from an entirely different project — import cleanly.
 */
#[AsCommand(
    name: 'app:import-local-storage',
    description: 'Import a ledger state previously exported from the browser\'s localStorage',
)]
class ImportLocalStorageCommand extends Command
{
    public function __construct(private readonly LedgerStateService $state)
    {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addArgument('file', InputArgument::OPTIONAL, 'Path to the exported JSON file', 'localStorage.export.json')
            ->setHelp(<<<'HELP'
                In the browser, with the app open, run this in the devtools console
                to copy the ledger's data out of localStorage:

                    copy(localStorage.getItem('ledger-storage:personal:ledger-data'))

                Paste the result into a JSON file and pass its path to this command
                (defaults to "localStorage.export.json" in the current directory).

                Also accepts an older export's "transactions" shape (every entry,
                including unmatched ones, wrapped as a one-line transaction) — it's
                upgraded automatically to a standalone line on import.

                This REPLACES whatever is currently in the database — it's meant for
                a one-time initial import, not a merge.
                HELP);
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $path = $input->getArgument('file');

        if (!is_file($path)) {
            $io->error(\sprintf('File not found: %s', $path));

            return Command::FAILURE;
        }

        $raw = file_get_contents($path);
        $data = json_decode($raw, true);
        if (!\is_array($data)) {
            $io->error(\sprintf('%s does not contain valid JSON.', $path));

            return Command::FAILURE;
        }

        $accounts = $data['accounts'] ?? null;
        if (!\is_array($accounts)) {
            $io->error('Expected an object with an "accounts" array — is this the right export?');

            return Command::FAILURE;
        }

        if (isset($data['records']) && \is_array($data['records'])) {
            $records = $data['records'];
        } elseif (isset($data['transactions']) && \is_array($data['transactions'])) {
            $records = $this->upgradeLegacyShape($data['transactions']);
        } else {
            $io->error('Expected a "records" array (or an older export\'s "transactions" array) — is this the right export?');

            return Command::FAILURE;
        }

        $settings = $data['settings'] ?? [];

        $linkedCount = \count(array_filter($records, static fn ($r) => null !== ($r['transactionId'] ?? null)));
        $standaloneCount = \count($records) - $linkedCount;

        $io->note(\sprintf(
            'Importing %d account(s), %d linked transaction(s), and %d standalone line(s) from %s. This replaces the current database contents.',
            \count($accounts),
            $linkedCount,
            $standaloneCount,
            $path,
        ));

        if ($input->isInteractive() && !$io->confirm('Continue?', false)) {
            $io->comment('Aborted.');

            return Command::SUCCESS;
        }

        $this->state->writeState($accounts, $records, $settings);

        $io->success('Import complete.');

        return Command::SUCCESS;
    }

    /**
     * @param array<int, array{id: string, lines: array<int, array<string, mixed>>}> $transactions
     *
     * @return array<int, array{transactionId: ?string, lines: array<int, array<string, mixed>>}>
     */
    private function upgradeLegacyShape(array $transactions): array
    {
        return array_map(static function (array $t) {
            $lines = $t['lines'] ?? [];

            return [
                'transactionId' => \count($lines) >= 2 ? ($t['id'] ?? null) : null,
                'lines' => $lines,
            ];
        }, $transactions);
    }
}
