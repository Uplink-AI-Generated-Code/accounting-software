<?php

namespace App\Money;

use BcMath\Number;

/**
 * The backend's decimal core — mirrors src/lib/decimal.js function for
 * function, and both are pinned to tests/fixtures/decimal-cases.json.
 * Every public method takes and returns *canonical* decimal strings (no
 * "+", no leading zeros, no trailing fractional zeros, never "-0"), so
 * string equality is numeric equality. BcMath\Number does the arithmetic;
 * it never escapes this class — its own string form keeps trailing zeros
 * ("41.0"), which is exactly why callers get canonical strings instead.
 */
final class Decimal
{
    public const DIVISION_PLACES = 20;

    private const CANONICAL_RE = '/^-?(0|[1-9]\d*)(\.\d*[1-9])?$/';

    /** Lenient input (user or JSON text) → canonical, or null if it isn't a plain decimal. */
    public static function parse(string $input): ?string
    {
        $s = trim($input);
        if (!preg_match('/^([+-]?)(\d*)(?:\.(\d*))?$/', $s, $m) || ('' === $m[2] && '' === ($m[3] ?? ''))) {
            return null;
        }
        $int = ltrim($m[2], '0');
        $frac = rtrim($m[3] ?? '', '0');
        $body = ('' === $int ? '0' : $int).('' !== $frac ? '.'.$frac : '');

        return ('-' === $m[1] && '0' !== $body) ? '-'.$body : $body;
    }

    public static function canonical(string|int $x): string
    {
        if (\is_int($x)) {
            return (string) $x;
        }
        $c = self::parse($x);
        if (null === $c) {
            throw new \InvalidArgumentException(sprintf('"%s" is not a decimal amount.', $x));
        }

        return $c;
    }

    public static function isCanonical(string $x): bool
    {
        return '-0' !== $x && 1 === preg_match(self::CANONICAL_RE, $x);
    }

    public static function add(string $a, string $b): string
    {
        return self::out(new Number($a) + new Number($b));
    }

    public static function sub(string $a, string $b): string
    {
        return self::out(new Number($a) - new Number($b));
    }

    public static function mul(string $a, string $b): string
    {
        return self::out(new Number($a) * new Number($b));
    }

    public static function neg(string $a): string
    {
        return self::out(-new Number($a));
    }

    public static function abs(string $a): string
    {
        return self::sign($a) < 0 ? self::neg($a) : $a;
    }

    public static function min(string $a, string $b): string
    {
        return self::cmp($a, $b) <= 0 ? $a : $b;
    }

    public static function max(string $a, string $b): string
    {
        return self::cmp($a, $b) >= 0 ? $a : $b;
    }

    /** @param iterable<string> $xs */
    public static function sum(iterable $xs): string
    {
        $total = '0';
        foreach ($xs as $x) {
            $total = self::add($total, $x);
        }

        return $total;
    }

    /**
     * The ONLY division of amounts in the backend — keeping every division
     * behind this one method is what keeps a future switch to exact
     * fractions cheap (see the spec). 20 dp, half away from zero; a zero
     * divisor yields "0". Number::div() truncates, so divide one extra
     * place and round that away — truncation can't move a value across
     * the half-way point of the 20th place.
     */
    public static function divide(string $a, string $b): string
    {
        if (self::isZero($b)) {
            return '0';
        }

        return self::out((new Number($a))->div($b, self::DIVISION_PLACES + 1)->round(self::DIVISION_PLACES, \RoundingMode::HalfAwayFromZero));
    }

    public static function round(string $x, int $places): string
    {
        return self::out((new Number($x))->round($places, \RoundingMode::HalfAwayFromZero));
    }

    public static function cmp(string $a, string $b): int
    {
        return (new Number($a))->compare($b);
    }

    public static function sign(string $x): int
    {
        return self::cmp($x, '0');
    }

    public static function isZero(string $x): bool
    {
        return 0 === self::sign($x);
    }

    public static function fractionDigits(string $x): int
    {
        $i = strpos($x, '.');

        return false === $i ? 0 : \strlen($x) - $i - 1;
    }

    private static function out(Number $n): string
    {
        $s = self::parse((string) $n);
        if (null === $s) {
            // Number's own string form is always a plain decimal (it never
            // emits "+", exponents, etc.), so parse() failing here means
            // something is badly wrong — silently returning "0" would turn
            // that bug into a wrong money value instead of a loud failure.
            throw new \LogicException(sprintf('BcMath\Number produced a non-decimal string: "%s".', (string) $n));
        }

        return $s;
    }
}
