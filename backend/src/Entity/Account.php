<?php

namespace App\Entity;

use App\Repository\AccountRepository;
use Doctrine\ORM\Mapping as ORM;

/**
 * One row per ledger account. `id` is provided by the frontend (it already
 * generates its own ids client-side with uid()) rather than DB-generated,
 * so re-saving the same account keeps the same id transactions' lines
 * reference.
 *
 * `isaParentId` is kept as a plain string, not a mapped association: the
 * frontend already resolves the parent by scanning the account list itself
 * (see institutionOf() in lib/grouping.js), and a bulk replace-on-save
 * doesn't need relational integrity here.
 */
#[ORM\Entity(repositoryClass: AccountRepository::class)]
class Account
{
    #[ORM\Id]
    #[ORM\Column(length: 32)]
    private string $id;

    #[ORM\Column(length: 255)]
    private string $name;

    #[ORM\Column(length: 32)]
    private string $type;

    #[ORM\Column(length: 8, nullable: true)]
    private ?string $currency = null;

    #[ORM\Column(nullable: true)]
    private ?float $openingBalance = null;

    #[ORM\Column(length: 32, nullable: true)]
    private ?string $symbol = null;

    #[ORM\Column(length: 255, nullable: true)]
    private ?string $institution = null;

    #[ORM\Column(length: 32, nullable: true)]
    private ?string $isaKind = null;

    #[ORM\Column(length: 32, nullable: true)]
    private ?string $isaParentId = null;

    #[ORM\Column(nullable: true)]
    private ?bool $flexible = null;

    public function getId(): string
    {
        return $this->id;
    }

    public function setId(string $id): static
    {
        $this->id = $id;

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

    public function getType(): string
    {
        return $this->type;
    }

    public function setType(string $type): static
    {
        $this->type = $type;

        return $this;
    }

    public function getCurrency(): ?string
    {
        return $this->currency;
    }

    public function setCurrency(?string $currency): static
    {
        $this->currency = $currency;

        return $this;
    }

    public function getOpeningBalance(): ?float
    {
        return $this->openingBalance;
    }

    public function setOpeningBalance(?float $openingBalance): static
    {
        $this->openingBalance = $openingBalance;

        return $this;
    }

    public function getSymbol(): ?string
    {
        return $this->symbol;
    }

    public function setSymbol(?string $symbol): static
    {
        $this->symbol = $symbol;

        return $this;
    }

    public function getInstitution(): ?string
    {
        return $this->institution;
    }

    public function setInstitution(?string $institution): static
    {
        $this->institution = $institution;

        return $this;
    }

    public function getIsaKind(): ?string
    {
        return $this->isaKind;
    }

    public function setIsaKind(?string $isaKind): static
    {
        $this->isaKind = $isaKind;

        return $this;
    }

    public function getIsaParentId(): ?string
    {
        return $this->isaParentId;
    }

    public function setIsaParentId(?string $isaParentId): static
    {
        $this->isaParentId = $isaParentId;

        return $this;
    }

    public function isFlexible(): ?bool
    {
        return $this->flexible;
    }

    public function setFlexible(?bool $flexible): static
    {
        $this->flexible = $flexible;

        return $this;
    }
}
