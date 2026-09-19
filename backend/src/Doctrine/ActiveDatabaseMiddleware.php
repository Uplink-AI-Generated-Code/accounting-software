<?php

namespace App\Doctrine;

use App\Service\AppSettingsRepository;
use Doctrine\DBAL\Driver;
use Doctrine\DBAL\Driver\Middleware;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * Registered automatically for every DBAL connection (doctrine-bundle
 * autoconfigures any Middleware implementation — see
 * DoctrineExtension::load()'s registerForAutoconfiguration call — no
 * explicit services.yaml tagging needed). Deliberately a no-op under
 * test: test keeps its own fixed DATABASE_URL (var/data_test.db, see
 * config/packages/doctrine.yaml's when@test block) entirely independent
 * of app-settings.yaml, so tests never depend on this file's state.
 */
class ActiveDatabaseMiddleware implements Middleware
{
    public function __construct(
        private readonly AppSettingsRepository $appSettingsRepository,
        #[Autowire('%kernel.project_dir%/databases')]
        private readonly string $databasesDir,
        #[Autowire('%kernel.environment%')]
        private readonly string $environment,
    ) {
    }

    public function wrap(Driver $driver): Driver
    {
        if ('test' === $this->environment) {
            return $driver;
        }

        return new ActiveDatabaseDriver($driver, $this->appSettingsRepository, $this->databasesDir);
    }
}
