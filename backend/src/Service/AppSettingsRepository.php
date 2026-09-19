<?php

namespace App\Service;

use Symfony\Component\DependencyInjection\Attribute\Autowire;
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

        $parsed = Yaml::parseFile($path);

        return \is_array($parsed) ? array_merge($this->defaults(), $parsed) : $this->defaults();
    }

    /**
     * Merges $partial into the current content and writes it back —
     * flock()'d exclusive for the whole read-merge-write, so two
     * near-simultaneous writers (two browser tabs, a double-click) can't
     * silently clobber each other: the second writer's read happens
     * *after* the first writer's write completes, not before it.
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

        $handle = fopen($this->filePath(), 'c+');
        if (false === $handle) {
            throw new \RuntimeException(\sprintf('Could not open %s', $this->filePath()));
        }

        try {
            if (!flock($handle, \LOCK_EX)) {
                throw new \RuntimeException(\sprintf('Could not lock %s', $this->filePath()));
            }

            $existingRaw = stream_get_contents($handle);
            $existing = '' !== $existingRaw ? Yaml::parse($existingRaw) : null;
            $merged = array_merge($this->defaults(), \is_array($existing) ? $existing : [], $partial);

            $tmp = $this->filePath().'.tmp-'.bin2hex(random_bytes(4));
            file_put_contents($tmp, Yaml::dump($merged, 4));
            rename($tmp, $this->filePath());

            return $merged;
        } finally {
            flock($handle, \LOCK_UN);
            fclose($handle);
        }
    }

    private function filePath(): string
    {
        return $this->projectDir.'/databases/app-settings.yaml';
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
