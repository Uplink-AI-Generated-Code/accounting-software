<?php

namespace App\Command;

use App\Entity\Currency;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Populates a baseline set of currencies — useful when standing up a
 * fresh database, so there's something for an account's currency picker
 * to offer before any real data has been imported. Idempotent
 * (find-or-create, matching the sibling project's `app:data:currencies`
 * this was ported from): safe to re-run, e.g. after adding a new
 * currency to the list below.
 *
 * This is a convenience, not the only way a currency gets into the
 * table — `app:import-local-storage` also upserts whatever currencies
 * the state JSON itself declares (see LedgerStateService::writeState()
 * and CLAUDE.md's "Amounts, currencies, and reference data"), since a
 * currency used by imported data is part of that data, not something
 * this fixed list can be expected to anticipate.
 */
#[AsCommand(
    name: 'app:currencies:seed',
    description: 'Populate a baseline set of currencies',
)]
class SeedCurrenciesCommand extends Command
{
    private const CURRENCIES = [
        'GBP' => ['British Pound Sterling', 2],
        'USD' => ['United States Dollar', 2],
        'EUR' => ['Euro', 2],
        'JPY' => ['Japanese Yen', 0],
        'CHF' => ['Swiss Franc', 2],
        'CAD' => ['Canadian Dollar', 2],
        'AUD' => ['Australian Dollar', 2],
        'RON' => ['Romanian New Leu', 2],
        'INR' => ['Indian Rupee', 2],
    ];

    public function __construct(private readonly EntityManagerInterface $em)
    {
        parent::__construct();
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);

        foreach (self::CURRENCIES as $code => [$name, $scale]) {
            $io->text("Code: {$code}; Name: {$name}; Scale: {$scale}");

            $currency = $this->em->getRepository(Currency::class)->find($code) ?? (new Currency())->setCode($code);
            $currency->setName($name)->setScale($scale);
            $this->em->persist($currency);
        }

        $this->em->flush();

        $io->success(sprintf('Seeded %d currencies.', \count(self::CURRENCIES)));

        return Command::SUCCESS;
    }
}
