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
 * (see counterpartyOf() in lib/grouping.js), and a bulk replace-on-save
 * doesn't need relational integrity here.
 *
 * `currency`/`symbol`/`counterparty` are FKs to natural-key reference
 * entities (Currency/Symbol/Counterparty) rather than free strings — see
 * CLAUDE.md's "half-normalization" note. `Counterparty` covers both
 * meanings this field can have — "where this account is held" for a real
 * account, "who was paid/who paid" for an income/expense one — the UI
 * labels the field "Institution" or "Counterparty" depending on `type`,
 * but it's one column, one entity, either way. `openingBalance` is stored
 * as an integer scaled by the account's currency's `scale` (or, for an
 * investment account, its symbol's `scale`) — never a float, to avoid
 * floating-point drift; see CLAUDE.md. For an investment account (one with
 * a `symbol` set), `currency` is unused/left null: trading currency is
 * derived via `symbol.tradingCurrency` instead of being stored twice.
 * `openingBalanceCashValue` only ever means something alongside a nonzero
 * `openingBalance` on an investment account: the cost basis tied to that
 * opening unit count, the same pairing `Line.cashValue` has with
 * `Line.amount` on a trade — see LedgerStateService::stockStatsFor(),
 * which seeds its cost/value walk from these two fields instead of
 * starting at zero. Unused for every other account type. Populated by
 * `app:new-year` when carrying an investment account's closing position
 * into a fresh tax year's database; never surfaced in AccountFormModal.
 *
 * `subtype` is a free-text product-type tag (e.g. "Credit Card", "Loan",
 * "Trading") — a fourth grouping dimension alongside type/counterparty/
 * currency, for when counterparty alone doesn't distinguish enough
 * accounts apart (e.g. several credit products at the same bank, or
 * several loan accounts with no real counterparty at all). Deliberately a
 * plain string column, not a reference entity like Currency/Symbol/
 * Counterparty — nothing else references it, so there's no half-
 * normalization benefit to a separate table, just a free-text field with
 * the same UX as counterparty's datalist-backed input.
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

    #[ORM\ManyToOne(targetEntity: Currency::class)]
    #[ORM\JoinColumn(name: 'currency', referencedColumnName: 'code', nullable: true)]
    private ?Currency $currency = null;

    #[ORM\Column(nullable: true)]
    private ?int $openingBalance = null;

    #[ORM\Column(nullable: true)]
    private ?int $openingBalanceCashValue = null;

    #[ORM\ManyToOne(targetEntity: Symbol::class)]
    #[ORM\JoinColumn(name: 'symbol', referencedColumnName: 'ticker', nullable: true)]
    private ?Symbol $symbol = null;

    #[ORM\ManyToOne(targetEntity: Counterparty::class)]
    #[ORM\JoinColumn(name: 'counterparty', referencedColumnName: 'name', nullable: true)]
    private ?Counterparty $counterparty = null;

    #[ORM\Column(length: 255, nullable: true)]
    private ?string $subtype = null;

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

    public function getCurrency(): ?Currency
    {
        return $this->currency;
    }

    public function setCurrency(?Currency $currency): static
    {
        $this->currency = $currency;

        return $this;
    }

    public function getOpeningBalance(): ?int
    {
        return $this->openingBalance;
    }

    public function setOpeningBalance(?int $openingBalance): static
    {
        $this->openingBalance = $openingBalance;

        return $this;
    }

    public function getOpeningBalanceCashValue(): ?int
    {
        return $this->openingBalanceCashValue;
    }

    public function setOpeningBalanceCashValue(?int $openingBalanceCashValue): static
    {
        $this->openingBalanceCashValue = $openingBalanceCashValue;

        return $this;
    }

    public function getSymbol(): ?Symbol
    {
        return $this->symbol;
    }

    public function setSymbol(?Symbol $symbol): static
    {
        $this->symbol = $symbol;

        return $this;
    }

    public function getCounterparty(): ?Counterparty
    {
        return $this->counterparty;
    }

    public function setCounterparty(?Counterparty $counterparty): static
    {
        $this->counterparty = $counterparty;

        return $this;
    }

    public function getSubtype(): ?string
    {
        return $this->subtype;
    }

    public function setSubtype(?string $subtype): static
    {
        $this->subtype = $subtype;

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
