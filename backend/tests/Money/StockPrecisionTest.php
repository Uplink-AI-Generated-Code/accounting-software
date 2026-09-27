<?php

namespace App\Tests\Money;

use App\Money\StockPrecision;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class StockPrecisionTest extends TestCase
{
    public static function cases(): iterable
    {
        $fixture = json_decode((string) file_get_contents(\dirname(__DIR__, 3).'/tests/fixtures/decimal-cases.json'), true, flags: \JSON_THROW_ON_ERROR);
        foreach ($fixture['stockPlaces'] as $i => $c) {
            yield "case $i" => [$c];
        }
    }

    /** @param array<string, mixed> $c */
    #[DataProvider('cases')]
    public function testMatchesSharedFixture(array $c): void
    {
        self::assertSame(
            ['money' => $c['money'], 'units' => $c['units'], 'price' => $c['price']],
            StockPrecision::places($c['cashScale'], $c['openingBalance'], $c['openingBalanceCashValue'], $c['lines']),
        );
    }
}
