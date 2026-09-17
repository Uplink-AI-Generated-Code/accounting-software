<?php

namespace App\Controller;

use App\Entity\Currency;
use App\Entity\Symbol;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Mostly read-only, like CurrencyController/CounterpartyController — but
 * Symbol is a curated, closed set (LedgerStateService::resolveSymbol()
 * hard-errors on an unknown ticker rather than find-or-creating like
 * Counterparty does), and there was previously no way at all to add the
 * *first* one: a blank database has zero symbols, so the investment
 * account form's picker had nothing to offer and no way to define one.
 * This one write endpoint exists specifically to unblock that — see
 * AccountFormModal.jsx's inline "add a new symbol" flow. Still no
 * PUT/DELETE, and no endpoint for Currency/Counterparty gains one either
 * just because this one did; see CLAUDE.md.
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
        if ($scale < 0) {
            return new JsonResponse(['error' => 'Scale must be a non-negative integer'], 400);
        }

        if (null !== $this->em->getRepository(Symbol::class)->find($ticker)) {
            return new JsonResponse(['error' => \sprintf('Symbol "%s" already exists', $ticker)], 409);
        }

        $tradingCurrency = $this->em->getRepository(Currency::class)->find($tradingCurrencyCode);
        if (!$tradingCurrency) {
            return new JsonResponse(['error' => \sprintf('Unknown trading currency "%s"', $tradingCurrencyCode)], 400);
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
}
