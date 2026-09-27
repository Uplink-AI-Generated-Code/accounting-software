<?php

namespace App\Money;

/**
 * Phase 1 shim: converts amount fields between the integer arrays the
 * services still produce/consume and the canonical decimal strings the
 * API now speaks — applied only in controllers. See the field → scale
 * table in docs/superpowers/plans/2026-09-27-decimals-phase1-wire-format.md.
 * Deleted in phase 2.
 */
final class WireAmounts
{
    private const ACCOUNT_AMOUNT_FIELDS = ['openingBalance', 'balance'];
    private const ACCOUNT_CASH_FIELDS = ['openingBalanceCashValue', 'costBasis', 'portfolioValue', 'imbalanceIn', 'imbalanceOut'];

    /** @param array<string, mixed> $a @return array<string, mixed> */
    public static function accountOut(array $a, ScaleRegistry $r): array
    {
        foreach (self::ACCOUNT_AMOUNT_FIELDS as $k) {
            if (isset($a[$k])) {
                $a[$k] = self::out($a[$k], $r->amountScaleFor($a), $k);
            }
        }
        foreach (self::ACCOUNT_CASH_FIELDS as $k) {
            if (isset($a[$k])) {
                $a[$k] = self::out($a[$k], $r->cashScaleFor($a), $k);
            }
        }

        return $a;
    }

    /** @param array<int, array<string, mixed>> $list @return array<int, array<string, mixed>> */
    public static function accountsOut(array $list, ScaleRegistry $r): array
    {
        return array_map(static fn (array $a) => self::accountOut($a, $r), $list);
    }

    /** @param array<string, mixed> $l @return array<string, mixed> */
    public static function lineOut(array $l, ScaleRegistry $r): array
    {
        $l['amount'] = self::out($l['amount'], $r->amountScaleFor($r->account((string) $l['accountId'])), 'amount');
        if (isset($l['cashValue'])) {
            $l['cashValue'] = self::out($l['cashValue'], $r->currencyScale($l['cashCurrency'] ?? null), 'cashValue');
        }
        if (isset($l['exchangeAmount'])) {
            $l['exchangeAmount'] = self::out($l['exchangeAmount'], $r->currencyScale($l['exchangeCurrency'] ?? null), 'exchangeAmount');
        }

        return $l;
    }

    /** @param array<int, array{transactionId: ?string, lines: array<int, array<string, mixed>>}> $records @return array<int, array<string, mixed>> */
    public static function recordsOut(array $records, ScaleRegistry $r): array
    {
        return array_map(static fn (array $rec) => [
            ...$rec,
            'lines' => array_map(static fn (array $l) => self::lineOut($l, $r), $rec['lines']),
        ], $records);
    }

    /** @param array<int, array{lineId: int, line: array<string, mixed>, account: array<string, mixed>}> $candidates @return array<int, array<string, mixed>> */
    public static function candidatesOut(array $candidates, ScaleRegistry $r): array
    {
        return array_map(static fn (array $c) => [
            ...$c,
            'line' => self::lineOut($c['line'], $r),
            'account' => self::accountOut($c['account'], $r),
        ], $candidates);
    }

    /** @param array<int, array{value: string, currency: string, amount: int}> $totals @return array<int, array<string, mixed>> */
    public static function tagTotalsOut(array $totals, ScaleRegistry $r): array
    {
        return array_map(static fn (array $t) => [
            ...$t,
            'amount' => self::out($t['amount'], $r->currencyScale($t['currency']), 'amount'),
        ], $totals);
    }

    /** @param array{byKind: array<string, int>, total: int} $usage @return array<string, mixed> */
    public static function isaUsageOut(array $usage, ScaleRegistry $r): array
    {
        $scale = $r->currencyScale('GBP');

        return [
            'byKind' => array_map(static fn ($v) => self::out($v, $scale, 'byKind'), $usage['byKind']),
            'total' => self::out($usage['total'], $scale, 'total'),
        ];
    }

    /** @param array<string, mixed> $data @return array<string, mixed> */
    public static function accountIn(array $data, ScaleRegistry $r): array
    {
        if (isset($data['openingBalance'])) {
            $data['openingBalance'] = self::in($data['openingBalance'], $r->amountScaleFor($data), 'openingBalance');
        }
        if (isset($data['openingBalanceCashValue'])) {
            $data['openingBalanceCashValue'] = self::in($data['openingBalanceCashValue'], $r->cashScaleFor($data), 'openingBalanceCashValue');
        }

        return $data;
    }

    /** @param array<string, mixed> $l @return array<string, mixed> */
    public static function lineIn(array $l, ScaleRegistry $r): array
    {
        $l['amount'] = self::in($l['amount'] ?? null, $r->amountScaleFor($r->account((string) ($l['accountId'] ?? ''))), 'amount');
        if (isset($l['cashValue'])) {
            $l['cashValue'] = self::in($l['cashValue'], $r->currencyScale($l['cashCurrency'] ?? null), 'cashValue');
        }
        if (isset($l['exchangeAmount'])) {
            $l['exchangeAmount'] = self::in($l['exchangeAmount'], $r->currencyScale($l['exchangeCurrency'] ?? null), 'exchangeAmount');
        }

        return $l;
    }

    /** @param array<int, array<string, mixed>> $ops @return array<int, array<string, mixed>> */
    public static function operationsIn(array $ops, ScaleRegistry $r): array
    {
        return array_map(static function (array $op) use ($r) {
            if ('upsertLine' === ($op['op'] ?? null) && \is_array($op['line'] ?? null)) {
                $op['line'] = self::lineIn($op['line'], $r);
            }
            if ('upsertTransaction' === ($op['op'] ?? null) && \is_array($op['lines'] ?? null)) {
                $op['lines'] = array_map(static fn (array $l) => self::lineIn($l, $r), $op['lines']);
            }

            return $op;
        }, $ops);
    }

    public static function amountIn(string $value, ?string $currency, ScaleRegistry $r): int
    {
        return ScaledAmount::fromDecimal($value, $r->currencyScale($currency));
    }

    private static function out(mixed $value, ?int $scale, string $field): string
    {
        $v = (int) $value;
        if (0 === $v) {
            return '0';
        }
        if (null === $scale) {
            throw new \LogicException(sprintf('No scale known for nonzero %s.', $field));
        }

        return ScaledAmount::toDecimal($v, $scale);
    }

    private static function in(mixed $value, ?int $scale, string $field): int
    {
        if (!\is_string($value)) {
            throw new \InvalidArgumentException(sprintf('%s must be a decimal string.', $field));
        }
        if (null === $scale) {
            throw new \InvalidArgumentException(sprintf('Can\'t determine the scale for %s.', $field));
        }

        return ScaledAmount::fromDecimal($value, $scale);
    }
}
