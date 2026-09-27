<?php

namespace App\Controller;

use App\Service\TagService;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Three narrow query endpoints over line-level tags — see
 * TagService's docblock and CLAUDE.md's "Tags" section for why this is
 * deliberately small rather than a general reporting engine.
 */
class TagController
{
    public function __construct(private readonly TagService $tags)
    {
    }

    #[Route('/api/tags', methods: ['GET'])]
    public function list(Request $request): JsonResponse
    {
        return new JsonResponse($this->tags->listTags($request->query->get('dimension')));
    }

    #[Route('/api/lines', methods: ['GET'])]
    public function lines(Request $request): JsonResponse
    {
        $dimension = $request->query->get('dimension');
        if (!$dimension) {
            return new JsonResponse(['error' => 'dimension is required'], 400);
        }
        $value = (string) $request->query->get('value', '');

        return new JsonResponse($this->tags->findLinesByTag($dimension, $value));
    }

    #[Route('/api/tag-totals', methods: ['GET'])]
    public function totals(Request $request): JsonResponse
    {
        $dimension = $request->query->get('dimension');
        if (!$dimension) {
            return new JsonResponse(['error' => 'dimension is required'], 400);
        }
        $excludeDimension = null;
        $excludeValue = null;
        $excludeTag = $request->query->get('excludeTag');
        if ($excludeTag) {
            [$excludeDimension, $excludeValue] = array_pad(explode(':', (string) $excludeTag, 2), 2, '');
        }

        return new JsonResponse($this->tags->computeTagTotals($dimension, $excludeDimension, $excludeValue));
    }
}
