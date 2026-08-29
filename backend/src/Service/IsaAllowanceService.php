<?php

namespace App\Service;

use App\Entity\Account;
use App\Entity\Transaction;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Ported from src/lib/isa.js's computeIsaUsage/isaProducts/isExternalLine/
 * priorPoolEntering — kept as close as possible to that source (same
 * variable names, same order of operations) to make auditing the two side
 * by side easy. See CLAUDE.md's "ISA allowance engine" section for why
 * the flexible-ISA lot-tracking has to be simulated chronologically
 * rather than computed as a running deposits-minus-withdrawals total —
 * that mistake produced wrong (negative) numbers before.
 *
 * isaRulesFor()/ISA_RULE_TABLE (the annual caps) and taxYearStartYearFor()/
 * taxYearBounds() stay client-side — they're pure, static rules over data
 * the frontend already has (today's date, the account list), not
 * something that needs a database. Only the actual usage computation,
 * which needs every ISA-tagged account's full transaction history,
 * lives here.
 */
class IsaAllowanceService
{
    private const ISA_KINDS = ['cash-isa', 'stocks-shares-isa', 'lifetime-isa', 'innovative-finance-isa'];

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly LedgerStateService $ledgerState,
    ) {
    }

    /** @return array{byKind: array<string, float>, total: float} */
    public function computeUsage(int $startYear): array
    {
        $start = sprintf('%d-04-06', $startYear);
        $end = sprintf('%d-04-05', $startYear + 1);

        $byKind = array_fill_keys(self::ISA_KINDS, 0.0);

        $accounts = array_map($this->ledgerState->accountToArray(...), $this->em->getRepository(Account::class)->findAll());
        $products = $this->isaProducts($accounts);

        $isaAccountIds = [];
        foreach ($products as $p) {
            foreach ($p['accountIds'] as $id) {
                $isaAccountIds[$id] = true;
            }
        }
        $isaAccountIds = array_keys($isaAccountIds);
        if (!$isaAccountIds) {
            return ['byKind' => $byKind, 'total' => 0.0];
        }

        $transactions = $this->transactionsTouching($isaAccountIds);

        // Non-flexible: every deposit counts, withdrawals never reduce
        // anything.
        foreach (array_filter($products, static fn ($p) => !$p['flexible']) as $product) {
            $deposits = 0.0;
            foreach ($transactions as $t) {
                foreach ($t['lines'] as $line) {
                    if (!\in_array($line['accountId'], $product['accountIds'], true) || $line['amount'] <= 0) {
                        continue;
                    }
                    if ($line['date'] < $start || $line['date'] > $end) {
                        continue;
                    }
                    if ($this->isExternalLine($t, $line, $accounts)) {
                        $deposits += $line['amount'];
                    }
                }
            }
            $byKind[$product['kind']] = ($byKind[$product['kind']] ?? 0.0) + $deposits;
        }

        // Flexible: simulate withdrawal/replacement ordering together, in
        // date order across all of them, since a this-year withdrawal
        // from one can be replaced into another.
        $flexProducts = array_values(array_filter($products, static fn ($p) => $p['flexible']));
        if ($flexProducts) {
            $state = [];
            $accountToProduct = [];
            foreach ($flexProducts as $p) {
                $state[$p['accountId']] = [
                    'product' => $p,
                    'priorBalance' => $this->priorPoolEntering($p, $accounts, $transactions, $start),
                    'priorReplaceable' => 0.0,
                    'thisYearBalance' => 0.0,
                ];
                foreach ($p['accountIds'] as $id) {
                    $accountToProduct[$id] = $p;
                }
            }
            $globalReplaceable = 0.0; // this-year money, replaceable into any flexible ISA

            $events = [];
            foreach ($transactions as $t) {
                foreach ($t['lines'] as $line) {
                    $product = $accountToProduct[$line['accountId']] ?? null;
                    if (!$product || !$line['amount']) {
                        continue;
                    }
                    if ($line['date'] < $start || $line['date'] > $end) {
                        continue;
                    }
                    if ($this->isExternalLine($t, $line, $accounts)) {
                        $events[] = ['date' => $line['date'], 'amount' => $line['amount'], 'product' => $product];
                    }
                }
            }
            usort($events, static fn ($a, $b) => $a['date'] <=> $b['date']);

            foreach ($events as $ev) {
                $key = $ev['product']['accountId'];
                $s = $state[$key];
                if ($ev['amount'] < 0) {
                    // Withdrawal: this year's own money goes first, freeing
                    // capacity usable anywhere; anything beyond that draws
                    // on older money, freeing capacity usable only back
                    // into this same ISA.
                    $w = -$ev['amount'];
                    $fromThisYear = min($w, $s['thisYearBalance']);
                    $s['thisYearBalance'] -= $fromThisYear;
                    $globalReplaceable += $fromThisYear;
                    $w -= $fromThisYear;
                    $fromPrior = min($w, $s['priorBalance']);
                    $s['priorBalance'] -= $fromPrior;
                    $s['priorReplaceable'] += $fromPrior;
                } else {
                    // Deposit: first pays down this ISA's own
                    // same-account-only replacement obligation, then any
                    // outstanding this-year capacity from anywhere, and
                    // only what's left over is a genuinely new
                    // subscription.
                    $d = $ev['amount'];
                    $fillPrior = min($d, $s['priorReplaceable']);
                    $s['priorReplaceable'] -= $fillPrior;
                    $s['priorBalance'] += $fillPrior;
                    $d -= $fillPrior;
                    $fillGlobal = min($d, $globalReplaceable);
                    $globalReplaceable -= $fillGlobal;
                    $s['thisYearBalance'] += $fillGlobal;
                    $d -= $fillGlobal;
                    $s['thisYearBalance'] += $d;
                }
                $state[$key] = $s;
            }

            // A product's displayed usage is simply how much
            // this-year-sourced money is currently sitting in it — see
            // isa.js's computeIsaUsage for the full reasoning.
            foreach ($state as $s) {
                $byKind[$s['product']['kind']] = ($byKind[$s['product']['kind']] ?? 0.0) + max(0.0, $s['thisYearBalance']);
            }
        }

        return ['byKind' => $byKind, 'total' => array_sum($byKind)];
    }

    /** @param array<int, array<string, mixed>> $accounts */
    private function isaProducts(array $accounts): array
    {
        $products = [];
        foreach ($accounts as $a) {
            if ('isa-parent' === $a['type']) {
                $childIds = array_values(array_map(
                    static fn ($x) => $x['id'],
                    array_filter($accounts, static fn ($x) => ($x['isaParentId'] ?? null) === $a['id'])
                ));
                $products[] = [
                    'accountId' => $a['id'],
                    'kind' => 'stocks-shares-isa',
                    'flexible' => !empty($a['flexible']),
                    'accountIds' => $childIds,
                ];
            } elseif (!empty($a['isaKind']) && 'stocks-shares-isa' !== $a['isaKind']) {
                $products[] = [
                    'accountId' => $a['id'],
                    'kind' => $a['isaKind'],
                    'flexible' => !empty($a['flexible']),
                    'accountIds' => [$a['id']],
                ];
            }
        }

        return $products;
    }

    /**
     * @param array<string, mixed>            $t
     * @param array<string, mixed>            $line
     * @param array<int, array<string, mixed>> $accounts
     */
    private function isExternalLine(array $t, array $line, array $accounts): bool
    {
        $others = array_filter($t['lines'], static fn ($l) => $l['accountId'] !== $line['accountId']);
        if (!$others) {
            return true;
        }
        foreach ($others as $l) {
            $oAcc = $this->findAccount($accounts, $l['accountId']);
            if ($oAcc && !empty($oAcc['isaKind'])) {
                return false;
            }
        }

        return true;
    }

    /**
     * @param array<string, mixed>             $product
     * @param array<int, array<string, mixed>>  $accounts
     * @param array<int, array<string, mixed>>  $transactions
     */
    private function priorPoolEntering(array $product, array $accounts, array $transactions, string $yearStart): float
    {
        $pool = 0.0;
        foreach ($product['accountIds'] as $id) {
            $acc = $this->findAccount($accounts, $id);
            if ($acc) {
                $pool += $acc['openingBalance'] ?? 0.0;
            }
        }
        foreach ($transactions as $t) {
            foreach ($t['lines'] as $line) {
                if (!\in_array($line['accountId'], $product['accountIds'], true) || !$line['amount']) {
                    continue;
                }
                if ($line['date'] >= $yearStart) {
                    continue;
                }
                if ($this->isExternalLine($t, $line, $accounts)) {
                    $pool += $line['amount'];
                }
            }
        }

        return max(0.0, $pool);
    }

    /** @param array<int, array<string, mixed>> $accounts */
    private function findAccount(array $accounts, string $id): ?array
    {
        foreach ($accounts as $a) {
            if ($a['id'] === $id) {
                return $a;
            }
        }

        return null;
    }

    /**
     * @param string[] $accountIds
     *
     * @return array<int, array<string, mixed>>
     */
    private function transactionsTouching(array $accountIds): array
    {
        $placeholders = implode(',', array_fill(0, \count($accountIds), '?'));
        $rows = $this->em->getConnection()->fetchFirstColumn(
            "SELECT DISTINCT transaction_id FROM line WHERE account_id IN ({$placeholders})",
            $accountIds
        );
        if (!$rows) {
            return [];
        }

        $transactions = $this->em->getRepository(Transaction::class)->findBy(['id' => $rows]);

        return array_map($this->ledgerState->transactionToArray(...), $transactions);
    }
}
