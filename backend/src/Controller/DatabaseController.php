<?php

namespace App\Controller;

use App\Service\AppSettingsRepository;
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
 * `backend/databases/app-settings.yaml` names which file is active — see
 * AppSettingsRepository and the design doc this implements
 * (docs/superpowers/specs/2026-09-19-app-settings-and-active-database-design.md).
 * Switching is a plain write to that file; the connection middleware
 * (ActiveDatabaseDriver) picks it up on the very next connection, no
 * process signaling or restart needed.
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
        private readonly AppSettingsRepository $appSettingsRepository,
    ) {
    }

    #[Route('', methods: ['GET'])]
    public function list(): JsonResponse
    {
        $dir = $this->databasesDir();
        $activeTarget = $this->appSettingsRepository->read()['activeDatabase'];

        $entries = [];
        foreach (glob($dir.'/*.sqlite3') ?: [] as $path) {
            $entries[] = $this->entryFor(basename($path), $activeTarget);
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

        $this->appSettingsRepository->write(['activeDatabase' => $filename]);

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
        // ACTIVE_DATABASE_PATH_OVERRIDE — not DATABASE_URL — is what
        // ActiveDatabaseDriver checks first (see backend/src/Doctrine/):
        // DATABASE_URL is entirely ignored by the connection middleware
        // now, and reusing it here would just silently do nothing rather
        // than target the new file.
        $env = ['ACTIVE_DATABASE_PATH_OVERRIDE' => $path];

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

        return new JsonResponse($this->entryFor($filename, $this->appSettingsRepository->read()['activeDatabase']), 201);
    }

    #[Route('/new-year', methods: ['POST'])]
    public function newYear(): JsonResponse
    {
        $dir = $this->databasesDir();
        $activeTarget = $this->appSettingsRepository->read()['activeDatabase'];
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
