# In-app Database Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ledger-project switch, create, and roll forward its per-tax-year SQLite databases from inside the running app, instead of hand-editing `backend/.env.local`.

**Architecture:** `backend/databases/active.sqlite3` becomes a symlink that `DATABASE_URL` always points at (fixed, in a new committed `backend/.env.dev`); a new `DatabaseController` lists/switches/creates files and repoints the symlink atomically; `NewYearCommand`'s carry-forward logic moves into an injectable `NewYearService` so the console command and a new in-app action share one implementation; `MigrationStatusListener` gains an earlier check for "no active database" alongside its existing migration-pending one; the frontend gets a `DatabaseSwitcher` component (a header dropdown, and a full-screen blocking variant for the no-active-database case).

**Tech Stack:** Symfony 8.1 (PHP 8.4+), Doctrine ORM/Migrations, `symfony/process` (new dependency), React 18 + Vite, no new frontend dependencies.

**Spec:** `docs/superpowers/specs/2026-09-18-in-app-database-switcher-design.md`

## Global Constraints

- Single user, no auth — see CLAUDE.md's "Backend". No new auth model for any new endpoint.
- Every mutating endpoint validates and refuses (400/409) rather than silently overwriting — same posture as `SymbolController`/`app:new-year`'s existing "target already exists" check.
- No new PHPUnit coverage for this feature (pure filesystem glue, per CLAUDE.md's existing testing posture) — verification is manual, and must follow the project's standing testing-isolation convention: never point the *real* `DATABASE_URL`/symlink at a database being deliberately broken for a test. Use a scratch copy, verify, then restore.
- `php bin/phpunit` must stay green throughout (it exercises `IsaAllowanceService`, untouched by this plan, but must not regress from the `NewYearService` extraction).
- `yarn build` must stay clean throughout.

---

## Task 1: Add the `symfony/process` dependency

**Files:**
- Modify: `backend/composer.json`
- Modify: `backend/composer.lock` (composer manages this)

**Interfaces:**
- Produces: `Symfony\Component\Process\Process` and `Symfony\Component\Process\PhpExecutableFinder`, available for Task 4.

- [ ] **Step 1: Confirm it isn't already installed**

Run: `cd backend && composer show symfony/process 2>&1`
Expected: `Package "symfony/process" not found` (confirms it's not already a direct dependency — it may appear transitively in `composer.lock` from another package's own requirement, which doesn't make it usable).

- [ ] **Step 2: Require it, pinned to the same 8.1 line as the rest of this app's Symfony components**

Run: `cd backend && composer require symfony/process:8.1.*`
Expected: composer resolves and installs cleanly, `composer.json`'s `require` block gains `"symfony/process": "8.1.*"`.

- [ ] **Step 3: Verify it's actually usable**

Run: `cd backend && php -r "require 'vendor/autoload.php'; var_dump(class_exists(\Symfony\Component\Process\Process::class));"`
Expected: `bool(true)`

- [ ] **Step 4: Commit**

```bash
cd backend && git add composer.json composer.lock && git commit -m "Add symfony/process, needed to run migrations against a newly created database from a web request"
```

---

## Task 2: Extract `NewYearCommand`'s logic into `NewYearService`

**Files:**
- Create: `backend/src/Service/NewYearService.php`
- Modify: `backend/src/Command/NewYearCommand.php` (full rewrite, same behavior)

**Interfaces:**
- Produces: `NewYearService::createNextYear(string $newDbPath): array` — copies the live database to `$newDbPath`, carries balances forward in the copy, returns
  `array{sourcePath: string, rows: array<int, array{0: array<string,mixed>, 1: int, 2: ?int}>, currencyScales: array<string,int>, symbolScales: array<string,int>, symbolTradingCurrency: array<string,string>}`.
  Throws `\InvalidArgumentException` if `$newDbPath` already exists (expected, caller-fixable). Throws `\RuntimeException` for anything else that stops it completing.
- Consumes (Task 5, Task 3-5's controller): this exact method and its exact exception types — `DatabaseController::newYear()` catches `\InvalidArgumentException` specifically to turn it into a `400`.

- [ ] **Step 1: Create the service with the logic moved verbatim from the command**

```php
<?php

namespace App\Service;

use App\Entity\Currency;
use App\Entity\Symbol;
use Doctrine\DBAL\DriverManager;
use Doctrine\ORM\EntityManagerInterface;

/**
 * The copy/wipe/carry-forward logic behind `app:new-year` — see
 * NewYearCommand's docblock for the full behavior description (copies the
 * live database wholesale, then in the copy only wipes lines/transactions
 * and carries each real account's closing balance/cost basis forward as
 * its opening balance). Pulled out of the command into its own service,
 * following this app's existing convention of business logic living in
 * services (see LedgerStateService), so DatabaseController's in-app
 * "start a new tax year" action (POST /api/databases/new-year) can call
 * the exact same code the terminal command does — see CLAUDE.md's
 * "Backend" section.
 */
class NewYearService
{
    private const CARRY_FORWARD_TYPES = ['asset', 'liability', 'equity', 'investment'];

    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly LedgerStateService $state,
    ) {
    }

    /**
     * Copies the current live database to $newDbPath and carries balances
     * forward in the copy — see class docblock. Throws
     * \InvalidArgumentException if $newDbPath already exists (an expected,
     * caller-fixable rejection), \RuntimeException for anything else that
     * stops this from completing (can't determine the source path, the
     * file copy itself failed, or the carry-forward write failed).
     *
     * @return array{sourcePath: string, rows: array<int, array{0: array<string, mixed>, 1: int, 2: ?int}>, currencyScales: array<string, int>, symbolScales: array<string, int>, symbolTradingCurrency: array<string, string>}
     */
    public function createNextYear(string $newDbPath): array
    {
        $sourcePath = $this->em->getConnection()->getParams()['path'] ?? null;
        if (!\is_string($sourcePath) || '' === $sourcePath) {
            throw new \RuntimeException('Could not determine the current database\'s file path — app:new-year only supports SQLite.');
        }

        if (file_exists($newDbPath)) {
            throw new \InvalidArgumentException(\sprintf('%s already exists — remove or rename it first.', $newDbPath));
        }

        // Read every account's current closing balance/cost basis before
        // touching anything — accountsWithStats() is the same computation
        // GET /api/accounts uses, so this can never drift from what the
        // live app itself shows.
        $stats = $this->state->accountsWithStats();

        $currencyScales = [];
        foreach ($this->em->getRepository(Currency::class)->findAll() as $c) {
            $currencyScales[$c->getCode()] = $c->getScale();
        }
        $symbolScales = [];
        $symbolTradingCurrency = [];
        foreach ($this->em->getRepository(Symbol::class)->findAll() as $s) {
            $symbolScales[$s->getTicker()] = $s->getScale();
            $symbolTradingCurrency[$s->getTicker()] = $s->getTradingCurrency()->getCode();
            $currencyScales[$s->getTradingCurrency()->getCode()] ??= $s->getTradingCurrency()->getScale();
        }

        if (!copy($sourcePath, $newDbPath)) {
            throw new \RuntimeException(\sprintf('Could not copy %s to %s.', $sourcePath, $newDbPath));
        }

        $target = DriverManager::getConnection(['driver' => 'pdo_sqlite', 'path' => $newDbPath]);

        $target->beginTransaction();
        try {
            $target->executeStatement('DELETE FROM line_tag');
            $target->executeStatement('DELETE FROM line');
            $target->executeStatement('DELETE FROM transactions');

            $rows = [];
            foreach ($stats as $a) {
                $carry = \in_array($a['type'], self::CARRY_FORWARD_TYPES, true);
                $openingBalance = $carry ? $a['balance'] : null;
                $openingBalanceCashValue = $carry && 'investment' === $a['type'] ? ($a['costBasis'] ?? 0) : null;

                $target->executeStatement(
                    'UPDATE account SET opening_balance = ?, opening_balance_cash_value = ? WHERE id = ?',
                    [$openingBalance, $openingBalanceCashValue, $a['id']]
                );

                if ($carry && 0 !== $openingBalance) {
                    $rows[] = [$a, $openingBalance, $openingBalanceCashValue];
                }
            }

            $target->commit();
        } catch (\Throwable $e) {
            $target->rollBack();
            $target->close();

            throw new \RuntimeException(\sprintf('Failed to write %s: %s', $newDbPath, $e->getMessage()), 0, $e);
        }
        $target->close();

        return [
            'sourcePath' => $sourcePath,
            'rows' => $rows,
            'currencyScales' => $currencyScales,
            'symbolScales' => $symbolScales,
            'symbolTradingCurrency' => $symbolTradingCurrency,
        ];
    }
}
```

- [ ] **Step 2: Rewrite the command as a thin wrapper**

Replace `backend/src/Command/NewYearCommand.php` entirely with:

```php
<?php

namespace App\Command;

use App\Service\NewYearService;
use Symfony\Component\Console\Attribute\AsCommand;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use Symfony\Component\Console\Style\SymfonyStyle;

/**
 * Bootstraps a fresh tax year's database from the current, live one — see
 * CLAUDE.md's "The active tax year": a ledger-project database belongs to
 * exactly one UK tax year for its whole lifetime, and switching years
 * means pointing DATABASE_URL at a new file, not something the app does
 * itself. This is the "one file per tax year" convention documented in
 * .env.local, ported from the sibling Nucleware/Accounts project.
 *
 * A thin wrapper — see NewYearService::createNextYear() for the actual
 * copy/wipe/carry-forward logic, shared with the in-app "start a new tax
 * year" action (DatabaseController::newYear(), POST
 * /api/databases/new-year) so both call exactly the same code.
 */
#[AsCommand(
    name: 'app:new-year',
    description: "Bootstrap a fresh tax year's database from the current one's closing balances",
)]
class NewYearCommand extends Command
{
    public function __construct(private readonly NewYearService $newYearService)
    {
        parent::__construct();
    }

    protected function configure(): void
    {
        $this
            ->addArgument('newDbPath', InputArgument::REQUIRED, 'Path to write the new tax year\'s SQLite file to (must not already exist)')
            ->setHelp(<<<'HELP'
                Copies the current database to a new file, wipes every line and
                transaction in the copy, and carries each real account's current
                closing balance forward as its opening balance in the new file:

                    php bin/console app:new-year databases/2025-2026.sqlite3

                Point DATABASE_URL (see .env.local) at the new file once you're
                ready to start using it.
                HELP);
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $io = new SymfonyStyle($input, $output);
        $newDbPath = (string) $input->getArgument('newDbPath');

        try {
            $result = $this->newYearService->createNextYear($newDbPath);
        } catch (\Throwable $e) {
            $io->error($e->getMessage());

            return Command::FAILURE;
        }

        $io->success(\sprintf('Created %s from %s.', $newDbPath, $result['sourcePath']));

        $table = [];
        foreach ($result['rows'] as [$a, $openingBalance, $openingBalanceCashValue]) {
            if ('investment' === $a['type']) {
                $unitsScale = $result['symbolScales'][$a['symbol'] ?? ''] ?? 6;
                $tradingCurrency = $result['symbolTradingCurrency'][$a['symbol'] ?? ''] ?? null;
                $costScale = $result['currencyScales'][$tradingCurrency] ?? 2;
                $table[] = [
                    $a['name'],
                    $a['type'],
                    $this->formatScaled($openingBalance, $unitsScale).' units',
                    $this->formatScaled($openingBalanceCashValue, $costScale).' cost',
                ];
            } else {
                $scale = $result['currencyScales'][$a['currency'] ?? ''] ?? 2;
                $table[] = [$a['name'], $a['type'], $this->formatScaled($openingBalance, $scale), '—'];
            }
        }

        if ($table) {
            $io->table(['Account', 'Type', 'Opening balance', 'Opening cost basis'], $table);
        }

        $investmentCount = \count(array_filter($result['rows'], static fn ($r) => 'investment' === $r[0]['type']));
        if ($investmentCount > 0) {
            $io->note(\sprintf(
                '%d investment account(s) carried forward: portfolio value will read as the carried cost basis until the first new trade re-marks it — there\'s no live price feed (see CLAUDE.md\'s "Stock valuation").',
                $investmentCount
            ));
        }

        $io->text('The new file has no lines yet, so its tax year is undetermined until the first entry is saved — same as any blank database.');

        return Command::SUCCESS;
    }

    private function formatScaled(int $value, int $scale): string
    {
        if (0 === $scale) {
            return (string) $value;
        }
        $divisor = 10 ** $scale;
        $sign = $value < 0 ? '-' : '';
        $abs = abs($value);

        return \sprintf('%s%d.%0'.$scale.'d', $sign, intdiv($abs, $divisor), $abs % $divisor);
    }
}
```

- [ ] **Step 3: Verify `php bin/phpunit` is still green**

Run: `cd backend && php bin/phpunit`
Expected: all tests pass (this refactor doesn't touch `IsaAllowanceService`, but confirms nothing else broke — e.g. an autowiring error would surface here too since the container gets rebuilt).

- [ ] **Step 4: Verify the command still behaves identically, against a scratch copy**

Per this project's standing testing-isolation convention — never point the real `DATABASE_URL` at a database being used for a test.

```bash
cd backend
cp databases/2024-2025.sqlite3 /tmp/nys-test.sqlite3   # use whichever file .env.local currently names — check with: grep '^DATABASE_URL' .env.local
rm -f /tmp/nys-test-out.sqlite3
DATABASE_URL="sqlite:////tmp/nys-test.sqlite3" php bin/console app:new-year /tmp/nys-test-out.sqlite3
```

Expected: a success message, a table of carried-forward accounts (same shape as before the refactor — Account/Type/Opening balance/Opening cost basis columns), the investment-accounts note if any exist, and the "no lines yet" closing line — i.e. the exact same output shape this command already produced when it was first built and verified earlier in this project's history.

```bash
rm -f /tmp/nys-test.sqlite3 /tmp/nys-test-out.sqlite3
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/Service/NewYearService.php backend/src/Command/NewYearCommand.php
git commit -m "Extract NewYearCommand's carry-forward logic into NewYearService

So the upcoming in-app \"start a new tax year\" action can call the
exact same code the terminal command does, instead of a second
implementation. No behavior change for app:new-year itself."
```

---

## Task 3: `DatabaseController` — list and switch among existing databases

**Files:**
- Create: `backend/src/Controller/DatabaseController.php`

**Interfaces:**
- Produces:
  - `GET /api/databases` → `200`, `array<int, {filename: string, label: ?string, isTaxYear: bool, active: bool}>`.
  - `POST /api/databases/active` body `{filename: string}` → `200` with the switched-to entry, or `400` `{"error": "..."}`.
- Consumes: nothing from earlier tasks (pure filesystem).

- [ ] **Step 1: Write the controller**

```php
<?php

namespace App\Controller;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Lists, switches, creates, and rolls forward the per-tax-year SQLite
 * files under backend/databases/ — see CLAUDE.md's "The active tax year"
 * and the design doc this implements
 * (docs/superpowers/specs/2026-09-18-in-app-database-switcher-design.md).
 *
 * `databases/active.sqlite3` is a symlink to whichever file is "active";
 * DATABASE_URL (backend/.env.dev) always points at that fixed symlink
 * path, never at a real file directly — switching is purely repointing
 * the symlink, done atomically (temp symlink + rename(), never a moment
 * where active.sqlite3 is missing or broken).
 *
 * Pure filesystem operations — no EntityManager here. The one action that
 * does touch the database layer (newYear(), via NewYearService) works
 * against the *current* live connection, not a path this controller
 * manages directly.
 */
#[Route('/api/databases')]
class DatabaseController
{
    private const TAX_YEAR_PATTERN = '/^(\d{4})-(\d{4})\.sqlite3$/';

    public function __construct(
        #[Autowire('%kernel.project_dir%')]
        private readonly string $projectDir,
    ) {
    }

    #[Route('', methods: ['GET'])]
    public function list(): JsonResponse
    {
        $dir = $this->databasesDir();
        $activeTarget = $this->activeTarget($dir);

        $entries = [];
        foreach (glob($dir.'/*.sqlite3') ?: [] as $path) {
            $filename = basename($path);
            if ('active.sqlite3' === $filename) {
                continue;
            }
            $entries[] = $this->entryFor($filename, $activeTarget);
        }

        usort($entries, static fn (array $a, array $b) => $a['filename'] <=> $b['filename']);

        return new JsonResponse($entries);
    }

    #[Route('/active', methods: ['POST'])]
    public function setActive(Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);
        $filename = \is_array($body) ? (string) ($body['filename'] ?? '') : '';

        $error = $this->validateFilename($filename);
        if (null !== $error) {
            return new JsonResponse(['error' => $error], 400);
        }

        $this->activateSymlink($filename);

        return new JsonResponse($this->entryFor($filename, $filename));
    }

    private function validateFilename(string $filename): ?string
    {
        if ('' === $filename) {
            return 'filename is required';
        }
        if (!preg_match('/^[A-Za-z0-9_.-]+\.sqlite3$/', $filename)) {
            return 'filename must be a bare *.sqlite3 name, no path separators';
        }
        if ('active.sqlite3' === $filename) {
            return 'active.sqlite3 is the pointer itself, not a selectable database';
        }
        if (!file_exists($this->databasesDir().'/'.$filename)) {
            return \sprintf('%s does not exist', $filename);
        }

        return null;
    }

    /**
     * Atomically repoints databases/active.sqlite3 at $filename: create a
     * new symlink under a temporary name in the same directory, then
     * rename() it over active.sqlite3 — rename() is atomic on the same
     * filesystem, so a request arriving mid-switch never sees a missing
     * or broken symlink.
     */
    private function activateSymlink(string $filename): void
    {
        $dir = $this->databasesDir();
        $target = $dir.'/'.$filename;
        $active = $dir.'/active.sqlite3';
        $tmp = $dir.'/.active.sqlite3.tmp-'.bin2hex(random_bytes(4));

        symlink($target, $tmp);
        rename($tmp, $active);
    }

    /**
     * The real filename databases/active.sqlite3 currently resolves to,
     * or null if it doesn't exist, isn't a symlink, or points at
     * something that no longer exists — see MigrationStatusListener's
     * "no_active_database" check, which uses the same definition.
     */
    private function activeTarget(string $dir): ?string
    {
        $active = $dir.'/active.sqlite3';
        if (!is_link($active)) {
            return null;
        }
        $target = readlink($active);
        if (false === $target || !file_exists($target)) {
            return null;
        }

        return basename($target);
    }

    /** @return array{filename: string, label: ?string, isTaxYear: bool, active: bool} */
    private function entryFor(string $filename, ?string $activeTarget): array
    {
        $isTaxYear = 1 === preg_match(self::TAX_YEAR_PATTERN, $filename, $m);

        return [
            'filename' => $filename,
            'label' => $isTaxYear ? \sprintf('%d/%s', (int) $m[1], substr($m[2], 2)) : null,
            'isTaxYear' => $isTaxYear,
            'active' => $filename === $activeTarget,
        ];
    }

    private function databasesDir(): string
    {
        return $this->projectDir.'/databases';
    }
}
```

- [ ] **Step 2: Verify against a scratch `databases/` directory**

Per the testing-isolation convention, this exercises the controller entirely against scratch files, never the real `databases/` directory.

```bash
cd backend
mkdir -p /tmp/db-switch-test/databases
cp databases/2024-2025.sqlite3 /tmp/db-switch-test/databases/2024-2025.sqlite3   # use whichever real file exists
cp databases/2024-2025.sqlite3 /tmp/db-switch-test/databases/2025-2026.sqlite3
touch /tmp/db-switch-test/databases/development.sqlite3
```

There's no clean way to override `%kernel.project_dir%` for a single request without a running server pointed at a temp project dir, so verify the two pure-PHP helper behaviors directly instead:

```bash
php -r '
require "vendor/autoload.php";
$dir = "/tmp/db-switch-test/databases";
$r = new ReflectionClass(App\Controller\DatabaseController::class);
$ctrl = $r->newInstanceWithoutConstructor();
$prop = $r->getProperty("projectDir");
$prop->setAccessible(true);
$prop->setValue($ctrl, "/tmp/db-switch-test");

$list = $r->getMethod("list");
$list->setAccessible(true);
$response = $list->invoke($ctrl);
echo $response->getContent(), PHP_EOL;

$setActive = $r->getMethod("setActive");
$setActive->setAccessible(true);
$request = new Symfony\Component\HttpFoundation\Request([], [], [], [], [], [], json_encode(["filename" => "2025-2026.sqlite3"]));
$response = $setActive->invoke($ctrl, $request);
echo $response->getContent(), PHP_EOL;

echo readlink($dir."/active.sqlite3"), PHP_EOL;
'
```

Expected: the first line lists `2024-2025.sqlite3` (label `2024/25`, `isTaxYear: true`), `2025-2026.sqlite3` (label `2025/26`), and `development.sqlite3` (`label: null`, `isTaxYear: false`) — `active.sqlite3` itself absent from the list. The second line shows the switched-to `2025-2026.sqlite3` entry with `active: true`. The third line ends in `2025-2026.sqlite3`, confirming the symlink was actually repointed.

```bash
rm -rf /tmp/db-switch-test
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/Controller/DatabaseController.php
git commit -m "Add DatabaseController: list and switch among existing tax-year databases"
```

---

## Task 4: `DatabaseController` — create a brand-new blank database

**Files:**
- Modify: `backend/src/Controller/DatabaseController.php` (add one action + its helpers; everything from Task 3 stays)

**Interfaces:**
- Produces: `POST /api/databases` body `{startYear: int}` → `201` with the new entry, or `400`/`409` `{"error": "..."}`.
- Consumes: `Symfony\Component\Process\Process`, `Symfony\Component\Process\PhpExecutableFinder` (Task 1).

- [ ] **Step 1: Add the `create` action**

Add these two `use` statements at the top of `backend/src/Controller/DatabaseController.php`, alongside the existing ones:

```php
use Symfony\Component\Process\PhpExecutableFinder;
use Symfony\Component\Process\Process;
```

Add this method to the class, anywhere after `setActive()`:

```php
    #[Route('', methods: ['POST'])]
    public function create(Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);
        $startYearRaw = \is_array($body) ? ($body['startYear'] ?? null) : null;

        if (!\is_int($startYearRaw) && !(\is_string($startYearRaw) && ctype_digit($startYearRaw))) {
            return new JsonResponse(['error' => 'startYear must be a whole number'], 400);
        }
        $startYear = (int) $startYearRaw;
        if ($startYear < 1900 || $startYear > 2200) {
            return new JsonResponse(['error' => 'startYear is not a plausible year'], 400);
        }

        $filename = \sprintf('%d-%d.sqlite3', $startYear, $startYear + 1);
        $dir = $this->databasesDir();
        $path = $dir.'/'.$filename;
        if (file_exists($path)) {
            return new JsonResponse(['error' => \sprintf('%s already exists', $filename)], 409);
        }

        if (false === touch($path)) {
            return new JsonResponse(['error' => \sprintf('Could not create %s', $filename)], 500);
        }

        $phpBinary = (new PhpExecutableFinder())->find();
        if (false === $phpBinary) {
            @unlink($path);

            return new JsonResponse(['error' => 'Could not locate the PHP binary to run migrations'], 500);
        }
        $consolePath = $this->projectDir.'/bin/console';
        $env = ['DATABASE_URL' => \sprintf('sqlite:///%s', $path)];

        // Exactly the two commands CLAUDE.md already documents as the
        // correct way to bootstrap a fresh database — reused as
        // subprocesses rather than reimplemented, so there's no second,
        // less-tested code path for "build a database's schema."
        $migrate = new Process([$phpBinary, $consolePath, 'doctrine:migrations:migrate', '--no-interaction'], $this->projectDir, $env);
        $migrate->run();
        if (!$migrate->isSuccessful()) {
            @unlink($path);

            return new JsonResponse(['error' => 'Failed to migrate the new database: '.$migrate->getErrorOutput()], 500);
        }

        $seed = new Process([$phpBinary, $consolePath, 'app:currencies:seed'], $this->projectDir, $env);
        $seed->run();
        if (!$seed->isSuccessful()) {
            @unlink($path);

            return new JsonResponse(['error' => 'Failed to seed currencies for the new database: '.$seed->getErrorOutput()], 500);
        }

        return new JsonResponse($this->entryFor($filename, $this->activeTarget($dir)), 201);
    }
```

- [ ] **Step 2: Verify against a real scratch directory (this one needs the actual HTTP path, since it shells out relative to `$this->projectDir`)**

The cleanest way to exercise this for real without touching the live app: temporarily copy the whole `backend/` tree's essential pieces isn't practical — instead, verify the *subprocess mechanics* directly, the same way `NewYearCommand`'s file-path resolution was verified earlier in this project (a standalone PHP script), since that's the part genuinely new here (the filename/validation logic was already covered by Task 3's reflection-based test):

```bash
cd backend
rm -f /tmp/db-create-test.sqlite3
php bin/console doctrine:migrations:migrate --no-interaction 2>&1 | tail -3   # sanity: confirms the two commands below work standalone first
DATABASE_URL="sqlite:////tmp/db-create-test.sqlite3" php bin/console doctrine:migrations:migrate --no-interaction
DATABASE_URL="sqlite:////tmp/db-create-test.sqlite3" php bin/console app:currencies:seed
sqlite3 /tmp/db-create-test.sqlite3 "SELECT COUNT(*) FROM currency;"
sqlite3 /tmp/db-create-test.sqlite3 "SELECT COUNT(*) FROM account;"
```

Expected: `9` currencies, `0` accounts — proves the exact two-command sequence `create()` runs (with `DATABASE_URL` overridden the same way) produces a working, empty, currency-seeded database. Then confirm `PhpExecutableFinder` resolves correctly on this machine:

```bash
php -r 'require "vendor/autoload.php"; echo (new Symfony\Component\Process\PhpExecutableFinder())->find(), PHP_EOL;'
```

Expected: a real path to a `php` binary (not `false`).

```bash
rm -f /tmp/db-create-test.sqlite3
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/Controller/DatabaseController.php
git commit -m "DatabaseController: create a brand-new blank database (no databases to choose from yet)"
```

---

## Task 5: `DatabaseController` — start a new tax year

**Files:**
- Modify: `backend/src/Controller/DatabaseController.php` (add one action + constructor param; everything from Tasks 3-4 stays)

**Interfaces:**
- Consumes: `NewYearService::createNextYear()` (Task 2).
- Produces: `POST /api/databases/new-year` (no body) → `201` with the new entry, or `400` `{"error": "..."}`.

- [ ] **Step 1: Inject `NewYearService` and add the `newYear` action**

Add this `use` statement:

```php
use App\Service\NewYearService;
```

Change the constructor to:

```php
    public function __construct(
        #[Autowire('%kernel.project_dir%')]
        private readonly string $projectDir,
        private readonly NewYearService $newYearService,
    ) {
    }
```

Add this method to the class, anywhere after `create()`:

```php
    #[Route('/new-year', methods: ['POST'])]
    public function newYear(): JsonResponse
    {
        $dir = $this->databasesDir();
        $activeTarget = $this->activeTarget($dir);
        if (null === $activeTarget) {
            return new JsonResponse(['error' => 'No active database to start a new tax year from'], 400);
        }

        if (!preg_match(self::TAX_YEAR_PATTERN, $activeTarget, $m)) {
            return new JsonResponse(['error' => \sprintf('"%s" isn\'t a recognized tax-year filename — can\'t compute the next year', $activeTarget)], 400);
        }

        $nextStart = ((int) $m[1]) + 1;
        $newFilename = \sprintf('%d-%d.sqlite3', $nextStart, $nextStart + 1);
        $newPath = $dir.'/'.$newFilename;

        try {
            $this->newYearService->createNextYear($newPath);
        } catch (\InvalidArgumentException $e) {
            return new JsonResponse(['error' => $e->getMessage()], 400);
        }

        return new JsonResponse($this->entryFor($newFilename, $activeTarget), 201);
    }
```

- [ ] **Step 2: Verify against a scratch copy**

```bash
cd backend
grep '^DATABASE_URL' .env.local   # note the currently active file
cp databases/2024-2025.sqlite3 /tmp/ny-active-test.sqlite3   # substitute whatever .env.local actually named
rm -f /tmp/ny-active-test-next.sqlite3
DATABASE_URL="sqlite:////tmp/ny-active-test.sqlite3" php bin/console app:new-year /tmp/ny-active-test-next.sqlite3
```

Expected: succeeds, same as Task 2's verification — this confirms `NewYearService::createNextYear()` still works standalone. The controller action itself (filename parsing, `400` on a non-tax-year active file) is pure string logic already covered by inspection; a full HTTP-level check happens in Task 11's end-to-end pass once the real symlink exists.

```bash
rm -f /tmp/ny-active-test.sqlite3 /tmp/ny-active-test-next.sqlite3
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/Controller/DatabaseController.php
git commit -m "DatabaseController: start a new tax year, backed by NewYearService"
```

---

## Task 6: The one-time real migration to the symlink mechanism

**Files:**
- Create: `backend/.env.dev`
- Modify: `backend/.env.local` (empty out the `DATABASE_URL` block)
- Create: `backend/databases/active.sqlite3` (a real symlink, not tracked by git — `databases/` is already gitignored)

**Interfaces:** none — this is environment setup, not code.

This is a real, one-time change to the actual dev setup, done explicitly and watched — not folded into any scratch/testing step. Placed here (before Task 7's listener change) specifically so the live app is never in a broken state: once Task 7 starts enforcing "active.sqlite3 must be a valid symlink," it must already be one.

- [ ] **Step 1: Confirm which file is currently active**

Run: `cd backend && grep '^DATABASE_URL' .env.local`
Expected: one line naming a file under `databases/` — re-check this now even though the spec/plan assumed `2024-2025.sqlite3`, since this can change between sessions without notice.

- [ ] **Step 2: Create the symlink**

```bash
cd backend/databases
ln -s <the-file-from-step-1> active.sqlite3   # e.g. ln -s 2024-2025.sqlite3 active.sqlite3
ls -la active.sqlite3
```

Expected: `ls -la` shows `active.sqlite3 -> <the-file-from-step-1>`.

- [ ] **Step 3: Add `.env.dev`**

Create `backend/.env.dev`:

```
# Dev-only DATABASE_URL override — always the fixed symlink at
# databases/active.sqlite3, never a specific tax year's file directly.
# See DatabaseController and CLAUDE.md's "The active tax year": switching
# which file is active is done from inside the running app now (repoints
# the symlink), not by editing this file. test keeps its own separate
# var/data_test.db via the base .env's %kernel.environment%-templated
# default, untouched by this override.
DATABASE_URL="sqlite:///%kernel.project_dir%/databases/active.sqlite3"
```

- [ ] **Step 4: Empty out `.env.local`'s now-obsolete `DATABASE_URL` block**

Replace the entire contents of `backend/.env.local` with:

```
# Nothing needed here anymore — DATABASE_URL is fixed in .env.dev,
# pointing at the databases/active.sqlite3 symlink. Switching which tax
# year's file is active is done from inside the running app (see
# DatabaseController) rather than by editing this file.
```

- [ ] **Step 5: Clear the Symfony cache defensively**

Run: `cd backend && php bin/console cache:clear`
Expected: succeeds. (`.env` resolution is normally re-evaluated per request in `dev`, not baked into the compiled container, but this guards against any stale state either way.)

- [ ] **Step 6: Verify the live app still serves the same data through the symlink**

```bash
curl -s http://127.0.0.1:8000/api/accounts | python3 -c "import json,sys; print(len(json.load(sys.stdin)), 'accounts')"
```

Expected: the same account count the live app showed before this task (if the backend dev server wasn't already running, start it first: `symfony server:start -d --port=8000` from `backend/`). If this doesn't match, stop and investigate before proceeding — do not continue to Task 7 with a broken symlink in place.

- [ ] **Step 7: Commit**

```bash
cd backend && git add .env.dev .env.local && git commit -m "Switch to the fixed active.sqlite3 symlink for DATABASE_URL

.env.local's per-year commented-line convention is retired — DATABASE_URL
is now always backend/.env.dev's fixed path to databases/active.sqlite3,
a symlink DatabaseController repoints to switch years. The symlink itself
(databases/active.sqlite3) isn't tracked by git, same as every other file
under the already-gitignored databases/ directory."
```

---

## Task 7: `MigrationStatusListener` — detect "no active database"

**Files:**
- Modify: `backend/src/EventListener/MigrationStatusListener.php` (full rewrite, small diff)

**Interfaces:**
- Produces: on `/api/*` (except `/api/databases*`) with no valid `active.sqlite3` symlink, `503` `{"error": "...", "reason": "no_active_database"}`. The existing migrations-pending `503` now also carries `"reason": "migrations_pending"`.
- Consumes: nothing new.

- [ ] **Step 1: Rewrite the listener**

Replace `backend/src/EventListener/MigrationStatusListener.php` entirely with:

```php
<?php

namespace App\EventListener;

use Doctrine\Migrations\DependencyFactory;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\EventDispatcher\Attribute\AsEventListener;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpKernel\Event\RequestEvent;

/**
 * Refuses every `/api/*` request (except `/api/databases*` — see below)
 * with one clear, specific message in two situations, instead of letting
 * whatever exception happens to fire first surface as a generic 500:
 *
 *  - No active database at all: `databases/active.sqlite3` doesn't exist,
 *    isn't a symlink, or points at a file that no longer exists (e.g. a
 *    fresh clone — `databases/` is gitignored, so a new checkout starts
 *    with nothing there). Checked *before* any connection is ever
 *    attempted, specifically because SQLite's PDO driver would otherwise
 *    silently *create* an empty regular file at that path the moment
 *    anything tried to open a connection — masking the real "nothing set
 *    up yet" state and leaving a stray non-symlink file sitting where
 *    active.sqlite3 is supposed to be a symlink.
 *  - The active database's schema hasn't caught up with the latest
 *    migration. This bit for real once: a database missing a single
 *    migration made GET /api/accounts 500, which — because App.jsx used
 *    to gate the rest of its startup fetch on accounts succeeding —
 *    cascaded into the currency picker looking broken too, with no clue
 *    that the actual problem was one unrun migration.
 *
 * Both responses carry a machine-readable `reason` field
 * ("no_active_database" / "migrations_pending") so App.jsx can branch on
 * it directly instead of matching message text.
 *
 * `/api/databases*` (DatabaseController — list/switch/create/roll
 * forward databases) is exempt from both checks: a database in either
 * bad state must not make it impossible to reach the UI that fixes it.
 *
 * Runs at a high priority specifically so it short-circuits before
 * routing or any controller touches the database. If the migration
 * status check itself throws (e.g. a file with no tables at all, not
 * even the migrations-tracking one) that's treated the same as "out of
 * date" rather than letting a different raw exception through — the
 * message is less precise but the fix is identical either way.
 */
#[AsEventListener(event: 'kernel.request', priority: 300)]
class MigrationStatusListener
{
    public function __construct(
        #[Autowire(service: 'doctrine.migrations.dependency_factory')]
        private readonly DependencyFactory $dependencyFactory,
        #[Autowire('%kernel.project_dir%')]
        private readonly string $projectDir,
    ) {
    }

    public function __invoke(RequestEvent $event): void
    {
        $path = $event->getRequest()->getPathInfo();
        if (!$event->isMainRequest() || !str_starts_with($path, '/api') || str_starts_with($path, '/api/databases')) {
            return;
        }

        if (!$this->hasActiveDatabase()) {
            $event->setResponse(new JsonResponse([
                'error' => 'No active database — select or create one to continue.',
                'reason' => 'no_active_database',
            ], 503));

            return;
        }

        try {
            $pending = $this->dependencyFactory->getMigrationStatusCalculator()->getNewMigrations()->count();
        } catch (\Throwable) {
            $pending = null;
        }

        if (0 === $pending) {
            return;
        }

        $message = null === $pending
            ? 'Database schema is out of date or not yet migrated — run: php bin/console doctrine:migrations:migrate'
            : \sprintf(
                'Database schema is out of date (%d migration%s pending) — run: php bin/console doctrine:migrations:migrate',
                $pending,
                1 === $pending ? '' : 's'
            );

        $event->setResponse(new JsonResponse(['error' => $message, 'reason' => 'migrations_pending'], 503));
    }

    private function hasActiveDatabase(): bool
    {
        $active = $this->projectDir.'/databases/active.sqlite3';
        if (!is_link($active)) {
            return false;
        }
        $target = readlink($active);

        return false !== $target && file_exists($target);
    }
}
```

- [ ] **Step 2: Verify the real app still works (Task 6's symlink already exists)**

Run: `curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:8000/api/accounts | tail -3`
Expected: the account list, `HTTP 200`.

- [ ] **Step 3: Verify the "no active database" path, on a scratch copy of just the symlink**

```bash
cd backend/databases
mv active.sqlite3 active.sqlite3.bak
curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:8000/api/accounts
```

Expected: `{"error":"No active database...","reason":"no_active_database"}`, `HTTP 503`.

```bash
curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:8000/api/databases
```

Expected: the real database list, `HTTP 200` — confirms the `/api/databases*` exemption works even while `active.sqlite3` is missing.

```bash
mv active.sqlite3.bak active.sqlite3
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/api/accounts
```

Expected: `200` — restored.

- [ ] **Step 4: Verify the migrations-pending path still works, and still exempts `/api/databases*`, using a scratch database**

```bash
cd backend
cp databases/active.sqlite3.bak 2>/dev/null || cp "$(readlink databases/active.sqlite3)" /tmp/mig-pending-test.sqlite3
# ^ copy whatever active.sqlite3 currently resolves to
cd backend
DATABASE_URL="sqlite:////tmp/mig-pending-test.sqlite3" php bin/console doctrine:migrations:execute --down "DoctrineMigrations\\Version20260917222410" --no-interaction
mv databases/active.sqlite3 /tmp/active.sqlite3.realbak
ln -s /tmp/mig-pending-test.sqlite3 databases/active.sqlite3
curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:8000/api/accounts
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/api/databases
rm databases/active.sqlite3
mv /tmp/active.sqlite3.realbak databases/active.sqlite3
rm -f /tmp/mig-pending-test.sqlite3
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/api/accounts
```

Expected: first `curl` returns `{"error":"Database schema is out of date...","reason":"migrations_pending"}` with `503`; second returns `200` (the exemption holds); final `curl` returns `200` again (fully restored to the real database).

- [ ] **Step 5: `php bin/phpunit` still green**

Run: `cd backend && php bin/phpunit`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/EventListener/MigrationStatusListener.php
git commit -m "MigrationStatusListener: detect and clearly report no active database

A fresh clone (databases/ is gitignored) or a manually broken symlink
now gets a clear, machine-readable {\"reason\": \"no_active_database\"}
503 instead of SQLite silently creating an empty file where
active.sqlite3 is supposed to be a symlink. /api/databases* stays
exempt from both this and the existing migrations-pending check, so
the switcher UI is always reachable to fix either state."
```

---

## Task 8: Frontend — `api.js` additions

**Files:**
- Modify: `src/api.js`

**Interfaces:**
- Produces: `getDatabases()`, `setActiveDatabase(filename)`, `createDatabase(startYear)`, `startNewTaxYear()` — each returning the promise `request()` returns. Errors thrown by `request()` now carry `.reason` when the backend's JSON body included one.
- Consumes: nothing new from earlier tasks (talks to Tasks 3-7's endpoints by URL).

- [ ] **Step 1: Make `request()` attach `reason` to the thrown error**

In `src/api.js`, replace:

```js
async function request(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    // A handful of endpoints (the ledger batch write, symbol creation)
    // return a deliberate 400/409 with {"error": "..."} for an expected
    // rejection rather than a bug — surface that message when present so
    // a caller can show it directly, instead of always falling back to
    // the generic "<method> <path> failed: <status>".
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `${options?.method || "GET"} ${path} failed: ${res.status}`);
  }
  return res.json();
}
```

with:

```js
async function request(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    // A handful of endpoints (the ledger batch write, symbol creation,
    // the database switcher) return a deliberate 400/409/503 with
    // {"error": "...", "reason"?: "..."} for an expected rejection rather
    // than a bug — surface the message when present so a caller can show
    // it directly, instead of always falling back to the generic
    // "<method> <path> failed: <status>". `reason` (when the backend
    // supplied one — see MigrationStatusListener) lets a caller branch on
    // a stable machine-readable value instead of matching message text.
    const body = await res.json().catch(() => null);
    const err = new Error(body?.error || `${options?.method || "GET"} ${path} failed: ${res.status}`);
    if (body?.reason) err.reason = body.reason;
    throw err;
  }
  return res.json();
}
```

- [ ] **Step 2: Add the four new functions**

At the end of `src/api.js`, add:

```js

// The database switcher — see CLAUDE.md's "The active tax year" and
// backend/src/Controller/DatabaseController.php. `filename` is always a
// bare *.sqlite3 name under backend/databases/, never a path.
export function getDatabases() {
  return request("/api/databases");
}
export function setActiveDatabase(filename) {
  return request("/api/databases/active", { method: "POST", ...jsonBody({ filename }) });
}
export function createDatabase(startYear) {
  return request("/api/databases", { method: "POST", ...jsonBody({ startYear }) });
}
export function startNewTaxYear() {
  return request("/api/databases/new-year", { method: "POST" });
}
```

- [ ] **Step 3: `yarn build` clean**

Run: `yarn build`
Expected: builds without errors.

- [ ] **Step 4: Commit**

```bash
git add src/api.js
git commit -m "api.js: surface backend error 'reason', add database switcher functions"
```

---

## Task 9: Frontend — `DatabaseSwitcher.jsx`

**Files:**
- Create: `src/components/DatabaseSwitcher.jsx`

**Interfaces:**
- Produces:
  - `DatabaseSwitcher({ attemptNavigation, onSwitched })` — header trigger + popover.
  - `DatabaseSwitcherBlocking({ onSwitched })` — full-screen, non-dismissible variant.
- Consumes: `api.getDatabases/setActiveDatabase/createDatabase/startNewTaxYear` (Task 8), `taxYearStartYearFor`/`taxYearBounds` (`src/lib/isa.js`, already exists), `todayISO` (`src/lib/format.js`, already exists), `miniInput` (`src/components/ui.jsx`, already exists).

- [ ] **Step 1: Write the component**

```jsx
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { C } from "../lib/theme";
import { todayISO } from "../lib/format";
import { taxYearStartYearFor, taxYearBounds } from "../lib/isa";
import { miniInput } from "./ui";
import * as api from "../api";

const TAX_YEAR_PATTERN = /^(\d{4})-(\d{4})\.sqlite3$/;

// The shared list-or-create-form content — used both inside the header's
// small popover (DatabaseSwitcher) and, fullScreen, as the blocking
// "no active database" state (DatabaseSwitcherBlocking). `entries` is
// GET /api/databases's response, already fetched by the caller (each
// wrapper owns its own fetch — see below for why). `onDone` fires once a
// switch/create/new-year action has actually succeeded server-side; this
// component never reloads the page itself, so it stays usable in both
// contexts — see CLAUDE.md's "The active tax year".
function DatabasePicker({ entries, fullScreen, attemptNavigation, onDone }) {
  const [showAll, setShowAll] = useState(false);
  const [startYear, setStartYear] = useState(() => String(taxYearStartYearFor(todayISO())));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const taxYearEntries = entries.filter((e) => e.isTaxYear);
  const visible = showAll ? entries : taxYearEntries;
  const active = entries.find((e) => e.active);
  const latestTaxYear = taxYearEntries.reduce((max, e) => (!max || e.filename > max.filename ? e : max), null);
  // Only offered from the currently active file, and only when it's the
  // latest tax-year one present — see the design doc's Frontend section.
  // (This condition is naturally false in the fullScreen/no-active-
  // database case too, since no entry has active:true there — the
  // explicit !fullScreen is belt-and-suspenders, matching the spec's
  // explicit requirement.)
  const showStartNewYear = !fullScreen && active && latestTaxYear && active.filename === latestTaxYear.filename;

  function guarded(action) {
    if (attemptNavigation) attemptNavigation(action);
    else action();
  }

  function finish(promise) {
    setBusy(true);
    setError("");
    promise.then(onDone).catch((e) => { setError(e.message); setBusy(false); });
  }

  function pick(filename) {
    guarded(() => finish(api.setActiveDatabase(filename)));
  }

  function startNewYear() {
    guarded(() => finish(api.startNewTaxYear().then((entry) => api.setActiveDatabase(entry.filename))));
  }

  function create() {
    const year = parseInt(startYear, 10);
    if (!Number.isInteger(year)) {
      setError("Enter a whole number for the tax year.");
      return;
    }
    guarded(() => finish(api.createDatabase(year).then((entry) => api.setActiveDatabase(entry.filename))));
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col gap-2" style={{ minWidth: 220 }}>
        <div style={{ fontSize: 12.5, color: C.inkSoft }}>No databases yet — create the first one.</div>
        <label style={{ display: "block" }}>
          <div style={{ fontSize: 11, color: C.inkFaint, marginBottom: 3, textTransform: "uppercase", letterSpacing: 0.5 }}>Tax year starting</div>
          <input type="number" value={startYear} onChange={(e) => setStartYear(e.target.value)} style={miniInput} />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={create}
          className="px-3 py-1.5 rounded"
          style={{ background: C.ink, color: C.paper, fontSize: 12.5, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Creating…" : "Create"}
        </button>
        {error && <div style={{ fontSize: 12, color: C.debit }}>{error}</div>}
      </div>
    );
  }

  return (
    <div style={{ minWidth: 220 }}>
      <div style={{ maxHeight: 260, overflowY: "auto" }}>
        {visible.map((e) => (
          <button
            key={e.filename}
            type="button"
            disabled={busy}
            onClick={() => pick(e.filename)}
            className="w-full text-left flex items-center justify-between"
            style={{
              padding: "6px 8px",
              borderRadius: 4,
              fontSize: 12.5,
              background: e.active ? C.paperDim : "transparent",
              color: e.active ? C.ink : C.inkSoft,
              fontWeight: e.active ? 600 : 400,
            }}
          >
            <span>{e.label || e.filename}</span>
            {e.active && <span style={{ fontSize: 10.5, color: C.inkFaint }}>active</span>}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1.5" style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 6, cursor: "pointer" }}>
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        Show all files
      </label>
      {showStartNewYear && (
        <button
          type="button"
          disabled={busy}
          onClick={startNewYear}
          className="w-full text-left"
          style={{ padding: "6px 8px", marginTop: 6, borderRadius: 4, fontSize: 12.5, color: C.gold, borderTop: `1px solid ${C.lineSoft}` }}
        >
          {(() => {
            const m = TAX_YEAR_PATTERN.exec(latestTaxYear.filename);
            const label = m ? taxYearBounds(parseInt(m[1], 10) + 1).label : "next year";
            return busy ? "Starting…" : `Start ${label} tax year`;
          })()}
        </button>
      )}
      {error && <div style={{ marginTop: 6, fontSize: 12, color: C.debit }}>{error}</div>}
    </div>
  );
}

// Header trigger + small popover — click-outside-to-close, same pattern
// as AccountPicker.jsx. Fetches its own database list on mount (kept
// separate from DatabasePicker so it can show the active file's label on
// the trigger button itself without the popover needing to be open).
export function DatabaseSwitcher({ attemptNavigation, onSwitched }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState(null); // null = still loading
  const containerRef = useRef(null);

  useEffect(() => {
    api.getDatabases().then(setEntries).catch(() => setEntries([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const active = (entries || []).find((e) => e.active);
  const label = active ? active.label || active.filename : "Select database";

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded"
        style={{ border: `1px solid ${C.line}`, padding: "5px 10px", fontSize: 12.5, color: C.inkSoft, background: "transparent" }}
      >
        <span className="ll-mono">{label}</span>
        <ChevronDown size={12} />
      </button>
      {open && entries && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 40,
            background: C.card,
            border: `1px solid ${C.line}`,
            borderRadius: 6,
            padding: 10,
            boxShadow: "0 8px 24px rgba(34,39,31,0.18)",
          }}
        >
          <DatabasePicker
            entries={entries}
            attemptNavigation={attemptNavigation}
            onDone={() => { setOpen(false); onSwitched(); }}
          />
        </div>
      )}
    </div>
  );
}

// Full-screen, non-dismissible variant for when there's no active
// database at all — see App.jsx's noActiveDatabase state and
// MigrationStatusListener's "no_active_database" reason. No
// attemptNavigation here: nothing in the app has loaded yet, so there's
// nothing to guard against navigating away from.
export function DatabaseSwitcherBlocking({ onSwitched }) {
  const [entries, setEntries] = useState(null);

  useEffect(() => {
    api.getDatabases().then(setEntries).catch(() => setEntries([]));
  }, []);

  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ background: C.paper, zIndex: 100 }}>
      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 8, padding: 22, width: 380, maxWidth: "92vw", boxShadow: "0 12px 40px rgba(34,39,31,0.25)" }}>
        <h3 className="ll-serif" style={{ fontSize: 17, marginBottom: 4 }}>Select a database</h3>
        <p style={{ fontSize: 12.5, color: C.inkFaint, marginBottom: 14 }}>No database is active yet — pick one below, or create your first.</p>
        {null === entries ? (
          <div style={{ fontSize: 12.5, color: C.inkFaint }}>Loading…</div>
        ) : (
          <DatabasePicker entries={entries} fullScreen onDone={onSwitched} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `yarn build` clean**

Run: `yarn build`
Expected: builds without errors (this component isn't wired into the app yet, so nothing renders it — this just confirms it compiles and its imports resolve).

- [ ] **Step 3: Commit**

```bash
git add src/components/DatabaseSwitcher.jsx
git commit -m "Add DatabaseSwitcher.jsx: header dropdown and full-screen blocking variant"
```

---

## Task 10: Frontend — wire `DatabaseSwitcher` into `App.jsx`

**Files:**
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `DatabaseSwitcher`, `DatabaseSwitcherBlocking` (Task 9); `attemptNavigation` (already exists in `App.jsx`).

- [ ] **Step 1: Import the new component**

In `src/App.jsx`, add this import alongside the other component imports (near the top, with the other `./components/...` imports):

```js
import { DatabaseSwitcher, DatabaseSwitcherBlocking } from "./components/DatabaseSwitcher";
```

- [ ] **Step 2: Add `noActiveDatabase` state**

Find this existing block (around line 48-53):

```js
  const [storageOK, setStorageOK] = useState(true);
  // Set only when the backend itself told us why (e.g. a database missing
  // a migration — see MigrationStatusListener) rather than a generic
  // network failure, so the banner below can show that specific reason
  // instead of always falling back to "check that the server is running".
  const [backendErrorReason, setBackendErrorReason] = useState("");
```

Add immediately after it:

```js
  // True specifically when the backend reported "no_active_database" —
  // see MigrationStatusListener — distinct from a generic backend
  // failure: this renders a full-screen, non-dismissible database picker
  // instead of the normal app shell (see the early return below), rather
  // than just a banner.
  const [noActiveDatabase, setNoActiveDatabase] = useState(false);
```

- [ ] **Step 3: Detect the reason in the startup fetch**

Find this existing block (around line 154-161):

```js
        refreshAccounts().catch((e) => {
          // A real network failure (server not running at all) rejects
          // fetch() itself with a TypeError before any response exists —
          // only trust e.message as a specific reason when it didn't.
          setBackendErrorReason(e instanceof TypeError ? "" : e.message);
          return null;
        }),
```

Replace with:

```js
        refreshAccounts().catch((e) => {
          // A real network failure (server not running at all) rejects
          // fetch() itself with a TypeError before any response exists —
          // only trust e.message as a specific reason when it didn't.
          setBackendErrorReason(e instanceof TypeError ? "" : e.message);
          if (e && e.reason === "no_active_database") setNoActiveDatabase(true);
          return null;
        }),
```

- [ ] **Step 4: Render the full-screen blocking state**

Find the start of the component's main render (around line 340):

```js
  return (
    <div style={{ background: C.paper, color: C.ink, height: "100%", display: "flex", flexDirection: "column", fontFamily: "'Inter', sans-serif" }} className="w-full">
```

Insert immediately before it (this must come after every hook call above it in the file, which it does — all `useState`/`useEffect` calls happen earlier):

```js
  if (noActiveDatabase) {
    return <DatabaseSwitcherBlocking onSwitched={() => window.location.reload()} />;
  }

```

- [ ] **Step 5: Add the header trigger**

Find the header's right-hand button group (around line 359-360):

```jsx
        <div className="flex items-center gap-3">
          {activeTaxYearStart != null && (
```

Replace with:

```jsx
        <div className="flex items-center gap-3">
          <DatabaseSwitcher attemptNavigation={attemptNavigation} onSwitched={() => window.location.reload()} />
          {activeTaxYearStart != null && (
```

(The existing `activeTaxYearStart`-derived badge right after this — the data-computed tax year label and its "N outside" warning — is untouched: a different concern, which file you're in vs. what the data in it says.)

- [ ] **Step 6: `yarn build` clean**

Run: `yarn build`
Expected: builds without errors.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "Wire DatabaseSwitcher into App.jsx: header trigger + full-screen blocking state"
```

---

## Task 11: End-to-end manual verification

**Files:** none — verification only, per the design doc's Testing section.

- [ ] **Step 1: Switching between two real databases**

With the frontend dev server (`yarn dev`) and backend (`symfony server:start`, already running throughout) both up, open the app in the browser pane. Click the new header trigger, confirm it lists tax-year files with the currently active one marked. Pick a different one, confirm the reload lands on that database's actual data (spot-check an account balance that differs between the two files).

- [ ] **Step 2: The dirty-draft guard**

Start editing a ledger entry (don't save). Open the switcher and pick a different database. Confirm the existing Save/Discard/Stay prompt appears. Choose "Stay" — confirm you're still on the draft and no switch happened. Repeat and choose "Discard" — confirm the switch proceeds.

- [ ] **Step 3: "Start a new tax year" visibility**

Confirm the option appears only when the active database is the filename-latest tax-year file present (check `GET /api/databases` in the Network tab to see the full list and compare). Switch to an older tax-year file and confirm the option disappears from the dropdown.

- [ ] **Step 3b: "Start a new tax year" actually triggered, compared against the command**

This creates a real new file, so do it against a scratch copy of `databases/`, not the real one — per the testing-isolation convention.

```bash
mkdir -p /tmp/ny-ui-test/databases
cp backend/databases/<latest-real-tax-year-file>.sqlite3 /tmp/ny-ui-test/databases/
```

First, capture what the CLI path produces (this mirrors exactly what `DatabaseController::newYear()` calls):

```bash
cd backend
DATABASE_URL="sqlite:////tmp/ny-ui-test/databases/<latest-real-tax-year-file>.sqlite3" \
  php bin/console app:new-year /tmp/ny-ui-test/databases/cli-result.sqlite3
sqlite3 /tmp/ny-ui-test/databases/cli-result.sqlite3 "SELECT id, opening_balance, opening_balance_cash_value FROM account ORDER BY id;" > /tmp/ny-ui-test/cli-result.txt
```

Then point a throwaway backend + the switcher's `POST /api/databases/new-year` at the *same* source file (a fresh copy, so the CLI run above doesn't interfere) and let it compute and create `<nextYear>-<nextYear+1>.sqlite3` itself — either by driving the real UI against a throwaway backend instance (same approach as Step 5 below), or directly:

```bash
cp backend/databases/<latest-real-tax-year-file>.sqlite3 /tmp/ny-ui-test/databases/active-src.sqlite3
ln -sf active-src.sqlite3 /tmp/ny-ui-test/databases/active.sqlite3
# start a throwaway backend against /tmp/ny-ui-test pointed at databases/active.sqlite3, then:
curl -s -X POST http://127.0.0.1:8099/api/databases/new-year
sqlite3 /tmp/ny-ui-test/databases/<nextYear>-<nextYear+1>.sqlite3 "SELECT id, opening_balance, opening_balance_cash_value FROM account ORDER BY id;" > /tmp/ny-ui-test/api-result.txt
diff /tmp/ny-ui-test/cli-result.txt /tmp/ny-ui-test/api-result.txt
```

Expected: `diff` reports no differences — the API-triggered result is identical to the CLI-triggered one.

```bash
rm -rf /tmp/ny-ui-test
```

- [ ] **Step 4: No active database (full-screen blocking state)**

Per the testing-isolation convention — do this on the real `databases/active.sqlite3`, since this specific scenario is about the symlink's *presence*, not about database content, and reverting it is a single `mv` back:

```bash
cd backend/databases
mv active.sqlite3 /tmp/active.sqlite3.verify-bak
```

Reload the app in the browser. Confirm the full-screen picker appears (no header, no sidebar, nothing else usable), lists the real tax-year files, and has no close/dismiss control. Pick one, confirm it switches and reloads into the normal app.

```bash
# if the picker's own switch didn't already restore a working symlink,
# or you want to restore the exact original target:
cd backend/databases
rm -f active.sqlite3
mv /tmp/active.sqlite3.verify-bak active.sqlite3   # only if step above didn't leave a working symlink already
```

Confirm `curl -s http://127.0.0.1:8000/api/accounts | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"` shows the expected real account count before moving on.

- [ ] **Step 5: No databases at all (empty-state creation)**

Per the testing-isolation convention, this one must happen against a scratch directory — never empty out the real `databases/` folder.

```bash
mkdir -p /tmp/empty-db-test/databases
cp -r backend/. /tmp/empty-db-test/ 2>/dev/null || true
rm -f /tmp/empty-db-test/databases/*.sqlite3
```

Start a throwaway backend instance against this scratch copy:

```bash
cd /tmp/empty-db-test && symfony server:start --port=8099 -d
```

Confirm the empty-state HTTP path works directly first:

```bash
curl -s http://127.0.0.1:8099/api/databases
curl -s -X POST http://127.0.0.1:8099/api/databases -H "Content-Type: application/json" -d '{"startYear": 2030}'
curl -s http://127.0.0.1:8099/api/databases
```

Expected: first call returns `[]`; the `POST` returns a `201` with the new `2030-2031.sqlite3` entry; the final call now lists it.

Then drive the actual UI against this scratch backend: temporarily edit `vite.config.js`'s dev proxy target from `http://127.0.0.1:8000` to `http://127.0.0.1:8099`, restart `yarn dev`, reload the browser tab. Confirm the header trigger opens to the empty-state year input (defaulting to the current UK tax year), and that submitting it switches into the newly created database. Revert `vite.config.js` and restart `yarn dev` once done.

```bash
symfony server:stop --port=8099 2>/dev/null || true
rm -rf /tmp/empty-db-test
```

- [ ] **Step 6: Final full-suite check**

```bash
cd backend && php bin/phpunit
cd .. && yarn build
```

Expected: both clean.

- [ ] **Step 7: Update CLAUDE.md**

Add a short paragraph to CLAUDE.md's "Backend" section (near the existing `MigrationStatusListener` bullet) and "Commands" section documenting: `DatabaseController`'s four endpoints, that `DATABASE_URL` is now fixed at `databases/active.sqlite3` (a symlink) via `.env.dev`, and that switching/creating/rolling forward a tax year's database is now done from inside the app rather than by hand-editing `.env.local`. Update the existing `app:new-year` bullet to note its logic now lives in `NewYearService`, shared with the in-app action. Commit this alongside no code change:

```bash
git add CLAUDE.md
git commit -m "Document the in-app database switcher in CLAUDE.md"
```
