<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

final class Version20260919133202 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Replace the single-row settings table with a key-value setting table — over65 is the only key carried over, group_levels/saved_groupings move to the global app-settings.yaml file (see docs/superpowers/specs/2026-09-19-app-settings-and-active-database-design.md)';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE setting ("key" VARCHAR(64) NOT NULL, value CLOB NOT NULL, PRIMARY KEY ("key"))');
        $this->addSql("INSERT INTO setting (key, value) SELECT 'over65', CASE WHEN over65 THEN 'true' ELSE 'false' END FROM settings");
        $this->addSql('DROP TABLE settings');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, over65 BOOLEAN NOT NULL, group_levels CLOB NOT NULL COLLATE "BINARY", saved_groupings CLOB NOT NULL COLLATE "BINARY")');
        $this->addSql("INSERT INTO settings (id, over65, group_levels, saved_groupings) SELECT 1, CASE WHEN (SELECT value FROM setting WHERE key = 'over65') = 'true' THEN 1 ELSE 0 END, '[\"type\"]', '[]'");
        $this->addSql('DROP TABLE setting');
    }
}
