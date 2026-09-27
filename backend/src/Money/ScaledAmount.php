<?php

namespace App\Money;

/**
 * Converts a legacy scaled integer to a canonical decimal string — used by
 * `LegacyIntegerAmounts` to upgrade pre-phase-2 exports. Pure string
 * manipulation — no floats, no bcmath needed for a plain shift of the
 * decimal point.
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
}
