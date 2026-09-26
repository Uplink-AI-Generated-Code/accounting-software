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
}
