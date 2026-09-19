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

    /**
     * The lightweight, app-wide account list — sidebar, Overview, the
     * "link another account" dropdown, and every other place that needs
     * to know about every account without loading any of their line-level
     * history.
     */
    #[Route('', methods: ['GET'])]
    public function list(): JsonResponse
    {
        return new JsonResponse($this->state->accountsWithStats());
    }

    /**
     * The per-account ledger — fetched when a ledger screen opens,
     * discarded when it closes. See LedgerStateService::accountLedger().
     */
    #[Route('/{id}/ledger', methods: ['GET'])]
    public function ledger(string $id): JsonResponse
    {
        return new JsonResponse(['records' => $this->state->accountLedger($id)]);
    }

    #[Route('/{id}', methods: ['PUT'])]
    public function put(string $id, Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);
        if (!\is_array($body)) {
            return new JsonResponse(['error' => 'Invalid JSON body'], 400);
        }

        try {
            return new JsonResponse($this->state->upsertAccount($id, $body));
        } catch (\InvalidArgumentException $e) {
            return new JsonResponse(['error' => $e->getMessage()], 400);
        }
    }

    /**
     * Deleting an account always navigates the frontend away from it (see
     * App.jsx's performDeleteAccount), so there's no ledger view left to
     * patch — just an ack.
     */
    #[Route('/{id}', methods: ['DELETE'])]
    public function delete(string $id): JsonResponse
    {
        try {
            $this->state->deleteAccount($id);
        } catch (\Doctrine\DBAL\Exception\ForeignKeyConstraintViolationException) {
            return new JsonResponse(['error' => "Can't delete a wrapper account that still has subaccounts. Delete those first."], 409);
        }

        return new JsonResponse(['ok' => true]);
    }
}
