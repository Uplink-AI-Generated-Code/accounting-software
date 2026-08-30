<?php

namespace App\Entity;

use App\Repository\InstitutionRepository;
use Doctrine\ORM\Mapping as ORM;

/**
 * Natural-key reference entity: the institution's name is the primary
 * key — same half-normalization pattern as Currency/Symbol, see
 * CLAUDE.md. Deliberately bare today (just the name); more fields
 * (address, phone, notes, ...) can be added later with a cheap
 * `ADD COLUMN` migration, no redesign needed.
 */
#[ORM\Entity(repositoryClass: InstitutionRepository::class)]
class Institution
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
