<?php

namespace App\EventListener;

use Doctrine\Migrations\DependencyFactory;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpKernel\Event\RequestEvent;

/**
 * Refuses every `/api/*` request (except `/api/databases*` — see below)
 * with one clear, specific message in two situations, instead of letting
 * whatever exception happens to fire first surface as a generic 500:
 *
 *  - No active database at all: `databases/active.sqlite3` doesn't exist,
 *    isn't a symlink, or points at a file that no longer exists (e.g. a
 *    fresh clone — `databases/` is gitignored, so a new checkout starts
 *    with nothing there). Checked *before* any connection is ever
 *    attempted, specifically because SQLite's PDO driver would otherwise
 *    silently *create* an empty regular file at that path the moment
 *    anything tried to open a connection — masking the real "nothing set
 *    up yet" state and leaving a stray non-symlink file sitting where
 *    active.sqlite3 is supposed to be a symlink.
 *  - The active database's schema hasn't caught up with the latest
 *    migration. This bit for real once: a database missing a single
 *    migration made GET /api/accounts 500, which — because App.jsx used
 *    to gate the rest of its startup fetch on accounts succeeding —
 *    cascaded into the currency picker looking broken too, with no clue
 *    that the actual problem was one unrun migration.
 *
 * Both responses carry a machine-readable `reason` field
 * ("no_active_database" / "migrations_pending") so App.jsx can branch on
 * it directly instead of matching message text.
 *
 * `/api/databases*` (DatabaseController — list/switch/create/roll
 * forward databases) is exempt from both checks: a database in either
 * bad state must not make it impossible to reach the UI that fixes it.
 *
 * Runs at a high priority specifically so it short-circuits before
 * routing or any controller touches the database. If the migration
 * status check itself throws (e.g. a file with no tables at all, not
 * even the migrations-tracking one) that's treated the same as "out of
 * date" rather than letting a different raw exception through — the
 * message is less precise but the fix is identical either way.
 */
#[AsEventListener(event: 'kernel.request', priority: 300)]
class MigrationStatusListener
{
    public function __construct(
        #[Autowire(service: 'doctrine.migrations.dependency_factory')]
        private readonly DependencyFactory $dependencyFactory,
        #[Autowire('%kernel.project_dir%')]
        private readonly string $projectDir,
    ) {
    }

    public function __invoke(RequestEvent $event): void
    {
        $path = $event->getRequest()->getPathInfo();
        $isDatabasesRoute = '/api/databases' === $path || str_starts_with($path, '/api/databases/');
        if (!$event->isMainRequest() || !str_starts_with($path, '/api') || $isDatabasesRoute) {
            return;
        }

        if (!$this->hasActiveDatabase()) {
            $event->setResponse(new JsonResponse([
                'error' => 'No active database — select or create one to continue.',
                'reason' => 'no_active_database',
            ], 503));

            return;
        }

        try {
            $pending = $this->dependencyFactory->getMigrationStatusCalculator()->getNewMigrations()->count();
        } catch (\Throwable) {
            $pending = null;
        }

        if (0 === $pending) {
            return;
        }

        $message = null === $pending
            ? 'Database schema is out of date or not yet migrated — run: php bin/console doctrine:migrations:migrate'
            : \sprintf(
                'Database schema is out of date (%d migration%s pending) — run: php bin/console doctrine:migrations:migrate',
                $pending,
                1 === $pending ? '' : 's'
            );

        $event->setResponse(new JsonResponse(['error' => $message, 'reason' => 'migrations_pending'], 503));
    }

    private function hasActiveDatabase(): bool
    {
        $active = $this->projectDir.'/databases/active.sqlite3';
        if (!is_link($active)) {
            return false;
        }

        // realpath(), not readlink()+file_exists(): a relative symlink
        // target (e.g. hand-created via `ln -s 2024-2025.sqlite3
        // active.sqlite3`) resolves against this process's CWD under
        // readlink()+file_exists(), not the symlink's own directory —
        // wrongly reporting no active database even though the file
        // exists. Keep in agreement with DatabaseController::
        // activeTarget(), which does the same check independently.
        return false !== realpath($active);
    }
}
