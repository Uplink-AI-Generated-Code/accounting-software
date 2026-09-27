<?php

namespace App\Tests\Money;

use App\Money\ScaleRegistry;
use App\Money\WireAmounts;
use PHPUnit\Framework\TestCase;

class WireAmountsTest extends TestCase
{
    private ScaleRegistry $r;

    protected function setUp(): void
    {
        $this->r = new ScaleRegistry(
            ['GBP' => 2, 'USD' => 2, 'JPY' => 0, 'BTC' => 8],
            ['AAPL|USD' => 6],
            [
                'cash' => ['type' => 'asset', 'currency' => 'GBP', 'symbolTicker' => null, 'symbolCurrency' => null],
                'inv' => ['type' => 'investment', 'currency' => null, 'symbolTicker' => 'AAPL', 'symbolCurrency' => 'USD'],
                'wrap' => ['type' => 'investment-parent', 'currency' => null, 'symbolTicker' => null, 'symbolCurrency' => null],
            ],
        );
    }

    public function testCashAccountOut(): void
    {
        $out = WireAmounts::accountOut(
            ['id' => 'cash', 'type' => 'asset', 'currency' => 'GBP', 'openingBalance' => 2050, 'balance' => -5, 'entryCount' => 3, 'imbalancedLineCount' => 1, 'imbalanceIn' => 100, 'imbalanceOut' => 0],
            $this->r,
        );
        self::assertSame('20.5', $out['openingBalance']);
        self::assertSame('-0.05', $out['balance']);
        self::assertSame('1', $out['imbalanceIn']);
        self::assertSame('0', $out['imbalanceOut']);
        self::assertSame(3, $out['entryCount']);
        self::assertSame(1, $out['imbalancedLineCount']);
    }

    public function testInvestmentAccountOut(): void
    {
        $out = WireAmounts::accountOut(
            ['id' => 'inv', 'type' => 'investment', 'symbolTicker' => 'AAPL', 'symbolCurrency' => 'USD', 'openingBalance' => 1500000, 'openingBalanceCashValue' => 100, 'balance' => 2500000, 'costBasis' => 12345, 'portfolioValue' => 20000],
            $this->r,
        );
        self::assertSame('1.5', $out['openingBalance']);
        self::assertSame('1', $out['openingBalanceCashValue']);
        self::assertSame('2.5', $out['balance']);
        self::assertSame('123.45', $out['costBasis']);
        self::assertSame('200', $out['portfolioValue']);
    }

    public function testWrapperZeroBalanceNeedsNoScale(): void
    {
        $out = WireAmounts::accountOut(['id' => 'wrap', 'type' => 'investment-parent', 'balance' => 0], $this->r);
        self::assertSame('0', $out['balance']);
    }

    public function testLineOut(): void
    {
        $out = WireAmounts::lineOut(
            ['id' => 7, 'accountId' => 'inv', 'amount' => -250000, 'date' => '2025-05-01', 'description' => 'Sell', 'cashValue' => -9999, 'cashCurrency' => 'USD'],
            $this->r,
        );
        self::assertSame('-0.25', $out['amount']);
        self::assertSame('-99.99', $out['cashValue']);

        $fx = WireAmounts::lineOut(
            ['id' => 8, 'accountId' => 'cash', 'amount' => -1000, 'date' => '2025-05-01', 'description' => 'FX', 'exchangeAmount' => 1500, 'exchangeCurrency' => 'JPY'],
            $this->r,
        );
        self::assertSame('-10', $fx['amount']);
        self::assertSame('1500', $fx['exchangeAmount']);
    }

