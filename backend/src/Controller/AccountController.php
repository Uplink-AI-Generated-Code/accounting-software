<?php

namespace App\Controller;

use App\Service\LedgerStateService;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * `id`s are always frontend-provided (see CLAUDE.md), so PUT doubles as
 * both create and update — there's no separate POST /api/accounts.
 */
#[Route('/api/accounts')]
class AccountController
{
    public function __construct(private readonly LedgerStateService $state)
    {
    }

    #[Route('/{id}', methods: ['PUT'])]
    public function put(string $id, Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);
        if (!\is_array($body)) {
            return new JsonResponse(['error' => 'Invalid JSON body'], 400);
        }

        return new JsonResponse($this->state->upsertAccount($id, $body));
    }

    /**
     * Deleting an account can also delete transactions that become fully
     * empty as a result (see LedgerStateService::deleteAccount) — the
     * response carries the fresh transactions list so the frontend can
     * update its local state without a separate GET.
     */
    #[Route('/{id}', methods: ['DELETE'])]
    public function delete(string $id): JsonResponse
    {
        return new JsonResponse(['transactions' => $this->state->deleteAccount($id)]);
    }
}
