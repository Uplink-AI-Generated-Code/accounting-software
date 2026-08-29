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
 * LedgerStateService::writeState() the live PUT /api/state endpoint uses
 * — so importing behaves exactly like the frontend saving that data for
 * the first time, wipe-and-rebuild included.
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
        $transactions = $data['transactions'] ?? null;
        if (!\is_array($accounts) || !\is_array($transactions)) {
            $io->error('Expected an object with "accounts" and "transactions" arrays — is this the right export?');

            return Command::FAILURE;
        }
        $settings = $data['settings'] ?? [];

        $io->note(\sprintf(
            'Importing %d account(s) and %d transaction(s) from %s. This replaces the current database contents.',
            \count($accounts),
            \count($transactions),
            $path,
        ));

        if ($input->isInteractive() && !$io->confirm('Continue?', false)) {
            $io->comment('Aborted.');

            return Command::SUCCESS;
        }

        $this->state->writeState($accounts, $transactions, $settings);

        $io->success('Import complete.');

        return Command::SUCCESS;
    }
}
