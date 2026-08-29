<?php

namespace App\Controller;

use App\Service\LedgerStateService;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

/**
 * The frontend's one-shot initial load — see App.jsx's load effect. Every
 * write after that goes through the discrete endpoints instead
 * (AccountController, SettingsController, TransactionController).
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
}
