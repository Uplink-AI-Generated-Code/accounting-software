<?php

namespace App\Service;

use App\Entity\Account;
use App\Entity\Counterparty;
use App\Entity\Currency;
use App\Entity\Line;
use App\Entity\Symbol;
use App\Entity\Tag;
use App\Entity\Transaction;
use App\Service\AppSettingsRepository;
use App\Service\SettingKeys;
use App\Service\SettingsService;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Owns every read/write path for the ledger's data.
 *
 * A **record** is the unit the frontend edits: either a linked
 * `Transaction` (2+ lines) — `{transactionId: string, lines: [...]}` — or a
 * standalone, unpaired `Line` with no Transaction at all —
 * `{transactionId: null, lines: [oneLine]}`. `Transaction` exists strictly
 * to link 2+ lines together; it is never created for a lone entry. See
 * CLAUDE.md's "Data model" section.
 *
 * Three kinds of caller:
 *
 *  - The discrete per-entity endpoints (AccountController,
 *    SettingsController, TransactionController): upsertAccount(),
 *    deleteAccount(), patchSettings(), applyLedgerOperations() —
 *    each one a single, independently-atomic mutation. This is the live
 *    app's normal write path.
 *  - AccountController::list()/::ledger(): accountsWithStats(),
 *    accountLedger() — the two reads the frontend actually uses.
 *  - ImportLocalStorageCommand / ExportStateCommand: writeState() /
 *    readState(), a wipe-and-rebuild / full read of everything. This is
 *    intentionally *not* built out of the discrete methods above — a
 *    first-time import or a full backup is genuinely an "everything at
 *    once" operation.
 *
 * Compound frontend actions — merging two entries, splitting a removed
 * line off into its own record, reordering several same-date rows,
 * demoting a transaction back to a standalone line — become a single
 * applyLedgerOperations() call carrying an ordered list of
 * upsert/delete-line/upsert/delete-transaction operations, applied in one
 * DB transaction. That's the one place multiple rows still need to change
 * atomically together; accounts and settings never had that requirement.
 */
