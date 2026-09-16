<?php

namespace App\Controller;

use App\Service\LedgerStateService;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * One endpoint for every ledger write that isn't a plain account/settings
 * change — a standalone line's own save/delete, a transaction's, and
 * every compound action built from them (merge, split-off, unlink,
 * same-date reorder) — applied atomically as an ordered list of
 * operations. See LedgerStateService::applyLedgerOperations() for the
 * four primitives and worked examples of how each frontend action maps
 * to a short sequence of them.
 */
#[Route('/api/ledger')]
class LedgerController
{
    public function __construct(private readonly LedgerStateService $state)
    {
    }

    #[Route('/batch', methods: ['POST'])]
    public function batch(Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);
        $operations = \is_array($body) ? ($body['operations'] ?? null) : null;
        if (!\is_array($operations)) {
            return new JsonResponse(['error' => 'Expected {"operations": [...]}'], 400);
        }

        try {
            $this->state->applyLedgerOperations($operations);
        } catch (\InvalidArgumentException $e) {
            // Currently only thrown by the active-tax-year date check —
            // a clear 400 instead of an uncaught 500, since this is a
            // real, expected rejection path (a stale tab, a fat-fingered
            // date), not a bug.
            return new JsonResponse(['error' => $e->getMessage()], 400);
        }

        return new JsonResponse(['ok' => true]);
    }
}
