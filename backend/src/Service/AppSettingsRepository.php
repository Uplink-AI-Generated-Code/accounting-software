<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\Yaml\Exception\ParseException;
use Symfony\Component\Yaml\Yaml;

/**
 * Owns backend/databases/app-settings.yaml — the single source of truth
 * for which tax-year database is active, and for settings that are
 * genuinely global rather than tied to one tax year (groupLevels,
 * savedGroupings). Not Doctrine-managed; this file isn't a database.
 *
 * See docs/superpowers/specs/2026-09-19-app-settings-and-active-database-design.md
 * for why this replaced databases/active.sqlite3 (a symlink) and the
 * per-tax-year settings.groupLevels/savedGroupings columns.
 */
class AppSettingsRepository
{
    private const DEFAULT_SAVED_GROUPING_ID = 'default-type-currency-subtype-counterparty';

    public function __construct(
        #[Autowire('%kernel.project_dir%')]
        private readonly string $projectDir,
    ) {
    }

    /** @return array{activeDatabase: ?string, groupLevels: array<int, string>, savedGroupings: array<int, array{id: string, levels: array<int, string>}>} */
    public function read(): array
    {
        $path = $this->filePath();
        if (!file_exists($path)) {
            return $this->defaults();
        }

        try {
            $parsed = Yaml::parseFile($path);
        } catch (ParseException) {
            // A hand-edited file with a typo shouldn't crash every route
            // (including /api/databases* — the very recovery UI this is
            // meant to stay reachable for). Treat it like a missing file:
            // fall back to defaults, which surfaces as the normal
            // "no_active_database" blocking picker the user can already
            // recover from, not an opaque stack-trace 500.
            return $this->defaults();
        }

        return \is_array($parsed) ? array_merge($this->defaults(), $parsed) : $this->defaults();
    }

    /**
     * Merges $partial into the current content and writes it back —
     * flock()'d exclusive for the whole read-merge-write, so two
     * near-simultaneous writers (two browser tabs, a double-click) can't
     * silently clobber each other: the second writer's read happens
     * *after* the first writer's write completes, not before it.
     *
     * Uses a separate, never-renamed lock file to serialize writers,
     * since flock() on a file that gets rename()'d underneath doesn't
     * work: the lock ends up bound to the old inode, not the new content.
     *
     * @param array<string, mixed> $partial
     *
     * @return array{activeDatabase: ?string, groupLevels: array<int, string>, savedGroupings: array<int, array{id: string, levels: array<int, string>}>}
     */
    public function write(array $partial): array
    {
        $dir = \dirname($this->filePath());
        if (!is_dir($dir) && false === @mkdir($dir, 0777, true) && !is_dir($dir)) {
            throw new \RuntimeException(\sprintf('Could not create %s', $dir));
        }

        $lockHandle = fopen($this->lockFilePath(), 'c+');
        if (false === $lockHandle) {
            throw new \RuntimeException(\sprintf('Could not open lock file %s', $this->lockFilePath()));
        }

        try {
            if (!flock($lockHandle, \LOCK_EX)) {
                throw new \RuntimeException(\sprintf('Could not lock %s', $this->lockFilePath()));
            }

            // Now that we hold the lock on a stable inode (the lock file),
            // read the data file's current content.
            $existingRaw = '';
            if (file_exists($this->filePath())) {
                $existingRaw = file_get_contents($this->filePath());
            }
            $existing = '' !== $existingRaw ? Yaml::parse($existingRaw) : null;
            $merged = array_merge($this->defaults(), \is_array($existing) ? $existing : [], $partial);

            $tmp = $this->filePath().'.tmp-'.bin2hex(random_bytes(4));
            if (false === file_put_contents($tmp, Yaml::dump($merged, 4))) {
                @unlink($tmp);

                throw new \RuntimeException(\sprintf('Could not write %s', $tmp));
            }
            if (!rename($tmp, $this->filePath())) {
                @unlink($tmp);

                throw new \RuntimeException(\sprintf('Could not move %s into place at %s', $tmp, $this->filePath()));
            }

            return $merged;
        } finally {
            flock($lockHandle, \LOCK_UN);
            fclose($lockHandle);
        }
    }

    private function filePath(): string
    {
        return $this->projectDir.'/databases/app-settings.yaml';
    }

    private function lockFilePath(): string
    {
        return $this->filePath().'.lock';
    }

    /** @return array{activeDatabase: ?string, groupLevels: array<int, string>, savedGroupings: array<int, array{id: string, levels: array<int, string>}>} */
    private function defaults(): array
    {
        return [
            'activeDatabase' => null,
            'groupLevels' => [],
            'savedGroupings' => [
                ['id' => self::DEFAULT_SAVED_GROUPING_ID, 'levels' => ['type', 'currency', 'subtype', 'counterparty']],
            ],
        ];
    }
}
