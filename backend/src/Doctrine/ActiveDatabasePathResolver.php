<?php

namespace App\Doctrine;

use App\Service\AppSettingsRepository;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * The single place that resolves the currently active database's
 * absolute file path — used by ActiveDatabaseDriver (at actual PDO
 * connect time) and by anything else (NewYearService) that needs to
 * know the active file's path directly, without going through
 * Doctrine\DBAL\Connection::getParams() — which reflects only the
 * connection's *original* params (from DATABASE_URL), never
 * ActiveDatabaseDriver::connect()'s in-flight override, since
 * AbstractDriverMiddleware::connect(array $params) takes $params by
 * value and the mutation never propagates back into Connection's own
 * stored params. This was the root cause of a real bug: NewYearService
 * read getParams()['path'] directly and silently built a new tax year's
 * file from the wrong source database.
 *
 * Throws when nothing is configured, since every caller of resolve()
 * genuinely needs a real file to proceed — unlike
 * MigrationStatusListener::hasActiveDatabase(), which only asks the
 * question and acts on a false answer by refusing the request, so it
 * reads AppSettingsRepository directly rather than going through this.
 */
class ActiveDatabasePathResolver
{
    public function __construct(
        private readonly AppSettingsRepository $appSettingsRepository,
        #[Autowire('%kernel.project_dir%/databases')]
        private readonly string $databasesDir,
    ) {
    }

    public function resolve(): string
    {
        $override = getenv('ACTIVE_DATABASE_PATH_OVERRIDE');
        if (false !== $override && '' !== $override) {
            return $override;
        }

        $activeDatabase = $this->appSettingsRepository->read()['activeDatabase'];
        if (null === $activeDatabase) {
            throw new \RuntimeException('No active database configured — set activeDatabase in databases/app-settings.yaml, or set ACTIVE_DATABASE_PATH_OVERRIDE.');
        }

        return $this->databasesDir.'/'.$activeDatabase;
    }
}
