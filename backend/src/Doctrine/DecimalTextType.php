<?php

namespace App\Doctrine;

use App\Money\Decimal;
use Doctrine\DBAL\Platforms\AbstractPlatform;
use Doctrine\DBAL\Types\Type;

/**
 * An exact decimal amount, stored as a canonical decimal string in a
 * TEXT column. Deliberately NOT Doctrine's `decimal` type: on SQLite that
 * becomes NUMERIC(p,s), whose NUMERIC affinity silently converts "20.50"
 * into a float — the exact drift this type exists to prevent. Refuses to
 * write anything but a canonical string (see App\Money\Decimal), so a
 * stray float or "20.50" can never reach storage.
 */
final class DecimalTextType extends Type
{
    public const NAME = 'decimal_text';

    public function getSQLDeclaration(array $column, AbstractPlatform $platform): string
    {
        return 'TEXT';
    }

    public function convertToDatabaseValue(mixed $value, AbstractPlatform $platform): ?string
    {
        if (null === $value) {
            return null;
        }
        if (!\is_string($value) || !Decimal::isCanonical($value)) {
            throw new \InvalidArgumentException(sprintf('Refusing to store non-canonical decimal amount %s.', var_export($value, true)));
        }

        return $value;
    }

    public function convertToPHPValue(mixed $value, AbstractPlatform $platform): ?string
    {
        return null === $value ? null : (string) $value;
    }
}
