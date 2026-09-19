<?php

namespace App\Doctrine;

use Doctrine\DBAL\Driver\Connection as DriverConnection;
use Doctrine\DBAL\Driver\Middleware\AbstractDriverMiddleware;

/**
 * Overrides the SQLite connection path on every real connect() call — see
 * ActiveDatabaseMiddleware for why, and
 * docs/superpowers/specs/2026-09-19-app-settings-and-active-database-design.md
 * for the full design.
 *
 * The actual path resolution (including the ACTIVE_DATABASE_PATH_OVERRIDE
 * escape hatch) lives in ActiveDatabasePathResolver, shared with
 * NewYearService — see that class's docblock for why this can't just read
 * back Connection::getParams() the way NewYearService used to.
 */
class ActiveDatabaseDriver extends AbstractDriverMiddleware
{
    public function __construct(
        \Doctrine\DBAL\Driver $wrappedDriver,
        private readonly ActiveDatabasePathResolver $pathResolver,
    ) {
        parent::__construct($wrappedDriver);
    }

    public function connect(array $params): DriverConnection
    {
        $params['path'] = $this->pathResolver->resolve();

        return parent::connect($params);
    }
}
