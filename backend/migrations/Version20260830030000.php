<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Adds `account.subtype` — a free-text product-type tag ("Credit Card",
 * "Loan", "Trading", ...), a fourth grouping dimension alongside type/
 * institution/currency. Plain nullable `ADD COLUMN`/`DROP COLUMN`, no
 * temp-table rebuild: SQLite has supported both directly since 3.35.0.
 */
final class Version20260830030000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Add nullable subtype column to account.';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE account ADD COLUMN subtype VARCHAR(255) DEFAULT NULL');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE account DROP COLUMN subtype');
    }
}
