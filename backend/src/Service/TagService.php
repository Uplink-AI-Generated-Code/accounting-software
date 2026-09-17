<?php

namespace App\Service;

use App\Entity\Line;
use App\Entity\Tag;
use Doctrine\ORM\EntityManagerInterface;

/**
 * The query side of tagging — see CLAUDE.md's "Tags" section. Deliberately
 * narrow: most of the "how much did I spend/earn on X" questions this
 * feature was originally motivated by turned out to already be answered
 * by the account-grouping tree (Counterparty/Subtype/Type), once nominal
 * accounts adopted Counterparty. Tags, and this service, exist only for
 * the genuinely cross-cutting facts that grouping can't reach (which car,
 * which trip, refund status, ...).
 */
class TagService
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly LedgerStateService $ledgerState,
    ) {
    }

    /**
     * Distinct `{dimension, value}` pairs in use, optionally scoped to one
     * dimension — powers the autocomplete picker (existing dimensions
     * first, then existing values once one's chosen). This is the
     * guardrail against "Refunded" vs "refund" silently fragmenting a
     * report, since nothing at the schema level prevents that.
     *
     * @return array<int, array{dimension: string, value: string}>
     */
    public function listTags(?string $dimension): array
    {
        $qb = $this->em->createQueryBuilder()->select('t')->from(Tag::class, 't');
        if (null !== $dimension && '' !== $dimension) {
            $qb->where('t.dimension = :dimension')->setParameter('dimension', $dimension);
        }
        $qb->orderBy('t.dimension', 'ASC')->addOrderBy('t.value', 'ASC');

        return array_map(
            static fn (Tag $t) => ['dimension' => $t->getDimension(), 'value' => $t->getValue()],
            $qb->getQuery()->getResult()
        );
    }

    /**
     * Every line carrying this exact tag, each with its account context —
     * the drill-down behind a tag-totals figure. Shaped like
     * MatchingService::findCandidates()'s own candidates
     * (`{lineId, line, account}`), for the same reason: a browsable list,
     * not just a number.
     *
     * @return array<int, array{lineId: int, line: array<string, mixed>, account: array<string, mixed>}>
     */
    public function findLinesByTag(string $dimension, string $value): array
    {
        $lines = $this->em->createQueryBuilder()
            ->select('l')->from(Line::class, 'l')
            ->join('l.tags', 't')
            ->where('t.dimension = :dimension')->andWhere('t.value = :value')
            ->setParameter('dimension', $dimension)->setParameter('value', $value)
            ->getQuery()->getResult();

        return array_map(fn (Line $l) => [
            'lineId' => $l->getId(),
            'line' => $this->ledgerState->lineToArray($l),
            'account' => $this->ledgerState->accountToArray($l->getAccount()),
        ], $lines);
    }

    /**
     * Server-side SUM grouped by `(value, currency)` — same "compute it
     * server-side, never sum many lines client-side" posture as
     * accountsWithStats()'s own balance SUM. `excludeDimension`/
     * `excludeValue` cover "Groceries total, excluding refunded" style
     * filtering: a line carrying that second tag is skipped entirely.
     *
     * Scope cut: investment lines are never summed here — an investment
     * line's `amount` is units, not cash, so mixing it into a cash total
     * under one `(value, currency)` bucket would silently combine
     * incompatible quantities. Investment lines can still be tagged and
     * will show up via findLinesByTag(), just not summed here.
     *
     * A line carrying more than one value of the requested dimension
     * (left unconstrained by design — see CLAUDE.md) contributes to each
     * value's total, not just one.
     *
     * @return array<int, array{value: string, currency: string, amount: int}>
     */
    public function computeTagTotals(string $dimension, ?string $excludeDimension, ?string $excludeValue): array
    {
        $lines = $this->em->createQueryBuilder()
            ->select('l', 'a')->from(Line::class, 'l')
            ->join('l.account', 'a')
            ->join('l.tags', 't')
            ->where('t.dimension = :dimension')
            ->setParameter('dimension', $dimension)
            ->getQuery()->getResult();

        $totals = [];
        foreach ($lines as $line) {
            /* @var Line $line */
            $account = $line->getAccount();
            if ('investment' === $account->getType()) {
                continue;
            }
            if (null !== $excludeDimension && $this->lineHasTag($line, $excludeDimension, $excludeValue ?? '')) {
                continue;
            }
            $currency = $account->getCurrency()?->getCode();
            if (null === $currency) {
                continue;
            }
            foreach ($line->getTags() as $tag) {
                if ($tag->getDimension() !== $dimension) {
                    continue;
                }
                $totals[$tag->getValue()][$currency] = ($totals[$tag->getValue()][$currency] ?? 0) + $line->getAmount();
            }
        }

        $result = [];
        foreach ($totals as $value => $byCurrency) {
            foreach ($byCurrency as $currency => $amount) {
                $result[] = ['value' => $value, 'currency' => $currency, 'amount' => $amount];
            }
        }
        usort($result, static fn ($a, $b) => [$a['value'], $a['currency']] <=> [$b['value'], $b['currency']]);

        return $result;
    }

    private function lineHasTag(Line $line, string $dimension, string $value): bool
    {
        return $line->getTags()->exists(
            static fn (int $i, Tag $tag) => $tag->getDimension() === $dimension && $tag->getValue() === $value
        );
    }
}
