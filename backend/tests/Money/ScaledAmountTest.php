<?php

namespace App\Tests\Money;

use App\Money\ScaledAmount;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class ScaledAmountTest extends TestCase
{
    /** @return array<int, array{int, int, string}> */
    public static function toDecimalCases(): array
    {
        return [
            [2000, 2, '20'],
            [2050, 2, '20.5'],
            [-5, 2, '-0.05'],
            [0, 8, '0'],
            [123, 0, '123'],
            [100000000, 8, '1'],
            [12345678, 8, '0.12345678'],
        ];
    }

    #[DataProvider('toDecimalCases')]
    public function testToDecimal(int $value, int $scale, string $expected): void
    {
        self::assertSame($expected, ScaledAmount::toDecimal($value, $scale));
    }
}
