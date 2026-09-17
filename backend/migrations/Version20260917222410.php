<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20260917222410 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Add account.opening_balance_cash_value, the cost basis paired with opening_balance for an investment account carried forward by app:new-year';
    }

    public function up(Schema $schema): void
    {
        // this up() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TEMPORARY TABLE __temp__account AS SELECT id, name, type, currency, opening_balance, symbol, counterparty, isa_kind, isa_parent_id, flexible, subtype FROM account');
        $this->addSql('DROP TABLE account');
        $this->addSql('CREATE TABLE account (id VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL, currency VARCHAR(8) DEFAULT NULL, opening_balance INTEGER DEFAULT NULL, symbol VARCHAR(32) DEFAULT NULL, counterparty VARCHAR(255) DEFAULT NULL, isa_kind VARCHAR(32) DEFAULT NULL, isa_parent_id VARCHAR(32) DEFAULT NULL, flexible BOOLEAN DEFAULT NULL, subtype VARCHAR(255) DEFAULT NULL, opening_balance_cash_value INTEGER DEFAULT NULL, PRIMARY KEY (id), CONSTRAINT FK_ACCOUNT_CURRENCY FOREIGN KEY (currency) REFERENCES currency (code) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_ACCOUNT_SYMBOL FOREIGN KEY (symbol) REFERENCES symbol (ticker) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_ACCOUNT_INSTITUTION FOREIGN KEY (counterparty) REFERENCES counterparty (name) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO account (id, name, type, currency, opening_balance, symbol, counterparty, isa_kind, isa_parent_id, flexible, subtype) SELECT id, name, type, currency, opening_balance, symbol, counterparty, isa_kind, isa_parent_id, flexible, subtype FROM __temp__account');
        $this->addSql('DROP TABLE __temp__account');
        $this->addSql('CREATE INDEX IDX_7D3656A46956883F ON account (currency)');
        $this->addSql('CREATE INDEX IDX_7D3656A4ECC836F9 ON account (symbol)');
        $this->addSql('CREATE INDEX IDX_7D3656A49B3DE79C ON account (counterparty)');
        $this->addSql('CREATE TEMPORARY TABLE __temp__line AS SELECT id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id FROM line');
        $this->addSql('DROP TABLE line');
        $this->addSql('CREATE TABLE line (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, amount INTEGER NOT NULL, date VARCHAR(10) NOT NULL, description VARCHAR(255) NOT NULL, line_order INTEGER DEFAULT NULL, cash_value INTEGER DEFAULT NULL, cash_currency VARCHAR(8) DEFAULT NULL, exchange_amount INTEGER DEFAULT NULL, exchange_currency VARCHAR(8) DEFAULT NULL, transaction_id VARCHAR(32) DEFAULT NULL, account_id VARCHAR(32) NOT NULL, CONSTRAINT FK_D114B4F62FC0CB0F FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_D114B4F69B6B5FBA FOREIGN KEY (account_id) REFERENCES account (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_LINE_CASH_CURRENCY FOREIGN KEY (cash_currency) REFERENCES currency (code) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_LINE_EXCHANGE_CURRENCY FOREIGN KEY (exchange_currency) REFERENCES currency (code) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO line (id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id) SELECT id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id FROM __temp__line');
        $this->addSql('DROP TABLE __temp__line');
        $this->addSql('CREATE INDEX IDX_D114B4F62FC0CB0F ON line (transaction_id)');
        $this->addSql('CREATE INDEX IDX_D114B4F69B6B5FBA ON line (account_id)');
        $this->addSql('CREATE INDEX IDX_D114B4F6BD579F2 ON line (cash_currency)');
        $this->addSql('CREATE INDEX IDX_D114B4F6F3AEF15F ON line (exchange_currency)');
        $this->addSql('CREATE TEMPORARY TABLE __temp__line_tag AS SELECT line_id, tag_dimension, tag_value FROM line_tag');
        $this->addSql('DROP TABLE line_tag');
        $this->addSql('CREATE TABLE line_tag (line_id INTEGER NOT NULL, tag_dimension VARCHAR(255) NOT NULL, tag_value VARCHAR(255) NOT NULL, PRIMARY KEY (line_id, tag_dimension, tag_value), CONSTRAINT FK_LINE_TAG_LINE FOREIGN KEY (line_id) REFERENCES line (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_LINE_TAG_TAG FOREIGN KEY (tag_dimension, tag_value) REFERENCES tag (dimension, value) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO line_tag (line_id, tag_dimension, tag_value) SELECT line_id, tag_dimension, tag_value FROM __temp__line_tag');
        $this->addSql('DROP TABLE __temp__line_tag');
        $this->addSql('CREATE INDEX IDX_F0C284D94D7B7542 ON line_tag (line_id)');
        $this->addSql('CREATE INDEX IDX_F0C284D9DBACFBBB3F9B4132 ON line_tag (tag_dimension, tag_value)');
        $this->addSql('CREATE TEMPORARY TABLE __temp__settings AS SELECT id, over65, group_levels, saved_groupings FROM settings');
        $this->addSql('DROP TABLE settings');
        $this->addSql('CREATE TABLE settings (id INTEGER NOT NULL, over65 BOOLEAN NOT NULL, group_levels CLOB NOT NULL, saved_groupings CLOB NOT NULL, PRIMARY KEY (id))');
        $this->addSql('INSERT INTO settings (id, over65, group_levels, saved_groupings) SELECT id, over65, group_levels, saved_groupings FROM __temp__settings');
        $this->addSql('DROP TABLE __temp__settings');
        $this->addSql('CREATE TEMPORARY TABLE __temp__symbol AS SELECT ticker, name, scale, trading_currency FROM symbol');
        $this->addSql('DROP TABLE symbol');
        $this->addSql('CREATE TABLE symbol (ticker VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, scale INTEGER NOT NULL, trading_currency VARCHAR(8) NOT NULL, PRIMARY KEY (ticker), CONSTRAINT FK_SYMBOL_TRADING_CURRENCY FOREIGN KEY (trading_currency) REFERENCES currency (code) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO symbol (ticker, name, scale, trading_currency) SELECT ticker, name, scale, trading_currency FROM __temp__symbol');
        $this->addSql('DROP TABLE __temp__symbol');
        $this->addSql('CREATE INDEX IDX_ECC836F9B3532C3E ON symbol (trading_currency)');
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TEMPORARY TABLE __temp__account AS SELECT id, name, type, opening_balance, subtype, isa_kind, isa_parent_id, flexible, currency, symbol, counterparty FROM account');
        $this->addSql('DROP TABLE account');
        $this->addSql('CREATE TABLE account (id VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL, opening_balance INTEGER DEFAULT NULL, subtype VARCHAR(255) DEFAULT NULL, isa_kind VARCHAR(32) DEFAULT NULL, isa_parent_id VARCHAR(32) DEFAULT NULL, flexible BOOLEAN DEFAULT NULL, currency VARCHAR(8) DEFAULT NULL, symbol VARCHAR(32) DEFAULT NULL, counterparty VARCHAR(255) DEFAULT NULL, PRIMARY KEY (id), CONSTRAINT FK_7D3656A46956883F FOREIGN KEY (currency) REFERENCES currency (code) NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_7D3656A4ECC836F9 FOREIGN KEY (symbol) REFERENCES symbol (ticker) NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_7D3656A49B3DE79C FOREIGN KEY (counterparty) REFERENCES counterparty (name) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO account (id, name, type, opening_balance, subtype, isa_kind, isa_parent_id, flexible, currency, symbol, counterparty) SELECT id, name, type, opening_balance, subtype, isa_kind, isa_parent_id, flexible, currency, symbol, counterparty FROM __temp__account');
        $this->addSql('DROP TABLE __temp__account');
        $this->addSql('CREATE INDEX IDX_ACCOUNT_INSTITUTION ON account (counterparty)');
        $this->addSql('CREATE INDEX IDX_ACCOUNT_SYMBOL ON account (symbol)');
        $this->addSql('CREATE INDEX IDX_ACCOUNT_CURRENCY ON account (currency)');
        $this->addSql('CREATE TEMPORARY TABLE __temp__line AS SELECT id, amount, date, description, line_order, cash_value, exchange_amount, transaction_id, account_id, cash_currency, exchange_currency FROM line');
        $this->addSql('DROP TABLE line');
        $this->addSql('CREATE TABLE line (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, amount INTEGER NOT NULL, date VARCHAR(10) NOT NULL, description VARCHAR(255) NOT NULL, line_order INTEGER DEFAULT NULL, cash_value INTEGER DEFAULT NULL, exchange_amount INTEGER DEFAULT NULL, transaction_id VARCHAR(32) DEFAULT NULL, account_id VARCHAR(32) NOT NULL, cash_currency VARCHAR(8) DEFAULT NULL, exchange_currency VARCHAR(8) DEFAULT NULL, CONSTRAINT FK_D114B4F62FC0CB0F FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_D114B4F69B6B5FBA FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_D114B4F6BD579F2 FOREIGN KEY (cash_currency) REFERENCES currency (code) NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_D114B4F6F3AEF15F FOREIGN KEY (exchange_currency) REFERENCES currency (code) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO line (id, amount, date, description, line_order, cash_value, exchange_amount, transaction_id, account_id, cash_currency, exchange_currency) SELECT id, amount, date, description, line_order, cash_value, exchange_amount, transaction_id, account_id, cash_currency, exchange_currency FROM __temp__line');
        $this->addSql('DROP TABLE __temp__line');
        $this->addSql('CREATE INDEX IDX_D114B4F62FC0CB0F ON line (transaction_id)');
        $this->addSql('CREATE INDEX IDX_D114B4F69B6B5FBA ON line (account_id)');
        $this->addSql('CREATE INDEX IDX_LINE_EXCHANGE_CURRENCY ON line (exchange_currency)');
        $this->addSql('CREATE INDEX IDX_LINE_CASH_CURRENCY ON line (cash_currency)');
        $this->addSql('CREATE TEMPORARY TABLE __temp__line_tag AS SELECT line_id, tag_dimension, tag_value FROM line_tag');
        $this->addSql('DROP TABLE line_tag');
        $this->addSql('CREATE TABLE line_tag (line_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, tag_dimension VARCHAR(255) NOT NULL, tag_value VARCHAR(255) NOT NULL, CONSTRAINT FK_F0C284D94D7B7542 FOREIGN KEY (line_id) REFERENCES line (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_F0C284D9DBACFBBB3F9B4132 FOREIGN KEY (tag_dimension, tag_value) REFERENCES tag (dimension, value) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO line_tag (line_id, tag_dimension, tag_value) SELECT line_id, tag_dimension, tag_value FROM __temp__line_tag');
        $this->addSql('DROP TABLE __temp__line_tag');
        $this->addSql('CREATE INDEX IDX_F0C284D94D7B7542 ON line_tag (line_id)');
        $this->addSql('CREATE INDEX IDX_LINE_TAG_TAG ON line_tag (tag_dimension, tag_value)');
        $this->addSql('CREATE TEMPORARY TABLE __temp__settings AS SELECT id, over65, group_levels, saved_groupings FROM settings');
        $this->addSql('DROP TABLE settings');
        $this->addSql('CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, over65 BOOLEAN NOT NULL, group_levels CLOB NOT NULL, saved_groupings CLOB NOT NULL)');
        $this->addSql('INSERT INTO settings (id, over65, group_levels, saved_groupings) SELECT id, over65, group_levels, saved_groupings FROM __temp__settings');
        $this->addSql('DROP TABLE __temp__settings');
        $this->addSql('CREATE TEMPORARY TABLE __temp__symbol AS SELECT ticker, name, scale, trading_currency FROM symbol');
        $this->addSql('DROP TABLE symbol');
        $this->addSql('CREATE TABLE symbol (ticker VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, scale INTEGER NOT NULL, trading_currency VARCHAR(8) NOT NULL, PRIMARY KEY (ticker), CONSTRAINT FK_ECC836F9B3532C3E FOREIGN KEY (trading_currency) REFERENCES currency (code) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO symbol (ticker, name, scale, trading_currency) SELECT ticker, name, scale, trading_currency FROM __temp__symbol');
        $this->addSql('DROP TABLE __temp__symbol');
        $this->addSql('CREATE INDEX IDX_SYMBOL_TRADING_CURRENCY ON symbol (trading_currency)');
    }
}
