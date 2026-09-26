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
 *
 * Primary key is the pair `(ticker, tradingCurrency)`, not `ticker`
 * alone — mirroring `Tag`'s existing `(dimension, value)` composite key
 * (see CLAUDE.md's "Tags" section) — so the same ticker can exist more
 * than once, one row per trading currency it's actually traded in (e.g.
 * "AAPL" on Nasdaq in USD and "AAPL" as an LSE-listed line in GBP are two
 * separate Symbol rows). `tradingCurrency` is therefore immutable once
 * set: changing it would mean changing part of the row's own identity,
 * which is a new row, not an edit — see LedgerStateService's rescale
 * operation and the admin endpoints for what *is* editable (`name`,
 * `scale`).
 */
#[ORM\Entity(repositoryClass: SymbolRepository::class)]
class Symbol
{
    #[ORM\Id]
    #[ORM\Column(length: 32)]
    private string $ticker;

    // Part of the identity, not an ordinary field — see the class
    // docblock. Set once via setTradingCurrency() immediately after
    // construction (before the first persist()); there is deliberately
    // no way to change it on an existing row. `nullable: false` since a
    // Symbol without a trading currency has no meaningful identity.
    #[ORM\Id]
    #[ORM\ManyToOne(targetEntity: Currency::class)]
    #[ORM\JoinColumn(name: 'trading_currency', referencedColumnName: 'code', nullable: false)]
    private Currency $tradingCurrency;

    #[ORM\Column(length: 255)]
    private string $name;

    #[ORM\Column]
    private int $scale;

    public function getTicker(): string
    {
        return $this->ticker;
    }

    public function setTicker(string $ticker): static
    {
        $this->ticker = $ticker;

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
}
