<?php

namespace App\Money;

/**
 * Adaptive precision for a stock account's computed values — mirrors
 * src/lib/stockMath.js's stockPlaces() exactly; both are pinned by the
 * "stockPlaces" cases in tests/fixtures/decimal-cases.json. money: the
 * most decimals any of the account's cash inputs used, never fewer than
 * the trading currency's scale; units: the most decimals any unit amount
 * used; price: money + units.
 */
final class StockPrecision
{
    /**
     * @param iterable<array{amount: string, cashValue: ?string}> $lines
     *
     * @return array{money: int, units: int, price: int}
     */
    public static function places(int $cashScale, ?string $openingUnits, ?string $openingCash, iterable $lines): array
    {
        $money = $cashScale;
        $units = 0;
        if (null !== $openingCash) {
            $money = max($money, Decimal::fractionDigits($openingCash));
        }
        if (null !== $openingUnits) {
            $units = max($units, Decimal::fractionDigits($openingUnits));
        }
        foreach ($lines as $l) {
            $units = max($units, Decimal::fractionDigits($l['amount']));
            if (null !== ($l['cashValue'] ?? null)) {
                $money = max($money, Decimal::fractionDigits($l['cashValue']));
            }
        }

        return ['money' => $money, 'units' => $units, 'price' => $money + $units];
    }
}
