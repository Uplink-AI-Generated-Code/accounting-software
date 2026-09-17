<?php

namespace App\Entity;

use App\Repository\TagRepository;
use Doctrine\ORM\Mapping as ORM;

/**
 * A tag is a `(dimension, value)` pair — e.g. `("Car", "AB12CDE")`,
 * `("Status", "Refunded")` — covering the cross-cutting facts that don't
 * fit the account model's Type/Subtype/Counterparty (which car, which
 * trip, refund status, ...). See CLAUDE.md's "Tags" section.
 *
 * Natural-key reference entity like Currency/Symbol/Counterparty, but
 * with a **composite** key: both `dimension` and `value` together form
 * the primary key, since neither alone identifies a tag ("Refunded" could
 * be a Status value or a Car's actual name). Both are open, find-or-create
 * on write (see `LedgerStateService::resolveTags()`) — never a closed,
 * curated set like Currency/Symbol.
 *
 * `value` may be an empty string — a bare, flag-style tag (`{"Car", ""}`
 * for someone with exactly one car; `{"Tax-deductible", ""}` for a plain
 * yes/no fact) rather than a fake value invented just to satisfy the
 * composite key. Empty string, not null, for the same reason
 * `Account.name` is: null and "" would mean the same thing here.
 */
#[ORM\Entity(repositoryClass: TagRepository::class)]
class Tag
{
    #[ORM\Id]
    #[ORM\Column(length: 255)]
    private string $dimension;

    #[ORM\Id]
    #[ORM\Column(length: 255)]
    private string $value = '';

    public function getDimension(): string
    {
        return $this->dimension;
    }

    public function setDimension(string $dimension): static
    {
        $this->dimension = $dimension;

        return $this;
    }

    public function getValue(): string
    {
        return $this->value;
    }

    public function setValue(string $value): static
    {
        $this->value = $value;

        return $this;
    }
}
