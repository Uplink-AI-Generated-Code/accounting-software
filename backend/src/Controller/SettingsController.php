<?php

namespace App\Controller;

use App\Service\LedgerStateService;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/api/settings')]
class SettingsController
{
    public function __construct(private readonly LedgerStateService $state)
    {
    }

    #[Route('', methods: ['GET'])]
    public function get(): JsonResponse
    {
        return new JsonResponse($this->state->getSettings());
    }

    #[Route('', methods: ['PATCH'])]
    public function patch(Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);
        if (!\is_array($body)) {
            return new JsonResponse(['error' => 'Invalid JSON body'], 400);
        }

        return new JsonResponse($this->state->patchSettings($body));
    }
}
