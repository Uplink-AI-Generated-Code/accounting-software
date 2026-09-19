<?php

namespace App\Service;

/**
 * Known per-database Setting keys, so nothing scatters magic strings
 * across controllers/services. Add a new constant here (not a migration)
 * when a genuinely tax-year-scoped setting is needed later.
 */
final class SettingKeys
{
    public const OVER_65 = 'over65';

    private function __construct()
    {
    }
}
