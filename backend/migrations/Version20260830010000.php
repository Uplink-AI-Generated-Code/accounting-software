<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * N1 of the scaled-integer-amounts redesign (see CLAUDE.md): creates the
 * three new natural-key reference tables (currency/symbol/institution —
 * PK is the business key itself, e.g. "GBP", not a surrogate id) and
 * seeds them from the app's previously-hardcoded currency list plus
 * whatever currency/symbol/institution values already exist in this
 * database's data. Existing `account`/`line` columns aren't touched yet —
 * see N2 (value conversion) and N3 (FK-ification) for the rest.
 */
final class Version20260830010000 extends AbstractMigration
{
    /** Real-world decimal places — JPY has none, everything else here has 2. */
    private const KNOWN_CURRENCY_SCALES = [
        'GBP' => 2,
        'USD' => 2,
        'EUR' => 2,
        'JPY' => 0,
        'CHF' => 2,
        'CAD' => 2,
        'AUD' => 2,
    ];

    public function getDescription(): string
    {
        return 'Create and seed the currency/symbol/institution reference tables.';
    }

    public function up(Schema $schema): void
    {
        $connection = $this->connection;

        // Executed directly (not via addSql(), which queues SQL to run
        // only after this whole method returns) since the seeding below
        // needs these tables to actually exist immediately.
        $connection->executeStatement('CREATE TABLE currency (code VARCHAR(8) NOT NULL, scale INTEGER NOT NULL, PRIMARY KEY(code))');
        $connection->executeStatement('CREATE TABLE symbol (ticker VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, scale INTEGER NOT NULL, trading_currency VARCHAR(8) NOT NULL, PRIMARY KEY(ticker), CONSTRAINT FK_SYMBOL_TRADING_CURRENCY FOREIGN KEY (trading_currency) REFERENCES currency (code) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $connection->executeStatement('CREATE INDEX IDX_SYMBOL_TRADING_CURRENCY ON symbol (trading_currency)');
        $connection->executeStatement('CREATE TABLE institution (name VARCHAR(255) NOT NULL, PRIMARY KEY(name))');

        // Seed currencies: the app's known real-world scales, plus any
        // code already present in this DB's data that isn't in that list
        // (defaulted to scale 2 — flagged here for manual review, since
        // there's no way to infer a true scale from float data alone).
        $existingCodes = array_unique(array_merge(
            $connection->fetchFirstColumn('SELECT DISTINCT currency FROM account WHERE currency IS NOT NULL'),
            $connection->fetchFirstColumn('SELECT DISTINCT cash_currency FROM line WHERE cash_currency IS NOT NULL'),
            $connection->fetchFirstColumn('SELECT DISTINCT exchange_currency FROM line WHERE exchange_currency IS NOT NULL'),
        ));
        $codes = array_unique(array_merge(array_keys(self::KNOWN_CURRENCY_SCALES), $existingCodes));
        foreach ($codes as $code) {
            $scale = self::KNOWN_CURRENCY_SCALES[$code] ?? 2;
            $connection->executeStatement('INSERT INTO currency (code, scale) VALUES (?, ?)', [$code, $scale]);
        }

        // Seed symbols from existing account.symbol values. There's no
        // real name/scale recorded anywhere today — name defaults to the
        // ticker itself, scale defaults to 6 (matching the frontend's
        // existing fmtUnits() display convention; over-provisioning
        // precision here is safer than truncating real fractional-share
        // data — correct both by hand later). Trading currency is
        // whichever currency that symbol's account(s) currently use.
        $existingSymbols = $connection->fetchFirstColumn('SELECT DISTINCT symbol FROM account WHERE symbol IS NOT NULL');
        foreach ($existingSymbols as $ticker) {
            $tradingCurrency = $connection->fetchOne(
                'SELECT currency FROM account WHERE symbol = ? AND currency IS NOT NULL LIMIT 1',
                [$ticker]
            );
            $connection->executeStatement(
                'INSERT INTO symbol (ticker, name, scale, trading_currency) VALUES (?, ?, ?, ?)',
                [$ticker, $ticker, 6, $tradingCurrency ?: 'GBP']
            );
        }

        // Seed institutions from existing account.institution values.
        $existingInstitutions = $connection->fetchFirstColumn('SELECT DISTINCT institution FROM account WHERE institution IS NOT NULL');
        foreach ($existingInstitutions as $name) {
            $connection->executeStatement('INSERT INTO institution (name) VALUES (?)', [$name]);
        }
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE institution');
        $this->addSql('DROP TABLE symbol');
        $this->addSql('DROP TABLE currency');
    }
}
