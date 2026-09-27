<?php

namespace App\Money;

/**
 * Upgrades amounts in a JSON export written before phase 2 of the
 * decimal migration (docs/superpowers/specs/2026-09-27-arbitrary-
 * precision-decimals-design.md), when amounts were scaled integers
 * (2050 = £20.50 at GBP's scale of 2). A JSON integer is converted with
 * its own currency's/symbol's scale; a decimal string (the current
 * format) passes through untouched; a float is ambiguous and rejected.
 * Used only by app:import-local-storage — live API traffic always sends
 * decimal strings.
 */
final class LegacyIntegerAmounts
{
    /**
     * @param array<int, array<string, mixed>> $accounts
     * @param array<int, array<string, mixed>> $records
     * @param array<string, int>               $currencyScales code => scale
     * @param array<string, int>               $symbolScales   "TICKER|CUR" => scale
     *
     * @return array{accounts: array<int, array<string, mixed>>, records: array<int, array<string, mixed>>}
     */
    public static function upgrade(array $accounts, array $records, array $currencyScales, array $symbolScales): array
    {
        $byId = [];
        foreach ($accounts as $a) {
            $byId[(string) ($a['id'] ?? '')] = $a;
        }
        $amountScale = static function (?array $acc) use ($currencyScales, $symbolScales): ?int {
            if (null === $acc) {
                return null;
            }
            if ('investment' === ($acc['type'] ?? null)) {
                return $symbolScales[($acc['symbolTicker'] ?? '').'|'.($acc['symbolCurrency'] ?? '')] ?? null;
            }

            return isset($acc['currency']) ? ($currencyScales[$acc['currency']] ?? null) : null;
        };
        $currencyScale = static fn (mixed $code): ?int => \is_string($code) ? ($currencyScales[$code] ?? null) : null;

        $accounts = array_map(static function (array $a) use ($amountScale, $currencyScale) {
            $a = self::convertField($a, 'openingBalance', $amountScale($a), 'account '.($a['id'] ?? '?'));

            return self::convertField($a, 'openingBalanceCashValue', $currencyScale($a['symbolCurrency'] ?? null), 'account '.($a['id'] ?? '?'));
        }, $accounts);

        $records = array_map(static function (array $r) use ($byId, $amountScale, $currencyScale) {
            $r['lines'] = array_map(static function (array $l) use ($byId, $amountScale, $currencyScale) {
                $where = 'line on account '.($l['accountId'] ?? '?');
                $l = self::convertField($l, 'amount', $amountScale($byId[(string) ($l['accountId'] ?? '')] ?? null), $where);
                $l = self::convertField($l, 'cashValue', $currencyScale($l['cashCurrency'] ?? null), $where);

                return self::convertField($l, 'exchangeAmount', $currencyScale($l['exchangeCurrency'] ?? null), $where);
            }, $r['lines'] ?? []);

            return $r;
        }, $records);

        return ['accounts' => $accounts, 'records' => $records];
    }

    /** @param array<string, mixed> $row @return array<string, mixed> */
    private static function convertField(array $row, string $field, ?int $scale, string $where): array
    {
        if (!\array_key_exists($field, $row) || null === $row[$field] || \is_string($row[$field])) {
            return $row;
        }
        $v = $row[$field];
        if (\is_float($v)) {
            throw new \InvalidArgumentException(sprintf('%s: %s is a JSON float (%s) — ambiguous; export amounts as decimal strings or legacy scaled integers.', $where, $field, $v));
        }
        if (!\is_int($v)) {
            throw new \InvalidArgumentException(sprintf('%s: %s must be a decimal string.', $where, $field));
        }
        if (0 === $v) {
            $row[$field] = '0';

            return $row;
        }
        if (null === $scale) {
            throw new \InvalidArgumentException(sprintf('%s: can\'t determine the scale to upgrade legacy integer %s %d.', $where, $field, $v));
        }
        $row[$field] = ScaledAmount::toDecimal($v, $scale);

        return $row;
    }
}
