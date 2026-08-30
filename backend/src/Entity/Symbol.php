<?php

namespace App\Entity;

use App\Repository\SymbolRepository;
use Doctrine\ORM\Mapping as ORM;

/**
 * Natural-key reference entity: the ticker itself is the primary key —
 * same half-normalization pattern as Currency, see CLAUDE.md. `scale` is
 * the unit precision for this security (how many decimal places a
 * fractional share is tracked to) — NOT a currency scale. `tradingCurrency`
 * is here rather than on Account because a given ticker always trades in
 * one currency; an investment Account's own `currency` field is unused
 * once it has a `symbol` — see Account.php's docblock.
 */
#[ORM\Entity(repositoryClass: SymbolRepository::class)]
class Symbol
{
    #[ORM\Id]
    #[ORM\Column(length: 32)]
    private string $ticker;

    #[ORM\Column(length: 255)]
    private string $name;

    #[ORM\Column]
    private int $scale;

    #[ORM\ManyToOne(targetEntity: Currency::class)]
    #[ORM\JoinColumn(name: 'trading_currency', referencedColumnName: 'code', nullable: false)]
    private Currency $tradingCurrency;

    public function getTicker(): string
    {
        return $this->ticker;
    }

    public function setTicker(string $ticker): static
    {
        $this->ticker = $ticker;

        return $this;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function setName(string $name): static
    {
        $this->name = $name;

        return $this;
    }

    public function getScale(): int
    {
        return $this->scale;
    }

    public function setScale(int $scale): static
    {
        $this->scale = $scale;

        return $this;
    }

    public function getTradingCurrency(): Currency
    {
        return $this->tradingCurrency;
    }

    public function setTradingCurrency(Currency $tradingCurrency): static
    {
        $this->tradingCurrency = $tradingCurrency;

        return $this;
    }
}
