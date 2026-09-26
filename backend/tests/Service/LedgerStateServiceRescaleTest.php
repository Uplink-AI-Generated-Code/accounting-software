<?php

namespace App\Tests\Service;

use App\Entity\Account;
use App\Entity\Currency;
use App\Entity\Line;
use App\Service\LedgerStateService;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Test\KernelTestCase;

class LedgerStateServiceRescaleTest extends KernelTestCase
{
    private EntityManagerInterface $em;
    private LedgerStateService $service;

    protected function setUp(): void
    {
        self::bootKernel();
        $this->em = self::getContainer()->get(EntityManagerInterface::class);
        $this->service = self::getContainer()->get(LedgerStateService::class);

        $conn = $this->em->getConnection();
        $conn->executeStatement('DELETE FROM line');
        $conn->executeStatement('DELETE FROM account');
        // Symbol.trading_currency is an FK into currency; a later test
        // method appended to this file (Task 3) creates Symbol rows, and
        // without clearing them here first, the next test's DELETE FROM
        // currency below would throw a foreign-key-constraint violation
        // against a leftover Symbol row. This task's own tests never
        // create a Symbol row, so this is a no-op for them.
        $conn->executeStatement('DELETE FROM symbol');
        $conn->executeStatement('DELETE FROM currency');
    }

    private function makeCurrency(string $code, int $scale): Currency
    {
        $c = (new Currency())->setCode($code)->setScale($scale);
        $this->em->persist($c);
        $this->em->flush();

        return $c;
    }

    private function makeAccount(string $id, Currency $currency, int $openingBalance): Account
    {
        $a = (new Account())->setName($id)->setType('asset')->setCurrency($currency)->setOpeningBalance($openingBalance);
        $a->setId($id);
        $this->em->persist($a);
        $this->em->flush();

        return $a;
    }

    private function makeLine(Account $account, int $amount): Line
    {
        $l = (new Line())->setAccount($account)->setAmount($amount)->setDate('2024-01-01');
        $this->em->persist($l);
        $this->em->flush();

        return $l;
    }

    public function testIncreasingScaleAlwaysSucceedsAndMultiplies(): void
    {
        $gbp = $this->makeCurrency('GBP', 2);
        $acc = $this->makeAccount('a1', $gbp, 2000);
        $this->makeLine($acc, 1500);

        $touched = $this->service->rescaleCurrency('GBP', 3);

        $this->assertSame(2, $touched);
        $this->em->clear();
        $refreshedAcc = $this->em->getRepository(Account::class)->find('a1');
        $this->assertSame(20000, $refreshedAcc->getOpeningBalance());
        $lines = $this->em->getRepository(Line::class)->findBy(['account' => $refreshedAcc]);
        $this->assertSame(15000, $lines[0]->getAmount());
        $this->assertSame(3, $this->em->getRepository(Currency::class)->find('GBP')->getScale());
    }

    public function testDecreasingScaleSucceedsWhenEverythingDividesEvenly(): void
    {
        $gbp = $this->makeCurrency('GBP', 3);
        $acc = $this->makeAccount('a1', $gbp, 20000);
        $this->makeLine($acc, 15000);

        $touched = $this->service->rescaleCurrency('GBP', 2);

        $this->assertSame(2, $touched);
        $this->em->clear();
        $this->assertSame(2000, $this->em->getRepository(Account::class)->find('a1')->getOpeningBalance());
    }

    public function testDecreasingScaleIsRefusedWhenItWouldLosePrecision(): void
    {
        $gbp = $this->makeCurrency('GBP', 3);
        $acc = $this->makeAccount('a1', $gbp, 20001); // not divisible by 10

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessageMatches('/lose precision on 1 existing amount/');
        $this->service->rescaleCurrency('GBP', 2);

        $this->em->clear();
        $this->assertSame(20001, $this->em->getRepository(Account::class)->find('a1')->getOpeningBalance(), 'refused rescale must not partially apply');
        $this->assertSame(3, $this->em->getRepository(Currency::class)->find('GBP')->getScale(), 'refused rescale must not touch the scale itself');
    }

