<?php

namespace App\Entity;

use App\Repository\SettingsRepository;
use Doctrine\ORM\Mapping as ORM;

/**
 * Single-row settings — this is a single-user app, so there's exactly one
 * Settings row, always id=1. StateController fetches-or-creates it.
 */
#[ORM\Entity(repositoryClass: SettingsRepository::class)]
class Settings
{
    #[ORM\Id]
    #[ORM\Column]
    private int $id = 1;

    #[ORM\Column]
    private bool $over65 = false;

    /** @var string[] */
    #[ORM\Column(type: 'json')]
    private array $groupLevels = ['type'];

    /** @var array<int, array{id: string, levels: string[]}> */
    #[ORM\Column(type: 'json')]
    private array $savedGroupings = [];

    public function getId(): int
    {
        return $this->id;
    }

    public function isOver65(): bool
    {
        return $this->over65;
    }

    public function setOver65(bool $over65): static
    {
        $this->over65 = $over65;

        return $this;
    }

    /** @return string[] */
    public function getGroupLevels(): array
    {
        return $this->groupLevels;
    }

    /** @param string[] $groupLevels */
    public function setGroupLevels(array $groupLevels): static
    {
        $this->groupLevels = $groupLevels;

        return $this;
    }

    /** @return array<int, array{id: string, levels: string[]}> */
    public function getSavedGroupings(): array
    {
        return $this->savedGroupings;
    }

    /** @param array<int, array{id: string, levels: string[]}> $savedGroupings */
    public function setSavedGroupings(array $savedGroupings): static
    {
        $this->savedGroupings = $savedGroupings;

        return $this;
    }
}
