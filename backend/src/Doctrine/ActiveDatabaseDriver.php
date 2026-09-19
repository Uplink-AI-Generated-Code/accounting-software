<?php

namespace App\Doctrine;

use App\Service\AppSettingsRepository;
use Doctrine\DBAL\Driver\Connection as DriverConnection;
use Doctrine\DBAL\Driver\Middleware\AbstractDriverMiddleware;

/**
 * Overrides the SQLite connection path on every real connect() call — see
 * ActiveDatabaseMiddleware for why, and
 * docs/superpowers/specs/2026-09-19-app-settings-and-active-database-design.md
 * for the full design.
 */
class ActiveDatabaseDriver extends AbstractDriverMiddleware
{
    public function __construct(
        \Doctrine\DBAL\Driver $wrappedDriver,
        private readonly AppSettingsRepository $appSettingsRepository,
        private readonly string $databasesDir,
    ) {
        parent::__construct($wrappedDriver);
    }

    public function connect(array $params): DriverConnection
    {
        // A narrow, purpose-built escape hatch for DatabaseController::
        // create()'s migrate/seed subprocess, which needs to target a
        // brand-new, not-yet-active file — never declared in any .env*
        // file, so Symfony\Component\Dotenv\Dotenv's SYMFONY_DOTENV_VARS
        // bookkeeping can never treat it as "previously dotenv-loaded"
        // and silently overwrite it the way DATABASE_URL once was (see
        // DatabaseController's own history). Checked first so it always
        // wins when present.
        $override = getenv('ACTIVE_DATABASE_PATH_OVERRIDE');
        if (false !== $override && '' !== $override) {
            $params['path'] = $override;

            return parent::connect($params);
        }

        $activeDatabase = $this->appSettingsRepository->read()['activeDatabase'];
        if (null !== $activeDatabase) {
            $params['path'] = $this->databasesDir.'/'.$activeDatabase;
        }

        return parent::connect($params);
    }
}
