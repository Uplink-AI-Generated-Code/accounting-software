<?php

namespace App\Controller;

use App\Entity\Currency;
use App\Service\LedgerStateService;
use Doctrine\DBAL\Exception\ForeignKeyConstraintViolationException;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Full admin CRUD for Currency — see
 * docs/superpowers/specs/2026-09-26-currency-symbol-admin-design.md.
 * `code` is immutable once created (it's the primary key); only `name`
 * and `scale` can be edited via PATCH. A `scale` edit rewrites every
 * dependent stored amount transactionally — see
 * LedgerStateService::rescaleCurrency(). Delete relies on the schema's
 * own foreign-key enforcement to refuse a still-referenced currency;
 * this controller just translates that into a clean 409.
 */
#[Route('/api/currencies')]
class CurrencyController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly LedgerStateService $state,
    ) {
    }

    #[Route('', methods: ['GET'])]
    public function list(): JsonResponse
    {
        $currencies = $this->em->getRepository(Currency::class)->findAll();

        return new JsonResponse(array_map(
            static fn (Currency $c) => array_filter([
                'code' => $c->getCode(),
                'scale' => $c->getScale(),
                'name' => $c->getName(),
            ], static fn ($v) => null !== $v),
            $currencies
        ));
    }

    #[Route('', methods: ['POST'])]
    public function create(Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);
        if (!\is_array($body)) {
            return new JsonResponse(['error' => 'Invalid JSON body'], 400);
        }

        $code = strtoupper(trim((string) ($body['code'] ?? '')));
        $scale = $body['scale'] ?? null;
        $name = isset($body['name']) ? trim((string) $body['name']) : null;

        if ('' === $code) {
            return new JsonResponse(['error' => 'Code is required'], 400);
        }
        if (!\is_int($scale) && !(\is_string($scale) && ctype_digit($scale))) {
            return new JsonResponse(['error' => 'Scale must be a non-negative integer'], 400);
        }
        $scale = (int) $scale;
        if ($scale < 0 || $scale > 12) {
            return new JsonResponse(['error' => 'Scale must be between 0 and 12'], 400);
        }
        if (null !== $this->em->getRepository(Currency::class)->find($code)) {
            return new JsonResponse(['error' => sprintf('Currency "%s" already exists', $code)], 409);
        }

        $currency = (new Currency())->setCode($code)->setScale($scale)->setName($name);
        $this->em->persist($currency);
        $this->em->flush();

        return new JsonResponse(array_filter([
            'code' => $currency->getCode(),
            'scale' => $currency->getScale(),
            'name' => $currency->getName(),
        ], static fn ($v) => null !== $v), 201);
    }

    #[Route('/{code}', methods: ['PATCH'])]
    public function patch(string $code, Request $request): JsonResponse
    {
        $currency = $this->em->getRepository(Currency::class)->find($code);
        if (!$currency) {
            return new JsonResponse(['error' => sprintf('Unknown currency "%s"', $code)], 404);
        }

        $body = json_decode($request->getContent(), true);
        if (!\is_array($body)) {
            return new JsonResponse(['error' => 'Invalid JSON body'], 400);
        }

        $rowsTouched = 0;
        try {
            if (\array_key_exists('scale', $body)) {
                $scale = $body['scale'];
                if (!\is_int($scale) && !(\is_string($scale) && ctype_digit($scale))) {
                    return new JsonResponse(['error' => 'Scale must be a non-negative integer'], 400);
                }
                $scale = (int) $scale;
                if ($scale < 0 || $scale > 12) {
                    return new JsonResponse(['error' => 'Scale must be between 0 and 12'], 400);
                }
                $rowsTouched = $this->state->rescaleCurrency($code, $scale);
            }
            if (\array_key_exists('name', $body)) {
                $currency->setName(null === $body['name'] ? null : trim((string) $body['name']));
                $this->em->persist($currency);
                $this->em->flush();
            }
        } catch (\InvalidArgumentException $e) {
            return new JsonResponse(['error' => $e->getMessage()], 400);
        }

        return new JsonResponse([
            'currency' => array_filter([
                'code' => $currency->getCode(),
                'scale' => $currency->getScale(),
                'name' => $currency->getName(),
            ], static fn ($v) => null !== $v),
            'rowsRescaled' => $rowsTouched,
        ]);
    }

    #[Route('/{code}', methods: ['DELETE'])]
    public function delete(string $code): JsonResponse
    {
        $currency = $this->em->getRepository(Currency::class)->find($code);
        if (!$currency) {
            return new JsonResponse(['error' => sprintf('Unknown currency "%s"', $code)], 404);
        }

        try {
            $this->em->remove($currency);
            $this->em->flush();
        } catch (ForeignKeyConstraintViolationException) {
            return new JsonResponse(['error' => sprintf('Currency "%s" is still in use and can\'t be deleted.', $code)], 409);
        }

        return new JsonResponse(['ok' => true]);
    }
}
