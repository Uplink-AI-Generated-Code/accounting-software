<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20260829184944 extends AbstractMigration
{
    public function getDescription(): string
    {
        return '';
    }

    public function up(Schema $schema): void
    {
        // this up() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TABLE account (id VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL, currency VARCHAR(8) DEFAULT NULL, opening_balance DOUBLE PRECISION DEFAULT NULL, symbol VARCHAR(32) DEFAULT NULL, institution VARCHAR(255) DEFAULT NULL, isa_kind VARCHAR(32) DEFAULT NULL, isa_parent_id VARCHAR(32) DEFAULT NULL, flexible BOOLEAN DEFAULT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE TABLE line (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, amount DOUBLE PRECISION NOT NULL, date VARCHAR(10) NOT NULL, description VARCHAR(255) NOT NULL, line_order INTEGER DEFAULT NULL, cash_value DOUBLE PRECISION DEFAULT NULL, cash_currency VARCHAR(8) DEFAULT NULL, exchange_amount DOUBLE PRECISION DEFAULT NULL, exchange_currency VARCHAR(8) DEFAULT NULL, transaction_id VARCHAR(32) NOT NULL, account_id VARCHAR(32) NOT NULL, CONSTRAINT FK_D114B4F62FC0CB0F FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_D114B4F69B6B5FBA FOREIGN KEY (account_id) REFERENCES account (id) ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE)');
        $this->addSql('CREATE INDEX IDX_D114B4F62FC0CB0F ON line (transaction_id)');
        $this->addSql('CREATE INDEX IDX_D114B4F69B6B5FBA ON line (account_id)');
        $this->addSql('CREATE TABLE settings (id INTEGER NOT NULL, over65 BOOLEAN NOT NULL, group_levels CLOB NOT NULL, saved_groupings CLOB NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE TABLE transactions (id VARCHAR(32) NOT NULL, PRIMARY KEY (id))');
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('DROP TABLE account');
        $this->addSql('DROP TABLE line');
        $this->addSql('DROP TABLE settings');
        $this->addSql('DROP TABLE transactions');
    }
}
