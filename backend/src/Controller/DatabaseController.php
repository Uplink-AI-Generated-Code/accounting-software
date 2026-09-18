<?php

namespace App\Controller;

use App\Service\NewYearService;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Process\PhpExecutableFinder;
use Symfony\Component\Process\Process;
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
        private readonly NewYearService $newYearService,
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

        $dir = $this->databasesDir();
        if (!$this->activateSymlink($filename)) {
            return new JsonResponse(['error' => \sprintf('Could not switch to %s', $filename)], 500);
        }

        return new JsonResponse($this->entryFor($filename, $this->activeTarget($dir)));
    }

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

        // A fresh clone has no databases/ at all — it's gitignored (see
        // backend/.gitignore) — and that's exactly the case this action
        // exists to bootstrap out of (the empty-state "create your
        // first database" flow). Without this, touch() below fails
        // silently into "Could not create ..." with no way to recover
        // except creating the directory by hand outside the app.
        if (!is_dir($dir) && false === @mkdir($dir, 0777, true) && !is_dir($dir)) {
            return new JsonResponse(['error' => \sprintf('Could not create %s', $dir)], 500);
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
        // SYMFONY_DOTENV_VARS must be cleared alongside DATABASE_URL: this
        // request's own worker already booted its kernel via Dotenv, which
        // recorded DATABASE_URL there as "loaded from a .env file". Process
        // inherits that var into the child unless we override it too, and
        // Symfony\Component\Dotenv\Dotenv::populate() treats any name
        // already listed in SYMFONY_DOTENV_VARS as fair game to overwrite
        // from .env.dev regardless of what's externally set — silently
        // discarding our DATABASE_URL override and making the migration
        // land in the *current* active.sqlite3 instead of the new file.
        // Confirmed via `php bin/console debug:container --env-var=DATABASE_URL`
        // run both ways: without this, the child reports .env.dev's raw,
        // unresolved value; with it, it correctly reports our override.
        $env = ['DATABASE_URL' => \sprintf('sqlite:///%s', $path), 'SYMFONY_DOTENV_VARS' => ''];

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
        } catch (\RuntimeException $e) {
            return new JsonResponse(['error' => $e->getMessage()], 500);
        }

        return new JsonResponse($this->entryFor($newFilename, $activeTarget), 201);
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
     * or broken symlink. Returns false (leaving active.sqlite3 untouched)
     * if either filesystem operation fails, e.g. a permissions problem
     * or a cross-filesystem rename.
     */
    private function activateSymlink(string $filename): bool
    {
        $dir = $this->databasesDir();
        $target = $dir.'/'.$filename;
        $active = $dir.'/active.sqlite3';
        $tmp = $dir.'/.active.sqlite3.tmp-'.bin2hex(random_bytes(4));

        if (false === symlink($target, $tmp)) {
            return false;
        }
        if (false === rename($tmp, $active)) {
            @unlink($tmp);

            return false;
        }

        $this->reloadPhpFpmWorkers();

        return true;
    }

    /**
     * Under php-fpm, a worker process that already served a request
     * before this switch can keep resolving active.sqlite3 to the *old*
     * file for a while afterward — confirmed empirically (a rapid curl
     * loop against a multi-worker pool showed responses alternating
     * between the old and new file, correlated with which worker
     * handled each request), but not fully pinned down to one
     * mechanism: standard php-fpm tears down PHP-level state between
     * requests, so an already-open DBAL connection surviving isn't the
     * likely cause despite `idle_connection_ttl` (config/packages/
     * doctrine.yaml) existing for exactly that scenario; PHP's own
     * per-worker realpath cache (`realpath_cache_ttl`, 120s by default)
     * resolving the symlink to a stale target is a more likely fit, but
     * wasn't independently isolated. Whichever it is, sending SIGUSR2 to
     * the php-fpm master (this worker's parent process, assumed to
     * still be running — a dead/reparented master would make this a
     * harmless no-op against init instead) fixes it unconditionally:
     * gracefully respawning every worker discards whatever per-worker
     * state was responsible, without needing to know exactly what that
     * state was. Each worker finishes its current request first, so an
     * in-flight response is never dropped by the reload itself — but
     * there's a small window between this response reaching the client
     * and the reload completing where a request could still land on a
     * not-yet-respawned worker and see the old file; `idle_connection_ttl`
     * is a narrow secondary safety net for that window (only covers the
     * "stale open connection" hypothesis, not the realpath-cache one),
     * not a substitute for this reload. A no-op outside php-fpm
     * (e.g. `php bin/console`, or a future non-php-fpm prod SAPI), and
     * also a no-op if the pcntl extension (which defines SIGUSR2 — a
     * separate extension from posix, not guaranteed to ship alongside
     * it) isn't loaded.
     *
     * The signal is deferred to a shutdown function, and
     * fastcgi_finish_request() is called first: sending SIGUSR2 while
     * this request's own response is still buffered raced the reload
     * against the response reaching the client (observed directly as
     * an "unexpected EOF" from the local dev proxy) — flushing the
     * response and closing this worker's client connection first, then
     * signaling, avoids that race.
     */
    private function reloadPhpFpmWorkers(): void
    {
        if ('fpm-fcgi' !== \PHP_SAPI || !\function_exists('posix_kill') || !\defined('SIGUSR2')) {
            return;
        }

        $ppid = posix_getppid();
        if ($ppid <= 1) {
            return;
        }

        register_shutdown_function(static function () use ($ppid): void {
            if (\function_exists('fastcgi_finish_request')) {
                fastcgi_finish_request();
            }
            posix_kill($ppid, \SIGUSR2);
        });
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
        // realpath() (not readlink()+file_exists()) so a relative symlink
        // target resolves against the symlink's own directory rather than
        // the PHP process's CWD — activateSymlink() itself always writes
        // an absolute target, but a hand-created symlink (e.g. `ln -s
        // 2024-2025.sqlite3 active.sqlite3`, exactly what a user typing
        // this by hand would write) is relative, and readlink()+
        // file_exists() would then check for that filename relative to
        // CWD and wrongly report no active database. Keep this in
        // agreement with MigrationStatusListener::hasActiveDatabase(),
        // which does the same check independently.
        $target = realpath($active);

        return false === $target ? null : basename($target);
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
