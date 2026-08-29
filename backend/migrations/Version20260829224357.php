<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20260829224357 extends AbstractMigration
{
    public function getDescription(): string
    {
        return '';
    }

    public function up(Schema $schema): void
    {
        // this up() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TEMPORARY TABLE __temp__line AS SELECT id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id FROM line');
        $this->addSql('DROP TABLE line');
        $this->addSql('CREATE TABLE line (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, amount DOUBLE PRECISION NOT NULL, date VARCHAR(10) NOT NULL, description VARCHAR(255) NOT NULL, line_order INTEGER DEFAULT NULL, cash_value DOUBLE PRECISION DEFAULT NULL, cash_currency VARCHAR(8) DEFAULT NULL, exchange_amount DOUBLE PRECISION DEFAULT NULL, exchange_currency VARCHAR(8) DEFAULT NULL, transaction_id VARCHAR(32) DEFAULT NULL, account_id VARCHAR(32) NOT NULL, CONSTRAINT FK_D114B4F62FC0CB0F FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_D114B4F69B6B5FBA FOREIGN KEY (account_id) REFERENCES account (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO line (id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id) SELECT id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id FROM __temp__line');
        $this->addSql('DROP TABLE __temp__line');
        $this->addSql('CREATE INDEX IDX_D114B4F69B6B5FBA ON line (account_id)');
        $this->addSql('CREATE INDEX IDX_D114B4F62FC0CB0F ON line (transaction_id)');
        $this->addSql('CREATE TEMPORARY TABLE __temp__settings AS SELECT id, over65, group_levels, saved_groupings FROM settings');
        $this->addSql('DROP TABLE settings');
        $this->addSql('CREATE TABLE settings (id INTEGER NOT NULL, over65 BOOLEAN NOT NULL, group_levels CLOB NOT NULL, saved_groupings CLOB NOT NULL, PRIMARY KEY (id))');
        $this->addSql('INSERT INTO settings (id, over65, group_levels, saved_groupings) SELECT id, over65, group_levels, saved_groupings FROM __temp__settings');
        $this->addSql('DROP TABLE __temp__settings');
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TEMPORARY TABLE __temp__line AS SELECT id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id FROM line');
        $this->addSql('DROP TABLE line');
        $this->addSql('CREATE TABLE line (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, amount DOUBLE PRECISION NOT NULL, date VARCHAR(10) NOT NULL, description VARCHAR(255) NOT NULL, line_order INTEGER DEFAULT NULL, cash_value DOUBLE PRECISION DEFAULT NULL, cash_currency VARCHAR(8) DEFAULT NULL, exchange_amount DOUBLE PRECISION DEFAULT NULL, exchange_currency VARCHAR(8) DEFAULT NULL, transaction_id VARCHAR(32) NOT NULL, account_id VARCHAR(32) NOT NULL, CONSTRAINT FK_D114B4F62FC0CB0F FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_D114B4F69B6B5FBA FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('INSERT INTO line (id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id) SELECT id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id FROM __temp__line');
        $this->addSql('DROP TABLE __temp__line');
        $this->addSql('CREATE INDEX IDX_D114B4F62FC0CB0F ON line (transaction_id)');
        $this->addSql('CREATE INDEX IDX_D114B4F69B6B5FBA ON line (account_id)');
        $this->addSql('CREATE TEMPORARY TABLE __temp__settings AS SELECT id, over65, group_levels, saved_groupings FROM settings');
        $this->addSql('DROP TABLE settings');
        $this->addSql('CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, over65 BOOLEAN NOT NULL, group_levels CLOB NOT NULL, saved_groupings CLOB NOT NULL)');
        $this->addSql('INSERT INTO settings (id, over65, group_levels, saved_groupings) SELECT id, over65, group_levels, saved_groupings FROM __temp__settings');
        $this->addSql('DROP TABLE __temp__settings');
    }
}
