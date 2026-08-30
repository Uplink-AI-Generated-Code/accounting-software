<?php

namespace App\Controller;

use App\Entity\Institution;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Read-only for now — see CurrencyController's docblock; same reasoning.
 */
#[Route('/api/institutions')]
class InstitutionController
{
    public function __construct(private readonly EntityManagerInterface $em)
    {
    }

    #[Route('', methods: ['GET'])]
    public function list(): JsonResponse
    {
        $institutions = $this->em->getRepository(Institution::class)->findAll();

        return new JsonResponse(array_map(
            static fn (Institution $i) => ['name' => $i->getName()],
            $institutions
        ));
    }
}
