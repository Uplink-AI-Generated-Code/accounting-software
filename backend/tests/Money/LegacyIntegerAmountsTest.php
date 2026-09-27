<?php

namespace App\Tests\Money;

use App\Money\LegacyIntegerAmounts;
use PHPUnit\Framework\TestCase;

class LegacyIntegerAmountsTest extends TestCase
{
    private const CURRENCIES = ['GBP' => 2, 'USD' => 2, 'JPY' => 0];
    private const SYMBOLS = ['AAPL|USD' => 6];

    private static function accounts(): array
    {
        return [
            ['id' => 'cash', 'type' => 'asset', 'currency' => 'GBP', 'openingBalance' => 2050],
            ['id' => 'inv', 'type' => 'investment', 'symbolTicker' => 'AAPL', 'symbolCurrency' => 'USD', 'openingBalance' => 1500000, 'openingBalanceCashValue' => 12345],
            ['id' => 'wrap', 'type' => 'investment-parent'],
        ];
    }

    public function testConvertsIntegerAmountsWithTheirOwnScale(): void
    {
        $out = LegacyIntegerAmounts::upgrade(self::accounts(), [
            ['transactionId' => 't1', 'lines' => [
                ['accountId' => 'cash', 'amount' => -1000, 'exchangeAmount' => 1500, 'exchangeCurrency' => 'JPY'],
                ['accountId' => 'inv', 'amount' => 250000, 'cashValue' => 999, 'cashCurrency' => 'USD'],
            ]],
        ], self::CURRENCIES, self::SYMBOLS);

        self::assertSame('20.5', $out['accounts'][0]['openingBalance']);
        self::assertSame('1.5', $out['accounts'][1]['openingBalance']);
        self::assertSame('123.45', $out['accounts'][1]['openingBalanceCashValue']);
        self::assertArrayNotHasKey('openingBalance', $out['accounts'][2]);
        [$cashLine, $invLine] = $out['records'][0]['lines'];
        self::assertSame('-10', $cashLine['amount']);
        self::assertSame('1500', $cashLine['exchangeAmount']);
        self::assertSame('0.25', $invLine['amount']);
        self::assertSame('9.99', $invLine['cashValue']);
    }

    public function testLeavesDecimalStringsAlone(): void
    {
        $out = LegacyIntegerAmounts::upgrade(
            [['id' => 'cash', 'type' => 'asset', 'currency' => 'GBP', 'openingBalance' => '20.505']],
            [['transactionId' => null, 'lines' => [['accountId' => 'cash', 'amount' => '0.001']]]],
            self::CURRENCIES,
            self::SYMBOLS,
        );
        self::assertSame('20.505', $out['accounts'][0]['openingBalance']);
        self::assertSame('0.001', $out['records'][0]['lines'][0]['amount']);
    }

    public function testRejectsFloats(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        LegacyIntegerAmounts::upgrade([['id' => 'cash', 'type' => 'asset', 'currency' => 'GBP', 'openingBalance' => 20.5]], [], self::CURRENCIES, self::SYMBOLS);
    }

    public function testRejectsNonzeroIntegerWithUnknownScale(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        LegacyIntegerAmounts::upgrade([], [['transactionId' => null, 'lines' => [['accountId' => 'missing', 'amount' => 5]]]], self::CURRENCIES, self::SYMBOLS);
    }

    public function testZeroNeedsNoScale(): void
    {
        $out = LegacyIntegerAmounts::upgrade([['id' => 'wrap', 'type' => 'investment-parent', 'openingBalance' => 0]], [], self::CURRENCIES, self::SYMBOLS);
        self::assertSame('0', $out['accounts'][0]['openingBalance']);
    }
}
