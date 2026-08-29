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
     * @return array<int, array{transactionId: string, line: array<string, mixed>, account: array<string, mixed>}>
     */
    public function findCandidates(
        string $targetCurrency,
        float $targetAmount,
        string $date,
        ?string $excludeTransactionId,
        array $excludeAccountIds,
        string $mode,
    ): array {
        $direct = 'direct' === $mode;

        // Only single-line (unmatched) transactions are ever offered as a
        // candidate — a linked or split entry is already matched.
        $singleLineTxnIds = $this->em->getConnection()->fetchFirstColumn(
            'SELECT transaction_id FROM line GROUP BY transaction_id HAVING COUNT(*) = 1'
        );
        if (!$singleLineTxnIds) {
            return [];
        }

        $qb = $this->em->createQueryBuilder();
        $qb->select('l')
            ->from(Line::class, 'l')
            ->where($qb->expr()->in('IDENTITY(l.transaction)', ':txnIds'))
            ->setParameter('txnIds', $singleLineTxnIds);

        if ($excludeTransactionId) {
            $qb->andWhere('IDENTITY(l.transaction) != :excludeTxn')->setParameter('excludeTxn', $excludeTransactionId);
        }
        if ($excludeAccountIds) {
            $qb->andWhere($qb->expr()->notIn('IDENTITY(l.account)', ':excludeAccounts'))->setParameter('excludeAccounts', $excludeAccountIds);
        }

        $lines = $qb->getQuery()->getResult();

        $candidates = [];
        foreach ($lines as $line) {
            /* @var Line $line */
            $acc = $line->getAccount();
            $comparable = $this->comparableAmount($line, $acc, $targetCurrency, $direct);
            if (null === $comparable || abs($comparable - $targetAmount) >= 0.005) {
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
            'transactionId' => $c['line']->getTransaction()->getId(),
            'line' => $this->ledgerState->lineToArray($c['line']),
            'account' => $this->ledgerState->accountToArray($c['account']),
        ], $candidates);
    }

    // Mirrors getComparableAmount (direct=false) / getDirectComparableAmount
    // (direct=true) exactly — see lib/matching.js.
    private function comparableAmount(Line $line, Account $acc, string $targetCurrency, bool $direct): ?float
    {
        if ('investment' === $acc->getType()) {
            if ($line->getCashCurrency() !== $targetCurrency || null === $line->getCashValue()) {
                return null;
            }

            return $direct ? -$line->getCashValue() : $line->getCashValue();
        }
        if ($acc->getCurrency() === $targetCurrency) {
            return $line->getAmount();
        }
        if (!$direct && $line->getExchangeCurrency() === $targetCurrency) {
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
