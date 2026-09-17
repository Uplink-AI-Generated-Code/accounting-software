<?php

namespace App\Controller;

use App\Entity\Counterparty;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Read-only for now — see CurrencyController's docblock; same reasoning.
 */
#[Route('/api/counterparties')]
class CounterpartyController
{
    public function __construct(private readonly EntityManagerInterface $em)
    {
    }

    #[Route('', methods: ['GET'])]
    public function list(): JsonResponse
    {
        $counterparties = $this->em->getRepository(Counterparty::class)->findAll();

        return new JsonResponse(array_map(
            static fn (Counterparty $c) => ['name' => $c->getName()],
            $counterparties
        ));
    }
}