    public function testRecordsAndCandidatesOut(): void
    {
        $records = WireAmounts::recordsOut(
            [['transactionId' => null, 'lines' => [['id' => 1, 'accountId' => 'cash', 'amount' => 199, 'date' => '2025-05-01', 'description' => '']]]],
            $this->r,
        );
        self::assertSame('1.99', $records[0]['lines'][0]['amount']);

        $candidates = WireAmounts::candidatesOut(
            [['lineId' => 1, 'line' => ['id' => 1, 'accountId' => 'cash', 'amount' => 199, 'date' => '2025-05-01', 'description' => ''], 'account' => ['id' => 'cash', 'type' => 'asset', 'currency' => 'GBP', 'openingBalance' => 0]]],
            $this->r,
        );
        self::assertSame('1.99', $candidates[0]['line']['amount']);
        self::assertSame('0', $candidates[0]['account']['openingBalance']);
    }

    public function testTagTotalsAndIsaOut(): void
    {
        self::assertSame(
            [['value' => 'X', 'currency' => 'BTC', 'amount' => '0.5']],
            WireAmounts::tagTotalsOut([['value' => 'X', 'currency' => 'BTC', 'amount' => 50000000]], $this->r),
        );
        self::assertSame(
            ['byKind' => ['cash-isa' => '100'], 'total' => '100'],
            WireAmounts::isaUsageOut(['byKind' => ['cash-isa' => 10000], 'total' => 10000], $this->r),
        );
        self::assertSame(
            ['byKind' => [], 'total' => '0'],
            WireAmounts::isaUsageOut(['byKind' => [], 'total' => 0], $this->r),
        );
    }

    public function testAccountIn(): void
    {
        $cash = WireAmounts::accountIn(['type' => 'asset', 'currency' => 'GBP', 'openingBalance' => '20.5'], $this->r);
        self::assertSame(2050, $cash['openingBalance']);

        $inv = WireAmounts::accountIn(['type' => 'investment', 'symbolTicker' => 'AAPL', 'symbolCurrency' => 'USD', 'openingBalance' => '1.5', 'openingBalanceCashValue' => '100'], $this->r);
        self::assertSame(1500000, $inv['openingBalance']);
        self::assertSame(10000, $inv['openingBalanceCashValue']);

        $wrap = WireAmounts::accountIn(['type' => 'investment-parent', 'name' => 'W'], $this->r);
        self::assertArrayNotHasKey('openingBalance', $wrap);
    }

    public function testAccountInRejectsIntegers(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        WireAmounts::accountIn(['type' => 'asset', 'currency' => 'GBP', 'openingBalance' => 2050], $this->r);
    }

    public function testOperationsIn(): void
    {
        $ops = WireAmounts::operationsIn([
            ['op' => 'upsertLine', 'lineId' => 3, 'line' => ['accountId' => 'cash', 'amount' => '-12.3', 'date' => '2025-05-01', 'description' => '']],
            ['op' => 'upsertTransaction', 'transactionId' => 't1', 'lines' => [
                ['accountId' => 'cash', 'amount' => '-100', 'date' => '2025-05-01', 'description' => ''],
                ['accountId' => 'inv', 'amount' => '0.5', 'date' => '2025-05-01', 'description' => '', 'cashValue' => '100', 'cashCurrency' => 'USD'],
            ]],
            ['op' => 'deleteLine', 'lineId' => 9],
        ], $this->r);

        self::assertSame(-1230, $ops[0]['line']['amount']);
        self::assertSame(-10000, $ops[1]['lines'][0]['amount']);
        self::assertSame(500000, $ops[1]['lines'][1]['amount']);
        self::assertSame(10000, $ops[1]['lines'][1]['cashValue']);
        self::assertSame(['op' => 'deleteLine', 'lineId' => 9], $ops[2]);
    }

    public function testLineInRejectsExcessPrecisionAndUnknownAccounts(): void
    {
        try {
            WireAmounts::lineIn(['accountId' => 'cash', 'amount' => '1.234'], $this->r);
            self::fail('Expected excess precision to be rejected');
        } catch (\InvalidArgumentException) {
        }
        $this->expectException(\InvalidArgumentException::class);
        WireAmounts::lineIn(['accountId' => 'nope', 'amount' => '1'], $this->r);
    }

    public function testAmountIn(): void
    {
        self::assertSame(-1230, WireAmounts::amountIn('-12.3', 'GBP', $this->r));
    }
}
