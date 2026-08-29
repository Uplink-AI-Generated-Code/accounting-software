<?php

namespace App\Entity;

use App\Repository\TransactionRepository;
use Doctrine\Common\Collections\ArrayCollection;
use Doctrine\Common\Collections\Collection;
use Doctrine\ORM\Mapping as ORM;

/**
 * A transaction is just a bag of lines — no transaction-level date or
 * description (see CLAUDE.md: that was a deliberate fix for a real bug).
 * `id` is frontend-provided, same reasoning as Account.
 *
 * Table is explicitly named "transactions", not the default "transaction"
 * — the singular is a reserved word in SQLite, which breaks ORM-generated
 * (unquoted) INSERT/DELETE statements even though DBAL's own DDL happens
 * to auto-quote it.
 */
#[ORM\Entity(repositoryClass: TransactionRepository::class)]
#[ORM\Table(name: 'transactions')]
class Transaction
{
    #[ORM\Id]
    #[ORM\Column(length: 32)]
    private string $id;

    /** @var Collection<int, Line> */
    #[ORM\OneToMany(targetEntity: Line::class, mappedBy: 'transaction', cascade: ['persist', 'remove'], orphanRemoval: true)]
    private Collection $lines;

    public function __construct()
    {
        $this->lines = new ArrayCollection();
    }

    public function getId(): string
    {
        return $this->id;
    }

    public function setId(string $id): static
    {
        $this->id = $id;

        return $this;
    }

    /** @return Collection<int, Line> */
    public function getLines(): Collection
    {
        return $this->lines;
    }

    public function addLine(Line $line): static
    {
        if (!$this->lines->contains($line)) {
            $this->lines->add($line);
            $line->setTransaction($this);
        }

        return $this;
    }

    public function removeLine(Line $line): static
    {
        $this->lines->removeElement($line);

        return $this;
    }
}
