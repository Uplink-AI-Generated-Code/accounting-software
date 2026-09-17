<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Renames `account.institution` to `account.counterparty` — same FK to
 * `institution.name`, just a field name that fits both uses: "where this
 * account is held" for real accounts, "who was paid/who paid" for
 * income/expense accounts. A plain `RENAME COLUMN`, not a
 * drop-and-recreate, so existing account data survives untouched.
 *
 * Also rewrites the one settings row's `group_levels`/`saved_groupings`
 * JSON (Doctrine's snake_case columns for `Settings::$groupLevels`/
 * `$savedGroupings`), which stores grouping-dimension keys as plain
 * strings and may already contain "institution" from before this rename —
 * a straight string REPLACE across the whole JSON blob, safe here because
 * "institution" cannot appear as a dimension key substring of any other
 * key.
 */
final class Version20260917010000 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Rename account.institution to account.counterparty; fix up stored grouping-dimension keys.';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('ALTER TABLE account RENAME COLUMN institution TO counterparty');
        $this->addSql("UPDATE settings SET group_levels = REPLACE(group_levels, '\"institution\"', '\"counterparty\"')");
        $this->addSql("UPDATE settings SET saved_groupings = REPLACE(saved_groupings, '\"institution\"', '\"counterparty\"')");
    }

    public function down(Schema $schema): void
    {
        $this->addSql('ALTER TABLE account RENAME COLUMN counterparty TO institution');
        $this->addSql("UPDATE settings SET group_levels = REPLACE(group_levels, '\"counterparty\"', '\"institution\"')");
        $this->addSql("UPDATE settings SET saved_groupings = REPLACE(saved_groupings, '\"counterparty\"', '\"institution\"')");
    }
}
