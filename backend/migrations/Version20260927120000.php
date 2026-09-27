<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Phase 2 of docs/superpowers/specs/2026-09-27-arbitrary-precision-
 * decimals-design.md: the five amount columns become TEXT holding
 * canonical decimal strings. Each stored integer is converted with its
 * own scale (line amount: the account's currency, or its Symbol's scale
 * for an investment account; cash_value/exchange_amount: their own
 * currency; account opening_balance: as line amount; opening_balance_
 * cash_value: the account's symbol_currency). Values are read in up()
 * — before any queued SQL runs — and written back as per-row UPDATEs
 * after the rebuild. Self-contained on purpose: no App\ classes, since
 * those evolve and a migration must not.
 *
 * DROP TABLE rebuilds ⇒ isTransactional() false and the foreign_keys
 * pragma bracket, all via addSql() — see CLAUDE.md's migration rules.
 */
final class Version20260927120000 extends AbstractMigration
{
    private const ACCOUNT_COLUMNS = 'id, name, type, currency, opening_balance, symbol_ticker, counterparty, isa_kind, parent_id, flexible, subtype, opening_balance_cash_value, symbol_currency';
    private const LINE_COLUMNS = 'id, amount, date, description, line_order, cash_value, cash_currency, exchange_amount, exchange_currency, transaction_id, account_id';

    public function getDescription(): string
    {
        return 'Amounts become exact decimal TEXT (canonical strings) instead of scaled integers — see docs/superpowers/specs/2026-09-27-arbitrary-precision-decimals-design.md';
    }

    public function isTransactional(): bool
    {
        return false;
    }

    public function up(Schema $schema): void
    {
        [$accountUpdates, $lineUpdates] = $this->convertedValues(static fn (mixed $v, ?int $scale, string $what): ?string => self::toDecimal($v, $scale, $what));

        $this->addSql('PRAGMA foreign_keys = OFF');
        $this->rebuildAccount('TEXT');
        $this->rebuildLine('TEXT');
        foreach ($accountUpdates as $u) {
            $this->addSql('UPDATE account SET opening_balance = ?, opening_balance_cash_value = ? WHERE id = ?', $u);
        }
        foreach ($lineUpdates as $u) {
            $this->addSql('UPDATE line SET amount = ?, cash_value = ?, exchange_amount = ? WHERE id = ?', $u);
        }
        $this->addSql('PRAGMA foreign_key_check');
        $this->addSql('PRAGMA foreign_keys = ON');
    }

    public function down(Schema $schema): void
    {
        [$accountUpdates, $lineUpdates] = $this->convertedValues(static fn (mixed $v, ?int $scale, string $what): ?int => self::toScaledInt($v, $scale, $what));

        $this->addSql('PRAGMA foreign_keys = OFF');
        $this->rebuildAccount('INTEGER');
        $this->rebuildLine('INTEGER');
        foreach ($accountUpdates as $u) {
            $this->addSql('UPDATE account SET opening_balance = ?, opening_balance_cash_value = ? WHERE id = ?', $u);
        }
        foreach ($lineUpdates as $u) {
            $this->addSql('UPDATE line SET amount = ?, cash_value = ?, exchange_amount = ? WHERE id = ?', $u);
        }
        $this->addSql('PRAGMA foreign_key_check');
        $this->addSql('PRAGMA foreign_keys = ON');
    }

    /**
     * Reads every amount with its governing scale and converts it with
     * $convert. Returns [accountUpdates, lineUpdates], each row being the
     * UPDATE's parameter list.
     *
     * @return array{0: array<int, array<int, mixed>>, 1: array<int, array<int, mixed>>}
     */
    private function convertedValues(callable $convert): array
    {
        $currencyScales = [];
        foreach ($this->connection->fetchAllAssociative('SELECT code, scale FROM currency') as $r) {
            $currencyScales[$r['code']] = (int) $r['scale'];
        }
        $symbolScales = [];
        foreach ($this->connection->fetchAllAssociative('SELECT ticker, trading_currency, scale FROM symbol') as $r) {
            $symbolScales[$r['ticker'].'|'.$r['trading_currency']] = (int) $r['scale'];
        }
        $currencyScale = static fn (?string $code): ?int => null === $code ? null : ($currencyScales[$code] ?? null);
        $accounts = [];
        foreach ($this->connection->fetchAllAssociative('SELECT id, type, currency, symbol_ticker, symbol_currency, opening_balance, opening_balance_cash_value FROM account') as $r) {
            $accounts[$r['id']] = $r;
        }
        $amountScale = static function (?array $acc) use ($symbolScales, $currencyScale): ?int {
            if (null === $acc) {
                return null;
            }
            if ('investment' === $acc['type']) {
                return $symbolScales[$acc['symbol_ticker'].'|'.$acc['symbol_currency']] ?? null;
            }

            return $currencyScale($acc['currency']);
        };

        $accountUpdates = [];
        foreach ($accounts as $acc) {
            if (null === $acc['opening_balance'] && null === $acc['opening_balance_cash_value']) {
                continue;
            }
            $accountUpdates[] = [
                $convert($acc['opening_balance'], $amountScale($acc), "account {$acc['id']} opening_balance"),
                $convert($acc['opening_balance_cash_value'], $currencyScale($acc['symbol_currency']), "account {$acc['id']} opening_balance_cash_value"),
                $acc['id'],
            ];
        }

        $lineUpdates = [];
        foreach ($this->connection->fetchAllAssociative('SELECT id, account_id, amount, cash_value, cash_currency, exchange_amount, exchange_currency FROM line') as $r) {
            $lineUpdates[] = [
                $convert($r['amount'], $amountScale($accounts[$r['account_id']] ?? null), "line {$r['id']} amount"),
                $convert($r['cash_value'], $currencyScale($r['cash_currency']), "line {$r['id']} cash_value"),
                $convert($r['exchange_amount'], $currencyScale($r['exchange_currency']), "line {$r['id']} exchange_amount"),
                (int) $r['id'],
            ];
        }

        return [$accountUpdates, $lineUpdates];
    }

    private function rebuildAccount(string $amountType): void
    {
        $this->addSql('CREATE TEMPORARY TABLE __temp__account AS SELECT '.self::ACCOUNT_COLUMNS.' FROM account');
        $this->addSql('DROP TABLE account');
        $this->addSql("CREATE TABLE account (id VARCHAR(32) NOT NULL, name VARCHAR(255) NOT NULL, type VARCHAR(32) NOT NULL, currency VARCHAR(8) DEFAULT NULL, opening_balance {$amountType} DEFAULT NULL, symbol_ticker VARCHAR(32) DEFAULT NULL, counterparty VARCHAR(255) DEFAULT NULL, isa_kind VARCHAR(32) DEFAULT NULL, parent_id VARCHAR(32) DEFAULT NULL, flexible BOOLEAN DEFAULT NULL, subtype VARCHAR(255) DEFAULT NULL, opening_balance_cash_value {$amountType} DEFAULT NULL, symbol_currency VARCHAR(8) DEFAULT NULL, PRIMARY KEY (id), CONSTRAINT FK_ACCOUNT_CURRENCY FOREIGN KEY (currency) REFERENCES currency (code) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_ACCOUNT_INSTITUTION FOREIGN KEY (counterparty) REFERENCES counterparty (name) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_7D3656A4727ACA70 FOREIGN KEY (parent_id) REFERENCES account (id) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_7D3656A4E1F92935A015E871 FOREIGN KEY (symbol_ticker, symbol_currency) REFERENCES symbol (ticker, trading_currency) NOT DEFERRABLE INITIALLY IMMEDIATE, CHECK ((symbol_ticker IS NULL) = (symbol_currency IS NULL)))");
        $this->addSql('INSERT INTO account ('.self::ACCOUNT_COLUMNS.') SELECT '.self::ACCOUNT_COLUMNS.' FROM __temp__account');
        $this->addSql('DROP TABLE __temp__account');
        $this->addSql('CREATE INDEX IDX_7D3656A4727ACA70 ON account (parent_id)');
        $this->addSql('CREATE INDEX IDX_7D3656A46956883F ON account (currency)');
        $this->addSql('CREATE INDEX IDX_7D3656A49B3DE79C ON account (counterparty)');
        $this->addSql('CREATE INDEX IDX_7D3656A4E1F92935A015E871 ON account (symbol_ticker, symbol_currency)');
    }

    private function rebuildLine(string $amountType): void
    {
        $this->addSql('CREATE TEMPORARY TABLE __temp__line AS SELECT '.self::LINE_COLUMNS.' FROM line');
        $this->addSql('DROP TABLE line');
        $this->addSql("CREATE TABLE line (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, amount {$amountType} NOT NULL, date VARCHAR(10) NOT NULL, description VARCHAR(255) NOT NULL, line_order INTEGER DEFAULT NULL, cash_value {$amountType} DEFAULT NULL, cash_currency VARCHAR(8) DEFAULT NULL, exchange_amount {$amountType} DEFAULT NULL, exchange_currency VARCHAR(8) DEFAULT NULL, transaction_id VARCHAR(32) DEFAULT NULL, account_id VARCHAR(32) NOT NULL, CONSTRAINT FK_D114B4F62FC0CB0F FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_D114B4F69B6B5FBA FOREIGN KEY (account_id) REFERENCES account (id) ON UPDATE NO ACTION ON DELETE CASCADE NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_LINE_CASH_CURRENCY FOREIGN KEY (cash_currency) REFERENCES currency (code) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE, CONSTRAINT FK_LINE_EXCHANGE_CURRENCY FOREIGN KEY (exchange_currency) REFERENCES currency (code) ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE)");
        $this->addSql('INSERT INTO line ('.self::LINE_COLUMNS.') SELECT '.self::LINE_COLUMNS.' FROM __temp__line');
        $this->addSql('DROP TABLE __temp__line');
        $this->addSql('CREATE INDEX IDX_D114B4F62FC0CB0F ON line (transaction_id)');
        $this->addSql('CREATE INDEX IDX_D114B4F69B6B5FBA ON line (account_id)');
        $this->addSql('CREATE INDEX IDX_D114B4F6BD579F2 ON line (cash_currency)');
        $this->addSql('CREATE INDEX IDX_D114B4F6F3AEF15F ON line (exchange_currency)');
    }

    /** Scaled integer (as stored before this migration) → canonical decimal string. */
    private static function toDecimal(mixed $v, ?int $scale, string $what): ?string
    {
        if (null === $v) {
            return null;
        }
        if (!preg_match('/^-?\d+$/', (string) $v)) {
            throw new \RuntimeException(sprintf('%s: expected a stored integer, found "%s".', $what, $v));
        }
        $n = (int) $v;
        if (0 === $n) {
            return '0';
        }
        if (null === $scale) {
            throw new \RuntimeException(sprintf('%s: can\'t determine its scale (unknown currency/symbol) — fix the data before migrating.', $what));
        }
        $digits = str_pad((string) abs($n), $scale + 1, '0', \STR_PAD_LEFT);
        $whole = 0 === $scale ? $digits : substr($digits, 0, -$scale);
        $frac = 0 === $scale ? '' : rtrim(substr($digits, -$scale), '0');

        return ($n < 0 ? '-' : '').$whole.('' !== $frac ? '.'.$frac : '');
    }

    /** Canonical decimal string → scaled integer; refuses anything that wouldn't round-trip. */
    private static function toScaledInt(mixed $v, ?int $scale, string $what): ?int
    {
        if (null === $v) {
            return null;
        }
        if (!preg_match('/^(-?)(\d+)(?:\.(\d+))?$/', (string) $v, $m)) {
            throw new \RuntimeException(sprintf('%s: "%s" is not a decimal amount.', $what, $v));
        }
        $frac = rtrim($m[3] ?? '', '0');
        if ('' === ltrim($m[2].$frac, '0')) {
            return 0;
        }
        if (null === $scale) {
            throw new \RuntimeException(sprintf('%s: can\'t determine its scale.', $what));
        }
        if (\strlen($frac) > $scale) {
            throw new \RuntimeException(sprintf('%s: %s has more than %d decimal place(s) — can\'t go back to scaled integers without losing precision.', $what, $v, $scale));
        }
        $digits = ltrim($m[2].str_pad($frac, $scale, '0'), '0');
        if (\strlen($digits) > 18) {
            throw new \RuntimeException(sprintf('%s: %s is too large for a 64-bit scaled integer.', $what, $v));
        }

        return ('-' === $m[1] ? -1 : 1) * (int) $digits;
    }
}
