<?php

namespace App\Entity;

use App\Repository\CounterpartyRepository;
use Doctrine\ORM\Mapping as ORM;

/**
 * Natural-key reference entity: the counterparty's name is the primary
 * key — same half-normalization pattern as Currency/Symbol, see
 * CLAUDE.md. Covers both meanings `Account.counterparty` can have —
 * "where a real account is held" (a bank, a broker) and "who was paid/who
 * paid" on an income/expense account — there's no structural difference
 * between the two, only which label `AccountFormModal` shows. Deliberately
 * bare today (just the name); more fields (address, phone, notes, ...) can
 * be added later with a cheap `ADD COLUMN` migration, no redesign needed.
 */
#[ORM\Entity(repositoryClass: CounterpartyRepository::class)]
class Counterparty
{
    #[ORM\Id]
    #[ORM\Column(length: 255)]
    private string $name;

    public function getName(): string
    {
        return $this->name;
    }

    public function setName(string $name): static
    {
        $this->name = $name;

        return $this;
    }
}
