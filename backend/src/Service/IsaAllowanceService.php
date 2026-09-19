<?php

namespace App\Service;

use App\Entity\Account;
use App\Entity\Line;
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

    /** @return array{byKind: array<string, int>, total: int} */
    public function computeUsage(int $startYear): array
    {
        $start = sprintf('%d-04-06', $startYear);
        $end = sprintf('%d-04-05', $startYear + 1);

        $byKind = array_fill_keys(self::ISA_KINDS, 0);

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
            return ['byKind' => $byKind, 'total' => 0];
        }

        $transactions = $this->transactionsTouching($isaAccountIds);

        // Non-flexible: every deposit counts, withdrawals never reduce
        // anything.
        foreach (array_filter($products, static fn ($p) => !$p['flexible']) as $product) {
            $deposits = 0;
            foreach ($transactions as $t) {
                foreach ($t['lines'] as $line) {
                    if (!\in_array($line['accountId'], $product['accountIds'], true)) {
                        continue;
                    }
                    $amount = $this->contributionAmount($line, $accounts);
                    if (null === $amount || $amount <= 0) {
                        continue;
                    }
                    if ($line['date'] < $start || $line['date'] > $end) {
                        continue;
                    }
                    if ($this->isExternalLine($t, $line, $accounts)) {
                        $deposits += $amount;
                    }
                }
            }
            $byKind[$product['kind']] = ($byKind[$product['kind']] ?? 0) + $deposits;
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
                    'priorReplaceable' => 0,
                    'thisYearBalance' => 0,
                ];
                foreach ($p['accountIds'] as $id) {
                    $accountToProduct[$id] = $p;
                }
            }
            $globalReplaceable = 0; // this-year money, replaceable into any flexible ISA

            $events = [];
            foreach ($transactions as $t) {
                foreach ($t['lines'] as $line) {
                    $product = $accountToProduct[$line['accountId']] ?? null;
                    if (!$product) {
                        continue;
                    }
                    $amount = $this->contributionAmount($line, $accounts);
                    if (null === $amount || !$amount) {
                        continue;
                    }
                    if ($line['date'] < $start || $line['date'] > $end) {
                        continue;
                    }
                    if ($this->isExternalLine($t, $line, $accounts)) {
                        $events[] = ['date' => $line['date'], 'type' => 'external', 'amount' => $amount, 'product' => $product];
                    } elseif ($this->isIsaTransferLine($t, $line, $accounts)) {
                        // A transfer of already-subscribed capital between
                        // two of the user's own ISA products — not a new
                        // subscription (isExternalLine() already says so),
                        // but the money still needs to be tracked into the
                        // receiving product, or a later withdrawal-and-
                        // replacement of this same money would wrongly look
                        // like a fresh subscription (it did once, for real
                        // data — see CLAUDE.md's ISA allowance engine notes).
                        $events[] = ['date' => $line['date'], 'type' => 'transfer', 'amount' => $amount, 'product' => $product];
                    }
                }
            }
            usort($events, static fn ($a, $b) => $a['date'] <=> $b['date']);

            foreach ($events as $ev) {
                $key = $ev['product']['accountId'];
                $s = $state[$key];
                if ('transfer' === $ev['type']) {
                    if ($ev['amount'] < 0) {
                        // Money leaving this flexible product for another
                        // of the user's own ISAs — draw down whatever's
                        // tracked here so it doesn't linger as phantom
                        // replaceable capacity in this product.
                        $w = -$ev['amount'];
                        $fromThisYear = min($w, $s['thisYearBalance']);
                        $s['thisYearBalance'] -= $fromThisYear;
                        $w -= $fromThisYear;
                        $fromPrior = min($w, $s['priorBalance']);
                        $s['priorBalance'] -= $fromPrior;
                    } else {
                        // Money arriving from another of the user's own
                        // ISAs. Its this-year/prior split at the sending
                        // side isn't tracked through the transfer (see
                        // CLAUDE.md's "no flexible-ISA partial-year
                        // handling" scope note) — credited conservatively
                        // as this product's own older money, replaceable
                        // only back into this same account, never toward
                        // another flexible ISA's headroom. That's enough to
                        // fix the common case (money transferred in, later
                        // withdrawn and put back into the same account)
                        // without claiming cross-ISA replaceability the
                        // data can't actually verify.
                        $s['priorBalance'] += $ev['amount'];
                    }
                } elseif ($ev['amount'] < 0) {
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
                $byKind[$s['product']['kind']] = ($byKind[$s['product']['kind']] ?? 0) + max(0, $s['thisYearBalance']);
            }
        }

        return ['byKind' => $byKind, 'total' => array_sum($byKind)];
    }

    /** @param array<int, array<string, mixed>> $accounts */
    private function isaProducts(array $accounts): array
    {
        $products = [];
        foreach ($accounts as $a) {
            if ('investment-parent' === $a['type'] && 'stocks-shares-isa' === ($a['isaKind'] ?? null)) {
                $childIds = array_values(array_map(
                    static fn ($x) => $x['id'],
                    array_filter($accounts, static fn ($x) => ($x['parentId'] ?? null) === $a['id'])
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
     * A line's other leg counts as "internal to the ISA" — and so doesn't
     * make this line a new subscription — either because that account is
     * itself ISA-tagged (`isaKind`, a transfer between two of the user's
     * own ISA products) or because it's an `isa-income` account (a
     * dividend/interest credit generated *inside* an ISA, which HMRC
     * doesn't count against the subscription limit even though the money
     * is genuinely new — see CLAUDE.md's "ISA allowance engine"). Unlike
     * `isaKind` accounts, `isa-income` accounts aren't themselves one of
     * the `isaProducts()` — they never accrue usage of their own, they
     * only ever appear here as a counterpart.
     *
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

        return !array_any($others, function ($l) use ($accounts) {
            $oAcc = $this->findAccount($accounts, $l['accountId']);

            return $oAcc && (!empty($oAcc['isaKind']) || 'isa-income' === $oAcc['type']);
        });
    }

    /**
     * True when this line's other leg sits on a real ISA product account
     * (`isaKind`) — a transfer of already-subscribed capital between two
     * of the user's own ISAs, as opposed to an `isa-income` counterpart
     * (interest/dividends generated inside the ISA, never subscribed
     * money, deliberately left untracked by the flexible pool simulation).
     * Only meaningful for a line `isExternalLine()` has already said is
     * *not* external.
     *
     * @param array<string, mixed>             $t
     * @param array<string, mixed>             $line
     * @param array<int, array<string, mixed>> $accounts
     */
    private function isIsaTransferLine(array $t, array $line, array $accounts): bool
    {
        $others = array_filter($t['lines'], static fn ($l) => $l['accountId'] !== $line['accountId']);

        return array_any($others, function ($l) use ($accounts) {
            $oAcc = $this->findAccount($accounts, $l['accountId']);

            return $oAcc && !empty($oAcc['isaKind']);
        });
    }

    /**
     * @param array<string, mixed>             $product
     * @param array<int, array<string, mixed>>  $accounts
     * @param array<int, array<string, mixed>>  $transactions
     */
    private function priorPoolEntering(array $product, array $accounts, array $transactions, string $yearStart): int
    {
        $pool = 0;
        foreach ($product['accountIds'] as $id) {
            $acc = $this->findAccount($accounts, $id);
            if ($acc) {
                $pool += $acc['openingBalance'] ?? 0;
            }
        }
        foreach ($transactions as $t) {
            foreach ($t['lines'] as $line) {
                if (!\in_array($line['accountId'], $product['accountIds'], true)) {
                    continue;
                }
                $amount = $this->contributionAmount($line, $accounts);
                if (null === $amount || !$amount) {
                    continue;
                }
                if ($line['date'] >= $yearStart) {
                    continue;
                }
                if ($this->isExternalLine($t, $line, $accounts)) {
                    $pool += $amount;
                }
            }
        }

        return max(0, $pool);
    }

    /**
     * The line's contribution to the ISA pool, in currency-scale units.
     * `amount` is a cash figure for every account type except
     * `investment`, where it's a unit count scaled by the Symbol's own
     * scale (see CLAUDE.md's "Amounts, currencies, and reference data").
     * For an investment line we use `cashValue` instead — same
     * mirrored-sign convention as `amount` (positive = value entering the
     * account) — and treat an untagged trade (no `cashValue`) as having no
     * verifiable cash contribution rather than guessing.
     *
     * @param array<string, mixed>             $line
     * @param array<int, array<string, mixed>> $accounts
     */
    private function contributionAmount(array $line, array $accounts): ?int
    {
        $acc = $this->findAccount($accounts, $line['accountId']);
        if ($acc && 'investment' === $acc['type']) {
            return $line['cashValue'] ?? null;
        }

        return $line['amount'];
    }

    /** @param array<int, array<string, mixed>> $accounts */
    private function findAccount(array $accounts, string $id): ?array
    {
        return array_find($accounts, static fn ($a) => $a['id'] === $id);
    }

    /**
     * Every record (linked transaction or standalone line) touching any
     * of these accounts, in the same `{transactionId, lines}` shape
     * readState()/accountLedger() use. A standalone line has no siblings
     * to check in isExternalLine(), so it's trivially always external —
     * but it still has to actually appear here, or a withdrawal-turned-
     * standalone-deposit would silently vanish from the simulation.
     *
     * @param string[] $accountIds
     *
     * @return array<int, array<string, mixed>>
     */
    private function transactionsTouching(array $accountIds): array
    {
        $placeholders = implode(',', array_fill(0, \count($accountIds), '?'));

        $records = [];

        $transactionIds = $this->em->getConnection()->fetchFirstColumn(
            "SELECT DISTINCT transaction_id FROM line WHERE account_id IN ({$placeholders}) AND transaction_id IS NOT NULL",
            $accountIds
        );
        if ($transactionIds) {
            $transactions = $this->em->getRepository(Transaction::class)->findBy(['id' => $transactionIds]);
            foreach ($transactions as $transaction) {
                $records[] = $this->ledgerState->transactionRecordToArray($transaction);
            }
        }

        $qb = $this->em->createQueryBuilder();
        $standaloneLines = $qb->select('l')
            ->from(Line::class, 'l')
            ->where($qb->expr()->in('IDENTITY(l.account)', ':accountIds'))
            ->andWhere('l.transaction IS NULL')
            ->setParameter('accountIds', $accountIds)
            ->getQuery()->getResult();
        foreach ($standaloneLines as $line) {
            $records[] = $this->ledgerState->standaloneRecordToArray($line);
        }

        return $records;
    }
}
