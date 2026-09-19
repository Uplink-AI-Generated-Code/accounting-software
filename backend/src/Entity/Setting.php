<?php

namespace App\Entity;

use App\Repository\SettingRepository;
use Doctrine\ORM\Mapping as ORM;

/**
 * One row per genuinely tax-year-scoped setting — over65 today, whatever
 * else needs a per-database (not global) home later, without a migration
 * per new key. Natural-key entity like Currency/Symbol/Counterparty: the
 * key itself is the primary key, no surrogate id. `value` is always valid
 * JSON text — json_decode/json_encode alone round-trip the real PHP type
 * (bool/int/string/array/null), so there's no separate type column.
 */
#[ORM\Entity(repositoryClass: SettingRepository::class)]
class Setting
{
    #[ORM\Id]
    #[ORM\Column(name: '`key`', length: 64)]
    private string $key;

    #[ORM\Column(type: 'text')]
    private string $value;

    public function getKey(): string
    {
        return $this->key;
    }

    public function setKey(string $key): static
    {
        $this->key = $key;

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
