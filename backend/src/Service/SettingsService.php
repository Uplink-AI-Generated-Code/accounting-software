<?php

namespace App\Service;

use App\Entity\Setting;
use App\Repository\SettingRepository;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Type-safe access to the per-database key-value setting table — see
 * Setting's own docblock for why there's no separate type column.
 */
class SettingsService
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly SettingRepository $settingRepository,
    ) {
    }

    public function get(string $key): mixed
    {
        $row = $this->settingRepository->find($key);
        if (null === $row) {
            return null;
        }

        return json_decode($row->getValue(), true);
    }

    public function set(string $key, mixed $value): void
    {
        $row = $this->settingRepository->find($key) ?? (new Setting())->setKey($key);
        $row->setValue(json_encode($value, \JSON_THROW_ON_ERROR));
        $this->em->persist($row);
        $this->em->flush();
    }
}
