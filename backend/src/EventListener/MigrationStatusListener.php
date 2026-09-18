<?php

namespace App\EventListener;

use Doctrine\Migrations\DependencyFactory;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpKernel\Event\RequestEvent;

/**
 * Refuses every `/api/*` request with one clear, specific message when the
 * database's schema hasn't caught up with the latest migration, instead of
 * letting whatever SQL exception happens to fire first (e.g. "no such
 * column") surface as a generic 500. This bit for real once: a database
 * missing a single migration made GET /api/accounts 500, which — because
 * App.jsx used to gate the rest of its startup fetch on accounts
 * succeeding — cascaded into the currency picker looking broken too, with
 * no clue that the actual problem was one unrun migration. See CLAUDE.md's
 * "Commands" section and `app:new-year`, which is what produces a
 * not-yet-migrated database in the first place (a copy made before this
 * app's own migrations had run against it).
 *
 * Runs at a high priority specifically so it short-circuits before routing
 * or any controller touches the database. If the status check itself
 * throws (e.g. a genuinely fresh file with no tables at all, not even the
 * migrations-tracking one) that's treated the same as "out of date" rather
 * than letting a different raw exception through — the message is less
 * precise but the fix is identical either way.
 */
#[AsEventListener(event: 'kernel.request', priority: 300)]
class MigrationStatusListener
{
    public function __construct(
        #[Autowire(service: 'doctrine.migrations.dependency_factory')]
        private readonly DependencyFactory $dependencyFactory,
    ) {
    }

    public function __invoke(RequestEvent $event): void
    {
        if (!$event->isMainRequest() || !str_starts_with($event->getRequest()->getPathInfo(), '/api')) {
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

        $event->setResponse(new JsonResponse(['error' => $message], 503));
    }
}
