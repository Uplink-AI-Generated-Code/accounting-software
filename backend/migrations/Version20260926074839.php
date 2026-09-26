<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20260926074839 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Symbol gets a composite primary key (ticker, tradingCurrency); Account.symbol becomes symbol_ticker/symbol_currency — see docs/superpowers/specs/2026-09-26-currency-symbol-admin-design.md';
    }

    public function isTransactional(): bool
    {
        return false;
    }

    public function up(Schema $schema): void
    {
        $this->addSql('PRAGMA foreign_keys = OFF');
        // this up() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TEMPORARY TABLE __temp__account AS SELECT id, name, type, currency, opening_balance, symbol, counterparty, isa_kind, parent_id, flexible, subtype, opening_balance_cash_value FROM account');
        $this->addSql('DROP TABLE account');
        $this->addSql('CREATE TABLE account (id VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL, currency VARCHAR(8) DEFAULT NULL, opening_balance INTEGER DEFAULT NULL, symbol_ticker VARCHAR(32) DEFAULT NULL, counterparty VARCHAR(255) DEFAULT NULL, isa_kind VARCHAR(32) DEFAULT NULL, parent_id VARCHAR(32) DEFAULT NULL, flexible BOOLEAN DEFAULT NULL, subtype VARCHAR(255) DEFAULT NULL, opening_balance_cash_value INTEGER DEFAULT NULL, symbol_currency VARCHAR(8) DEFAULT NULL, PRIMARY KEY (id), CONSTRAINT FK_ACCOUNT_CURRENCY FOREIGN KEY (currency) REFERENCES currency (code) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_ACCOUNT_INSTITUTION FOREIGN KEY (counterparty) REFERENCES counterparty (name) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_7D3656A4727ACA70 FOREIGN KEY (parent_id) REFERENCES account (id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_7D3656A4E1F92935A015E871 FOREIGN KEY (symbol_ticker, symbol_currency) REFERENCES symbol (ticker, trading_currency) NOT DEFERRABLE INITIALLY IMMEDIATE, CHECK ((symbol_ticker IS NULL) = (symbol_currency IS NULL)))');
        // The generated INSERT only carried the old `symbol` column's value
        // into the new `symbol_ticker` column — `symbol_currency` had no
        // source column, so it would insert as NULL. That's not just wrong
        // data, it actively fails: the CHECK constraint above is enforced
        // per-row at INSERT time, not just once the whole statement
        // finishes, so a row with a non-null symbol_ticker and a still-null
        // symbol_currency violates it immediately (confirmed empirically —
        // the original two-step INSERT-then-UPDATE version of this
        // migration failed exactly this way against a real populated
        // database). Populate symbol_currency inline via a correlated
        // subquery against the (not-yet-rebuilt) `symbol` table's own
        // trading_currency for that ticker, which still exists under its
        // old single-column-PK shape at this point in the migration.
        $this->addSql('INSERT INTO account (id, name, type, currency, opening_balance, symbol_ticker, symbol_currency, counterparty, isa_kind, parent_id, flexible, subtype, opening_balance_cash_value) SELECT id, name, type, currency, opening_balance, symbol, (SELECT trading_currency FROM symbol WHERE symbol.ticker = __temp__account.symbol), counterparty, isa_kind, parent_id, flexible, subtype, opening_balance_cash_value FROM __temp__account');
        $this->addSql('DROP TABLE __temp__account');
        $this->addSql('CREATE INDEX IDX_7D3656A4727ACA70 ON account (parent_id)');
        $this->addSql('CREATE INDEX IDX_7D3656A46956883F ON account (currency)');
        $this->addSql('CREATE INDEX IDX_7D3656A49B3DE79C ON account (counterparty)');
        $this->addSql('CREATE INDEX IDX_7D3656A4E1F92935A015E871 ON account (symbol_ticker, symbol_currency)');
        $this->addSql('CREATE TEMPORARY TABLE __temp__line_tag AS SELECT line_id, tag_dimension, tag_value FROM line_tag');
        $this->addSql('DROP TABLE line_tag');
        $this->addSql('CREATE TABLE line_tag (line_id INTEGER NOT NULL, tag_dimension VARCHAR(255) NOT NULL, tag_value VARCHAR(255) NOT NULL, PRIMARY KEY (line_id, tag_dimension, tag_value), CONSTRAINT FK_LINE_TAG_LINE FOREIGN KEY (line_id) REFERENCES line (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_LINE_TAG_TAG FOREIGN KEY (tag_dimension, tag_value) REFERENCES tag (dimension, value) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO line_tag (line_id, tag_dimension, tag_value) SELECT line_id, tag_dimension, tag_value FROM __temp__line_tag');
        $this->addSql('DROP TABLE __temp__line_tag');
        $this->addSql('CREATE INDEX IDX_F0C284D9DBACFBBB3F9B4132 ON line_tag (tag_dimension, tag_value)');
        $this->addSql('CREATE INDEX IDX_F0C284D94D7B7542 ON line_tag (line_id)');
        $this->addSql('CREATE TEMPORARY TABLE __temp__symbol AS SELECT ticker, name, scale, trading_currency FROM symbol');
        $this->addSql('DROP TABLE symbol');
        $this->addSql('CREATE TABLE symbol (ticker VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, scale INTEGER NOT NULL, trading_currency VARCHAR(8) NOT NULL, PRIMARY KEY (ticker, trading_currency), CONSTRAINT FK_SYMBOL_TRADING_CURRENCY FOREIGN KEY (trading_currency) REFERENCES currency (code) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO symbol (ticker, name, scale, trading_currency) SELECT ticker, name, scale, trading_currency FROM __temp__symbol');
        $this->addSql('DROP TABLE __temp__symbol');
        $this->addSql('CREATE INDEX IDX_ECC836F9B3532C3E ON symbol (trading_currency)');
        $this->addSql('PRAGMA foreign_key_check');
        $this->addSql('PRAGMA foreign_keys = ON');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('PRAGMA foreign_keys = OFF');
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TEMPORARY TABLE __temp__account AS SELECT id, name, type, opening_balance, opening_balance_cash_value, subtype, isa_kind, flexible, currency, symbol_ticker, counterparty, parent_id FROM account');
        $this->addSql('DROP TABLE account');
        $this->addSql('CREATE TABLE account (id VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL, opening_balance INTEGER DEFAULT NULL, opening_balance_cash_value INTEGER DEFAULT NULL, subtype VARCHAR(255) DEFAULT NULL, isa_kind VARCHAR(32) DEFAULT NULL, flexible BOOLEAN DEFAULT NULL, currency VARCHAR(8) DEFAULT NULL, symbol VARCHAR(32) DEFAULT NULL, counterparty VARCHAR(255) DEFAULT NULL, parent_id VARCHAR(32) DEFAULT NULL, PRIMARY KEY (id), CONSTRAINT FK_7D3656A46956883F FOREIGN KEY (currency) REFERENCES currency (code) NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_7D3656A49B3DE79C FOREIGN KEY (counterparty) REFERENCES counterparty (name) NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_7D3656A4727ACA70 FOREIGN KEY (parent_id) REFERENCES account (id) NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_ACCOUNT_SYMBOL FOREIGN KEY (symbol) REFERENCES symbol (ticker) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO account (id, name, type, opening_balance, opening_balance_cash_value, subtype, isa_kind, flexible, currency, symbol, counterparty, parent_id) SELECT id, name, type, opening_balance, opening_balance_cash_value, subtype, isa_kind, flexible, currency, symbol_ticker, counterparty, parent_id FROM __temp__account');
        $this->addSql('DROP TABLE __temp__account');
        $this->addSql('CREATE INDEX IDX_7D3656A46956883F ON account (currency)');
        $this->addSql('CREATE INDEX IDX_7D3656A49B3DE79C ON account (counterparty)');
        $this->addSql('CREATE INDEX IDX_7D3656A4727ACA70 ON account (parent_id)');
        $this->addSql('CREATE INDEX IDX_7D3656A4ECC836F9 ON account (symbol)');
        $this->addSql('CREATE TEMPORARY TABLE __temp__line_tag AS SELECT line_id, tag_dimension, tag_value FROM line_tag');
        $this->addSql('DROP TABLE line_tag');
        $this->addSql('CREATE TABLE line_tag (line_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, tag_dimension VARCHAR(255) NOT NULL, tag_value VARCHAR(255) NOT NULL, CONSTRAINT FK_F0C284D94D7B7542 FOREIGN KEY (line_id) REFERENCES line (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_F0C284D9DBACFBBB3F9B4132 FOREIGN KEY (tag_dimension, tag_value) REFERENCES tag (dimension, value) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO line_tag (line_id, tag_dimension, tag_value) SELECT line_id, tag_dimension, tag_value FROM __temp__line_tag');
        $this->addSql('DROP TABLE __temp__line_tag');
        $this->addSql('CREATE INDEX IDX_F0C284D94D7B7542 ON line_tag (line_id)');
        $this->addSql('CREATE INDEX IDX_F0C284D9DBACFBBB3F9B4132 ON line_tag (tag_dimension, tag_value)');
        $this->addSql('CREATE TEMPORARY TABLE __temp__symbol AS SELECT ticker, name, scale, trading_currency FROM symbol');
        $this->addSql('DROP TABLE symbol');
        $this->addSql('CREATE TABLE symbol (ticker VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, scale INTEGER NOT NULL, trading_currency VARCHAR(8) NOT NULL, PRIMARY KEY (ticker), CONSTRAINT FK_ECC836F9B3532C3E FOREIGN KEY (trading_currency) REFERENCES currency (code) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO symbol (ticker, name, scale, trading_currency) SELECT ticker, name, scale, trading_currency FROM __temp__symbol');
        $this->addSql('DROP TABLE __temp__symbol');
        $this->addSql('CREATE INDEX IDX_ECC836F9B3532C3E ON symbol (trading_currency)');
        $this->addSql('PRAGMA foreign_key_check');
        $this->addSql('PRAGMA foreign_keys = ON');
    }
}
