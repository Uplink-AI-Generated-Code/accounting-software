<?php

namespace App\Controller;

use App\Service\IsaAllowanceService;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Usage only — the annual caps (isaRulesFor/ISA_RULE_TABLE) and the
 * account-grouping-into-products the allowance page also needs
 * (isaProducts) stay client-side; see IsaAllowanceService's docblock.
 */
#[Route('/api/isa-allowance')]
class IsaAllowanceController
{
    public function __construct(private readonly IsaAllowanceService $isa)
    {
    }

    #[Route('', methods: ['GET'])]
    public function get(Request $request): JsonResponse
    {
        $startYear = $request->query->get('taxYearStart');
        if (null === $startYear || !ctype_digit((string) $startYear)) {
            return new JsonResponse(['error' => 'taxYearStart (a tax year start year, e.g. 2026) is required'], 400);
        }

        return new JsonResponse($this->isa->computeUsage((int) $startYear));
    }
}
