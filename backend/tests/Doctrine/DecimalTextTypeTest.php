<?php

namespace App\Tests\Doctrine;

use App\Doctrine\DecimalTextType;
use Doctrine\DBAL\Platforms\SQLitePlatform;
use PHPUnit\Framework\TestCase;

class DecimalTextTypeTest extends TestCase
{
    private DecimalTextType $type;
    private SQLitePlatform $platform;

    protected function setUp(): void
    {
        $this->type = new DecimalTextType();
        $this->platform = new SQLitePlatform();
    }

    public function testDeclaresTextAffinityNotNumeric(): void
    {
        // SQLite gives any declared type containing "CLOB" TEXT affinity.
        self::assertSame('CLOB', $this->type->getSQLDeclaration([], $this->platform));
    }

    public function testStoresCanonicalStringsVerbatim(): void
    {
        self::assertSame('20.5', $this->type->convertToDatabaseValue('20.5', $this->platform));
        self::assertNull($this->type->convertToDatabaseValue(null, $this->platform));
    }

    public function testRefusesNonCanonicalValues(): void
    {
        foreach (['20.50', '-0', 20.5, 2050, '1e3', ''] as $bad) {
            try {
                $this->type->convertToDatabaseValue($bad, $this->platform);
                self::fail('Expected rejection of '.var_export($bad, true));
            } catch (\InvalidArgumentException) {
                self::addToAssertionCount(1);
            }
        }
    }

    public function testReadsBackAsString(): void
    {
        self::assertSame('7', $this->type->convertToPHPValue(7, $this->platform));
        self::assertSame('0.25', $this->type->convertToPHPValue('0.25', $this->platform));
        self::assertNull($this->type->convertToPHPValue(null, $this->platform));
    }
}
