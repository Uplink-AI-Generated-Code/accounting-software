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
 *
 * `amount`/`cashValue`/`exchangeAmount` are integers scaled by a currency's
 * (or, for units on an investment account, a symbol's) `scale` — never
 * floats, to avoid floating-point drift; see CLAUDE.md. `cashCurrency`/
 * `exchangeCurrency` are FKs to the Currency entity rather than free
 * strings.
 *
 * `transaction` is nullable: an unpaired/unmatched entry is a standalone
 * Line with no Transaction at all, not a fake one-line Transaction. A
 * `Transaction` exists strictly to link 2+ lines together — see
 * CLAUDE.md's "Data model" section. `id` is exposed to the frontend (via
 * LedgerStateService::lineToArray()) specifically so a standalone line has
 * something stable to be addressed by, the way a linked entry uses its
 * Transaction's id — unlike Account/Transaction ids (frontend-generated
 * strings), Line ids are backend-assigned integers, since a line is never
 * created client-side without a round trip anyway (writes aren't
 * optimistic here — see "Backend" in CLAUDE.md).
 */
#[ORM\Entity(repositoryClass: LineRepository::class)]
class Line
{
    #[ORM\Id]
    #[ORM\GeneratedValue]
    #[ORM\Column]
    private ?int $id = null;

    #[ORM\ManyToOne(targetEntity: Transaction::class, inversedBy: 'lines')]
    #[ORM\JoinColumn(nullable: true, onDelete: 'CASCADE')]
    private ?Transaction $transaction = null;

    #[ORM\ManyToOne(targetEntity: Account::class)]
    #[ORM\JoinColumn(nullable: false, onDelete: 'CASCADE')]
    private Account $account;

    #[ORM\Column]
    private int $amount;

    #[ORM\Column(length: 10)]
    private string $date;

    #[ORM\Column(length: 255)]
    private string $description = '';

    #[ORM\Column(nullable: true)]
    private ?int $lineOrder = null;

    #[ORM\Column(nullable: true)]
    private ?int $cashValue = null;

    #[ORM\ManyToOne(targetEntity: Currency::class)]
    #[ORM\JoinColumn(name: 'cash_currency', referencedColumnName: 'code', nullable: true)]
    private ?Currency $cashCurrency = null;

    #[ORM\Column(nullable: true)]
    private ?int $exchangeAmount = null;

    #[ORM\ManyToOne(targetEntity: Currency::class)]
    #[ORM\JoinColumn(name: 'exchange_currency', referencedColumnName: 'code', nullable: true)]
    private ?Currency $exchangeCurrency = null;

    public function getId(): ?int
    {
        return $this->id;
    }

    public function getTransaction(): ?Transaction
    {
        return $this->transaction;
    }

    public function setTransaction(?Transaction $transaction): static
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

    public function getAmount(): int
    {
        return $this->amount;
    }

    public function setAmount(int $amount): static
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

    public function getCashValue(): ?int
    {
        return $this->cashValue;
    }

    public function setCashValue(?int $cashValue): static
    {
        $this->cashValue = $cashValue;

        return $this;
    }

    public function getCashCurrency(): ?Currency
    {
        return $this->cashCurrency;
    }

    public function setCashCurrency(?Currency $cashCurrency): static
    {
        $this->cashCurrency = $cashCurrency;

        return $this;
    }

    public function getExchangeAmount(): ?int
    {
        return $this->exchangeAmount;
    }

    public function setExchangeAmount(?int $exchangeAmount): static
    {
        $this->exchangeAmount = $exchangeAmount;

        return $this;
    }

    public function getExchangeCurrency(): ?Currency
    {
        return $this->exchangeCurrency;
    }

    public function setExchangeCurrency(?Currency $exchangeCurrency): static
    {
        $this->exchangeCurrency = $exchangeCurrency;

        return $this;
    }
}
