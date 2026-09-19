# App Settings File and Connection-Middleware Active Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `databases/active.sqlite3` (a symlink, plus the `SIGUSR2` pool-reload and `idle_connection_ttl` tuning built to work around its php-fpm staleness bugs) with a Doctrine connection middleware that reads a plain YAML file at actual connect time, and split per-database settings (`over65`) from genuinely global ones (`groupLevels`, `savedGroupings`, `activeDatabase`).

**Architecture:** `backend/databases/app-settings.yaml` is the single source of truth for which database is active and for global UI settings, read/written by a plain-PHP `AppSettingsRepository` with `flock()`-guarded atomic writes. A Doctrine `Driver\Middleware` reads it at the moment each real PDO connection opens and builds the SQLite path directly — no env var, no symlink, no caching layer in between. Each per-tax-year database keeps a small `setting` key-value table (JSON-encoded values, no separate type column) for settings that are genuinely tied to that tax year.

**Tech Stack:** Symfony 8 / Doctrine ORM 3 / Doctrine DBAL 4 / `symfony/yaml` (already a dependency) / SQLite / React (frontend settings API changes only).

**Spec:** `docs/superpowers/specs/2026-09-19-app-settings-and-active-database-design.md`

## Global Constraints

- Single-user, no-auth personal app — no multi-tenancy, no per-request tenant resolution (spec's "Global Constraints").
- `test` environment must remain fully unaffected — no dependency on `app-settings.yaml`, connection middleware is a no-op there.
- `backend/.env.dev`'s `APP_SECRET` block must be preserved when its `DATABASE_URL` block is removed — this file has been wholesale-overwritten by mistake twice before in this project's history.
- No new `.gitignore` entry needed — `backend/databases/` is already ignored as a whole directory, and `app-settings.yaml` lives inside it.
- `value` in the per-database `setting` table is always valid JSON text — no separate type column; `json_decode`/`json_encode` alone round-trip the real PHP type.
- `PATCH /api/settings` accepts a **partial** object; each key routes to whichever backend owns it.

---

### Task 1: Per-database `Setting` entity, `SettingsService`, and migration

**Files:**
- Create: `backend/src/Entity/Setting.php`
- Create: `backend/src/Repository/SettingRepository.php`
- Create: `backend/src/Service/SettingKeys.php`
- Create: `backend/src/Service/SettingsService.php`
- Delete: `backend/src/Entity/Settings.php`
- Delete: `backend/src/Repository/SettingsRepository.php`
- Modify: `backend/src/Service/LedgerStateService.php`
- Create: `backend/migrations/VersionYYYYMMDDHHMMSS.php` (auto-generated timestamp, see Step 5)
- Test: `backend/tests/Service/IsaAllowanceServiceTest.php` (verify unaffected, no edits expected)

**Interfaces:**
- Produces: `App\Service\SettingsService::get(string $key): mixed` (JSON-decodes the stored value, `null` if the key doesn't exist), `SettingsService::set(string $key, mixed $value): void` (upserts, JSON-encodes `$value`, flushes). `App\Service\SettingKeys::OVER_65` (`'over65'`).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the new `Setting` entity**

```php
<?php

namespace App\Entity;

use App\Repository\SettingRepository;
use Doctrine\ORM\Mapping as ORM;

/**
 * One row per genuinely tax-year-scoped setting — over65 today, whatever
 * else needs a per-database (not global) home later, without a migration
 * per new key. Natural-key entity like Currency/Symbol/Counterparty: the
 * key itself is the primary key, no surrogate id. `value` is always valid
 * JSON text — json_decode/json_encode alone round-trip the real PHP type
 * (bool/int/string/array/null), so there's no separate type column.
 */
#[ORM\Entity(repositoryClass: SettingRepository::class)]
class Setting
{
    #[ORM\Id]
    #[ORM\Column(length: 64)]
    private string $key;

    #[ORM\Column(type: 'text')]
    private string $value;

    public function getKey(): string
    {
        return $this->key;
    }

    public function setKey(string $key): static
    {
        $this->key = $key;

        return $this;
    }

    public function getValue(): string
    {
        return $this->value;
    }

    public function setValue(string $value): static
    {
        $this->value = $value;

        return $this;
    }
}
```

- [ ] **Step 2: Write the new `SettingRepository`**

```php
<?php

namespace App\Repository;

use App\Entity\Setting;
use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
use Doctrine\Persistence\ManagerRegistry;

/**
 * @extends ServiceEntityRepository<Setting>
 */
class SettingRepository extends ServiceEntityRepository
{
    public function __construct(ManagerRegistry $registry)
    {
        parent::__construct($registry, Setting::class);
    }
}
```

- [ ] **Step 3: Write `SettingKeys`**

```php
<?php

namespace App\Service;

/**
 * Known per-database Setting keys, so nothing scatters magic strings
 * across controllers/services. Add a new constant here (not a migration)
 * when a genuinely tax-year-scoped setting is needed later.
 */
final class SettingKeys
{
    public const OVER_65 = 'over65';

    private function __construct()
    {
    }
}
```

- [ ] **Step 4: Write `SettingsService`**

```php
<?php

namespace App\Service;

use App\Entity\Setting;
use App\Repository\SettingRepository;
use Doctrine\ORM\EntityManagerInterface;

/**
 * Type-safe access to the per-database key-value setting table — see
 * Setting's own docblock for why there's no separate type column.
 */
class SettingsService
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly SettingRepository $settingRepository,
    ) {
    }

    public function get(string $key): mixed
    {
        $row = $this->settingRepository->find($key);
        if (null === $row) {
            return null;
        }

        return json_decode($row->getValue(), true);
    }

    public function set(string $key, mixed $value): void
    {
        $row = $this->settingRepository->find($key) ?? (new Setting())->setKey($key);
        $row->setValue(json_encode($value, \JSON_THROW_ON_ERROR));
        $this->em->persist($row);
        $this->em->flush();
    }
}
```

- [ ] **Step 5: Delete the old entity/repository, update `LedgerStateService`**

```bash
rm backend/src/Entity/Settings.php backend/src/Repository/SettingsRepository.php
```

In `backend/src/Service/LedgerStateService.php`:

Replace the constructor and imports — `SettingsRepository`/`Settings` are gone, `SettingsService`/`SettingKeys` take their place:

```php
use App\Service\SettingKeys;
use App\Service\SettingsService;
```
(remove `use App\Entity\Settings;` and `use App\Repository\SettingsRepository;`)

```php
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly SettingsService $settingsService,
    ) {
    }
```

Replace `readState()`'s settings line:

```php
            'settings' => $this->settingsToArray(),
```

Replace `writeState()`'s settings block (was `$settings = $this->settingsRepository->getOrCreate(); $this->hydrateSettings($settings, $settingsData); $this->em->persist($settings);`):

```php
            $this->settingsService->set(SettingKeys::OVER_65, (bool) ($settingsData['over65'] ?? false));
```

Replace `getSettings()` (still merges the computed tax-year fields — the global `groupLevels`/`savedGroupings` merge happens in Task 5, not here):

```php
    public function getSettings(): array
    {
        $arr = $this->settingsToArray();
        $taxYearStart = $this->determinedTaxYearStart();
        $arr['activeTaxYearStart'] = $taxYearStart;
        $arr['outOfTaxYearLineCount'] = null !== $taxYearStart ? $this->outOfTaxYearLineCount($taxYearStart) : 0;

        return $arr;
    }
```

Replace `replaceSettings()` — this becomes the per-database-only piece of the merged `PATCH`, wired up fully in Task 5:

```php
    /** @param array<string, mixed> $data */
    public function patchPerDatabaseSettings(array $data): array
    {
        if (\array_key_exists('over65', $data)) {
            $this->settingsService->set(SettingKeys::OVER_65, (bool) $data['over65']);
        }

        return $this->settingsToArray();
    }
```

Replace `hydrateSettings()`/`settingsToArray()` (delete `hydrateSettings()` entirely — no longer needed, `writeState()`/`patchPerDatabaseSettings()` call `SettingsService::set()` directly):

```php
    private function settingsToArray(): array
    {
        return [
            'over65' => (bool) ($this->settingsService->get(SettingKeys::OVER_65) ?? false),
        ];
    }
```

- [ ] **Step 6: Generate the migration**

```bash
cd backend && php bin/console doctrine:migrations:diff
```

Expected: a new `migrations/VersionYYYYMMDDHHMMSS.php` is created, with `up()` containing `DROP TABLE settings` and `CREATE TABLE setting (key VARCHAR(64) NOT NULL, value CLOB NOT NULL, PRIMARY KEY(key))` (exact column types may differ slightly — SQLite's temp-table-rebuild pattern, matching the style of every existing migration in `backend/migrations/`), and `down()` the reverse.

- [ ] **Step 7: Hand-edit the generated migration to carry `over65`'s value across**

The auto-generated `up()` drops `settings` before `setting` exists with data in it — reorder so the old table's data is still readable when the copy happens, and insert the data-copy SQL. Open the generated migration file and edit `up()` so the `CREATE TABLE setting` statement is followed immediately by:

```php
        $this->addSql("INSERT INTO setting (key, value) SELECT 'over65', CASE WHEN over65 THEN 'true' ELSE 'false' END FROM settings");
```

placed *before* the `DROP TABLE settings` statement (reorder the generated statements: `CREATE TABLE setting` → the `INSERT INTO setting ... FROM settings` line above → `DROP TABLE settings`, keeping every other generated statement in place). This must run before `settings` is dropped, since it reads from it. `getDescription()` should read:

```php
    public function getDescription(): string
    {
        return 'Replace the single-row settings table with a key-value setting table — over65 is the only key carried over, group_levels/saved_groupings move to the global app-settings.yaml file (see docs/superpowers/specs/2026-09-19-app-settings-and-active-database-design.md)';
    }
```

In `down()`, since `group_levels`/`saved_groupings` have no source to restore from, recreate them with the original entity's defaults rather than fabricating data — after the generated `CREATE TABLE settings` statement, add:

```php
        $this->addSql("INSERT INTO settings (id, over65, group_levels, saved_groupings) SELECT 1, CASE WHEN (SELECT value FROM setting WHERE key = 'over65') = 'true' THEN 1 ELSE 0 END, '[\"type\"]', '[]'");
```

placed *before* the generated `DROP TABLE setting` statement.

- [ ] **Step 8: Migrate the test database and run the test suite**

```bash
cd backend && php bin/console doctrine:migrations:migrate --env=test --no-interaction
php bin/phpunit
```

Expected: migration applies cleanly, all 6 existing tests still pass (`IsaAllowanceServiceTest` doesn't reference `Settings`/`Setting` at all — confirmed by grep before writing this plan).

- [ ] **Step 9: Manual verification against a scratch database**

```bash
cd backend
cp var/data_dev.db /tmp/setting-migration-test.db 2>/dev/null || touch /tmp/setting-migration-test.db
DATABASE_URL="sqlite:////tmp/setting-migration-test.db" php bin/console doctrine:migrations:migrate --no-interaction
sqlite3 /tmp/setting-migration-test.db "SELECT * FROM setting;"
rm /tmp/setting-migration-test.db
```

Expected: `over65|false` (or a copy of `var/data_dev.db`'s actual value if it has real data), confirming the data-copy SQL works. If `var/data_dev.db` doesn't exist yet (fresh checkout), the `touch` fallback still verifies the migration runs cleanly against a blank file with no `settings` table — in that case skip the `SELECT` (no `settings` table existed to copy from) and instead confirm no error occurred.

- [ ] **Step 10: Commit**

```bash
git add backend/src/Entity/Setting.php backend/src/Repository/SettingRepository.php backend/src/Service/SettingKeys.php backend/src/Service/SettingsService.php backend/src/Service/LedgerStateService.php backend/migrations/
git rm backend/src/Entity/Settings.php backend/src/Repository/SettingsRepository.php
git commit -m "Replace single-row Settings entity with a key-value Setting table"
```

---

### Task 2: `AppSettingsRepository` — the global YAML file

**Files:**
- Create: `backend/src/Service/AppSettingsRepository.php`
- Test: manual verification only (Step 4 below) — this is a plain-PHP file-I/O class with no framework dependency worth a full PHPUnit harness for a single-user local app; it's exercised end-to-end by every later task's manual verification.

**Interfaces:**
- Produces: `App\Service\AppSettingsRepository::read(): array{activeDatabase: ?string, groupLevels: array, savedGroupings: array}` and `AppSettingsRepository::write(array $partial): array` (returns the full merged content after writing).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write `AppSettingsRepository`**

```php
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
```

- [ ] **Step 2: Manual verification — defaults on a missing file**

```bash
cd backend
php -r "
require 'vendor/autoload.php';
\$repo = new App\Service\AppSettingsRepository(getcwd());
var_export(\$repo->read());
"
```

Expected: the defaults array (`activeDatabase: null`, `groupLevels: []`, one `savedGroupings` entry), and confirm `databases/app-settings.yaml` was *not* created by `read()` alone (only `write()` creates it).

- [ ] **Step 3: Manual verification — write, re-read, partial merge**

```bash
cd backend
php -r "
require 'vendor/autoload.php';
\$repo = new App\Service\AppSettingsRepository(getcwd());
\$repo->write(['activeDatabase' => '2099-2100.sqlite3']);
\$repo->write(['groupLevels' => ['type', 'currency']]);
var_export(\$repo->read());
"
cat databases/app-settings.yaml
rm databases/app-settings.yaml
```

Expected: the final `read()` shows both `activeDatabase: '2099-2100.sqlite3'` *and* `groupLevels: ['type', 'currency']` together — proving the second `write()` call correctly preserved the first call's change (the read-merge-write, not a blind overwrite) — plus the untouched default `savedGroupings` entry. Clean up the test file afterward so it doesn't leak into a later task's verification.

- [ ] **Step 4: Concurrency check — two overlapping writers don't clobber each other**

```bash
cd backend
php -r "
require 'vendor/autoload.php';
\$repo = new App\Service\AppSettingsRepository(getcwd());
\$pids = [];
for (\$i = 0; \$i < 5; \$i++) {
    \$pid = pcntl_fork();
    if (0 === \$pid) {
        \$repo->write(['groupLevels' => [\"writer-\$i\"]]);
        exit(0);
    }
    \$pids[] = \$pid;
}
foreach (\$pids as \$pid) { pcntl_waitpid(\$pid, \$status); }
var_export(\$repo->read());
"
rm -f databases/app-settings.yaml
```

Expected: the file parses as valid YAML (never a torn/partial write from an unlocked overlap), and `activeDatabase`/`savedGroupings` still show their default values (untouched by any of the 5 writers, proving the merge preserved keys none of them touched). If `pcntl` isn't available in this PHP build, skip this step — the `flock()` mechanism is still exercised correctly by Step 3, just not under genuine OS-level concurrency.

- [ ] **Step 5: Commit**

```bash
git add backend/src/Service/AppSettingsRepository.php
git commit -m "Add AppSettingsRepository: the global app-settings.yaml file, flock-guarded"
```

---

### Task 3: The Doctrine connection middleware

**Files:**
- Create: `backend/src/Doctrine/ActiveDatabaseDriver.php`
- Create: `backend/src/Doctrine/ActiveDatabaseMiddleware.php`
- Modify: `backend/config/packages/doctrine.yaml`
- Modify: `backend/.env.dev`

**Interfaces:**
- Consumes: `App\Service\AppSettingsRepository::read()` (Task 2).
- Produces: nothing later tasks call directly — this is infrastructure that makes every Doctrine connection resolve correctly; later tasks depend on its *behavior*, not its API.

- [ ] **Step 1: Write `ActiveDatabaseDriver`**

`Doctrine\DBAL\Driver\Middleware::wrap()` returns a `Driver` that overrides `connect()` — this is that driver. `$params['path']` is the key `pdo_sqlite`'s driver reads to build its DSN (confirmed in `vendor/doctrine/dbal/src/Driver/PDO/SQLite/Driver.php`).

```php
<?php

namespace App\Doctrine;

use App\Service\AppSettingsRepository;
use Doctrine\DBAL\Driver\Connection as DriverConnection;
use Doctrine\DBAL\Driver\Middleware\AbstractDriverMiddleware;

/**
 * Overrides the SQLite connection path on every real connect() call — see
 * ActiveDatabaseMiddleware for why, and
 * docs/superpowers/specs/2026-09-19-app-settings-and-active-database-design.md
 * for the full design.
 */
class ActiveDatabaseDriver extends AbstractDriverMiddleware
{
    public function __construct(
        \Doctrine\DBAL\Driver $wrappedDriver,
        private readonly AppSettingsRepository $appSettingsRepository,
        private readonly string $databasesDir,
    ) {
        parent::__construct($wrappedDriver);
    }

    public function connect(array $params): DriverConnection
    {
        // A narrow, purpose-built escape hatch for DatabaseController::
        // create()'s migrate/seed subprocess, which needs to target a
        // brand-new, not-yet-active file — never declared in any .env*
        // file, so Symfony\Component\Dotenv\Dotenv's SYMFONY_DOTENV_VARS
        // bookkeeping can never treat it as "previously dotenv-loaded"
        // and silently overwrite it the way DATABASE_URL once was (see
        // DatabaseController's own history). Checked first so it always
        // wins when present.
        $override = getenv('ACTIVE_DATABASE_PATH_OVERRIDE');
        if (false !== $override && '' !== $override) {
            $params['path'] = $override;

            return parent::connect($params);
        }

        $activeDatabase = $this->appSettingsRepository->read()['activeDatabase'];
        if (null !== $activeDatabase) {
            $params['path'] = $this->databasesDir.'/'.$activeDatabase;
        }

        return parent::connect($params);
    }
}
```

- [ ] **Step 2: Write `ActiveDatabaseMiddleware`**

```php
<?php

namespace App\Doctrine;

use App\Service\AppSettingsRepository;
use Doctrine\DBAL\Driver;
use Doctrine\DBAL\Driver\Middleware;
use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * Registered automatically for every DBAL connection (doctrine-bundle
 * autoconfigures any Middleware implementation — see
 * DoctrineExtension::load()'s registerForAutoconfiguration call — no
 * explicit services.yaml tagging needed). Deliberately a no-op under
 * test: test keeps its own fixed DATABASE_URL (var/data_test.db, see
 * config/packages/doctrine.yaml's when@test block) entirely independent
 * of app-settings.yaml, so tests never depend on this file's state.
 */
class ActiveDatabaseMiddleware implements Middleware
{
    public function __construct(
        private readonly AppSettingsRepository $appSettingsRepository,
        #[Autowire('%kernel.project_dir%/databases')]
        private readonly string $databasesDir,
        #[Autowire('%kernel.environment%')]
        private readonly string $environment,
    ) {
    }

    public function wrap(Driver $driver): Driver
    {
        if ('test' === $this->environment) {
            return $driver;
        }

        return new ActiveDatabaseDriver($driver, $this->appSettingsRepository, $this->databasesDir);
    }
}
```

- [ ] **Step 3: Update `doctrine.yaml`**

Remove the `idle_connection_ttl` line and its comment entirely — it existed only to paper over the symlink-era staleness (see the spec's "What this removes entirely"), and the middleware makes it unnecessary: `url` stays exactly as-is (it still resolves to something valid via the base `.env`'s default so container compilation succeeds), because the middleware unconditionally overwrites `$params['path']` after that resolution for every non-test connection — nothing needs to specially avoid setting a `url`.

```yaml
doctrine:
    dbal:
        url: '%env(resolve:DATABASE_URL)%'

        # IMPORTANT: You MUST configure your server version,
        # either here or in the DATABASE_URL env var (see .env file)
        #server_version: '16'

        profiling_collect_backtrace: '%kernel.debug%'
```

(the `when@test`/`when@prod` blocks below this are unchanged — leave them exactly as they are)

- [ ] **Step 4: Update `.env.dev`**

Remove only the `DATABASE_URL` block and its comment — leave `APP_SECRET` untouched:

```
###> symfony/framework-bundle ###
APP_SECRET=78c627f8ad7cd20f09a35b8520b8de62
###< symfony/framework-bundle ###
```

- [ ] **Step 5: Clear the cache and confirm the app boots**

```bash
cd backend
rm -rf var/cache/dev/*
php bin/console debug:container App\\Doctrine\\ActiveDatabaseMiddleware 2>&1 | grep -i "tags\|doctrine.middleware"
```

Expected: the service exists and shows the `doctrine.middleware` tag, confirming autoconfiguration picked it up without any explicit `services.yaml` change.

- [ ] **Step 6: Manual verification — the middleware actually resolves the active file**

```bash
cd backend
rm -f databases/app-settings.yaml
touch databases/mw-test-a.sqlite3 databases/mw-test-b.sqlite3
DATABASE_URL="sqlite:///%kernel.project_dir%/databases/mw-test-a.sqlite3" php bin/console doctrine:migrations:migrate --no-interaction -e dev -- databases/mw-test-a.sqlite3 2>&1 | tail -3
```

This step is superseded once Task 2's `AppSettingsRepository` is wired to `activeDatabase` — the real end-to-end check (switch `app-settings.yaml`'s `activeDatabase` between two real, migrated files and confirm `GET /api/accounts` follows it with no restart, across a repeated rapid request loop the way the symlink's staleness was originally caught) happens in Task 4's Step 6, once `DatabaseController` actually writes to `app-settings.yaml`. Skip attempting a full request-level check here — there's no active database configured yet for a normal request to succeed against.

```bash
rm -f databases/mw-test-a.sqlite3 databases/mw-test-b.sqlite3
```

- [ ] **Step 7: Manual verification — the `ACTIVE_DATABASE_PATH_OVERRIDE` escape hatch works**

```bash
cd backend
touch /tmp/override-test.sqlite3
ACTIVE_DATABASE_PATH_OVERRIDE=/tmp/override-test.sqlite3 php bin/console doctrine:migrations:migrate --no-interaction
sqlite3 /tmp/override-test.sqlite3 ".tables"
rm /tmp/override-test.sqlite3
```

Expected: the override file gets migrated (tables exist), proving the escape hatch works standalone via a plain environment variable, independent of `app-settings.yaml`'s state — no `activeDatabase` was ever set in this test.

- [ ] **Step 8: Manual verification — `test` environment is unaffected**

```bash
cd backend
php bin/phpunit
```

Expected: still 6/6 green, confirming the middleware's `'test' === $this->environment` no-op branch leaves the existing test-database mechanism completely untouched.

- [ ] **Step 9: Commit**

```bash
git add backend/src/Doctrine/ backend/config/packages/doctrine.yaml backend/.env.dev
git commit -m "Add ActiveDatabaseMiddleware: resolve the SQLite connection from app-settings.yaml at connect time"
```

---

### Task 4: Rewire `MigrationStatusListener` and `DatabaseController`

**Files:**
- Modify: `backend/src/EventListener/MigrationStatusListener.php`
- Modify: `backend/src/Controller/DatabaseController.php`

**Interfaces:**
- Consumes: `App\Service\AppSettingsRepository::read()`/`write()` (Task 2), `ACTIVE_DATABASE_PATH_OVERRIDE` (Task 3).
- Produces: nothing new for later tasks — `DatabaseController`'s routes (`GET /api/databases`, `POST /api/databases/active`, `POST /api/databases`, `POST /api/databases/new-year`) keep their existing shapes, just backed by the new mechanism.

- [ ] **Step 1: Rewrite `MigrationStatusListener::hasActiveDatabase()`**

Add the import (alongside the existing `use Doctrine\Migrations\DependencyFactory;` etc.): `use App\Service\AppSettingsRepository;`

```php
    public function __construct(
        #[Autowire(service: 'doctrine.migrations.dependency_factory')]
        private readonly DependencyFactory $dependencyFactory,
        private readonly AppSettingsRepository $appSettingsRepository,
        #[Autowire('%kernel.project_dir%')]
        private readonly string $projectDir,
    ) {
    }
```

```php
    private function hasActiveDatabase(): bool
    {
        $activeDatabase = $this->appSettingsRepository->read()['activeDatabase'];

        return null !== $activeDatabase && file_exists($this->projectDir.'/databases/'.$activeDatabase);
    }
```

Update the class docblock's bullet describing this check — replace the sentence about symlinks:

```
 *  - No active database at all: app-settings.yaml doesn't exist, has a
 *    null activeDatabase, or names a file that no longer exists (e.g. a
 *    fresh clone — backend/databases/ is gitignored, so a new checkout
 *    starts with nothing there).
```

- [ ] **Step 2: Rewrite `DatabaseController`'s constructor and `list()`/`entryFor()`/`activeTarget()`**

Add the import (alongside the existing `use App\Service\NewYearService;` etc.): `use App\Service\AppSettingsRepository;`

```php
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
```

(the `if ('active.sqlite3' === $filename) { continue; }` skip in the old `list()` is removed — there's no `active.sqlite3` file to filter out any more)

Delete `activeTarget()` entirely (its job is now just `$this->appSettingsRepository->read()['activeDatabase']`, inlined at each call site — no longer worth its own method).

`entryFor()` is unchanged (still takes `?string $activeTarget` and compares `$filename === $activeTarget`).

- [ ] **Step 3: Rewrite `setActive()`**

```php
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
```

`validateFilename()` is unchanged — still checks the filename shape and that the file exists on disk.

- [ ] **Step 4: Rewrite `create()`'s subprocess env, and its final response**

Replace the `$env` line:

```php
        // ACTIVE_DATABASE_PATH_OVERRIDE — not DATABASE_URL — is what
        // ActiveDatabaseDriver checks first (see backend/src/Doctrine/):
        // DATABASE_URL is entirely ignored by the connection middleware
        // now, and reusing it here would just silently do nothing rather
        // than target the new file.
        $env = ['ACTIVE_DATABASE_PATH_OVERRIDE' => $path];
```

Replace the final line (was `return new JsonResponse($this->entryFor($filename, $this->activeTarget($dir)), 201);`):

```php
        return new JsonResponse($this->entryFor($filename, $this->appSettingsRepository->read()['activeDatabase']), 201);
```

- [ ] **Step 5: Rewrite `newYear()`'s active-database lookups**

Replace the top of the method (was `$activeTarget = $this->activeTarget($dir);`):

```php
        $activeTarget = $this->appSettingsRepository->read()['activeDatabase'];
```

The rest of `newYear()` (the tax-year regex, `NewYearService::createNextYear()` call, exception handling) is unchanged.

- [ ] **Step 6: Delete `activateSymlink()` and `reloadPhpFpmWorkers()` entirely**

Remove both private methods from `DatabaseController.php` — nothing calls them any more.

Remove the class-level docblock's paragraph describing the symlink (lines 19-23 in the current file), replacing it with:

```
 * `backend/databases/app-settings.yaml` names which file is active — see
 * AppSettingsRepository and the design doc this implements
 * (docs/superpowers/specs/2026-09-19-app-settings-and-active-database-design.md).
 * Switching is a plain write to that file; the connection middleware
 * (ActiveDatabaseDriver) picks it up on the very next connection, no
 * process signaling or restart needed.
```

- [ ] **Step 7: Lint and unit-level sanity check**

```bash
cd backend
php -l src/EventListener/MigrationStatusListener.php
php -l src/Controller/DatabaseController.php
php bin/phpunit
```

Expected: no syntax errors, 6/6 still green.

- [ ] **Step 8: Manual end-to-end verification — the actual bug this replaces**

```bash
cd backend
rm -f databases/app-settings.yaml databases/verify-*.sqlite3
touch databases/verify-a.sqlite3
DATABASE_URL="sqlite:////$(pwd)/databases/verify-a.sqlite3" php bin/console doctrine:migrations:migrate --no-interaction >/dev/null 2>&1
touch databases/verify-b.sqlite3
DATABASE_URL="sqlite:////$(pwd)/databases/verify-b.sqlite3" php bin/console doctrine:migrations:migrate --no-interaction >/dev/null 2>&1
sqlite3 databases/verify-a.sqlite3 "INSERT INTO account (id, name, type, currency, opening_balance) VALUES ('verify-a','Verify A Account','asset','GBP',100);"
sqlite3 databases/verify-b.sqlite3 "INSERT INTO account (id, name, type, currency, opening_balance) VALUES ('verify-b','Verify B Account','asset','GBP',200);"
symfony server:start --port=8599 -d
```

```bash
curl -s -X POST http://127.0.0.1:8599/api/databases/active -H "Content-Type: application/json" -d '{"filename":"verify-a.sqlite3"}'
for i in 1 2 3 4 5 6; do curl -s http://127.0.0.1:8599/api/accounts; echo " <- $i"; done
```

Expected: all 6 responses show `Verify A Account` — no restart, no pool-reload wait, immediately consistent.

```bash
curl -s -X POST http://127.0.0.1:8599/api/databases/active -H "Content-Type: application/json" -d '{"filename":"verify-b.sqlite3"}'
for i in 1 2 3 4 5 6; do curl -s http://127.0.0.1:8599/api/accounts; echo " <- $i"; done
```

Expected: all 6 responses immediately show `Verify B Account` — this is the exact scenario (a multi-worker php-fpm pool, rapid successive requests right after a switch) that previously required `SIGUSR2` to make consistent; confirm it's consistent here with zero process signaling involved.

```bash
pgrep -f "port=8599" | xargs -r kill
rm -f databases/verify-a.sqlite3 databases/verify-b.sqlite3 databases/app-settings.yaml
```

- [ ] **Step 9: Commit**

```bash
git add backend/src/EventListener/MigrationStatusListener.php backend/src/Controller/DatabaseController.php
git commit -m "Rewire MigrationStatusListener/DatabaseController onto AppSettingsRepository, delete the symlink mechanism"
```

---

### Task 5: `PATCH /api/settings` — the merged endpoint

**Files:**
- Modify: `backend/src/Controller/SettingsController.php`
- Modify: `backend/src/Service/LedgerStateService.php`

**Interfaces:**
- Consumes: `LedgerStateService::getSettings()`/`patchPerDatabaseSettings()` (Task 1), `AppSettingsRepository::read()`/`write()` (Task 2).
- Produces: `GET /api/settings` → `{over65, groupLevels, savedGroupings, activeTaxYearStart, outOfTaxYearLineCount}` (unchanged shape from the frontend's perspective). `PATCH /api/settings` (body: any subset of `{over65, groupLevels, savedGroupings}`) → the same merged shape back.

- [ ] **Step 1: Add a merge method to `LedgerStateService`**

Add `AppSettingsRepository` to the constructor:

```php
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly SettingsService $settingsService,
        private readonly AppSettingsRepository $appSettingsRepository,
    ) {
    }
```

Add the import: `use App\Service\AppSettingsRepository;`

Replace `getSettings()` to merge in the global keys:

```php
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
```

Add `patchSettings()`, routing each key present in `$data` to whichever backend owns it:

```php
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
```

- [ ] **Step 2: Rewrite `SettingsController`**

```php
<?php

namespace App\Controller;

use App\Service\LedgerStateService;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/api/settings')]
class SettingsController
{
    public function __construct(private readonly LedgerStateService $state)
    {
    }

    #[Route('', methods: ['GET'])]
    public function get(): JsonResponse
    {
        return new JsonResponse($this->state->getSettings());
    }

    #[Route('', methods: ['PATCH'])]
    public function patch(Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);
        if (!\is_array($body)) {
            return new JsonResponse(['error' => 'Invalid JSON body'], 400);
        }

        return new JsonResponse($this->state->patchSettings($body));
    }
}
```

- [ ] **Step 3: Lint and test**

```bash
cd backend
php -l src/Controller/SettingsController.php
php -l src/Service/LedgerStateService.php
php bin/phpunit
```

Expected: no syntax errors, 6/6 green.

- [ ] **Step 4: Manual verification — merged GET, partial PATCH**

```bash
cd backend
rm -f databases/app-settings.yaml databases/patch-verify.sqlite3
touch databases/patch-verify.sqlite3
DATABASE_URL="sqlite:////$(pwd)/databases/patch-verify.sqlite3" php bin/console doctrine:migrations:migrate --no-interaction >/dev/null 2>&1
DATABASE_URL="sqlite:////$(pwd)/databases/patch-verify.sqlite3" php bin/console app:currencies:seed >/dev/null 2>&1
symfony server:start --port=8598 -d
curl -s -X POST http://127.0.0.1:8598/api/databases/active -H "Content-Type: application/json" -d '{"filename":"patch-verify.sqlite3"}' >/dev/null
curl -s http://127.0.0.1:8598/api/settings
echo
curl -s -X PATCH http://127.0.0.1:8598/api/settings -H "Content-Type: application/json" -d '{"over65": true}'
echo
curl -s -X PATCH http://127.0.0.1:8598/api/settings -H "Content-Type: application/json" -d '{"groupLevels": ["type", "currency"]}'
```

Expected: first `GET` shows `over65: false`, one default `savedGroupings` entry, empty `groupLevels`. First `PATCH` shows `over65: true`, *unchanged* `groupLevels`/`savedGroupings` (proving `over65` alone didn't touch the global file). Second `PATCH` shows `groupLevels: ["type", "currency"]` *and* `over65: true` still present (proving `groupLevels` alone didn't reset `over65` in the per-database table).

```bash
pgrep -f "port=8598" | xargs -r kill
rm -f databases/patch-verify.sqlite3 databases/app-settings.yaml
```

- [ ] **Step 5: Commit**

```bash
git add backend/src/Controller/SettingsController.php backend/src/Service/LedgerStateService.php
git commit -m "SettingsController: PUT becomes PATCH, GET/PATCH merge per-database and global settings"
```

---

### Task 6: Frontend — partial updates, no more full-object spreads

**Files:**
- Modify: `src/api.js`
- Modify: `src/App.jsx`
- Modify: `src/components/AllowanceView.jsx`
- Modify: `src/components/Overview.jsx`

**Interfaces:**
- Consumes: `PATCH /api/settings` (Task 5).
- Produces: nothing later tasks depend on — this is the last code task.

- [ ] **Step 1: Rename `putSettings` to `patchSettings` in `api.js`**

```javascript
export function patchSettings(partial) {
  return request("/api/settings", { method: "PATCH", ...jsonBody(partial) });
}
```

- [ ] **Step 2: Rewrite `App.jsx`'s `saveSettings` to accept a partial object**

```javascript
  function saveSettings(partial) {
    // Optimistic: merge the partial into local state immediately (not a
    // blind replace — `partial` only carries the field(s) actually
    // changing, so replacing outright would wipe every other setting
    // from the UI until the next GET /api/settings).
    setSettings((prev) => ({ ...prev, ...partial }));
    api.patchSettings(partial).then(() => setStorageOK(true)).catch(() => setStorageOK(false));
  }

  function saveGroupingPreset(levels) {
    const already = (settings.savedGroupings || []).some((s) => JSON.stringify(s.levels) === JSON.stringify(levels));
    if (already) return;
    saveSettings({ savedGroupings: [...(settings.savedGroupings || []), { id: uid(), levels }] });
  }

  function removeGroupingPreset(id) {
    saveSettings({ savedGroupings: (settings.savedGroupings || []).filter((s) => s.id !== id) });
  }
```

- [ ] **Step 3: Update the `groupLevels` call site in `App.jsx`**

Find `onChange={(lv) => saveSettings({ ...settings, groupLevels: lv })}` and replace with:

```javascript
              onChange={(lv) => saveSettings({ groupLevels: lv })}
```

- [ ] **Step 4: Update `AllowanceView.jsx`'s `over65` call site**

Find `onChange={(e) => onSaveSettings({ ...settings, over65: e.target.checked })}` and replace with:

```javascript
        <input type="checkbox" checked={!!settings.over65} onChange={(e) => onSaveSettings({ over65: e.target.checked })} />
```

- [ ] **Step 5: Update `Overview.jsx`'s `groupLevels` call site**

Find `onChange={(lv) => onSaveSettings({ ...settings, groupLevels: lv })}` and replace with:

```javascript
            onChange={(lv) => onSaveSettings({ groupLevels: lv })}
```

- [ ] **Step 6: Build**

```bash
cd /Users/radu/Code/Claude/ledger-project && yarn build
```

Expected: clean build, no errors.

- [ ] **Step 7: Manual browser verification**

Set up a scratch backend + frontend (same pattern as prior sessions' verification): a migrated, seeded scratch `.sqlite3` file, `app-settings.yaml` pointed at it via `POST /api/databases/active`, `vite.config.js`'s dev proxy temporarily pointed at the scratch backend's port, `yarn dev` restarted.

In the browser: toggle the "Over 65" checkbox on the ISA Allowance page — confirm it persists after a page reload, and confirm `groupLevels`/`savedGroupings` are *unaffected* by that toggle (inspect the Network tab's `PATCH /api/settings` request body — it should contain only `{"over65": true}`, nothing else). Change the account grouping (sidebar or Overview) — confirm the `PATCH` body contains only `{"groupLevels": [...]}`. Save a new named grouping preset — confirm the `PATCH` body contains only `{"savedGroupings": [...]}`.

Revert `vite.config.js` to its default proxy target afterward, and stop/clean up the scratch backend.

- [ ] **Step 8: Commit**

```bash
git add src/api.js src/App.jsx src/components/AllowanceView.jsx src/components/Overview.jsx
git commit -m "Frontend: PATCH partial settings updates, no more full-object spreads"
```

---

### Task 7: Real cutover and final verification

**Files:** none — this is the one-time migration of the actual checkout (`/Users/radu/Code/Claude/ledger-project`, not a worktree) plus end-to-end verification, matching this project's established real-data-cutover convention (see the prior in-app-database-switcher plan's own Task 11 and Ruling 1).

- [ ] **Step 1: Confirm the real checkout's current active file**

```bash
cd /Users/radu/Code/Claude/ledger-project/backend
readlink databases/active.sqlite3
```

Expected: whatever tax-year file is currently active (e.g. `2024-2025.sqlite3`) — confirm this before proceeding, since it's the value `app-settings.yaml` needs to be seeded with.

- [ ] **Step 2: Stop any running dev server, apply the migration to the currently-active file**

```bash
ps aux | grep "symfony server" | grep -v grep
```

If a server is running against this checkout, note its port, then:

```bash
cd /Users/radu/Code/Claude/ledger-project/backend
php bin/console doctrine:migrations:migrate --no-interaction
```

(this migrates whatever `app-settings.yaml`/the connection currently resolves to — at this point in the cutover that's still the *old* symlink-based mechanism from before Task 3's changes took effect on this checkout, since Task 3's code was only built and verified in scratch directories until now; running `composer install`/pulling this branch's commits onto the real checkout is what actually activates the new mechanism here)

- [ ] **Step 3: Create `app-settings.yaml` seeded with the real active file, remove the symlink**

```bash
cd /Users/radu/Code/Claude/ledger-project/backend
php -r "
require 'vendor/autoload.php';
\$repo = new App\Service\AppSettingsRepository(getcwd());
\$repo->write(['activeDatabase' => '2024-2025.sqlite3']);
var_export(\$repo->read());
"
rm databases/active.sqlite3
```

(replace `2024-2025.sqlite3` with whatever Step 1 actually showed, if different)

- [ ] **Step 4: Restart the dev server, verify the real app**

```bash
cd /Users/radu/Code/Claude/ledger-project/backend
symfony server:start --port=8000 -d
curl -s http://127.0.0.1:8000/api/accounts | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"
```

Expected: the same account count as before this cutover (205, per the count taken during this feature's brainstorming — re-verify it matches, don't assume).

- [ ] **Step 5: Restart the frontend dev server if one was running, spot-check in the browser**

```bash
cd /Users/radu/Code/Claude/ledger-project
```

Confirm the app loads normally, the header's database-switcher trigger shows the correct active file, and the ISA Allowance page's "Over 65" checkbox reflects whatever it was set to before this cutover (it should be `false`, per the migration in Task 1 copying the real file's actual pre-migration value).

- [ ] **Step 6: Full test suite and build, one final time, on the real checkout**

```bash
cd /Users/radu/Code/Claude/ledger-project/backend && php bin/phpunit
cd /Users/radu/Code/Claude/ledger-project && yarn build
```

Expected: both clean.

- [ ] **Step 7: Update CLAUDE.md**

Update the "Commands"/"Backend" sections' description of `databases/active.sqlite3` (added by the prior in-app-database-switcher work) to describe `app-settings.yaml` instead — replace every mention of the symlink mechanism, the `SIGUSR2` reload, and `idle_connection_ttl` with a description of `AppSettingsRepository` and `ActiveDatabaseMiddleware`. Update "The active tax year" section similarly. Update the `Setting`/`SettingsService` description under "Amounts, currencies, and reference data" or wherever `Settings`/`over65`/`groupLevels`/`savedGroupings` are currently documented, to reflect the new split.

```bash
git add CLAUDE.md
git commit -m "Document app-settings.yaml and the connection middleware in CLAUDE.md"
```

- [ ] **Step 8: Final commit for the cutover itself**

The real checkout's `databases/app-settings.yaml` and the removed `databases/active.sqlite3` are both outside git (the whole `databases/` directory is gitignored) — nothing to commit for the cutover step itself beyond the CLAUDE.md update above.
