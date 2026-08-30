<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Adds an optional human-readable `name` to `currency` (e.g. "British
 * Pound Sterling" for "GBP") — a plain nullable `ADD COLUMN`/`DROP
 * COLUMN` pair, no temp-table rebuild needed: SQLite has supported both
 * directly since 3.35.0 (2021), unlike the type/FK changes elsewhere in
 * this project's migrations, which still need the rebuild dance. See
 * CLAUDE.md's "Amounts, currencies, and reference data".
 */
final class Version20260830020000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Add nullable name column to currency.';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE currency ADD COLUMN name VARCHAR(255) DEFAULT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE currency DROP COLUMN name');
    }
}
