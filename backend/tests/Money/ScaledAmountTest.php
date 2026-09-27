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

    /** @return array<int, array{string, int, int}> */
    public static function fromDecimalCases(): array
    {
        return [
            ['20', 2, 2000],
            ['20.5', 2, 2050],
            ['20.50', 2, 2050],
            ['-0.05', 2, -5],
            ['0', 8, 0],
            ['-0', 2, 0],
            ['0.12345678', 8, 12345678],
            ['123', 0, 123],
        ];
    }

    #[DataProvider('fromDecimalCases')]
    public function testFromDecimal(string $value, int $scale, int $expected): void
    {
        self::assertSame($expected, ScaledAmount::fromDecimal($value, $scale));
    }

    /** @return array<int, array{string, int}> */
    public static function rejectedCases(): array
    {
        return [
            ['20.555', 2],   // more decimals than the scale
            ['abc', 2],
            ['1e5', 2],
            ['', 2],
            ['12345678901234567', 2], // 19 digits once scaled
        ];
    }

    #[DataProvider('rejectedCases')]
    public function testFromDecimalRejects(string $value, int $scale): void
    {
        $this->expectException(\InvalidArgumentException::class);
        ScaledAmount::fromDecimal($value, $scale);
    }
}
