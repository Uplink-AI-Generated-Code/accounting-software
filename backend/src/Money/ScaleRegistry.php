<?php

namespace App\Money;

use App\Entity\Account;
use App\Entity\Currency;
use App\Entity\Symbol;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Phase 1 shim: every scale WireAmounts needs, looked up once per request
 * from the reference data. Plain arrays in the constructor so tests can
 * build one by hand. Deleted in phase 2 along with WireAmounts.
 */
final class ScaleRegistry
{
    /**
     * @param array<string, int> $currencyScales code => scale
     * @param array<string, int> $symbolScales   "TICKER|CUR" => scale
     * @param array<string, array{type: string, currency: ?string, symbolTicker: ?string, symbolCurrency: ?string}> $accounts
     */
    public function __construct(
        private readonly array $currencyScales,
        private readonly array $symbolScales,
        private readonly array $accounts,
    ) {
    }

    public static function fromEntityManager(EntityManagerInterface $em): self
    {
        $currencies = [];
        foreach ($em->getRepository(Currency::class)->findAll() as $c) {
            $currencies[$c->getCode()] = $c->getScale();
        }
        $symbols = [];
        foreach ($em->getRepository(Symbol::class)->findAll() as $s) {
            $symbols[$s->getTicker().'|'.$s->getTradingCurrency()->getCode()] = $s->getScale();
        }
        $accounts = [];
        foreach ($em->getRepository(Account::class)->findAll() as $a) {
            $accounts[$a->getId()] = [
                'type' => $a->getType(),
                'currency' => $a->getCurrency()?->getCode(),
                'symbolTicker' => $a->getSymbol()?->getTicker(),
                'symbolCurrency' => $a->getSymbol()?->getTradingCurrency()->getCode(),
            ];
        }

        return new self($currencies, $symbols, $accounts);
    }

    public function currencyScale(?string $code): int
    {
        if (null === $code || !isset($this->currencyScales[$code])) {
            throw new \InvalidArgumentException(sprintf('Unknown currency "%s".', $code ?? ''));
        }

        return $this->currencyScales[$code];
    }

    /** @param array<string, mixed> $account an account array or an account PUT payload */
    public function amountScaleFor(array $account): ?int
    {
        if ('investment' === ($account['type'] ?? null)) {
            $key = ($account['symbolTicker'] ?? '').'|'.($account['symbolCurrency'] ?? '');
            if (!isset($this->symbolScales[$key])) {
                throw new \InvalidArgumentException(sprintf('Unknown symbol "%s".', $key));
            }

            return $this->symbolScales[$key];
        }

        return isset($account['currency']) ? $this->currencyScale($account['currency']) : null;
    }

    /** @param array<string, mixed> $account */
    public function cashScaleFor(array $account): ?int
    {
        $code = 'investment' === ($account['type'] ?? null) ? ($account['symbolCurrency'] ?? null) : ($account['currency'] ?? null);

        return null === $code ? null : $this->currencyScale($code);
    }

    /** @return array{type: string, currency: ?string, symbolTicker: ?string, symbolCurrency: ?string} */
    public function account(string $id): array
    {
        if (!isset($this->accounts[$id])) {
            throw new \InvalidArgumentException(sprintf('Unknown account "%s".', $id));
        }

        return $this->accounts[$id];
    }
}
