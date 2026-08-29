<?php

namespace App\Controller;

use App\Service\MatchingService;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Replaces the old client-side "scan every transaction for a plausible
 * counterpart" search (see CLAUDE.md's old "Matching and linking"
 * section) — now a real query, called as the user types instead of
 * filtering an in-memory array that no longer exists client-side.
 */
#[Route('/api/match-candidates')]
class MatchController
{
    public function __construct(private readonly MatchingService $matching)
    {
    }

    #[Route('', methods: ['GET'])]
    public function search(Request $request): JsonResponse
    {
        $currency = $request->query->get('currency');
        $amount = $request->query->get('amount');
        $date = $request->query->get('date');
        $mode = $request->query->get('mode', 'mirrored');
        $excludeTransactionId = $request->query->get('excludeTransactionId') ?: null;
        $excludeAccountIds = array_values(array_filter(explode(',', (string) $request->query->get('excludeAccountIds', ''))));

        if (!$currency || null === $amount || !$date) {
            return new JsonResponse(['error' => 'currency, amount, and date are required'], 400);
        }
        if (!\in_array($mode, ['mirrored', 'direct'], true)) {
            return new JsonResponse(['error' => 'mode must be "mirrored" or "direct"'], 400);
        }

        return new JsonResponse($this->matching->findCandidates($currency, (float) $amount, $date, $excludeTransactionId, $excludeAccountIds, $mode));
    }
}
