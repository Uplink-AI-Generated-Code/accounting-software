<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * N3 of the scaled-integer-amounts redesign (see CLAUDE.md, and N1/N2 for
 * the rest): rebuilds `account`/`line` (SQLite can't ALTER a column's
 * type or ADD a foreign key in place — same temp-table-rebuild pattern as
 * Version20260829224357.php) so that:
 *  - `account.currency`/`symbol`/`institution` and
 *    `line.cash_currency`/`exchange_currency` become real FK columns
 *    referencing the reference tables N1 created and seeded.
 *  - `account.opening_balance` and `line.amount`/`cash_value`/
 *    `exchange_amount` become true INTEGER columns (N2 already converted
 *    their values; this migration just changes the declared type).
 *
 * Run after N1 (every referenced code/ticker/name already exists as a
 * row, so this rebuild's data copy doesn't violate the new FK
 * constraints) and after N2 (so the amount columns are already holding
 * stable integer values going into this final rebuild).
 */
final class Version20260830010200 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Turn account.currency/symbol/institution and line.cash_currency/exchange_currency into FK columns; account.opening_balance and line.amount/cash_value/exchange_amount into INTEGER columns.';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TEMPORARY TABLE __temp__account AS SELECT id, name, type, currency, opening_balance, symbol, institution, isa_kind, isa_parent_id, flexible FROM account');
        $this->addSql('DROP TABLE account');
        $this->addSql('CREATE TABLE account (id VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL, currency VARCHAR(8) DEFAULT NULL, opening_balance INTEGER DEFAULT NULL, symbol VARCHAR(32) DEFAULT NULL, institution VARCHAR(255) DEFAULT NULL, isa_kind VARCHAR(32) DEFAULT NULL, isa_parent_id VARCHAR(32) DEFAULT NULL, flexible BOOLEAN DEFAULT NULL, PRIMARY KEY(id), CONSTRAINT FK_ACCOUNT_CURRENCY FOREIGN KEY (currency) REFERENCES currency (code) NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_ACCOUNT_SYMBOL FOREIGN KEY (symbol) REFERENCES symbol (ticker) NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_ACCOUNT_INSTITUTION FOREIGN KEY (institution) REFERENCES institution (name) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO account (id, name, type, currency, opening_balance, symbol, institution, isa_kind, isa_parent_id, flexible) SELECT id, name, type, currency, CAST(opening_balance AS INTEGER), symbol, institution, isa_kind, isa_parent_id, flexible FROM __temp__account');
        $this->addSql('DROP TABLE __temp__account');
        $this->addSql('CREATE INDEX IDX_ACCOUNT_CURRENCY ON account (currency)');
        $this->addSql('CREATE INDEX IDX_ACCOUNT_SYMBOL ON account (symbol)');
        $this->addSql('CREATE INDEX IDX_ACCOUNT_INSTITUTION ON account (institution)');

        $this->addSql('CREATE TEMPORARY TABLE __temp__line AS SELECT id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id FROM line');
        $this->addSql('DROP TABLE line');
        $this->addSql('CREATE TABLE line (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, amount INTEGER NOT NULL, date VARCHAR(10) NOT NULL, description VARCHAR(255) NOT NULL, line_order INTEGER DEFAULT NULL, cash_value INTEGER DEFAULT NULL, cash_currency VARCHAR(8) DEFAULT NULL, exchange_amount INTEGER DEFAULT NULL, exchange_currency VARCHAR(8) DEFAULT NULL, transaction_id VARCHAR(32) DEFAULT NULL, account_id VARCHAR(32) NOT NULL, CONSTRAINT FK_D114B4F62FC0CB0F FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_D114B4F69B6B5FBA FOREIGN KEY (account_id) REFERENCES account (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_LINE_CASH_CURRENCY FOREIGN KEY (cash_currency) REFERENCES currency (code) NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_LINE_EXCHANGE_CURRENCY FOREIGN KEY (exchange_currency) REFERENCES currency (code) NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO line (id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id) SELECT id, CAST(amount AS INTEGER), date, description, line_order, CAST(cash_value AS INTEGER), cash_currency, CAST(exchange_amount AS INTEGER), exchange_currency, transaction_id, account_id FROM __temp__line');
        $this->addSql('DROP TABLE __temp__line');
        $this->addSql('CREATE INDEX IDX_D114B4F69B6B5FBA ON line (account_id)');
        $this->addSql('CREATE INDEX IDX_D114B4F62FC0CB0F ON line (transaction_id)');
        $this->addSql('CREATE INDEX IDX_LINE_CASH_CURRENCY ON line (cash_currency)');
        $this->addSql('CREATE INDEX IDX_LINE_EXCHANGE_CURRENCY ON line (exchange_currency)');
    }

    public function down(Schema $schema): void
    {
        $this->addSql('CREATE TEMPORARY TABLE __temp__account AS SELECT id, name, type, currency, opening_balance, symbol, institution, isa_kind, isa_parent_id, flexible FROM account');
        $this->addSql('DROP TABLE account');
        $this->addSql('CREATE TABLE account (id VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL, currency VARCHAR(8) DEFAULT NULL, opening_balance DOUBLE PRECISION DEFAULT NULL, symbol VARCHAR(32) DEFAULT NULL, institution VARCHAR(255) DEFAULT NULL, isa_kind VARCHAR(32) DEFAULT NULL, isa_parent_id VARCHAR(32) DEFAULT NULL, flexible BOOLEAN DEFAULT NULL, PRIMARY KEY(id))');
        $this->addSql('INSERT INTO account (id, name, type, currency, opening_balance, symbol, institution, isa_kind, isa_parent_id, flexible) SELECT id, name, type, currency, opening_balance, symbol, institution, isa_kind, isa_parent_id, flexible FROM __temp__account');
        $this->addSql('DROP TABLE __temp__account');

        $this->addSql('CREATE TEMPORARY TABLE __temp__line AS SELECT id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id FROM line');
        $this->addSql('DROP TABLE line');
        $this->addSql('CREATE TABLE line (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, amount DOUBLE PRECISION NOT NULL, date VARCHAR(10) NOT NULL, description VARCHAR(255) NOT NULL, line_order INTEGER DEFAULT NULL, cash_value DOUBLE PRECISION DEFAULT NULL, cash_currency VARCHAR(8) DEFAULT NULL, exchange_amount DOUBLE PRECISION DEFAULT NULL, exchange_currency VARCHAR(8) DEFAULT NULL, transaction_id VARCHAR(32) DEFAULT NULL, account_id VARCHAR(32) NOT NULL, CONSTRAINT FK_D114B4F62FC0CB0F FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_D114B4F69B6B5FBA FOREIGN KEY (account_id) REFERENCES account (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO line (id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id) SELECT id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id FROM __temp__line');
        $this->addSql('DROP TABLE __temp__line');
        $this->addSql('CREATE INDEX IDX_D114B4F69B6B5FBA ON line (account_id)');
        $this->addSql('CREATE INDEX IDX_D114B4F62FC0CB0F ON line (transaction_id)');
    }
}
