<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Connection;
use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * N2 of the scaled-integer-amounts redesign (see CLAUDE.md, and N1/N3 for
 * the rest): converts `account.opening_balance` and
 * `line.amount`/`cash_value`/`exchange_amount` from decimal floats to
 * integers scaled by the relevant currency's (or, for units on an
 * investment account, symbol's) `scale` — e.g. £20.00 (scale 2) becomes
 * the integer 2000.
 *
 * This has to be done per-row in PHP rather than a single SQL expression:
 * the correct multiplier depends on a join to the currency/symbol seeded
 * in N1, which isn't cleanly portable SQLite SQL for a conditional
 * "which scale applies to this row" decision. The one-time float
 * multiplication below (`round($value * 10**$scale)`) is the one place in
 * this whole redesign that's allowed to touch a float — there's no way to
 * avoid it, since the *source* data being converted already is a float;
 * every point downstream of this migration works in exact integers.
 *
 * Column *types* aren't changed here (SQLite can't ALTER a column's type
 * in place) — they're still DOUBLE PRECISION after this migration, just
 * holding integer-valued data. N3 does the type-changing table rebuild
 * and adds the FK constraints, once the values are already correct.
 */
final class Version20260830010100 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Convert account.opening_balance and line.amount/cash_value/exchange_amount from floats to scaled integers.';
    }

    public function up(Schema $schema): void
    {
        $connection = $this->connection;

        $accounts = $connection->fetchAllAssociative('SELECT id, opening_balance, currency, symbol FROM account WHERE opening_balance IS NOT NULL');
        foreach ($accounts as $row) {
            $scale = $this->scaleFor($connection, $row['currency'], $row['symbol']);
            $connection->executeStatement(
                'UPDATE account SET opening_balance = ? WHERE id = ?',
                [$this->toMinorUnits((float) $row['opening_balance'], $scale), $row['id']]
            );
        }

        foreach ($this->lineRows($connection) as $row) {
            [$amount, $cashValue, $exchangeAmount] = $this->convertLineRow($connection, $row, $this->toMinorUnits(...));
            $connection->executeStatement(
                'UPDATE line SET amount = ?, cash_value = ?, exchange_amount = ? WHERE id = ?',
                [$amount, $cashValue, $exchangeAmount, $row['id']]
            );
        }
    }

    public function down(Schema $schema): void
    {
        $connection = $this->connection;

        $accounts = $connection->fetchAllAssociative('SELECT id, opening_balance, currency, symbol FROM account WHERE opening_balance IS NOT NULL');
        foreach ($accounts as $row) {
            $scale = $this->scaleFor($connection, $row['currency'], $row['symbol']);
            $connection->executeStatement(
                'UPDATE account SET opening_balance = ? WHERE id = ?',
                [$this->fromMinorUnits((float) $row['opening_balance'], $scale), $row['id']]
            );
        }

        foreach ($this->lineRows($connection) as $row) {
            [$amount, $cashValue, $exchangeAmount] = $this->convertLineRow($connection, $row, $this->fromMinorUnits(...));
            $connection->executeStatement(
                'UPDATE line SET amount = ?, cash_value = ?, exchange_amount = ? WHERE id = ?',
                [$amount, $cashValue, $exchangeAmount, $row['id']]
            );
        }
    }

    /** @return array<int, array<string, mixed>> */
    private function lineRows(Connection $connection): array
    {
        return $connection->fetchAllAssociative(
            'SELECT l.id, l.amount, l.cash_value, l.cash_currency, l.exchange_amount, l.exchange_currency,
                    a.currency AS acc_currency, a.symbol AS acc_symbol
             FROM line l JOIN account a ON a.id = l.account_id'
        );
    }

    /**
     * @param array<string, mixed> $row
     *
     * @return array{0: int|float, 1: int|float|null, 2: int|float|null}
     */
    private function convertLineRow(Connection $connection, array $row, callable $convert): array
    {
        $amountScale = $row['acc_symbol']
            ? $this->scaleFor($connection, null, $row['acc_symbol'])
            : $this->scaleFor($connection, $row['acc_currency'], null);
        $amount = $convert((float) $row['amount'], $amountScale);

        $cashValue = null;
        if (null !== $row['cash_value']) {
            $cashScale = $row['cash_currency'] ? $this->scaleFor($connection, $row['cash_currency'], null) : $amountScale;
            $cashValue = $convert((float) $row['cash_value'], $cashScale);
        }

        $exchangeAmount = null;
        if (null !== $row['exchange_amount']) {
            $exchangeScale = $row['exchange_currency'] ? $this->scaleFor($connection, $row['exchange_currency'], null) : $amountScale;
            $exchangeAmount = $convert((float) $row['exchange_amount'], $exchangeScale);
        }

        return [$amount, $cashValue, $exchangeAmount];
    }

    private function scaleFor(Connection $connection, ?string $currencyCode, ?string $symbolTicker): int
    {
        if ($symbolTicker) {
            $scale = $connection->fetchOne('SELECT scale FROM symbol WHERE ticker = ?', [$symbolTicker]);
            if (false !== $scale) {
                return (int) $scale;
            }
        }
        if ($currencyCode) {
            $scale = $connection->fetchOne('SELECT scale FROM currency WHERE code = ?', [$currencyCode]);
            if (false !== $scale) {
                return (int) $scale;
            }
        }

        return 2;
    }

    private function toMinorUnits(float $value, int $scale): int
    {
        return (int) round($value * (10 ** $scale));
    }

    private function fromMinorUnits(float $value, int $scale): float
    {
        return $value / (10 ** $scale);
    }
}
