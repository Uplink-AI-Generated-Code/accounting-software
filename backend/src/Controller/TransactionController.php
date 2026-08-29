<?php

namespace App\Controller;

use App\Service\LedgerStateService;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * One endpoint for every transaction write — a plain single save, a merge
 * (upsert the surviving record + delete the absorbed one), a split-off
 * (upsert + insert new standalone records), and a same-date reorder
 * (several upserts) all become one batch call, applied atomically. See
 * LedgerStateService::applyTransactionOperations().
 */
#[Route('/api/transactions')]
class TransactionController
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

        $this->state->applyTransactionOperations($operations);

        return new JsonResponse(['ok' => true]);
    }
}
