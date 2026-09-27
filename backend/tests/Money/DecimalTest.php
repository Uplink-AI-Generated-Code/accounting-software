<?php

namespace App\Tests\Money;

use App\Money\Decimal;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class DecimalTest extends TestCase
{
    /** @return array<string, mixed> */
    private static function fixture(): array
    {
        return json_decode((string) file_get_contents(\dirname(__DIR__, 3).'/tests/fixtures/decimal-cases.json'), true, flags: \JSON_THROW_ON_ERROR);
    }

    public static function canonicalCases(): iterable
    {
        foreach (self::fixture()['canonical'] as [$in, $out]) {
            yield $in => [$in, $out];
        }
    }

    #[DataProvider('canonicalCases')]
    public function testCanonicalMatchesSharedFixture(string $in, string $out): void
    {
        self::assertSame($out, Decimal::canonical($in));
        self::assertTrue(Decimal::isCanonical($out));
    }

    public static function invalidCases(): iterable
    {
        foreach (self::fixture()['invalid'] as $in) {
            yield json_encode($in) => [$in];
        }
    }

    #[DataProvider('invalidCases')]
    public function testInvalidMatchesSharedFixture(string $in): void
    {
        self::assertNull(Decimal::parse($in));
        $this->expectException(\InvalidArgumentException::class);
        Decimal::canonical($in);
    }

    public static function divideCases(): iterable
    {
        foreach (self::fixture()['divide'] as [$a, $b, $out]) {
            yield "$a / $b" => [$a, $b, $out];
        }
    }

    #[DataProvider('divideCases')]
    public function testDivideMatchesSharedFixture(string $a, string $b, string $out): void
    {
        self::assertSame($out, Decimal::divide($a, $b));
    }

    public static function roundCases(): iterable
    {
        foreach (self::fixture()['round'] as [$x, $places, $out]) {
            yield "$x @ $places" => [$x, $places, $out];
        }
    }

    #[DataProvider('roundCases')]
    public function testRoundMatchesSharedFixture(string $x, int $places, string $out): void
    {
        self::assertSame($out, Decimal::round($x, $places));
    }

    public function testArithmeticIsExactAndCanonical(): void
    {
        self::assertSame('0.3', Decimal::add('0.1', '0.2'));
        self::assertSame('9007199254740994', Decimal::add('9007199254740993', '1'));
        self::assertSame('0', Decimal::sub('1.5', '1.5'));
        self::assertSame('-3', Decimal::mul('1.5', '-2'));
        self::assertSame('0', Decimal::neg('0'));
        self::assertSame('2.5', Decimal::abs('-2.5'));
        self::assertSame('2.99', Decimal::min('3', '2.99'));
        self::assertSame('3', Decimal::max('3', '2.99'));
        self::assertSame('3', Decimal::sum(['1.1', '2.2', '-0.3']));
        self::assertSame('0', Decimal::sum([]));
    }

    public function testComparisons(): void
    {
        self::assertSame(-1, Decimal::cmp('2', '10'));
        self::assertSame(0, Decimal::cmp('-1', '-1'));
        self::assertSame(-1, Decimal::sign('-0.01'));
        self::assertTrue(Decimal::isZero('0'));
        self::assertSame(3, Decimal::fractionDigits('-0.125'));
        self::assertSame(0, Decimal::fractionDigits('12'));
    }

    public function testCanonicalAcceptsIntsAndRejectsNonCanonicalInIsCanonical(): void
    {
        self::assertSame('-42', Decimal::canonical(-42));
        self::assertFalse(Decimal::isCanonical('20.50'));
        self::assertFalse(Decimal::isCanonical('-0'));
        self::assertFalse(Decimal::isCanonical('+1'));
        self::assertFalse(Decimal::isCanonical('01'));
    }
}
