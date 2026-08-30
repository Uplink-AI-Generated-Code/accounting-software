<?php

namespace App\Entity;

use App\Repository\CurrencyRepository;
use Doctrine\ORM\Mapping as ORM;

/**
 * Natural-key reference entity: the currency code itself is the primary
 * key (no surrogate id), deliberately, so raw DB records stay
 * human-readable — see CLAUDE.md. `scale` is the number of decimal places
 * (2 for GBP/USD/EUR, 0 for JPY, etc.) that every amount stored against
 * this currency is scaled by.
 */
#[ORM\Entity(repositoryClass: CurrencyRepository::class)]
class Currency
{
    #[ORM\Id]
    #[ORM\Column(length: 8)]
    private string $code;

    #[ORM\Column]
    private int $scale;

    #[ORM\Column(length: 255, nullable: true)]
    private ?string $name = null;

    public function getCode(): string
    {
        return $this->code;
    }

    public function setCode(string $code): static
    {
        $this->code = $code;

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

    public function getName(): ?string
    {
        return $this->name;
    }

    public function setName(?string $name): static
    {
        $this->name = $name;

        return $this;
    }
}