    public function testRescalingOneCurrencyLeavesAnotherUntouched(): void
    {
        $gbp = $this->makeCurrency('GBP', 2);
        $usd = $this->makeCurrency('USD', 2);
        $gbpAcc = $this->makeAccount('gbp-acc', $gbp, 2000);
        $usdAcc = $this->makeAccount('usd-acc', $usd, 5000);

        $this->service->rescaleCurrency('GBP', 3);

        $this->em->clear();
        $this->assertSame(20000, $this->em->getRepository(Account::class)->find('gbp-acc')->getOpeningBalance());
        $this->assertSame(5000, $this->em->getRepository(Account::class)->find('usd-acc')->getOpeningBalance(), 'USD must be untouched by a GBP rescale');
    }

    private function makeSymbol(string $ticker, Currency $tradingCurrency, int $scale): \App\Entity\Symbol
    {
        $s = (new \App\Entity\Symbol())->setTicker($ticker)->setName($ticker)->setScale($scale)->setTradingCurrency($tradingCurrency);
        $this->em->persist($s);
        $this->em->flush();

        return $s;
    }

    private function makeInvestmentAccount(string $id, \App\Entity\Symbol $symbol, int $openingBalance): Account
    {
        $a = (new Account())->setName($id)->setType('investment')->setSymbol($symbol)->setOpeningBalance($openingBalance);
        $a->setId($id);
        $this->em->persist($a);
        $this->em->flush();

        return $a;
    }

    public function testRescalingASymbolOnlyTouchesThatExactTradingCurrencyVariant(): void
    {
        $usd = $this->makeCurrency('USD', 2);
        $gbp = $this->makeCurrency('GBP', 2);
        $aaplUsd = $this->makeSymbol('AAPL', $usd, 6);
        $aaplGbp = $this->makeSymbol('AAPL', $gbp, 6);
        $usdAcc = $this->makeInvestmentAccount('aapl-usd-acc', $aaplUsd, 1500000);
        $gbpAcc = $this->makeInvestmentAccount('aapl-gbp-acc', $aaplGbp, 2500000);
        $this->makeLine($usdAcc, 500000);

        $touched = $this->service->rescaleSymbol('AAPL', 'USD', 3);

        $this->assertSame(2, $touched); // usdAcc's opening balance + its one line
        $this->em->clear();
        // Scale goes 6 -> 3 (a decrease), so existing amounts are divided by 10^3, not multiplied.
        $this->assertSame(1500, $this->em->getRepository(Account::class)->find('aapl-usd-acc')->getOpeningBalance());
        $this->assertSame(2500000, $this->em->getRepository(Account::class)->find('aapl-gbp-acc')->getOpeningBalance(), 'the GBP variant of the same ticker must be untouched');
        $line = $this->em->getRepository(Line::class)->findBy(['account' => $this->em->getRepository(Account::class)->find('aapl-usd-acc')])[0];
        $this->assertSame(500, $line->getAmount());
    }

    public function testRescalingASymbolLeavesCashValueUntouched(): void
    {
        $usd = $this->makeCurrency('USD', 2);
        $aapl = $this->makeSymbol('AAPL', $usd, 6);
        $acc = $this->makeInvestmentAccount('aapl-acc', $aapl, 1000000);
        $line = $this->makeLine($acc, 500000);
        $line->setCashValue(750000);
        $this->em->persist($line);
        $this->em->flush();

        $this->service->rescaleSymbol('AAPL', 'USD', 8);

        $this->em->clear();
        $refreshed = $this->em->getRepository(Line::class)->find($line->getId());
        $this->assertSame(750000, $refreshed->getCashValue(), 'cashValue is currency-scaled, not symbol-scaled — a Symbol rescale must never touch it');
        $this->assertSame(50000000, $refreshed->getAmount());
    }
}
