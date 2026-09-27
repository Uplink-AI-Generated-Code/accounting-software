<?php

namespace App\Controller;

use App\Money\ScaleRegistry;
use App\Money\WireAmounts;
use App\Service\MatchingService;
use Doctrine\ORM\EntityManagerInterface;
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
    public function __construct(private readonly MatchingService $matching, private readonly EntityManagerInterface $em)
    {
    }

    #[Route('', methods: ['GET'])]
    public function search(Request $request): JsonResponse
    {
        $currency = $request->query->get('currency');
        $amount = $request->query->get('amount');
        $date = $request->query->get('date');
        $mode = $request->query->get('mode', 'mirrored');
        $excludeAccountIds = array_values(array_filter(explode(',', (string) $request->query->get('excludeAccountIds', ''))));

        if (!$currency || null === $amount || !$date) {
            return new JsonResponse(['error' => 'currency, amount, and date are required'], 400);
        }
        if (!\in_array($mode, ['mirrored', 'direct'], true)) {
            return new JsonResponse(['error' => 'mode must be "mirrored" or "direct"'], 400);
        }

        $registry = ScaleRegistry::fromEntityManager($this->em);
        try {
            $amountInt = WireAmounts::amountIn((string) $amount, $currency, $registry);
        } catch (\InvalidArgumentException $e) {
            return new JsonResponse(['error' => $e->getMessage()], 400);
        }

        return new JsonResponse(WireAmounts::candidatesOut($this->matching->findCandidates($currency, $amountInt, $date, $excludeAccountIds, $mode), $registry));
    }
}
