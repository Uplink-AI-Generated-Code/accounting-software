<?php

namespace App\Doctrine;

use Doctrine\DBAL\Driver\Connection as DriverConnection;
use Doctrine\DBAL\Driver\Middleware\AbstractDriverMiddleware;

/**
 * Executes PRAGMA foreign_keys = ON immediately after every real
 * connection opens — SQLite's foreign_keys enforcement is off by
 * default and must be set per-connection, it is never stored in the
 * database file itself. See ForeignKeysMiddleware's own docblock for
 * why this is unconditional (every environment, unlike
 * ActiveDatabaseMiddleware/ActiveDatabaseDriver) and
 * docs/superpowers/specs/2026-09-19-generalized-investment-parent-design.md
 * for the audit that confirmed this is safe against every existing
 * write path in this app.
 */
class ForeignKeysDriver extends AbstractDriverMiddleware
{
    public function connect(array $params): DriverConnection
    {
        $connection = parent::connect($params);
        $connection->exec('PRAGMA foreign_keys = ON');

        return $connection;
    }
}
