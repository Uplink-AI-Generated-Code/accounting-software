<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20260919194846 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Generalize isa-parent into investment-parent (rename isa_parent_id to parent_id, make it a real enforced FK), and require every investment account to have a parent (CHECK constraint) — see docs/superpowers/specs/2026-09-19-generalized-investment-parent-design.md';
    }

    /**
     * SQLite's `DROP TABLE account` (part of the temp-table-rebuild pattern below)
     * performs an implicit `DELETE FROM account` before dropping the table. With
     * `foreign_keys` enforcement on (see ForeignKeysMiddleware), `line.account_id`'s
     * `ON DELETE CASCADE` would fire on that implicit delete and wipe every `line`
     * row in the database. `PRAGMA foreign_keys` is also a documented no-op inside
     * an active transaction in SQLite, so this migration must run non-transactionally
     * and toggle the pragma itself around the rebuild.
     */
    public function isTransactional(): bool
    {
        return false;
    }

    public function up(Schema $schema): void
    {
        // Queued via addSql (not executed immediately), so it runs in the correct
        // order relative to every other addSql'd statement below — the migrator
        // executes all of $plannedSql, in the order added, only after up() returns.
        $this->addSql('PRAGMA foreign_keys = OFF');

        $this->addSql("UPDATE account SET type = 'investment-parent' WHERE type = 'isa-parent'");
        $this->addSql("UPDATE account SET isa_kind = 'stocks-shares-isa' WHERE type = 'investment-parent'");
        $this->addSql('CREATE TEMPORARY TABLE __temp__account AS SELECT id, name, type, currency, opening_balance, symbol, counterparty, isa_kind, isa_parent_id, flexible, subtype, opening_balance_cash_value FROM account');
        $this->addSql('DROP TABLE account');
        $this->addSql('CREATE TABLE account (id VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL, currency VARCHAR(8) DEFAULT NULL, opening_balance INTEGER DEFAULT NULL, symbol VARCHAR(32) DEFAULT NULL, counterparty VARCHAR(255) DEFAULT NULL, isa_kind VARCHAR(32) DEFAULT NULL, parent_id VARCHAR(32) DEFAULT NULL, flexible BOOLEAN DEFAULT NULL, subtype VARCHAR(255) DEFAULT NULL, opening_balance_cash_value INTEGER DEFAULT NULL, PRIMARY KEY (id), CONSTRAINT FK_ACCOUNT_CURRENCY FOREIGN KEY (currency) REFERENCES currency (code) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_ACCOUNT_SYMBOL FOREIGN KEY (symbol) REFERENCES symbol (ticker) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_ACCOUNT_INSTITUTION FOREIGN KEY (counterparty) REFERENCES counterparty (name) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_7D3656A4727ACA70 FOREIGN KEY (parent_id) REFERENCES account (id) NOT DEFERRABLE INITIALLY IMMEDIATE, CHECK (type != \'investment\' OR parent_id IS NOT NULL))');
        $this->addSql('INSERT INTO account (id, name, type, currency, opening_balance, symbol, counterparty, isa_kind, parent_id, flexible, subtype, opening_balance_cash_value) SELECT id, name, type, currency, opening_balance, symbol, counterparty, isa_kind, isa_parent_id, flexible, subtype, opening_balance_cash_value FROM __temp__account');
        $this->addSql('DROP TABLE __temp__account');
        $this->addSql('CREATE INDEX IDX_7D3656A49B3DE79C ON account (counterparty)');
        $this->addSql('CREATE INDEX IDX_7D3656A4ECC836F9 ON account (symbol)');
        $this->addSql('CREATE INDEX IDX_7D3656A46956883F ON account (currency)');
        $this->addSql('CREATE INDEX IDX_7D3656A4727ACA70 ON account (parent_id)');

        $this->addSql('PRAGMA foreign_key_check');
        $this->addSql('PRAGMA foreign_keys = ON');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('PRAGMA foreign_keys = OFF');

        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TEMPORARY TABLE __temp__account AS SELECT id, name, type, opening_balance, opening_balance_cash_value, subtype, isa_kind, flexible, currency, symbol, counterparty, parent_id FROM account');
        $this->addSql('DROP TABLE account');
        $this->addSql('CREATE TABLE account (id VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL, opening_balance INTEGER DEFAULT NULL, opening_balance_cash_value INTEGER DEFAULT NULL, subtype VARCHAR(255) DEFAULT NULL, isa_kind VARCHAR(32) DEFAULT NULL, flexible BOOLEAN DEFAULT NULL, currency VARCHAR(8) DEFAULT NULL, symbol VARCHAR(32) DEFAULT NULL, counterparty VARCHAR(255) DEFAULT NULL, isa_parent_id VARCHAR(32) DEFAULT NULL, PRIMARY KEY (id), CONSTRAINT FK_7D3656A46956883F FOREIGN KEY (currency) REFERENCES currency (code) NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_7D3656A4ECC836F9 FOREIGN KEY (symbol) REFERENCES symbol (ticker) NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_7D3656A49B3DE79C FOREIGN KEY (counterparty) REFERENCES counterparty (name) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO account (id, name, type, opening_balance, opening_balance_cash_value, subtype, isa_kind, flexible, currency, symbol, counterparty, isa_parent_id) SELECT id, name, type, opening_balance, opening_balance_cash_value, subtype, isa_kind, flexible, currency, symbol, counterparty, parent_id FROM __temp__account');
        $this->addSql('DROP TABLE __temp__account');
        $this->addSql('CREATE INDEX IDX_7D3656A46956883F ON account (currency)');
        $this->addSql('CREATE INDEX IDX_7D3656A4ECC836F9 ON account (symbol)');
        $this->addSql('CREATE INDEX IDX_7D3656A49B3DE79C ON account (counterparty)');

        $this->addSql('PRAGMA foreign_key_check');
        $this->addSql('PRAGMA foreign_keys = ON');
    }
}
