<?php

namespace App\Controller;

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
