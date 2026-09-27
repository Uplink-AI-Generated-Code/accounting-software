<?php

namespace App\Money;

/**
 * Phase 1 shim (docs/superpowers/specs/2026-09-27-arbitrary-precision-
 * decimals-design.md): storage is still scaled integers, while the API
 * speaks canonical decimal strings. Pure string manipulation — no floats,
 * no bcmath needed for a plain shift of the decimal point. Deleted in
 * phase 2, once storage itself is decimal.
 */
final class ScaledAmount
{
    public static function toDecimal(int $value, int $scale): string
    {
        if (0 === $value) {
            return '0';
        }
        $digits = (string) abs($value);
        if ($scale > 0) {
            $digits = str_pad($digits, $scale + 1, '0', \STR_PAD_LEFT);
            $whole = substr($digits, 0, -$scale);
            $frac = rtrim(substr($digits, -$scale), '0');
        } else {
            $whole = $digits;
            $frac = '';
        }

        return ($value < 0 ? '-' : '').$whole.('' !== $frac ? '.'.$frac : '');
    }

    public static function fromDecimal(string $value, int $scale): int
    {
        if (!preg_match('/^(-?)(\d+)(?:\.(\d+))?$/', $value, $m)) {
            throw new \InvalidArgumentException(sprintf('"%s" is not a decimal amount.', $value));
        }
        $frac = rtrim($m[3] ?? '', '0');
        if (\strlen($frac) > $scale) {
            throw new \InvalidArgumentException(sprintf('%s has more than %d decimal place(s), which isn\'t supported yet.', $value, $scale));
        }
        $digits = ltrim($m[2].str_pad($frac, $scale, '0'), '0');
        if ('' === $digits) {
            return 0;
        }
        if (\strlen($digits) > 18) {
            throw new \InvalidArgumentException(sprintf('%s is too large to store.', $value));
        }
        $n = (int) $digits;

        return '-' === $m[1] ? -$n : $n;
    }
}
