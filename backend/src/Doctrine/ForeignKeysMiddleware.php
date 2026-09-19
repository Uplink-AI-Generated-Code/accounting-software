<?php

namespace App\Doctrine;

use Doctrine\DBAL\Driver;
use Doctrine\DBAL\Driver\Middleware;

/**
 * Registered automatically for every DBAL connection (doctrine-bundle
 * autoconfigures any Middleware implementation — no services.yaml
 * wiring needed, same as ActiveDatabaseMiddleware). Unlike
 * ActiveDatabaseMiddleware, this is NOT environment-gated: foreign key
 * enforcement applies to dev, prod, and test alike, so the test suite
 * genuinely exercises the new parent_id constraint too. Composes
 * cleanly alongside ActiveDatabaseMiddleware — doctrine-bundle applies
 * every registered middleware in sequence, each wrapping the driver
 * the previous one returned.
 */
class ForeignKeysMiddleware implements Middleware
{
    public function wrap(Driver $driver): Driver
    {
        return new ForeignKeysDriver($driver);
    }
}
