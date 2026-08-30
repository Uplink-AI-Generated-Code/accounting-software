<?php

namespace App\Service;

use App\Entity\Account;
use App\Entity\Line;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Ported from lib/matching.js's getComparableAmount / getDirectComparableAmount
 * — see that file's comments for why two variants exist (the mirrored vs.
 * natural sign convention). This is the one piece of business logic that
 * used to require the whole ledger loaded client-side (searching every
 * unmatched entry for a plausible counterpart); now it's a query.
 *
 * A candidate is, by definition, a standalone line (`transaction IS
 * NULL`) — a line already inside a linked Transaction is never offered,
 * since it's already matched. There's no `excludeTransactionId` parameter
 * here: the current draft's own account is always in `excludeAccountIds`
 * already, which is what would have kept a standalone line from matching
 * itself anyway — a transaction id to additionally exclude has no
 * candidates to speak of under this model.
 */
class MatchingService
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly LedgerStateService $ledgerState,
    ) {
    }

    /**
     * @param string[] $excludeAccountIds
     *
     * @return array<int, array{lineId: int, line: array<string, mixed>, account: array<string, mixed>}>
     */
    public function findCandidates(
        string $targetCurrency,
        int $targetAmount,
        string $date,
        array $excludeAccountIds,
        string $mode,
    ): array {
        $direct = 'direct' === $mode;

        $qb = $this->em->createQueryBuilder();
        $qb->select('l')
            ->from(Line::class, 'l')
            ->where('l.transaction IS NULL');

        if ($excludeAccountIds) {
            $qb->andWhere($qb->expr()->notIn('IDENTITY(l.account)', ':excludeAccounts'))->setParameter('excludeAccounts', $excludeAccountIds);
        }

        $lines = $qb->getQuery()->getResult();

        $candidates = [];
        foreach ($lines as $line) {
            /* @var Line $line */
            $acc = $line->getAccount();
            $comparable = $this->comparableAmount($line, $acc, $targetCurrency, $direct);
            if (null === $comparable || $comparable !== $targetAmount) {
                continue;
            }
            $days = $this->daysDiff($date, $line->getDate());
            if (abs($days) > 3) {
                continue;
            }
            $candidates[] = ['days' => abs($days), 'line' => $line, 'account' => $acc];
        }

        usort($candidates, static fn ($a, $b) => $a['days'] <=> $b['days']);

        return array_map(fn ($c) => [
            'lineId' => $c['line']->getId(),
            'line' => $this->ledgerState->lineToArray($c['line']),
            'account' => $this->ledgerState->accountToArray($c['account']),
        ], $candidates);
    }

    // Mirrors getComparableAmount (direct=false) / getDirectComparableAmount
    // (direct=true) exactly — see lib/matching.js.
    private function comparableAmount(Line $line, Account $acc, string $targetCurrency, bool $direct): ?int
    {
        if ('investment' === $acc->getType()) {
            if ($line->getCashCurrency()?->getCode() !== $targetCurrency || null === $line->getCashValue()) {
                return null;
            }

            return $direct ? -$line->getCashValue() : $line->getCashValue();
        }
        if ($acc->getCurrency()?->getCode() === $targetCurrency) {
            return $line->getAmount();
        }
        if (!$direct && $line->getExchangeCurrency()?->getCode() === $targetCurrency) {
            return $line->getExchangeAmount();
        }

        return null;
    }

    private function daysDiff(string $a, string $b): int
    {
        $ta = new \DateTimeImmutable($a);
        $tb = new \DateTimeImmutable($b);

        return (int) round(($tb->getTimestamp() - $ta->getTimestamp()) / 86400);
    }
}
