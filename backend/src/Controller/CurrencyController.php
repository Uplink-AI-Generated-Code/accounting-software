<?php

namespace App\Controller;

use App\Entity\Currency;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Read-only for now — lets the frontend populate a real currency picker
 * instead of a hardcoded list. Full admin CRUD (add/edit a currency) is
 * future work; this is exactly where POST/PUT/DELETE would slot in later.
 */
#[Route('/api/currencies')]
class CurrencyController
{
    public function __construct(private readonly EntityManagerInterface $em)
    {
    }

    #[Route('', methods: ['GET'])]
    public function list(): JsonResponse
    {
        $currencies = $this->em->getRepository(Currency::class)->findAll();

        return new JsonResponse(array_map(
            static fn (Currency $c) => ['code' => $c->getCode(), 'scale' => $c->getScale()],
            $currencies
        ));
    }
}
