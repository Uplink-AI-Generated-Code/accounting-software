<?php

namespace App\Entity;

use App\Repository\LineRepository;
use Doctrine\ORM\Mapping as ORM;

/**
 * `date` is stored as a plain 'YYYY-MM-DD' string, not a Doctrine date
 * type: the frontend does its own lexicographic string comparisons on
 * dates everywhere (see lib/format.js, lib/grouping.js), so storing
 * anything that needs DateTime round-tripping would just add conversion
 * points for no benefit — ISO dates sort correctly as strings too.
 *
 * `order`, `cashValue`, `cashCurrency`, `exchangeAmount`, `exchangeCurrency`
 * are all nullable and omitted from the JSON entirely when null/absent —
 * see CLAUDE.md's data model section for what each mirrored-sign field
 * means.
 */
#[ORM\Entity(repositoryClass: LineRepository::class)]
class Line
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\ManyToOne(targetEntity: Transaction::class, inversedBy: 'lines')]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private Transaction $transaction;

    #[ORM\ManyToOne(targetEntity: Account::class)]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private Account $account;

    #[ORM\Column]
    private float $amount;

    #[ORM\Column(length: 10)]
    private string $date;

    #[ORM\Column(length: 255)]
    private string $description = '';

    #[ORM\Column(nullable: true)]
    private ?int $lineOrder = null;

    #[ORM\Column(nullable: true)]
    private ?float $cashValue = null;

    #[ORM\Column(length: 8, nullable: true)]
    private ?string $cashCurrency = null;

    #[ORM\Column(nullable: true)]
    private ?float $exchangeAmount = null;

    #[ORM\Column(length: 8, nullable: true)]
    private ?string $exchangeCurrency = null;

    public function getId(): ?int
    {
        return $this->id;
    }

    public function getTransaction(): Transaction
    {
        return $this->transaction;
    }

    public function setTransaction(Transaction $transaction): static
    {
        $this->transaction = $transaction;

        return $this;
    }

    public function getAccount(): Account
    {
        return $this->account;
    }

    public function setAccount(Account $account): static
    {
        $this->account = $account;

        return $this;
    }

    public function getAmount(): float
    {
        return $this->amount;
    }

    public function setAmount(float $amount): static
    {
        $this->amount = $amount;

        return $this;
    }

    public function getDate(): string
    {
        return $this->date;
    }

    public function setDate(string $date): static
    {
        $this->date = $date;

        return $this;
    }

    public function getDescription(): string
    {
        return $this->description;
    }

    public function setDescription(string $description): static
    {
        $this->description = $description;

        return $this;
    }

    public function getLineOrder(): ?int
    {
        return $this->lineOrder;
    }

    public function setLineOrder(?int $lineOrder): static
    {
        $this->lineOrder = $lineOrder;

        return $this;
    }

    public function getCashValue(): ?float
    {
        return $this->cashValue;
    }

    public function setCashValue(?float $cashValue): static
    {
        $this->cashValue = $cashValue;

        return $this;
    }

    public function getCashCurrency(): ?string
    {
        return $this->cashCurrency;
    }

    public function setCashCurrency(?string $cashCurrency): static
    {
        $this->cashCurrency = $cashCurrency;

        return $this;
    }

    public function getExchangeAmount(): ?float
    {
        return $this->exchangeAmount;
    }

    public function setExchangeAmount(?float $exchangeAmount): static
    {
        $this->exchangeAmount = $exchangeAmount;

        return $this;
    }

    public function getExchangeCurrency(): ?string
    {
        return $this->exchangeCurrency;
    }

    public function setExchangeCurrency(?string $exchangeCurrency): static
    {
        $this->exchangeCurrency = $exchangeCurrency;

        return $this;
    }
}
