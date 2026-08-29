<?php

namespace App\Controller;

use App\Service\LedgerStateService;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * The whole app talks to exactly two endpoints, mirroring the frontend's
 * own "load the whole state" / "persist(accounts, transactions, settings)"
 * pattern (see App.jsx) rather than one-resource-per-verb REST — there's
 * only ever one ledger's worth of data, and the frontend already treats a
 * save as replacing the whole state atomically.
 */
#[Route('/api/state')]
class StateController
{
    public function __construct(private readonly LedgerStateService $state)
    {
    }

    #[Route('', methods: ['GET'])]
    public function get(): JsonResponse
    {
        return new JsonResponse($this->state->readState());
    }

    #[Route('', methods: ['PUT'])]
    public function put(Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);
        if (!\is_array($body)) {
            return new JsonResponse(['error' => 'Invalid JSON body'], 400);
        }

        $this->state->writeState(
            $body['accounts'] ?? [],
            $body['transactions'] ?? [],
            $body['settings'] ?? [],
        );

        return new JsonResponse($this->state->readState());
    }
}