class LedgerStateService
{
    /**
     * JS's Number.MAX_SAFE_INTEGER (2^53). A rescale increase that would
     * push any existing stored amount's magnitude past this is refused —
     * see rescaleCurrency()/rescaleSymbol()'s increase-branch headroom
     * check. This app's amounts cross the JSON API boundary as plain
     * integers, read back into JS numbers on the frontend (see CLAUDE.md's
     * "Amounts, currencies, and reference data") — PHP's own 64-bit ints
     * have far more headroom than this, but the frontend doesn't.
     */
    private const JS_MAX_SAFE_INTEGER = 9007199254740992;

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly SettingsService $settingsService,
        private readonly AppSettingsRepository $appSettingsRepository,
    ) {
    }

    /** @return array{accounts: array<int, array<string, mixed>>, records: array<int, array<string, mixed>>, settings: array<string, mixed>, currencies: array<int, array<string, mixed>>} */
    public function readState(): array
    {
        return [
            'accounts' => $this->accountsArray(),
            'records' => $this->recordsArray(),
            'settings' => $this->settingsToArray(),
            'currencies' => $this->currenciesArray(),
        ];
    }

    /**
     * The lightweight, always-loaded account list — GET /api/accounts.
     * No line-level data; each account carries its own computed balance
     * (and, for investment accounts, cost basis / portfolio value) so the
     * frontend never has to load every account's full transaction history
     * just to render the sidebar or Overview.
     *
     * @return array<int, array<string, mixed>>
     */
    public function accountsWithStats(): array
    {
        $accounts = $this->em->getRepository(Account::class)->findAll();
        $imbalance = $this->imbalanceStatsByAccount();

        return array_map(function (Account $a) use ($imbalance) {
            $arr = $this->accountToArray($a);
            $arr['balance'] = $this->balanceFor($a);
            $arr['entryCount'] = $this->entryCountFor($a);
            if ('investment' === $a->getType()) {
                ['cost' => $cost, 'value' => $value] = $this->stockStatsFor($a);
                $arr['costBasis'] = $cost;
                $arr['portfolioValue'] = $value;
            }
            if (isset($imbalance[$a->getId()])) {
                $arr['imbalancedLineCount'] = $imbalance[$a->getId()]['count'];
                $arr['imbalanceIn'] = $imbalance[$a->getId()]['in'];
                $arr['imbalanceOut'] = $imbalance[$a->getId()]['out'];
            }

            return $arr;
        }, $accounts);
    }

    /**
     * Every record touching one account: a standalone line the account
     * itself owns, or a full linked transaction (complete with *all* of
     * its lines, not just this account's own) for anything the account is
     * linked into. This is what a ledger screen loads on open and
     * discards on navigating away, instead of the whole ledger ever
     * living in the frontend.
     *
     * @return array<int, array<string, mixed>>
     */
    public function accountLedger(string $id): array
    {
        $account = $this->em->getRepository(Account::class)->find($id);
        if (!$account) {
            return [];
        }

        $lines = $this->em->getRepository(Line::class)->findBy(['account' => $account]);

        $records = [];
        $transactionIds = [];
        foreach ($lines as $line) {
            $transaction = $line->getTransaction();
            if ($transaction) {
                $transactionIds[$transaction->getId()] = true;
            } else {
                $records[] = $this->standaloneRecordToArray($line);
            }
        }

        if ($transactionIds) {
            $transactions = $this->em->getRepository(Transaction::class)->findBy(['id' => array_keys($transactionIds)]);
            foreach ($transactions as $transaction) {
                $records[] = $this->transactionRecordToArray($transaction);
            }
        }

        return $records;
    }

    private function balanceFor(Account $a): int
    {
        $sum = (int) $this->em->getConnection()->fetchOne(
            'SELECT COALESCE(SUM(amount), 0) FROM line WHERE account_id = ?',
            [$a->getId()]
        );

        return ($a->getOpeningBalance() ?? 0) + $sum;
    }

    private function entryCountFor(Account $a): int
    {
        return (int) $this->em->getConnection()->fetchOne(
            'SELECT COUNT(*) FROM line WHERE account_id = ?',
            [$a->getId()]
        );
    }

    /**
     * "Imbalanced" mirrors lib/matching.js's balanceHint() exactly — a
     * record (linked Transaction or standalone Line) is imbalanced if it's
     * a lone unmatched line ("single"), or its lines' values don't net to
     * zero within each currency ("unbalanced"); a genuine two-currency
     * exchange ("fx", opposite-signed legs) and an empty/all-zero record
     * are *not* imbalanced. Every line of an imbalanced record counts
     * toward its own account's stats, split into `in` (sum of its
     * positive-valued imbalanced lines) and `out` (sum of the magnitude
     * of its negative-valued ones) — the same sign convention the
     * ledger's own In/Out columns already use (see CLAUDE.md's "Data
     * model": positive = increase, negative = decrease). Keeping these
     * separate rather than netting them into one signed value is
     * deliberate — an account can have a large `in` and a large `out`
     * that happen to cancel, which a single net figure would hide
     * entirely. This has to be computed globally in one pass (a record's
     * lines can span more than one account), not per-account, since
     * GET /api/accounts is the one place the frontend gets this without
     * loading every account's own ledger — see CLAUDE.md's "The frontend
     * is a per-account editor" and "Matching and linking".
     *
     * @return array<string, array{count: int, in: int, out: int}>
     */
    private function imbalanceStatsByAccount(): array
    {
        $accountsById = [];
        foreach ($this->em->getRepository(Account::class)->findAll() as $a) {
            $accountsById[$a->getId()] = $this->accountToArray($a);
        }

        $stats = [];
        foreach ($this->em->getRepository(Transaction::class)->findAll() as $t) {
            $this->accumulateImbalance(array_map($this->lineToArray(...), $t->getLines()->toArray()), $accountsById, $stats);
        }
        foreach ($this->em->getRepository(Line::class)->findBy(['transaction' => null]) as $l) {
            $this->accumulateImbalance([$this->lineToArray($l)], $accountsById, $stats);
        }

        return $stats;
    }

    /**
     * @param array<int, array<string, mixed>>              $lines
     * @param array<string, array<string, mixed>>           $accountsById
     * @param array<string, array{count: int, in: int, out: int}> $stats
     */
    private function accumulateImbalance(array $lines, array $accountsById, array &$stats): void
    {
        $enriched = [];
        foreach ($lines as $line) {
            $accId = $line['accountId'] ?? null;
            if (!$accId || !isset($accountsById[$accId])) {
                continue;
            }
            $acc = $accountsById[$accId];
            $bv = $this->lineBalanceValue($line, $acc);
            if (null === $bv || 0 === $bv['value']) {
                continue;
            }
            $enriched[] = ['accountId' => $accId, 'type' => $acc['type'] ?? null, ...$bv];
        }

        if (\count($enriched) === 0) {
            return; // "empty" — nothing to balance.
        }
        // count===1 is "single" (an unmatched standalone line) — always
        // imbalanced, same as balanceHint(). Only run the balance check
        // once there's more than one contributing line.
        $imbalanced = 1 === \count($enriched) || !$this->enrichedIsBalanced($enriched);
        if (!$imbalanced) {
            return;
        }

        foreach ($enriched as $e) {
            $stats[$e['accountId']] ??= ['count' => 0, 'in' => 0, 'out' => 0];
            ++$stats[$e['accountId']]['count'];
            if ($e['value'] > 0) {
                $stats[$e['accountId']]['in'] += $e['value'];
            } else {
                $stats[$e['accountId']]['out'] += -$e['value'];
            }
        }
    }

    /**
     * The line's contribution to a balance check, in real cash terms —
     * ported from lib/matching.js's lineBalanceValue(). An investment
     * line's `amount` is units, not cash, so its contribution is the
     * trade's cash side instead; a stock line with no cash info recorded
     * contributes nothing verifiable and is excluded.
     *
     * @param array<string, mixed> $line
     * @param array<string, mixed> $acc
     *
     * @return array{value: int, currency: string}|null
     */
    private function lineBalanceValue(array $line, array $acc): ?array
    {
        if ('investment' === ($acc['type'] ?? null)) {
            if (isset($line['cashValue'], $line['cashCurrency'])) {
                return ['value' => (int) $line['cashValue'], 'currency' => (string) $line['cashCurrency']];
            }

            return null;
        }

        return ['value' => (int) ($line['amount'] ?? 0), 'currency' => $acc['currency'] ?? '???'];
    }

    /**
     * True for "balanced" (nets to zero) and "fx" (a legitimate two-leg,
     * two-currency, opposite-signed exchange) — both non-imbalanced. False
     * for "unbalanced" — same-direction legs, or nonzero leftover in any
     * currency. Caller already excludes the single-line ("single") case.
     * Mirrors lib/matching.js's balanceHint() byCur/curs logic exactly.
     *
     * @param array<int, array{accountId: string, type: ?string, value: int, currency: string}> $enriched
     */
    private function enrichedIsBalanced(array $enriched): bool
    {
        $byCur = [];
        foreach ($enriched as $e) {
            $byCur[$e['currency']] = ($byCur[$e['currency']] ?? 0) + $e['value'];
        }
        $curs = array_keys($byCur);

        if (1 === \count($curs)) {
            return 0 === $byCur[$curs[0]];
        }
        if (2 === \count($curs) && 2 === \count($enriched)) {
            [$a, $b] = $enriched;

            return ($a['value'] > 0) !== ($b['value'] > 0);
        }

        return array_all($curs, static fn ($c) => 0 === $byCur[$c]);
    }

    /**
     * Every line for one investment account, in the exact order the
     * frontend's own ledger rows use — date, then order (ties default to
     * 0), then a final tiebreak — since cost basis and portfolio value
     * are both running computations where same-day ordering can change
     * the result (see lib/stockMath.js). The tiebreak is the owning
     * transaction's id for a linked line, or the line's own id for a
     * standalone one — either way, stable and deterministic.
     *
     * @return Line[]
     */
    private function orderedLinesFor(Account $a): array
    {
        $lines = $this->em->getRepository(Line::class)->findBy(['account' => $a]);
        usort($lines, static function (Line $x, Line $y) {
            if ($x->getDate() !== $y->getDate()) {
                return $x->getDate() <=> $y->getDate();
            }
            $ox = $x->getLineOrder() ?? 0;
            $oy = $y->getLineOrder() ?? 0;
            if ($ox !== $oy) {
                return $ox <=> $oy;
            }
            $xTie = $x->getTransaction()?->getId() ?? (string) $x->getId();
            $yTie = $y->getTransaction()?->getId() ?? (string) $y->getId();

            return $xTie <=> $yTie;
        });

        return $lines;
    }

    /**
     * Cost basis (average-cost method) and "mark to last trade" portfolio
     * value — ported from lib/stockMath.js's applyCostBasisLine /
     * applyPortfolioValueLine. Kept as a single walk over the account's
     * own ordered lines so the two numbers can never drift from what the
     * frontend would compute given the same data.
     *
     * All arithmetic here is exact integer arithmetic — no floats — per
     * CLAUDE.md. `cost`/`cashValue` are currency-scale integers, `units`/
     * `amount` are symbol-scale integers; a cross-multiply-then-divide
     * (see divRoundHalfUp()) keeps every intermediate value an exact
     * integer of the correct implied scale without this method ever
     * needing to know either scale explicitly. Portfolio value keeps the
     * last trade's raw cashValue/units pair rather than a pre-rounded
     * price, and divides only once, at the end, to avoid compounding
     * rounding error across many trades.
     *
     * A carried-forward opening position (Account::$openingBalance /
     * $openingBalanceCashValue — set by app:new-year when rolling an
     * investment account into a fresh tax year's database, see
     * CLAUDE.md) seeds both walks instead of starting at zero, so this
     * total agrees with the account's own ledger view (StockLedger.jsx
     * seeds its running column the same way) even before any line exists
     * in the new database.
     *
     * @return array{cost: int, value: int}
     */
    private function stockStatsFor(Account $a): array
    {
        $openingUnits = $a->getOpeningBalance() ?? 0;
        $openingCost = $a->getOpeningBalanceCashValue() ?? 0;
        $costState = ['units' => $openingUnits, 'cost' => $openingCost];
        $valueState = ['units' => $openingUnits, 'lastCashValue' => $openingCost, 'lastUnits' => $openingUnits];

        foreach ($this->orderedLinesFor($a) as $line) {
            $this->applyCostBasisLine($costState, $line);
            $this->applyPortfolioValueLine($valueState, $line);
        }

        $value = 0 !== $valueState['lastUnits']
            ? $this->divRoundHalfUp($valueState['units'] * $valueState['lastCashValue'], $valueState['lastUnits'])
            : 0;

        return ['cost' => $costState['cost'], 'value' => $value];
    }

    /** @param array{units: int, cost: int} $state */
    private function applyCostBasisLine(array &$state, Line $l): void
    {
        $amount = $l->getAmount();
        if ($amount > 0) {
            $state['units'] += $amount;
            $state['cost'] += $l->getCashValue() ?? 0;
        } elseif ($amount < 0) {
            $sold = min(-$amount, $state['units']);
            $costRemoved = $state['units'] > 0
                ? $this->divRoundHalfUp($state['cost'] * $sold, $state['units'])
                : 0;
            $state['cost'] -= $costRemoved;
            $state['units'] -= $sold;
            if (0 === $state['units']) {
                // Exact by construction once units is an integer — this
                // only absorbs ±1-minor-unit rounding dust left over from
                // divRoundHalfUp() above, not float fuzz.
                $state['cost'] = 0;
            }
        }
    }

    /** @param array{units: int, lastCashValue: int, lastUnits: int} $state */
    private function applyPortfolioValueLine(array &$state, Line $l): void
    {
        $state['units'] += $l->getAmount();
        if (0 !== $l->getAmount() && null !== $l->getCashValue()) {
            $state['lastCashValue'] = abs($l->getCashValue());
            $state['lastUnits'] = abs($l->getAmount());
        }
    }

    /**
     * Exact integer division with round-half-up, using only native int
     * arithmetic (no bcmath, no float division) — safe for any amount a
     * personal ledger could realistically hold, well within PHP's 64-bit
     * int range even after the ×2 below. Mirrored exactly in the frontend
     * (see lib/scale.js) so the two never disagree.
     */
    private function divRoundHalfUp(int $numerator, int $denominator): int
    {
        if (0 === $denominator) {
            return 0;
        }
        $sign = (($numerator < 0) xor ($denominator < 0)) ? -1 : 1;
        $num = abs($numerator);
        $den = abs($denominator);

        return $sign * intdiv(2 * $num + $den, 2 * $den);
    }

    /**
     * Wipes and rebuilds the whole ledger from a plain array in the same
     * shape readState() returns. Only used for a one-time import — see
     * the class docblock. `$recordsData` items are `{transactionId,
     * lines}`; `transactionId: null` (or a single-element `lines` in an
     * older, pre-standalone-line export — see
     * ImportLocalStorageCommand::upgradeLegacyShape()) creates a
     * standalone line instead of a Transaction.
     *
     * `$currenciesData` (`[{code, scale, name?}, ...]`) is **upserted**,
     * not wiped-and-rebuilt like account/line/transactions — a currency
     * is part of the imported data (a legacy database's own Currency
     * table, say — see CLAUDE.md), so whatever's here gets its scale/name
     * written, but nothing is deleted. A destructive full replace was
     * considered and rejected: `Symbol.tradingCurrency` (and this same
     * import's own account/line rows) hold `NOT DEFERRABLE INITIALLY
     * IMMEDIATE` foreign keys into `currency`, so deleting a code still
     * referenced by a Symbol this import doesn't also touch would throw
     * immediately, not silently orphan anything. Upsert gets the actual
     * goal — "the currencies this data needs now exist with the right
     * scale" — without that failure mode.
     *
     * @param array<int, array<string, mixed>> $accountsData
     * @param array<int, array<string, mixed>> $recordsData
     * @param array<string, mixed>             $settingsData
     * @param array<int, array<string, mixed>> $currenciesData
     */
    public function writeState(array $accountsData, array $recordsData, array $settingsData, array $currenciesData = []): void
    {
        $this->em->wrapInTransaction(function () use ($accountsData, $recordsData, $settingsData, $currenciesData) {
            foreach ($currenciesData as $data) {
                $this->hydrateCurrency($data);
            }
            $this->em->flush();

            $connection = $this->em->getConnection();
            // line_tag first — same reason as deleteTransactionLines():
            // even though SQLite's foreign_keys pragma is now enforced
            // everywhere (see ForeignKeysMiddleware), so ON DELETE CASCADE
            // on line_tag does fire on its own now, this explicit delete is
            // kept for clarity/defense-in-depth rather than relied upon
            // implicitly.
            $connection->executeStatement('DELETE FROM line_tag');
            $connection->executeStatement('DELETE FROM line');
            $connection->executeStatement('DELETE FROM transactions');
            $connection->executeStatement('DELETE FROM account');

            // Two passes: an import file has no guaranteed ordering (a
            // hand-authored or externally-produced one especially — see
            // ImportLocalStorageCommand), so a child account can appear
            // before its own parent in $accountsData. The first pass
            // builds every Account object with its scalar fields — but no
            // `parent` set, and *not yet persisted or flushed* — into an
            // in-memory map keyed by id, so every account (however ordered
            // in the input) is resolvable by the second pass, which wires
            // up `parent` and re-validates the investment-requires-parent
            // rule now that the full set is known. Only then are all the
            // accounts persisted and flushed together, in one INSERT batch
            // that already carries the right `parent_id` on every row —
            // this has to happen in this order (build+link, then
            // persist+flush), not persist-then-link-then-flush, because
            // the schema's own `CHECK (type != 'investment' OR parent_id
            // IS NOT NULL)` is enforced per-row at INSERT time: an
            // investment account inserted with a still-null parent_id
            // (to be filled in by a second flush) would violate it
            // immediately, even though the batch as a whole is
            // consistent. hydrateAccount() itself keeps resolving/
            // validating parent immediately for the single-account
            // `upsertAccount()` path, which never has this ordering
            // problem (a client can't reference an unpersisted account).
            $accountsById = [];
            foreach ($accountsData as $data) {
                $account = $this->hydrateAccount(new Account(), $data, withParent: false);
                $account->setId((string) $data['id']);
                $accountsById[$account->getId()] = $account;
            }

            foreach ($accountsData as $data) {
                $account = $accountsById[(string) $data['id']];
                $parent = $this->resolveParentFromBatch($data['parentId'] ?? null, $accountsById);
                $account->setParent($parent);

                if ('investment' === $account->getType() && null === $parent) {
                    throw new \InvalidArgumentException('An investment account must have a parent wrapper.');
                }
            }

            foreach ($accountsById as $account) {
                $this->em->persist($account);
            }
            $this->em->flush();

            foreach ($recordsData as $data) {
                $transactionId = $data['transactionId'] ?? null;
                $lines = $data['lines'] ?? [];

                $transaction = null;
                if (null !== $transactionId) {
                    $transaction = new Transaction();
                    $transaction->setId((string) $transactionId);
                    $this->em->persist($transaction);
                }

                foreach ($lines as $lineData) {
                    $accountId = (string) ($lineData['accountId'] ?? '');
                    if (!isset($accountsById[$accountId])) {
                        // A line pointing at an account that isn't in this
                        // import is malformed input — skip rather than
                        // fail the whole import.
                        continue;
                    }
                    $line = $this->hydrateLine(new Line(), $lineData, $transaction, $accountsById[$accountId]);
                    $this->em->persist($line);
                }
            }

            $this->settingsService->set(SettingKeys::OVER_65, (bool) ($settingsData['over65'] ?? false));
        });
    }

    /** @param array<string, mixed> $data */
    public function upsertAccount(string $id, array $data): array
    {
        $account = $this->em->getRepository(Account::class)->find($id) ?? new Account();
        $account->setId($id);
        $this->hydrateAccount($account, $data);
        $this->em->persist($account);
        $this->em->flush();

        return $this->accountToArray($account);
    }

    /**
     * Deletes one account. Never deletes the other side of anything
     * linked to it — a transaction that also has lines in other accounts
     * just loses this account's own line; only a transaction that becomes
     * completely empty as a result is removed (a standalone line just
     * gets deleted outright — there's no wrapper to worry about). Same
     * semantics the frontend used to compute itself before persisting
     * (see CLAUDE.md).
     *
     * Deleting an account always navigates the frontend away from it, so
     * there's no ledger view left on screen that needs the result —
     * callers just re-fetch the lightweight account list afterward.
     */
    public function deleteAccount(string $id): void
    {
        $this->em->wrapInTransaction(function () use ($id) {
            $account = $this->em->getRepository(Account::class)->find($id);
            if (!$account) {
                return;
            }
            $lines = $this->em->getRepository(Line::class)->findBy(['account' => $account]);
            $touchedTransactionIds = [];
            foreach ($lines as $line) {
                $transaction = $line->getTransaction();
                if ($transaction) {
                    $touchedTransactionIds[$transaction->getId()] = true;
                }
                $this->em->remove($line);
            }
            $this->em->remove($account);
            $this->em->flush();

            foreach (array_keys($touchedTransactionIds) as $transactionId) {
                $this->deleteTransactionIfEmpty($transactionId);
            }
        });
    }

    /**
     * The stored settings plus this ledger's *computed* tax-year facts —
     * see CLAUDE.md's "The active tax year". `activeTaxYearStart` and
     * `outOfTaxYearLineCount` are never stored (there's no such column
     * any more); they're recomputed fresh on every call from the actual
     * line dates in the database, so they can never drift from reality
     * the way a cached value could. Not included in readState()'s export
     * shape (`settingsToArray()` alone) — matching how computed account
     * stats (`balance`, `costBasis`, ...) live only in
     * `accountsWithStats()`, not in the plain export.
     *
     * @return array<string, mixed>
     */
    public function getSettings(): array
    {
        $arr = $this->settingsToArray();
        $global = $this->appSettingsRepository->read();
        $arr['groupLevels'] = $global['groupLevels'];
        $arr['savedGroupings'] = $global['savedGroupings'];

        $taxYearStart = $this->determinedTaxYearStart();
        $arr['activeTaxYearStart'] = $taxYearStart;
        $arr['outOfTaxYearLineCount'] = null !== $taxYearStart ? $this->outOfTaxYearLineCount($taxYearStart) : 0;

        return $arr;
    }

    /** @param array<string, mixed> $data */
    public function patchPerDatabaseSettings(array $data): array
    {
        if (\array_key_exists('over65', $data)) {
            $this->settingsService->set(SettingKeys::OVER_65, (bool) $data['over65']);
        }

        return $this->settingsToArray();
    }

    /** @param array<string, mixed> $data */
    public function patchSettings(array $data): array
    {
        if (\array_key_exists('over65', $data)) {
            $this->patchPerDatabaseSettings(['over65' => $data['over65']]);
        }

        $globalPartial = array_intersect_key($data, ['groupLevels' => true, 'savedGroupings' => true]);
        if ([] !== $globalPartial) {
            $this->appSettingsRepository->write($globalPartial);
        }

        return $this->getSettings();
    }

    /**
     * Applies an ordered list of operations atomically — the shared path
     * for every ledger write. Four primitives, each doing exactly one
     * thing:
     *
     *  - `upsertLine` {lineId?, line}: create (lineId omitted/null) or
     *    update-in-place (lineId given) one standalone line. Always
     *    leaves the line with no transaction, even if it had one before
     *    (it shouldn't — see below).
     *  - `deleteLine` {lineId}: delete one standalone line outright.
     *  - `upsertTransaction` {transactionId, lines}: replace a
     *    transaction's lines wholesale (delete then reinsert, same as
     *    before) — `transactionId` is always frontend-provided (see
     *    CLAUDE.md), never null, for both create and update.
     *  - `deleteTransaction` {transactionId}: delete a transaction and
     *    all of its lines.
     *
     * A plain single save is one op. A merge (linking two standalone
     * lines, or adding a standalone line to an existing transaction)
     * deletes the absorbed standalone line(s) and upserts the transaction
     * with the full new line set — the absorbed line's *id* doesn't
     * survive the merge, a fresh row is created inside the transaction,
     * matching this endpoint's existing "wholesale replace, don't diff"
     * philosophy. A split-off/unlink is the reverse: delete (or shrink)
     * the transaction, upsert new standalone lines for whatever came out
     * of it. A same-date reorder is several upserts (line or transaction,
     * whichever each affected row actually is) in one call. See
     * CLAUDE.md's "Data model" section for the full worked examples.
     *
     * @param array<int, array{op: string, lineId?: int, transactionId?: string, line?: array<string, mixed>, lines?: array<int, array<string, mixed>>}> $operations
     */
    public function applyLedgerOperations(array $operations): void
    {
        $this->em->wrapInTransaction(function () use ($operations) {
            $this->assertOperationDatesInActiveTaxYear($operations);
            foreach ($operations as $op) {
                match ($op['op'] ?? null) {
                    'deleteLine' => $this->opDeleteLine($op),
                    'deleteTransaction' => $this->opDeleteTransaction($op),
                    'upsertLine' => $this->opUpsertLine($op),
                    'upsertTransaction' => $this->opUpsertTransaction($op),
                    default => null,
                };
            }
        });
    }

    /** @param array<string, mixed> $op */
    private function opDeleteLine(array $op): void
    {
        if (!isset($op['lineId'])) {
            return;
        }
        $line = $this->em->getRepository(Line::class)->find((int) $op['lineId']);
        if ($line) {
            $this->em->remove($line);
            $this->em->flush();
        }
    }

    /** @param array<string, mixed> $op */
    private function opDeleteTransaction(array $op): void
    {
        if (!isset($op['transactionId'])) {
            return;
        }
        $transactionId = (string) $op['transactionId'];
        $this->deleteTransactionLines($transactionId);
        $transaction = $this->em->getRepository(Transaction::class)->find($transactionId);
        if ($transaction) {
            $this->em->remove($transaction);
            $this->em->flush();
        }
    }

    /** @param array<string, mixed> $op */
    private function opUpsertLine(array $op): void
    {
        $lineData = $op['line'] ?? null;
        if (!\is_array($lineData) || !isset($lineData['accountId'])) {
            return;
        }
        $account = $this->em->getRepository(Account::class)->find((string) $lineData['accountId']);
        if (!$account) {
            return;
        }
        $lineId = isset($op['lineId']) ? (int) $op['lineId'] : null;
        $line = $lineId ? $this->em->getRepository(Line::class)->find($lineId) : null;
        $line = $this->hydrateLine($line ?? new Line(), $lineData, null, $account);
        $this->em->persist($line);
        $this->em->flush();
    }

    /** @param array<string, mixed> $op */
    private function opUpsertTransaction(array $op): void
    {
        if (!isset($op['transactionId'])) {
            return;
        }
        $txnId = (string) $op['transactionId'];
        $this->deleteTransactionLines($txnId);
        $transaction = $this->em->getRepository(Transaction::class)->find($txnId) ?? new Transaction();
        $transaction->setId($txnId);
        $this->em->persist($transaction);

        foreach ($op['lines'] ?? [] as $lineData) {
            $account = $this->em->getRepository(Account::class)->find((string) ($lineData['accountId'] ?? ''));
            if (!$account) {
                // A line pointing nowhere is malformed input, skip it
                // rather than fail the whole batch.
                continue;
            }
            $line = $this->hydrateLine(new Line(), $lineData, $transaction, $account);
            $this->em->persist($line);
        }
        $this->em->flush();
    }

    /**
     * Bulk-deletes a transaction's lines via DQL rather than through its
     * (possibly not yet loaded, possibly stale) in-memory collection —
     * every caller here only cares that the rows are gone, not about
     * touching loaded entities.
     *
     * A bulk DQL DELETE bypasses the UnitOfWork entirely, so it does
     * *not* clean up `line_tag` the way removing a Line entity normally
     * would (see opDeleteLine(), which uses `$em->remove()` and gets this
     * for free). SQLite's `ON DELETE CASCADE` on `line_tag` *would* now
     * cover it on its own — `foreign_keys` enforcement is on everywhere
     * as of ForeignKeysMiddleware — but this explicit cleanup is kept
     * anyway for clarity/defense-in-depth rather than relying on the
     * cascade implicitly. Every linked-transaction edit goes through
     * opUpsertTransaction(), which calls this before recreating the
     * lines.
     */
    private function deleteTransactionLines(string $transactionId): void
    {
        $this->deleteLineTagsForLines($this->em->getConnection()->fetchFirstColumn(
            'SELECT id FROM line WHERE transaction_id = ?',
            [$transactionId]
        ));
        $this->em->createQuery('DELETE FROM App\Entity\Line l WHERE IDENTITY(l.transaction) = :id')
            ->setParameter('id', $transactionId)
            ->execute();
    }

    /** @param array<int, int|string> $lineIds */
    private function deleteLineTagsForLines(array $lineIds): void
    {
        if (!$lineIds) {
            return;
        }
        $placeholders = implode(',', array_fill(0, \count($lineIds), '?'));
        $this->em->getConnection()->executeStatement("DELETE FROM line_tag WHERE line_id IN ($placeholders)", $lineIds);
    }

    private function deleteTransactionIfEmpty(string $transactionId): void
    {
        $count = (int) $this->em->createQuery('SELECT COUNT(l.id) FROM App\Entity\Line l WHERE IDENTITY(l.transaction) = :id')
            ->setParameter('id', $transactionId)
            ->getSingleScalarResult();

        if (0 === $count) {
            $this->em->createQuery('DELETE FROM App\Entity\Transaction t WHERE t.id = :id')
                ->setParameter('id', $transactionId)
                ->execute();
        }
    }

    /**
     * @param array<string, mixed> $data
     * @param bool                 $withParent when false, skips resolving/setting
     *                                         `parent` and the investment-requires-parent
     *                                         check — used by writeState()'s first pass,
     *                                         which completes both once every account in
     *                                         the batch has been persisted (see there)
     */
    private function hydrateAccount(Account $account, array $data, bool $withParent = true): Account
    {
        $account->setName((string) $data['name']);
        $account->setType((string) $data['type']);
        $account->setCurrency($this->resolveCurrency($data['currency'] ?? null));
        $account->setOpeningBalance(isset($data['openingBalance']) ? (int) $data['openingBalance'] : null);
        $account->setOpeningBalanceCashValue(isset($data['openingBalanceCashValue']) ? (int) $data['openingBalanceCashValue'] : null);
        $symbol = $this->resolveSymbol($data['symbolTicker'] ?? null, $data['symbolCurrency'] ?? null);
        $account->setSymbol($symbol);
        $account->setCounterparty($this->resolveCounterparty($data['counterparty'] ?? null));
        $account->setSubtype(isset($data['subtype']) ? (string) $data['subtype'] : null);
        $account->setIsaKind($data['isaKind'] ?? null);
        $account->setFlexible(isset($data['flexible']) ? (bool) $data['flexible'] : null);

        if ('investment' === $account->getType() && null === $symbol) {
            throw new \InvalidArgumentException('An investment account must have a symbol.');
        }

        // ISA allowance tracking (IsaAllowanceService) is GBP-only by
        // design (see CLAUDE.md) — it sums every ISA-tagged account's raw
        // scaled integer directly into one GBP-denominated pool, with no
        // currency conversion. A non-GBP ISA-kind account would silently
        // mix a foreign currency's amounts into that GBP total, the same
        // class of bug already fixed elsewhere for a genuine scale
        // mismatch — reject it outright instead. `type: 'investment'`
        // resolves via its Symbol's own tradingCurrency (an investment
        // account's own `currency` field is unused — see "Amounts,
        // currencies, and reference data"); every other ISA-tagged type
        // (a flat ISA, or a cash subaccount of a Stocks & Shares ISA
        // wrapper) resolves via its own `currency` directly. The wrapper
        // itself (`investment-parent` with isaKind 'stocks-shares-isa')
        // holds no currency of its own, so it has nothing to check here.
        if ($account->getIsaKind()) {
            $isaCurrency = 'investment' === $account->getType()
                ? $symbol?->getTradingCurrency()->getCode()
                : $account->getCurrency()?->getCode();
            if (null !== $isaCurrency && 'GBP' !== $isaCurrency) {
                throw new \InvalidArgumentException('ISA accounts must be denominated in GBP.');
            }
        }

        if (!$withParent) {
            return $account;
        }

        $account->setParent($this->resolveParent($data['parentId'] ?? null));

        if ('investment' === $account->getType() && null === $account->getParent()) {
            throw new \InvalidArgumentException('An investment account must have a parent wrapper.');
        }

        return $account;
    }

    /**
     * Rewrites every stored amount denominated in this currency to the
     * new scale, in one transaction — see CLAUDE.md's "Amounts,
     * currencies, and reference data" for why `scale` isn't just a
     * display setting. A decrease that would lose precision on any
     * existing row is refused outright (nothing partially applies); an
     * increase is always lossless and always allowed. Returns how many
     * rows were touched (0 if $newScale equals the current scale — a
     * genuine no-op, not an error).
     */
    public function rescaleCurrency(string $code, int $newScale): int
    {
        $currency = $this->em->getRepository(Currency::class)->find($code);
        if (!$currency) {
            throw new \InvalidArgumentException(sprintf('Unknown currency code "%s".', $code));
        }
        $delta = $newScale - $currency->getScale();
        if (0 === $delta) {
            return 0;
        }

        return $this->em->wrapInTransaction(function () use ($currency, $code, $delta, $newScale) {
            $conn = $this->em->getConnection();
            $divisor = 10 ** abs($delta);
            $op = $delta > 0 ? '*' : '/';

            /** @var array<int, array{sql: string, params: array<int, mixed>}> $targets */
            $targets = [
                [
                    'sql' => "opening_balance IS NOT NULL AND currency = ? AND type != 'investment'",
                    'table' => 'account',
                    'column' => 'opening_balance',
                    'params' => [$code],
                ],
                [
                    'sql' => 'opening_balance_cash_value IS NOT NULL AND symbol_currency = ?',
                    'table' => 'account',
                    'column' => 'opening_balance_cash_value',
                    'params' => [$code],
                ],
                [
                    'sql' => "account_id IN (SELECT id FROM account WHERE currency = ? AND type != 'investment')",
                    'table' => 'line',
                    'column' => 'amount',
                    'params' => [$code],
                ],
                [
                    'sql' => 'cash_value IS NOT NULL AND cash_currency = ?',
                    'table' => 'line',
                    'column' => 'cash_value',
                    'params' => [$code],
                ],
                [
                    'sql' => 'exchange_amount IS NOT NULL AND exchange_currency = ?',
                    'table' => 'line',
                    'column' => 'exchange_amount',
                    'params' => [$code],
                ],
            ];

            if ($delta < 0) {
                $lossy = 0;
                foreach ($targets as $t) {
                    $lossy += (int) $conn->fetchOne(
                        "SELECT COUNT(*) FROM {$t['table']} WHERE {$t['column']} % ? != 0 AND ({$t['sql']})",
                        [$divisor, ...$t['params']]
                    );
                }
                if ($lossy > 0) {
                    throw new \InvalidArgumentException(sprintf('Decreasing %s\'s scale would lose precision on %d existing amount(s) — refused.', $code, $lossy));
                }
            } else {
                foreach ($targets as $t) {
                    $max = $conn->fetchOne(
                        "SELECT MAX(ABS({$t['column']})) FROM {$t['table']} WHERE {$t['sql']}",
                        $t['params']
                    );
                    if (null !== $max && ((float) $max) * $divisor > self::JS_MAX_SAFE_INTEGER) {
                        throw new \InvalidArgumentException(sprintf('Increasing %s\'s scale to %d would push %s.%s past the safe-integer range for at least one existing amount — refused.', $code, $newScale, $t['table'], $t['column']));
                    }
                }
            }

            $rowsTouched = 0;
            foreach ($targets as $t) {
                $rowsTouched += $conn->executeStatement(
                    "UPDATE {$t['table']} SET {$t['column']} = {$t['column']} {$op} ? WHERE {$t['sql']}",
                    [$divisor, ...$t['params']]
                );
            }

            $currency->setScale($newScale);
            $this->em->persist($currency);
            $this->em->flush();

            return $rowsTouched;
        });
    }

    /**
     * Same shape as rescaleCurrency(), but only touches unit-denominated
     * amounts for this exact (ticker, tradingCurrency) variant — a
     * Symbol's own scale never affects cash-side amounts (those are
     * currency-scaled, via tradingCurrency, which can't change — see
     * Symbol's docblock).
     */
    public function rescaleSymbol(string $ticker, string $tradingCurrencyCode, int $newScale): int
    {
        $currency = $this->em->getRepository(Currency::class)->find($tradingCurrencyCode);
        if (!$currency) {
            throw new \InvalidArgumentException(sprintf('Unknown currency code "%s".', $tradingCurrencyCode));
        }
        $symbol = $this->em->getRepository(Symbol::class)->find(['ticker' => $ticker, 'tradingCurrency' => $currency]);
        if (!$symbol) {
            throw new \InvalidArgumentException(sprintf('Unknown symbol "%s" in %s.', $ticker, $tradingCurrencyCode));
        }
        $delta = $newScale - $symbol->getScale();
        if (0 === $delta) {
            return 0;
        }

        return $this->em->wrapInTransaction(function () use ($symbol, $ticker, $tradingCurrencyCode, $delta, $newScale) {
            $conn = $this->em->getConnection();
            $divisor = 10 ** abs($delta);
            $op = $delta > 0 ? '*' : '/';

            /** @var array<int, array{sql: string, table: string, column: string, params: array<int, mixed>}> $targets */
            $targets = [
                [
                    'sql' => 'opening_balance IS NOT NULL AND symbol_ticker = ? AND symbol_currency = ?',
                    'table' => 'account',
                    'column' => 'opening_balance',
                    'params' => [$ticker, $tradingCurrencyCode],
                ],
                [
                    'sql' => 'account_id IN (SELECT id FROM account WHERE symbol_ticker = ? AND symbol_currency = ?)',
                    'table' => 'line',
                    'column' => 'amount',
                    'params' => [$ticker, $tradingCurrencyCode],
                ],
            ];

            if ($delta < 0) {
                $lossy = 0;
                foreach ($targets as $t) {
                    $lossy += (int) $conn->fetchOne(
                        "SELECT COUNT(*) FROM {$t['table']} WHERE {$t['column']} % ? != 0 AND ({$t['sql']})",
                        [$divisor, ...$t['params']]
                    );
                }
                if ($lossy > 0) {
                    throw new \InvalidArgumentException(sprintf('Decreasing %s (%s)\'s scale would lose precision on %d existing amount(s) — refused.', $ticker, $tradingCurrencyCode, $lossy));
                }
            } else {
                foreach ($targets as $t) {
                    $max = $conn->fetchOne(
                        "SELECT MAX(ABS({$t['column']})) FROM {$t['table']} WHERE {$t['sql']}",
                        $t['params']
                    );
                    if (null !== $max && ((float) $max) * $divisor > self::JS_MAX_SAFE_INTEGER) {
                        throw new \InvalidArgumentException(sprintf('Increasing %s (%s)\'s scale to %d would push %s.%s past the safe-integer range for at least one existing amount — refused.', $ticker, $tradingCurrencyCode, $newScale, $t['table'], $t['column']));
                    }
                }
            }

            $rowsTouched = 0;
            foreach ($targets as $t) {
                $rowsTouched += $conn->executeStatement(
                    "UPDATE {$t['table']} SET {$t['column']} = {$t['column']} {$op} ? WHERE {$t['sql']}",
                    [$divisor, ...$t['params']]
                );
            }

            $symbol->setScale($newScale);
            $this->em->persist($symbol);
            $this->em->flush();

            return $rowsTouched;
        });
    }

    /**
     * Looks up a Currency/Symbol/Counterparty by its natural key. Throws a
     * clear error naming the missing code rather than silently
     * fabricating a row with a guessed scale — these are reference data,
     * not something a ledger write should be allowed to invent on the
     * fly. Only ImportLocalStorageCommand and the live batch/account
     * write paths call these, never anything user-facing without a
     * chance to fix the input first.
     *
     * Currency and Symbol are deliberately curated, closed sets (a new
     * one needs a real scale decided — see CLAUDE.md's plan for a future
     * "add symbol" admin flow that actually asks for that), so an
     * unknown code/ticker is always an error. Counterparty is different:
     * free-text institution/payee names were always fine before this
     * schema existed (any bank, or any payee, the user hasn't used yet),
     * and there's no meaningful extra data a first use needs to supply —
     * so resolveCounterparty() find-or-creates instead of find-or-throws.
     */
    private function resolveCurrency(mixed $code): ?Currency
    {
        if (null === $code || '' === $code) {
            return null;
        }
        $currency = $this->em->getRepository(Currency::class)->find((string) $code);
        if (!$currency) {
            throw new \InvalidArgumentException(sprintf('Unknown currency code "%s".', $code));
        }

        return $currency;
    }

    private function resolveSymbol(mixed $ticker, mixed $tradingCurrencyCode): ?Symbol
    {
        if (null === $ticker || '' === $ticker) {
            return null;
        }
        $currency = $this->resolveCurrency($tradingCurrencyCode);
        if (!$currency) {
            throw new \InvalidArgumentException('A symbol reference requires its trading currency.');
        }
        $symbol = $this->em->getRepository(Symbol::class)->find(['ticker' => (string) $ticker, 'tradingCurrency' => $currency]);
        if (!$symbol) {
            throw new \InvalidArgumentException(sprintf('Unknown symbol "%s" in %s.', $ticker, $tradingCurrencyCode));
        }

        return $symbol;
    }

    private function resolveParent(mixed $id): ?Account
    {
        if (null === $id || '' === $id) {
            return null;
        }
        $parent = $this->em->getRepository(Account::class)->find((string) $id);
        if (!$parent) {
            throw new \InvalidArgumentException(sprintf('Unknown parent account "%s".', $id));
        }

        return $parent;
    }

    /**
     * writeState()'s order-independent counterpart to resolveParent(): looks
     * the parent up in the batch's own in-memory map (every Account object
     * built for this import, keyed by id — not yet persisted) rather than
     * querying the repository, since the parent may appear later than the
     * child in $accountsData's own order.
     *
     * @param array<string, Account> $accountsById
     */
    private function resolveParentFromBatch(mixed $id, array $accountsById): ?Account
    {
        if (null === $id || '' === $id) {
            return null;
        }
        $parent = $accountsById[(string) $id] ?? null;
        if (!$parent) {
            throw new \InvalidArgumentException(sprintf('Unknown parent account "%s".', $id));
        }

        return $parent;
    }

    private function resolveCounterparty(mixed $name): ?Counterparty
    {
        if (null === $name || '' === $name) {
            return null;
        }
        $counterparty = $this->em->getRepository(Counterparty::class)->find((string) $name);
        if (!$counterparty) {
            $counterparty = (new Counterparty())->setName((string) $name);
            $this->em->persist($counterparty);
        }

        return $counterparty;
    }

    /**
     * Find-or-creates each `{dimension, value}` pair as a Tag — same open,
     * find-or-create posture as resolveCounterparty(), never a closed set.
     * A pair with a blank/missing `dimension` is skipped rather than
     * erroring, since that's not a meaningful tag to begin with; a blank
     * `value` is kept (a bare, flag-style tag — see Tag's docblock).
     *
     * @param array<int, array{dimension?: mixed, value?: mixed}> $tagPairs
     *
     * @return array<int, Tag>
     */
    private function resolveTags(array $tagPairs): array
    {
        $tags = [];
        foreach ($tagPairs as $pair) {
            $dimension = trim((string) ($pair['dimension'] ?? ''));
            if ('' === $dimension) {
                continue;
            }
            $value = trim((string) ($pair['value'] ?? ''));
            $tag = $this->em->getRepository(Tag::class)->find(['dimension' => $dimension, 'value' => $value]);
            if (!$tag) {
                $tag = (new Tag())->setDimension($dimension)->setValue($value);
                $this->em->persist($tag);
            }
            $tags[] = $tag;
        }

        return $tags;
    }

    /**
     * `$transaction` null means this line is (or is becoming) standalone.
     * addLine(), not setTransaction() directly, when there *is* a
     * transaction — it also keeps the Transaction's own in-memory $lines
     * collection in sync. Without that, a later read of this same
     * Transaction's lines *within the same request* (e.g.
     * IsaAllowanceService reading a just-written transaction back) sees
     * Doctrine's stale, still-empty collection from when the entity was
     * constructed, even though the DB row is correct — the identity map
     * serves back the same PHP object rather than re-querying.
     *
     * @param array<string, mixed> $data
     */
    private function hydrateLine(Line $line, array $data, ?Transaction $transaction, Account $account): Line
    {
        if ('investment-parent' === $account->getType()) {
            // A wrapper holds no balance of its own — see the account
            // type's docblock/CLAUDE.md — so it can never legitimately be
            // a line's own account, only the parent other accounts point
            // at. The frontend's AccountPicker already excludes wrapper
            // accounts from the linked-account list (otherLines.jsx); this
            // is the same rule enforced server-side, for every write path
            // that reaches hydrateLine() (the live batch endpoint, and
            // writeState()'s import/restore).
            throw new \InvalidArgumentException(sprintf('Account "%s" is a wrapper and cannot hold lines directly.', $account->getId()));
        }
        if ($transaction) {
            $transaction->addLine($line);
        } else {
            $line->setTransaction(null);
        }
        $line->setAccount($account);
        $line->setAmount((int) $data['amount']);
        $line->setDate((string) $data['date']);
        $line->setDescription((string) ($data['description'] ?? ''));
        $line->setLineOrder(isset($data['order']) ? (int) $data['order'] : null);
        $line->setCashValue(isset($data['cashValue']) ? (int) $data['cashValue'] : null);
        $line->setCashCurrency($this->resolveCurrency($data['cashCurrency'] ?? null));
        $line->setExchangeAmount(isset($data['exchangeAmount']) ? (int) $data['exchangeAmount'] : null);
        $line->setExchangeCurrency($this->resolveCurrency($data['exchangeCurrency'] ?? null));
        $line->setTags($this->resolveTags($data['tags'] ?? []));

        return $line;
    }

    /**
     * Find-or-create a Currency and write its scale/name from import
     * data — the one place a Currency's own attributes get *written*
     * from outside the app (contrast resolveCurrency(), which only ever
     * looks one up and never writes). See writeState()'s docblock for
     * why this upserts rather than replacing the whole table.
     *
     * @param array<string, mixed> $data
     */
    private function hydrateCurrency(array $data): void
    {
        if (!isset($data['code'], $data['scale'])) {
            return;
        }
        $code = (string) $data['code'];
        $currency = $this->em->getRepository(Currency::class)->find($code) ?? (new Currency())->setCode($code);
        $currency->setScale((int) $data['scale']);
        $currency->setName(isset($data['name']) ? (string) $data['name'] : $currency->getName());
        $this->em->persist($currency);
    }

    /** @return array<int, array<string, mixed>> */
    private function accountsArray(): array
    {
        return array_map($this->accountToArray(...), $this->em->getRepository(Account::class)->findAll());
    }

    /**
     * Every currency in the table — not just ones referenced by an
     * account/line right now — so a full backup/export genuinely carries
     * the currency data along with it, the way it would for any other
     * table. See writeState()'s docblock for the other half of this.
     *
     * @return array<int, array<string, mixed>>
     */
    private function currenciesArray(): array
    {
        return array_map(
            static fn (Currency $c) => array_filter([
                'code' => $c->getCode(),
                'scale' => $c->getScale(),
                'name' => $c->getName(),
            ], static fn ($v) => null !== $v),
            $this->em->getRepository(Currency::class)->findAll()
        );
    }

    /**
     * Every record — every linked Transaction plus every standalone Line
     * — in the shape the frontend/import/export expect.
     *
     * @return array<int, array<string, mixed>>
     */
    private function recordsArray(): array
    {
        $records = array_map($this->transactionRecordToArray(...), $this->em->getRepository(Transaction::class)->findAll());
        $standalone = $this->em->getRepository(Line::class)->findBy(['transaction' => null]);
        foreach ($standalone as $line) {
            $records[] = $this->standaloneRecordToArray($line);
        }

        return $records;
    }

    /** @return array<string, mixed> */
    public function accountToArray(Account $a): array
    {
        return array_filter([
            'id' => $a->getId(),
            'name' => $a->getName(),
            'type' => $a->getType(),
            'currency' => $a->getCurrency()?->getCode(),
            'openingBalance' => $a->getOpeningBalance(),
            'openingBalanceCashValue' => $a->getOpeningBalanceCashValue(),
            'symbolTicker' => $a->getSymbol()?->getTicker(),
            'symbolCurrency' => $a->getSymbol()?->getTradingCurrency()->getCode(),
            'counterparty' => $a->getCounterparty()?->getName(),
            'subtype' => $a->getSubtype(),
            'isaKind' => $a->getIsaKind(),
            'parentId' => $a->getParent()?->getId(),
            'flexible' => $a->isFlexible(),
        ], static fn ($v) => null !== $v);
    }

    /** @return array{transactionId: string, lines: array<int, array<string, mixed>>} */
    public function transactionRecordToArray(Transaction $t): array
    {
        return [
            'transactionId' => $t->getId(),
            'lines' => array_map($this->lineToArray(...), $t->getLines()->toArray()),
        ];
    }

    /** @return array{transactionId: null, lines: array<int, array<string, mixed>>} */
    public function standaloneRecordToArray(Line $l): array
    {
        return [
            'transactionId' => null,
            'lines' => [$this->lineToArray($l)],
        ];
    }

    /** @return array<string, mixed> */
    public function lineToArray(Line $l): array
    {
        $tags = array_map(
            static fn (Tag $t) => ['dimension' => $t->getDimension(), 'value' => $t->getValue()],
            $l->getTags()->toArray()
        );

        return array_filter([
            'id' => $l->getId(),
            'accountId' => $l->getAccount()->getId(),
            'amount' => $l->getAmount(),
            'date' => $l->getDate(),
            'description' => $l->getDescription(),
            'order' => $l->getLineOrder(),
            'cashValue' => $l->getCashValue(),
            'cashCurrency' => $l->getCashCurrency()?->getCode(),
            'exchangeAmount' => $l->getExchangeAmount(),
            'exchangeCurrency' => $l->getExchangeCurrency()?->getCode(),
            // Omitted (not []) when empty, same null-omission convention as
            // every other optional field here — see CLAUDE.md.
            'tags' => $tags ?: null,
        ], static fn ($v) => null !== $v);
    }

    /** @return array<string, mixed> */
    private function settingsToArray(): array
    {
        return [
            'over65' => (bool) ($this->settingsService->get(SettingKeys::OVER_65) ?? false),
        ];
    }

    /**
     * UK tax years run 6 April – 5 April, not the calendar year — mirrors
     * src/lib/isa.js's taxYearStartYearFor() exactly (same date format).
     */
    private function taxYearStartYearFor(string $dateISO): int
    {
        $year = (int) substr($dateISO, 0, 4);
        $boundary = sprintf('%d-04-06', $year);

        return $dateISO < $boundary ? $year - 1 : $year;
    }

    /** @return array{start: string, end: string, label: string} */
    private function taxYearBounds(int $startYear): array
    {
        return [
            'start' => sprintf('%d-04-06', $startYear),
            'end' => sprintf('%d-04-05', $startYear + 1),
            'label' => sprintf('%d/%s', $startYear, substr((string) ($startYear + 1), 2)),
        ];
    }

    /**
     * This ledger's one UK tax year — see CLAUDE.md's "The active tax
     * year". **Never stored** — always freshly computed as
     * `taxYearStartYearFor()` of the earliest date among every line
     * already saved, plus `$extraDates` (lines about to be saved, for
     * the live-write path). Returns null only when there is truly
     * nothing to derive from (no lines saved yet, and no `$extraDates`
     * either).
     *
     * @param string[] $extraDates
     */
    private function determinedTaxYearStart(array $extraDates = []): ?int
    {
        $existingEarliest = $this->em->getConnection()->fetchOne('SELECT MIN(date) FROM line');
        $dates = array_filter([...$extraDates, $existingEarliest ?: null]);
        if (!$dates) {
            return null;
        }
        sort($dates);

        return $this->taxYearStartYearFor($dates[0]);
    }

    /**
     * How many already-saved lines fall outside `$startYear`'s bounds —
     * surfaced as a warning (`GET /api/settings`'s `outOfTaxYearLineCount`,
     * `App.jsx`'s header badge), never blocked: this ledger's tax year is
     * derived from the *earliest* date, so by construction nothing can
     * be earlier than it, but data can still exist *after* it — an
     * import that happens to span more than one tax year, say. Existing
     * data is never rejected retroactively, only flagged.
     */
    private function outOfTaxYearLineCount(int $startYear): int
    {
        $bounds = $this->taxYearBounds($startYear);

        return (int) $this->em->getConnection()->fetchOne(
            'SELECT COUNT(*) FROM line WHERE date < ? OR date > ?',
            [$bounds['start'], $bounds['end']]
        );
    }

    /**
     * Hard-blocks saving any *new* line whose date falls outside this
     * ledger's one tax year — AccountLedger/StockLedger's commit()
     * already prevents this in normal use, but this is the backend's own
     * independent guard against the same mistake (a stale tab, a direct
     * API call, a future bug in the frontend check), the same "don't
     * just trust the frontend" posture resolveCurrency()/resolveSymbol()
     * already take. This is the only place tax-year dates are ever
     * *rejected* — existing data is only ever warned about (see
     * outOfTaxYearLineCount()), never blocked after the fact.
     *
     * @param array<int, array{op: string, line?: array<string, mixed>, lines?: array<int, array<string, mixed>>}> $operations
     */
    private function assertOperationDatesInActiveTaxYear(array $operations): void
    {
        $dates = [];
        foreach ($operations as $op) {
            $lines = match ($op['op'] ?? null) {
                'upsertLine' => [$op['line'] ?? []],
                'upsertTransaction' => $op['lines'] ?? [],
                default => [],
            };
            foreach ($lines as $line) {
                if (\is_array($line) && \is_string($line['date'] ?? null)) {
                    $dates[] = $line['date'];
                }
            }
        }
        if (!$dates) {
            return;
        }

        // $dates is non-empty, so determinedTaxYearStart() always derives
        // something from it even on a blank database — never null here.
        $startYear = $this->determinedTaxYearStart($dates);
        \assert(null !== $startYear);
        $bounds = $this->taxYearBounds($startYear);

        foreach ($dates as $date) {
            if ($date < $bounds['start'] || $date > $bounds['end']) {
                throw new \InvalidArgumentException(sprintf(
                    '%s is outside this ledger\'s %s tax year (%s to %s).',
                    $date,
                    $bounds['label'],
                    $bounds['start'],
                    $bounds['end']
                ));
            }
        }
    }
}
