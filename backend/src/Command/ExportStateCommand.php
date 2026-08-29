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
 * Writes the whole ledger out as one JSON file — { accounts, records,
 * settings }, the same shape LedgerStateService::writeState() (and so
 * app:import-local-storage) expects back in — so this file is both a
 * plain backup and something you can hand straight to that command to
 * restore it (into this database or another one). Uses
 * LedgerStateService::readState(), the same read path the live app uses,
 * so the export can never drift from what the app itself sees.
 */
#[AsCommand(
    name: 'app:export-state',
    description: 'Export the whole ledger as one state JSON file',
)]
class ExportStateCommand extends Command
{
    public function __construct(private readonly LedgerStateService $state)
    {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addArgument('file', InputArgument::OPTIONAL, 'Path to write the JSON file to', 'state.export.json')
            ->setHelp(<<<'HELP'
                Writes the current database out as one JSON file:

                    php bin/console app:export-state backup.json

                The output is in the shape app:import-local-storage expects, so it
                doubles as a backup you can restore with that command later.
                HELP);
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $path = $input->getArgument('file');

        $state = $this->state->readState();

        $json = json_encode($state, \JSON_PRETTY_PRINT | \JSON_UNESCAPED_SLASHES);
        if (false === $json) {
            $io->error('Failed to encode the ledger state as JSON.');

            return Command::FAILURE;
        }

        if (false === file_put_contents($path, $json.\PHP_EOL)) {
            $io->error(\sprintf('Could not write to %s', $path));

            return Command::FAILURE;
        }

        $linkedCount = \count(array_filter($state['records'], static fn ($r) => null !== ($r['transactionId'] ?? null)));
        $standaloneCount = \count($state['records']) - $linkedCount;

        $io->success(\sprintf(
            'Exported %d account(s), %d linked transaction(s), and %d standalone line(s) to %s',
            \count($state['accounts']),
            $linkedCount,
            $standaloneCount,
            $path,
        ));

        return Command::SUCCESS;
    }
}
