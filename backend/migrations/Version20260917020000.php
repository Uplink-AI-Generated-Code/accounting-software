<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Renames the `institution` table (and its `App\Entity\Institution` class)
 * to `counterparty` (`App\Entity\Counterparty`) — completing the rename
 * started in Version20260917010000, which only renamed
 * `account.institution` to `account.counterparty`. Plain `RENAME TABLE`;
 * SQLite updates the `account.counterparty` foreign key's REFERENCES
 * clause to point at the new table name automatically, so no data or
 * constraint needs rebuilding by hand.
 */
final class Version20260917020000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Rename the institution table to counterparty.';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE institution RENAME TO counterparty');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE counterparty RENAME TO institution');
    }
}
