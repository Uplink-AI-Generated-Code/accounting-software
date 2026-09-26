<?php

namespace App\Controller;

use App\Entity\Currency;
use App\Entity\Symbol;
use App\Service\LedgerStateService;
use Doctrine\DBAL\Exception\ForeignKeyConstraintViolationException;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Full admin CRUD for Symbol — see
 * docs/superpowers/specs/2026-09-26-currency-symbol-admin-design.md.
 * Identity is the pair (ticker, tradingCurrency) — the same ticker can
 * exist more than once, one row per trading currency, so the duplicate
 * check on create and the routes on PATCH/DELETE both key on the pair,
 * not the ticker alone. tradingCurrency itself is never editable (it's
 * part of the identity) — only name and scale can change via PATCH.
 */
#[Route('/api/symbols')]
class SymbolController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly LedgerStateService $state,
    ) {
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

    #[Route('', methods: ['POST'])]
    public function create(Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);
        if (!\is_array($body)) {
            return new JsonResponse(['error' => 'Invalid JSON body'], 400);
        }

        $ticker = strtoupper(trim((string) ($body['ticker'] ?? '')));
        $name = trim((string) ($body['name'] ?? ''));
        $scale = $body['scale'] ?? null;
        $tradingCurrencyCode = (string) ($body['tradingCurrency'] ?? '');

        if ('' === $ticker) {
            return new JsonResponse(['error' => 'Ticker is required'], 400);
        }
        if ('' === $name) {
            return new JsonResponse(['error' => 'Name is required'], 400);
        }
        if (!\is_int($scale) && !(\is_string($scale) && ctype_digit($scale))) {
            return new JsonResponse(['error' => 'Scale must be a non-negative integer'], 400);
        }
        $scale = (int) $scale;
        if ($scale < 0 || $scale > 12) {
            return new JsonResponse(['error' => 'Scale must be between 0 and 12'], 400);
        }

        $tradingCurrency = $this->em->getRepository(Currency::class)->find($tradingCurrencyCode);
        if (!$tradingCurrency) {
            return new JsonResponse(['error' => sprintf('Unknown trading currency "%s"', $tradingCurrencyCode)], 400);
        }

        if (null !== $this->em->getRepository(Symbol::class)->find(['ticker' => $ticker, 'tradingCurrency' => $tradingCurrency])) {
            return new JsonResponse(['error' => sprintf('Symbol "%s" in %s already exists', $ticker, $tradingCurrencyCode)], 409);
        }

        $symbol = (new Symbol())
            ->setTicker($ticker)
            ->setName($name)
            ->setScale($scale)
            ->setTradingCurrency($tradingCurrency);
        $this->em->persist($symbol);
        $this->em->flush();

        return new JsonResponse([
            'ticker' => $symbol->getTicker(),
            'name' => $symbol->getName(),
            'scale' => $symbol->getScale(),
            'tradingCurrency' => $symbol->getTradingCurrency()->getCode(),
        ], 201);
    }

    #[Route('/{ticker}/{tradingCurrency}', methods: ['PATCH'])]
    public function patch(string $ticker, string $tradingCurrency, Request $request): JsonResponse
    {
        $currency = $this->em->getRepository(Currency::class)->find($tradingCurrency);
        $symbol = $currency ? $this->em->getRepository(Symbol::class)->find(['ticker' => $ticker, 'tradingCurrency' => $currency]) : null;
        if (!$symbol) {
            return new JsonResponse(['error' => sprintf('Unknown symbol "%s" in %s', $ticker, $tradingCurrency)], 404);
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
                $rowsTouched = $this->state->rescaleSymbol($ticker, $tradingCurrency, $scale);
            }
            if (\array_key_exists('name', $body)) {
                $name = trim((string) $body['name']);
                if ('' === $name) {
                    return new JsonResponse(['error' => 'Name is required'], 400);
                }
                $symbol->setName($name);
                $this->em->persist($symbol);
                $this->em->flush();
            }
        } catch (\InvalidArgumentException $e) {
            return new JsonResponse(['error' => $e->getMessage()], 400);
        }

        return new JsonResponse([
            'symbol' => [
                'ticker' => $symbol->getTicker(),
                'name' => $symbol->getName(),
                'scale' => $symbol->getScale(),
                'tradingCurrency' => $symbol->getTradingCurrency()->getCode(),
            ],
            'rowsRescaled' => $rowsTouched,
        ]);
    }

    #[Route('/{ticker}/{tradingCurrency}', methods: ['DELETE'])]
    public function delete(string $ticker, string $tradingCurrency): JsonResponse
    {
        $currency = $this->em->getRepository(Currency::class)->find($tradingCurrency);
        $symbol = $currency ? $this->em->getRepository(Symbol::class)->find(['ticker' => $ticker, 'tradingCurrency' => $currency]) : null;
        if (!$symbol) {
            return new JsonResponse(['error' => sprintf('Unknown symbol "%s" in %s', $ticker, $tradingCurrency)], 404);
        }

        try {
            $this->em->remove($symbol);
            $this->em->flush();
        } catch (ForeignKeyConstraintViolationException) {
            return new JsonResponse(['error' => sprintf('Symbol "%s" in %s is still in use and can\'t be deleted.', $ticker, $tradingCurrency)], 409);
        }

        return new JsonResponse(['ok' => true]);
    }
}
