<?php

namespace App\Controller;

use App\Entity\Symbol;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Read-only for now — see CurrencyController's docblock; same reasoning.
 */
#[Route('/api/symbols')]
class SymbolController
{
    public function __construct(private readonly EntityManagerInterface $em)
    {
    }

    #[Route('', methods: ['GET'])]
    public function list(): JsonResponse
    {
        $symbols = $this->em->getRepository(Symbol::class)->findAll();

        return new JsonResponse(array_map(
            static fn (Symbol $s) => [
                'ticker' => $s->getTicker(),
                'name' => $s->getName(),
                'scale' => $s->getScale(),
                'tradingCurrency' => $s->getTradingCurrency()->getCode(),
            ],
            $symbols
        ));
    }
}
