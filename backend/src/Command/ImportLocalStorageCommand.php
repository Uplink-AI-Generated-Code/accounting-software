<?php

namespace App\Command;

use App\Entity\Symbol;
use App\Service\LedgerStateService;
use Doctrine\ORM\EntityManagerInterface;
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
 *
 * An optional `currencies` array (`[{code, scale, name?}, ...]`) is
 * upserted into the Currency table — see
 * LedgerStateService::writeState()'s docblock for why this is an upsert,
 * not a wipe-and-rebuild like everything else here. A currency used by
 * imported data (e.g. a foreign-currency account from another project's
 * database) is part of that data, not something this app's own baseline
 * list can be expected to anticipate — omit it and any account/line
 * referencing an unrecognized currency code fails the whole import.
 */
#[AsCommand(
    name: 'app:import-local-storage',
    description: 'Import a ledger state previously exported from the browser\'s localStorage',
)]
class ImportLocalStorageCommand extends Command
{
    public function __construct(
        private readonly LedgerStateService $state,
        private readonly EntityManagerInterface $em,
    ) {
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
        try {
            $accounts = $this->upgradeLegacyAccountShape($accounts);
        } catch (\InvalidArgumentException $e) {
            $io->error($e->getMessage());

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
        $currencies = isset($data['currencies']) && \is_array($data['currencies']) ? $data['currencies'] : [];

        $linkedCount = \count(array_filter($records, static fn ($r) => null !== ($r['transactionId'] ?? null)));
        $standaloneCount = \count($records) - $linkedCount;

        $io->note(\sprintf(
            'Importing %d account(s), %d linked transaction(s), %d standalone line(s), and %d currenc(y/ies) from %s. This replaces the current database\'s accounts/lines/transactions and upserts the given currencies (existing ones not mentioned are left alone — see LedgerStateService::writeState()).',
            \count($accounts),
            $linkedCount,
            $standaloneCount,
            \count($currencies),
            $path,
        ));

        if ($input->isInteractive() && !$io->confirm('Continue?', false)) {
            $io->comment('Aborted.');

            return Command::SUCCESS;
        }

        try {
            $this->state->writeState($accounts, $records, $settings, $currencies);
        } catch (\InvalidArgumentException $e) {
            // e.g. an account/line referencing a currency or symbol code
            // that isn't in this database's Currency/Symbol tables — see
            // resolveCurrency()/resolveSymbol(). writeState() already
            // rolled back before returning, so nothing was written.
            $io->error($e->getMessage());

            return Command::FAILURE;
        }

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

    /**
     * Upgrades every account's shape from before the isa-parent →
     * investment-parent generalization (see CLAUDE.md): a wrapper account
     * used to be `type: "isa-parent"` with subaccounts pointing at it via
     * `isaParentId`; it's now `type: "investment-parent"` (with an
     * `isaKind` of "stocks-shares-isa", since every pre-existing wrapper
     * was implicitly a Stocks & Shares ISA — there was no other kind yet)
     * and subaccounts point at it via `parentId`. Without this,
     * LedgerStateService::hydrateAccount() either hard-throws on an
     * investment subaccount (it only reads `parentId`, which a legacy
     * export never has) or silently drops an asset subaccount's wrapper
     * link, and the wrapper itself would import as an orphaned,
     * unrecognized `type: "isa-parent"` row. A no-op on any export already
     * in the current shape (no `isa-parent` type, no `isaParentId` key).
     *
     * Also upgrades the pre-composite-key Symbol shape: every export made
     * before Symbol's identity became (ticker, tradingCurrency) carries a
     * plain `"symbol": "AAPL"` on an investment account, with no
     * `symbolCurrency` — the ticker alone was unambiguous back then. This
     * maps it to `symbolTicker`/`symbolCurrency` by looking up which
     * `Symbol` row(s) currently exist for that ticker: exactly one match
     * resolves unambiguously to that Symbol's own `tradingCurrency`; zero
     * or more than one match means the reference can no longer be resolved
     * automatically (the ticker either doesn't exist yet, or has since
     * become ambiguous across more than one trading currency) and is a
     * hard error rather than a silent guess — see CLAUDE.md's
     * resolveCurrency()/resolveSymbol() "hard-error on unknown reference"
     * convention, which this mirrors.
     *
     * @param array<int, array<string, mixed>> $accounts
     *
     * @return array<int, array<string, mixed>>
     *
     * @throws \InvalidArgumentException when a legacy `symbol` ticker
     *                                    can't be resolved unambiguously
     */
    private function upgradeLegacyAccountShape(array $accounts): array
    {
        return array_map(function ($a) {
            if (!\is_array($a)) {
                return $a;
            }

            if ('isa-parent' === ($a['type'] ?? null)) {
                $a['type'] = 'investment-parent';
                $a['isaKind'] = $a['isaKind'] ?? 'stocks-shares-isa';
            }

            if (\array_key_exists('isaParentId', $a)) {
                if (!\array_key_exists('parentId', $a)) {
                    $a['parentId'] = $a['isaParentId'];
                }
                unset($a['isaParentId']);
            }

            if (\array_key_exists('symbol', $a) && !\array_key_exists('symbolTicker', $a)) {
                $ticker = $a['symbol'];
                unset($a['symbol']);

                if (null !== $ticker && '' !== $ticker) {
                    $matches = $this->em->getRepository(Symbol::class)->createQueryBuilder('s')
                        ->where('s.ticker = :t')
                        ->setParameter('t', $ticker)
                        ->getQuery()
                        ->getResult();

                    if (1 !== \count($matches)) {
                        throw new \InvalidArgumentException(\sprintf(
                            'Account "%s" references legacy symbol "%s", which %s — can\'t resolve its trading currency automatically. Fix this account\'s data manually (set an explicit "symbolCurrency") before importing.',
                            $a['name'] ?? $a['id'] ?? '?',
                            $ticker,
                            0 === \count($matches) ? 'doesn\'t exist in this database' : \sprintf('is ambiguous (%d symbols share this ticker across different trading currencies)', \count($matches))
                        ));
                    }

                    $a['symbolTicker'] = $ticker;
                    $a['symbolCurrency'] = $matches[0]->getTradingCurrency()->getCode();
                }
            }

            return $a;
        }, $accounts);
    }
}
