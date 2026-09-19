# Generalized investment-parent wrapper + enforced foreign keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the ISA-only `isa-parent` wrapper account into `investment-parent` (any wrapper, ISA or not), turn `isaParentId` into a real, enforced self-referential foreign key (`parentId`), require every `investment` account to have a parent at all three layers (frontend, backend, database), and enable SQLite's `foreign_keys` pragma app-wide.

**Architecture:** One Doctrine entity/migration change generalizes the wrapper type and its FK; a new, unconditional (all-environments) Doctrine driver middleware turns on `PRAGMA foreign_keys = ON`, mirroring the existing `ActiveDatabaseDriver`/`ActiveDatabaseMiddleware` pattern; the two independent `isaProducts()` ports (backend PHP, frontend JS) and every UI call site that reads `isa-parent`/`isaParentId` are updated in lockstep.

**Tech Stack:** Symfony 8 / Doctrine ORM 3 / Doctrine DBAL 4 / SQLite / React.

**Spec:** `docs/superpowers/specs/2026-09-19-generalized-investment-parent-design.md`

## Global Constraints

- No new financial rule or limit — purely organizational. A non-ISA `investment-parent` must never appear in ISA allowance tracking.
- `IsaAllowanceService.php` (backend) and `src/lib/isa.js` (frontend) must stay in exact agreement — every logic change here applies to both identically.
- API wire format for `parentId` stays a flat natural-key string (the referenced account's `id`), never a nested object.
- Enabling `foreign_keys` enforcement must not change behavior for any existing write path (already audited in the spec — every bulk-delete already deletes child-before-parent).
- Every real tax-year database currently has zero `investment`/`isa-parent` accounts (confirmed directly) — no real-data migration risk anywhere in this plan. Only the scratch `development.sqlite3` file has one violating row, explicitly out of scope.
- A non-ISA `investment-parent` wrapper may hold both `asset` (cash) and `investment` subaccounts, exactly like an ISA wrapper does today.

---

### Task 1: `Account` entity, migration, and `ForeignKeysMiddleware`

**Files:**
- Modify: `backend/src/Entity/Account.php`
- Create: `backend/migrations/VersionYYYYMMDDHHMMSS.php` (auto-generated timestamp, see Step 3)
- Create: `backend/src/Doctrine/ForeignKeysDriver.php`
- Create: `backend/src/Doctrine/ForeignKeysMiddleware.php`

**Interfaces:**
- Produces: `Account::getParent(): ?Account` / `Account::setParent(?Account $parent): static` (replaces `getIsaParentId()`/`setIsaParentId(?string)`). `PRAGMA foreign_keys = ON` active on every real SQLite connection this app makes, in every environment.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Update the `Account` entity's docblock and `isaParentId` field**

Replace the docblock's `isaParentId` paragraph (currently: `` `isaParentId` is kept as a plain string, not a mapped association: the frontend already resolves the parent by scanning the account list itself (see counterpartyOf() in lib/grouping.js), and a bulk replace-on-save doesn't need relational integrity here. ``) with:

```php
 * `parent` is a real, enforced self-referential foreign key (`ON DELETE
 * NO ACTION`, matching every other FK on this entity — currency, symbol,
 * counterparty): an `investment-parent` wrapper account groups other
 * accounts, which point back at it via this field. Wire format is still
 * a flat string (`parentId`, the referenced account's `id`), matching
 * how currency/symbol/counterparty are already exposed despite being
 * real associations backend-side. A `type: "investment"` account must
 * always have a non-null parent — enforced here via a database CHECK
 * constraint (see the migration that introduced this), in
 * LedgerStateService::hydrateAccount(), and in AccountFormModal.jsx.
```

Replace the `isaParentId` column and its accessors:

```php
    #[ORM\ManyToOne(targetEntity: self::class)]
    #[ORM\JoinColumn(name: 'parent_id', referencedColumnName: 'id', nullable: true)]
    private ?self $parent = null;
```

```php
    public function getParent(): ?self
    {
        return $this->parent;
    }

    public function setParent(?self $parent): static
    {
        $this->parent = $parent;

        return $this;
    }
```

(replaces `getIsaParentId()`/`setIsaParentId(?string $isaParentId)` entirely — delete those two methods and the `private ?string $isaParentId` column declaration.)

- [ ] **Step 2: Write `ForeignKeysDriver` and `ForeignKeysMiddleware`**

```php
<?php

namespace App\Doctrine;

use Doctrine\DBAL\Driver\Connection as DriverConnection;
use Doctrine\DBAL\Driver\Middleware\AbstractDriverMiddleware;

/**
 * Executes PRAGMA foreign_keys = ON immediately after every real
 * connection opens — SQLite's foreign_keys enforcement is off by
 * default and must be set per-connection, it is never stored in the
 * database file itself. See ForeignKeysMiddleware's own docblock for
 * why this is unconditional (every environment, unlike
 * ActiveDatabaseMiddleware/ActiveDatabaseDriver) and
 * docs/superpowers/specs/2026-09-19-generalized-investment-parent-design.md
 * for the audit that confirmed this is safe against every existing
 * write path in this app.
 */
class ForeignKeysDriver extends AbstractDriverMiddleware
{
    public function connect(array $params): DriverConnection
    {
        $connection = parent::connect($params);
        $connection->exec('PRAGMA foreign_keys = ON');

        return $connection;
    }
}
```

```php
<?php

namespace App\Doctrine;

use Doctrine\DBAL\Driver;
use Doctrine\DBAL\Driver\Middleware;

/**
 * Registered automatically for every DBAL connection (doctrine-bundle
 * autoconfigures any Middleware implementation — no services.yaml
 * wiring needed, same as ActiveDatabaseMiddleware). Unlike
 * ActiveDatabaseMiddleware, this is NOT environment-gated: foreign key
 * enforcement applies to dev, prod, and test alike, so the test suite
 * genuinely exercises the new parent_id constraint too. Composes
 * cleanly alongside ActiveDatabaseMiddleware — doctrine-bundle applies
 * every registered middleware in sequence, each wrapping the driver
 * the previous one returned.
 */
class ForeignKeysMiddleware implements Middleware
{
    public function wrap(Driver $driver): Driver
    {
        return new ForeignKeysDriver($driver);
    }
}
```

- [ ] **Step 3: Generate the migration**

```bash
cd backend && php bin/console doctrine:migrations:diff
```

Expected: a new `migrations/VersionYYYYMMDDHHMMSS.php`, with `up()` renaming `isa_parent_id` → `parent_id` and adding a foreign key constraint on it referencing `account (id)`, `ON DELETE NO ACTION` (via the usual SQLite temp-table-rebuild pattern, matching every prior migration's style in this directory).

- [ ] **Step 4: Hand-edit the generated migration**

Open the generated file. In `up()`, insert these two statements **before** the first generated statement (they read `type`/`isa_kind` on the *original* table — those columns are untouched by the rebuild, so this ordering is for readability, not correctness):

```php
        $this->addSql("UPDATE account SET type = 'investment-parent' WHERE type = 'isa-parent'");
        $this->addSql("UPDATE account SET isa_kind = 'stocks-shares-isa' WHERE type = 'investment-parent'");
```

Find the generated `CREATE TABLE account (...)` statement inside `up()` and add a `CHECK` clause just before its closing `)` — e.g. if the generated statement ends `..., CONSTRAINT FK_... FOREIGN KEY (parent_id) REFERENCES account (id) ON DELETE NO ACTION NOT DEFERRABLE INITIALLY IMMEDIATE)`, change the final `)` to:

```
, CHECK (type != 'investment' OR parent_id IS NOT NULL))
```

(i.e. append `, CHECK (type != 'investment' OR parent_id IS NOT NULL)` right before the statement's closing parenthesis — this is a single edit to that one SQL string, not a separate `addSql` call, since SQLite's `CREATE TABLE` syntax needs the `CHECK` inside the same statement.)

Update `getDescription()`:

```php
    public function getDescription(): string
    {
        return 'Generalize isa-parent into investment-parent (rename isa_parent_id to parent_id, make it a real enforced FK), and require every investment account to have a parent (CHECK constraint) — see docs/superpowers/specs/2026-09-19-generalized-investment-parent-design.md';
    }
```

Leave `down()` as generated (best-effort reversal is fine here — reversing the `type`/`isa_kind` data statements isn't attempted, matching this project's established precedent for one-way data transforms, e.g. the app-settings migration's `down()`).

- [ ] **Step 5: Migrate the test database and confirm the pragma is active**

```bash
cd backend && php bin/console doctrine:migrations:migrate --env=test --no-interaction
php bin/console doctrine:migrations:status --env=test
```

Expected: migration applies cleanly, status shows it as the latest executed version.

```bash
php bin/console debug:container App\\Doctrine\\ForeignKeysMiddleware 2>&1 | grep -i "doctrine.middleware"
```

Expected: the service exists and is tagged `doctrine.middleware`, confirming autoconfiguration picked it up.

- [ ] **Step 6: Manual verification — the CHECK constraint and the FK are both real**

```bash
cd backend
touch /tmp/fk-check-test.sqlite3
DATABASE_URL="sqlite:////tmp/fk-check-test.sqlite3" php bin/console doctrine:migrations:migrate --no-interaction >/dev/null 2>&1
sqlite3 /tmp/fk-check-test.sqlite3 "INSERT INTO account (id, name, type) VALUES ('bad-inv', 'Bad', 'investment');"
```

Expected: `Runtime error: CHECK constraint failed: ...` — confirms the `CHECK` constraint is genuinely present and enforced (this raw `sqlite3` CLI call has its own default pragma state, but `CHECK` constraints are enforced unconditionally by SQLite regardless of the `foreign_keys` pragma, per the spec — this is the right way to test it standalone).

```bash
sqlite3 /tmp/fk-check-test.sqlite3 "PRAGMA foreign_keys = ON; INSERT INTO account (id, name, type, parent_id) VALUES ('orphan', 'Orphan', 'investment-parent', 'does-not-exist');"
```

Expected: `Runtime error: FOREIGN KEY constraint failed` — confirms the FK constraint itself exists in the schema (this manually turns the pragma on for this one `sqlite3` CLI session, which doesn't go through this app's middleware at all — it only proves the constraint is declared, not that this app's own connections enforce it).

The real test — that `ForeignKeysMiddleware` actually makes the app's *own* connections enforce this, with nobody manually setting the pragma — uses the app's own console, which goes through the full Doctrine/DBAL stack including the new middleware:

```bash
ACTIVE_DATABASE_PATH_OVERRIDE=/tmp/fk-check-test.sqlite3 php bin/console dbal:run-sql "INSERT INTO account (id, name, type, parent_id) VALUES ('orphan', 'Orphan', 'investment-parent', 'does-not-exist')"
```

Expected: an error containing `FOREIGN KEY constraint failed`, thrown *without* anything in this command explicitly setting the pragma — proving `ForeignKeysDriver::connect()` genuinely ran. If this instead succeeds silently, the middleware isn't being applied to this connection — stop and investigate (check `debug:container`'s tag output from Step 5 again, and confirm `ACTIVE_DATABASE_PATH_OVERRIDE` is being honored by `ActiveDatabaseDriver` first, since both middlewares must compose correctly on the same connection).

```bash
rm /tmp/fk-check-test.sqlite3
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/Entity/Account.php backend/src/Doctrine/ backend/migrations/
git commit -m "Generalize isa-parent into investment-parent: real parent_id FK, CHECK constraint, foreign_keys enforcement"
```

---

### Task 2: `LedgerStateService` and `AccountController`

**Files:**
- Modify: `backend/src/Service/LedgerStateService.php`
- Modify: `backend/src/Controller/AccountController.php`

**Interfaces:**
- Consumes: `Account::getParent()`/`setParent()` (Task 1).
- Produces: `LedgerStateService::hydrateAccount()` throws `\InvalidArgumentException` for an unknown or missing-when-required `parentId`; `accountToArray()` emits `parentId` (was `isaParentId`).

- [ ] **Step 1: Add `resolveParent()`, mirroring `resolveCurrency()`/`resolveSymbol()`**

Add near the other `resolve*()` private methods:

```php
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
```

- [ ] **Step 2: Update `hydrateAccount()`**

Replace:

```php
        $account->setIsaParentId($data['isaParentId'] ?? null);
```

with:

```php
        $account->setParent($this->resolveParent($data['parentId'] ?? null));

        if ('investment' === $account->getType() && null === $account->getParent()) {
            throw new \InvalidArgumentException('An investment account must have a parent wrapper.');
        }
```

(placed after the existing `$account->setSymbol(...)`/`$account->setCounterparty(...)` lines, so `$account->getType()` already reflects this save's incoming `type` value — `setType()` runs first in this method, near the top, unchanged.)

- [ ] **Step 3: Update `accountToArray()`**

Replace:

```php
            'isaParentId' => $a->getIsaParentId(),
```

with:

```php
            'parentId' => $a->getParent()?->getId(),
```

- [ ] **Step 4: Update `AccountController` — catch both new failure modes**

```php
    #[Route('/{id}', methods: ['PUT'])]
    public function put(string $id, Request $request): JsonResponse
    {
        $body = json_decode($request->getContent(), true);
        if (!\is_array($body)) {
            return new JsonResponse(['error' => 'Invalid JSON body'], 400);
        }

        try {
            return new JsonResponse($this->state->upsertAccount($id, $body));
        } catch (\InvalidArgumentException $e) {
            return new JsonResponse(['error' => $e->getMessage()], 400);
        }
    }
```

```php
    #[Route('/{id}', methods: ['DELETE'])]
    public function delete(string $id): JsonResponse
    {
        try {
            $this->state->deleteAccount($id);
        } catch (\Doctrine\DBAL\Exception\ForeignKeyConstraintViolationException) {
            return new JsonResponse(['error' => "Can't delete a wrapper account that still has subaccounts. Delete those first."], 409);
        }

        return new JsonResponse(['ok' => true]);
    }
```

- [ ] **Step 5: Lint and test**

```bash
cd backend
php -l src/Service/LedgerStateService.php
php -l src/Controller/AccountController.php
php bin/phpunit
```

Expected: no syntax errors. Tests may still fail at this point — `IsaAllowanceServiceTest.php` isn't updated until Task 4 — a failure there referencing `setIsaParentId`/`isaParentId` is expected and will be resolved by Task 4, not this task. If any *other* test fails, stop and investigate before proceeding.

- [ ] **Step 6: Manual verification — all three validation layers at the backend/database level**

```bash
cd backend
rm -f databases/av-test.sqlite3 databases/app-settings.yaml
touch databases/av-test.sqlite3
DATABASE_URL="sqlite:////$(pwd)/databases/av-test.sqlite3" php bin/console doctrine:migrations:migrate --no-interaction >/dev/null 2>&1
DATABASE_URL="sqlite:////$(pwd)/databases/av-test.sqlite3" php bin/console app:currencies:seed >/dev/null 2>&1
php -r "
require 'vendor/autoload.php';
\$repo = new App\Service\AppSettingsRepository(getcwd());
\$repo->write(['activeDatabase' => 'av-test.sqlite3']);
"
symfony server:start --port=8497 -d
```

```bash
curl -s -w "\n[%{http_code}]\n" -X PUT http://127.0.0.1:8497/api/accounts/inv1 -H "Content-Type: application/json" -d '{"name":"No Parent","type":"investment","symbol":"AAPL"}'
```

Expected: `400` with a clear error message — either "Unknown symbol" (since no symbol exists yet in this scratch file — swap in a real symbol first if you want to isolate the parent check specifically) or "An investment account must have a parent wrapper." Confirm you see the parent-wrapper message specifically by first creating a wrapper and a real symbol, then omitting `parentId`:

```bash
curl -s -X PUT http://127.0.0.1:8497/api/accounts/wrap1 -H "Content-Type: application/json" -d '{"name":"My Wrapper","type":"investment-parent"}'
curl -s -X POST http://127.0.0.1:8497/api/symbols -H "Content-Type: application/json" -d '{"ticker":"AAPL","name":"Apple","scale":6,"tradingCurrency":"GBP"}'
curl -s -w "\n[%{http_code}]\n" -X PUT http://127.0.0.1:8497/api/accounts/inv1 -H "Content-Type: application/json" -d '{"name":"No Parent","type":"investment","symbol":"AAPL"}'
```

Expected: `400 {"error":"An investment account must have a parent wrapper."}`.

```bash
curl -s -w "\n[%{http_code}]\n" -X PUT http://127.0.0.1:8497/api/accounts/inv1 -H "Content-Type: application/json" -d '{"name":"With Parent","type":"investment","symbol":"AAPL","parentId":"wrap1"}'
```

Expected: `201`/`200` success — confirms the happy path works once a real parent is given.

```bash
curl -s -w "\n[%{http_code}]\n" -X DELETE http://127.0.0.1:8497/api/accounts/wrap1
```

Expected: `409` with the "still has subaccounts" message — confirms the FK-violation catch in `delete()` fires correctly (if this instead returns a raw 500, the exception class caught in Step 4 is wrong — inspect the actual exception via `var_dump(get_class($e))` temporarily to find the real class, then fix the `catch` clause to match).

```bash
pgrep -f "port=8497" | xargs -r kill
rm -f databases/av-test.sqlite3 databases/app-settings.yaml
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/Service/LedgerStateService.php backend/src/Controller/AccountController.php
git commit -m "LedgerStateService/AccountController: enforce parent_id resolution and investment-requires-parent"
```

---

### Task 3: `IsaAllowanceService` and its test suite

**Files:**
- Modify: `backend/src/Service/IsaAllowanceService.php`
- Modify: `backend/tests/Service/IsaAllowanceServiceTest.php`

**Interfaces:**
- Consumes: `Account::setParent()`/`getParent()` (Task 1), `accountToArray()`'s `parentId` key (Task 2).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Update `IsaAllowanceService::isaProducts()`**

Replace:

```php
            if ('isa-parent' === $a['type']) {
                $childIds = array_values(array_map(
                    static fn ($x) => $x['id'],
                    array_filter($accounts, static fn ($x) => ($x['isaParentId'] ?? null) === $a['id'])
                ));
```

with:

```php
            if ('investment-parent' === $a['type'] && 'stocks-shares-isa' === ($a['isaKind'] ?? null)) {
                $childIds = array_values(array_map(
                    static fn ($x) => $x['id'],
                    array_filter($accounts, static fn ($x) => ($x['parentId'] ?? null) === $a['id'])
                ));
```

- [ ] **Step 2: Update `IsaAllowanceServiceTest.php`'s `makeAccount()` helper**

Replace:

```php
        $a->setIsaParentId($overrides['isaParentId'] ?? null);
```

with:

```php
        $a->setParent($overrides['parent'] ?? null);
```

- [ ] **Step 3: Update the one test call site that uses this override**

Find `testStandaloneInvestmentLineInsideIsaWrapperUsesCashValueNotUnits()`. Replace:

```php
        $wrapper = $this->makeAccount('isaWrapper', ['type' => 'isa-parent', 'flexible' => false]);
        $symbol = $this->ensureSymbol('ACME');
        $holding = $this->makeAccount('isaHolding', [
            'type' => 'investment',
            'isaParentId' => 'isaWrapper',
        ]);
```

with:

```php
        $wrapper = $this->makeAccount('isaWrapper', ['type' => 'investment-parent', 'isaKind' => 'stocks-shares-isa', 'flexible' => false]);
        $symbol = $this->ensureSymbol('ACME');
        $holding = $this->makeAccount('isaHolding', [
            'type' => 'investment',
            'parent' => $wrapper,
        ]);
```

- [ ] **Step 4: Run the test suite**

```bash
cd backend && php bin/phpunit
```

Expected: 6/6 green — this is the same test suite Task 2 left one failure in; that failure should now be resolved.

- [ ] **Step 5: Commit**

```bash
git add backend/src/Service/IsaAllowanceService.php backend/tests/Service/IsaAllowanceServiceTest.php
git commit -m "IsaAllowanceService: recognize investment-parent+stocks-shares-isa, not isa-parent"
```

---

### Task 4: Frontend logic layer — `theme.js`, `isa.js`, `grouping.js`

**Files:**
- Modify: `src/lib/theme.js`
- Modify: `src/lib/isa.js`
- Modify: `src/lib/grouping.js`

**Interfaces:**
- Produces: `TYPES` includes `{ key: "investment-parent", label: "Investment wrapper" }` instead of `isa-parent`; `isaProducts()`/`bucketBy()`/`counterpartyOf()` all read `.parentId` and `type === "investment-parent"`.

- [ ] **Step 1: Update `theme.js`'s `TYPES` array**

Replace:

```javascript
  { key: "isa-parent", label: "Stocks & Shares ISAs" },
```

with:

```javascript
  { key: "investment-parent", label: "Investment wrapper" },
```

- [ ] **Step 2: Update `isa.js`'s `isaProducts()`**

Replace:

```javascript
    if (a.type === "isa-parent") {
      products.push({
        account: a,
        kind: "stocks-shares-isa",
        flexible: !!a.flexible,
        accountIds: accounts.filter((x) => x.isaParentId === a.id).map((x) => x.id),
      });
    } else if (a.isaKind && a.isaKind !== "stocks-shares-isa") {
```

with:

```javascript
    if (a.type === "investment-parent" && a.isaKind === "stocks-shares-isa") {
      products.push({
        account: a,
        kind: "stocks-shares-isa",
        flexible: !!a.flexible,
        accountIds: accounts.filter((x) => x.parentId === a.id).map((x) => x.id),
      });
    } else if (a.isaKind && a.isaKind !== "stocks-shares-isa") {
```

- [ ] **Step 3: Update `grouping.js`'s three call sites**

`counterpartyOf()` — replace:

```javascript
  if (account.isaParentId) {
    const parent = allAccounts.find((a) => a.id === account.isaParentId);
```

with:

```javascript
  if (account.parentId) {
    const parent = allAccounts.find((a) => a.id === account.parentId);
```

`bucketBy()`'s currency branch — replace:

```javascript
      if (a.type === "isa-parent") { wrappers.push(a); return; }
```

with:

```javascript
      if (a.type === "investment-parent") { wrappers.push(a); return; }
```

The currency-totals exclusion — replace:

```javascript
  items.filter((a) => a.type !== "investment" && a.type !== "isa-parent").forEach((a) => { sub[a.currency] = (sub[a.currency] || 0) + (a.balance || 0); });
```

with:

```javascript
  items.filter((a) => a.type !== "investment" && a.type !== "investment-parent").forEach((a) => { sub[a.currency] = (sub[a.currency] || 0) + (a.balance || 0); });
```

- [ ] **Step 4: Build**

```bash
cd /Users/radu/Code/Claude/ledger-project && yarn build
```

Expected: clean build (this task's changes are pure logic, no JSX — a build failure here would indicate a typo, not a missing dependency on a later task).

- [ ] **Step 5: Commit**

```bash
git add src/lib/theme.js src/lib/isa.js src/lib/grouping.js
git commit -m "Frontend lib: investment-parent replaces isa-parent, parentId replaces isaParentId"
```

---

### Task 5: Frontend UI layer — `AccountFormModal.jsx`, `IsaParentView.jsx`, `App.jsx`, `Overview.jsx`, `AccountRow.jsx`

**Files:**
- Modify: `src/components/AccountFormModal.jsx`
- Modify: `src/components/IsaParentView.jsx`
- Modify: `src/App.jsx`
- Modify: `src/components/Overview.jsx`
- Modify: `src/components/AccountRow.jsx`

**Interfaces:**
- Consumes: `TYPES`'s `investment-parent` entry, `isaProducts()` (Task 4); `PUT /api/accounts/{id}` now rejecting a parent-less investment account (Task 2).
- Produces: nothing later tasks depend on — this is the last code task.

- [ ] **Step 1: `AccountFormModal.jsx` — `wrappers`, `isWrapper`, and the docblock comment**

Replace:

```javascript
  const wrappers = accounts.filter((a) => a.type === "isa-parent");
```

with:

```javascript
  const wrappers = accounts.filter((a) => a.type === "investment-parent");
```

Replace the comment above `isaChoice`'s declaration:

```javascript
  // "" = not an ISA, "cash-isa"/"lifetime-isa"/"innovative-finance-isa" = a
  // standalone flat ISA, or an isa-parent account id = "this is a
  // subaccount of that Stocks & Shares ISA wrapper".
```

with:

```javascript
  // For a non-wrapper account: "" = not an ISA, "cash-isa"/"lifetime-isa"/
  // "innovative-finance-isa" = a standalone flat ISA, or a wrapper account
  // id = "this is a subaccount of that wrapper" (ISA or not — see
  // isSubaccount below). For a wrapper account itself (isWrapper): ""  =
  // a plain organizational wrapper, "stocks-shares-isa" = this wrapper is
  // an ISA — reusing the same field/values rather than a separate flag.
```

Replace:

```javascript
  const isWrapper = type === "isa-parent";
```

with:

```javascript
  const isWrapper = type === "investment-parent";
```

Replace `showFlexible`'s line:

```javascript
  const showFlexible = isWrapper || (!isSubaccount && !!isaChoice);
```

with:

```javascript
  const showFlexible = (isWrapper && isaChoice === "stocks-shares-isa") || (!isWrapper && !isSubaccount && !!isaChoice);
```

- [ ] **Step 2: `AccountFormModal.jsx` — `submit()`**

Add a required-parent guard alongside the existing symbol guard at the top of `submit()`:

```javascript
    if (type === "investment" && !symbol.trim()) return;
    if (type === "investment" && !isSubaccount) return;
```

Replace the `isWrapper`/`isSubaccount` branches:

```javascript
    if (isWrapper) {
      // A wrapper holds nothing directly — no currency or opening balance.
      delete data.currency;
      delete data.openingBalance;
      data.flexible = flexible;
    } else if (isaEligible && isSubaccount) {
      data.isaKind = "stocks-shares-isa";
      data.isaParentId = isaChoice;
    } else if (isaEligible && isaChoice) {
      data.isaKind = isaChoice;
      data.flexible = flexible;
    }
```

with:

```javascript
    if (isWrapper) {
      // A wrapper holds nothing directly — no currency or opening balance.
      delete data.currency;
      delete data.openingBalance;
      data.isaKind = isaChoice || null;
      if (isaChoice === "stocks-shares-isa") data.flexible = flexible;
    } else if (isaEligible && isSubaccount) {
      // Only tag the subaccount itself as ISA-related when the chosen
      // wrapper actually is one — IsaAllowanceService::isExternalLine()
      // checks a counterpart account's own isaKind directly, so setting
      // this unconditionally would make a non-ISA wrapper's subaccounts
      // look like internal ISA transfers to the allowance engine.
      const chosenWrapper = wrappers.find((w) => w.id === isaChoice);
      if (chosenWrapper?.isaKind === "stocks-shares-isa") {
        data.isaKind = "stocks-shares-isa";
      }
      data.parentId = isaChoice;
    } else if (isaEligible && isaChoice) {
      data.isaKind = isaChoice;
      data.flexible = flexible;
    }
```

- [ ] **Step 3: `AccountFormModal.jsx` — the ISA/wrapper field itself**

Replace the whole `Field label="ISA"` block:

```javascript
        {!isWrapper && (type === "asset" || type === "investment") && (
          <Field label="ISA">
            <select value={isaChoice} onChange={(e) => setIsaChoice(e.target.value)} style={inputStyle} disabled={!!initial.isaParentPreset}>
              <option value="">Not an ISA</option>
              {type === "asset" && ISA_KINDS.filter((k) => k.key !== "stocks-shares-isa").map((k) => (
                <option key={k.key} value={k.key}>{k.label}</option>
              ))}
              {wrappers.map((w) => (
                <option key={w.id} value={w.id}>{type === "investment" ? "Part of" : "Cash within"}: {w.name}</option>
              ))}
            </select>
            {type === "investment" && wrappers.length === 0 && (
              <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 4 }}>Create a Stocks & Shares ISA wrapper first to hold this as a subaccount.</div>
            )}
          </Field>
        )}
```

with:

```javascript
        {isWrapper && (
          <label className="flex items-center gap-2" style={{ fontSize: 13, color: C.inkSoft }}>
            <input type="checkbox" checked={isaChoice === "stocks-shares-isa"} onChange={(e) => setIsaChoice(e.target.checked ? "stocks-shares-isa" : "")} />
            This is a Stocks &amp; Shares ISA
          </label>
        )}
        {!isWrapper && (type === "asset" || type === "investment") && (
          <Field label={type === "investment" ? "Wrapper" : "ISA"}>
            <select value={isaChoice} onChange={(e) => setIsaChoice(e.target.value)} style={inputStyle} disabled={!!initial.isaParentPreset}>
              {type !== "investment" && <option value="">Not an ISA</option>}
              {type === "asset" && ISA_KINDS.filter((k) => k.key !== "stocks-shares-isa").map((k) => (
                <option key={k.key} value={k.key}>{k.label}</option>
              ))}
              {wrappers.map((w) => (
                <option key={w.id} value={w.id}>{type === "investment" ? "Part of" : "Cash within"}: {w.name}</option>
              ))}
            </select>
            {type === "investment" && wrappers.length === 0 && (
              <div style={{ fontSize: 11.5, color: C.inkFaint, marginTop: 4 }}>Create an investment wrapper first — every stock/share account must belong to one.</div>
            )}
          </Field>
        )}
```

(the wrapper's own checkbox is placed as its own element, outside the `Field label=...` block used for non-wrapper accounts, since it's a plain checkbox not a select — position it right after the existing `Field label="Type"` block, before the symbol/currency fields, matching where the removed `isWrapper`-excluded block used to sit in the render order.)

- [ ] **Step 4: `IsaParentView.jsx` — `.isaParentId` and the hardcoded "ISA" label**

Replace:

```javascript
  const subs = accounts.filter((a) => a.isaParentId === account.id);
```

with:

```javascript
  const subs = accounts.filter((a) => a.parentId === account.id);
```

Replace the header block:

```javascript
        <div>
          <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>Stocks & Shares ISA</div>
          <h2 className="ll-serif" style={{ fontSize: 24, marginTop: 2 }}>{displayAccountName(account)}</h2>
          <div style={{ fontSize: 13, color: C.inkFaint, marginTop: 6 }}>{subs.length} subaccount{subs.length === 1 ? "" : "s"}</div>
        </div>
        <button onClick={onEditAccount} className="px-3 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13 }}>Edit ISA</button>
```

with:

```javascript
        <div>
          <div style={{ fontSize: 10.5, color: C.inkFaint, textTransform: "uppercase", letterSpacing: 0.8 }}>{account.isaKind === "stocks-shares-isa" ? "Stocks & Shares ISA" : "Investment wrapper"}</div>
          <h2 className="ll-serif" style={{ fontSize: 24, marginTop: 2 }}>{displayAccountName(account)}</h2>
          <div style={{ fontSize: 13, color: C.inkFaint, marginTop: 6 }}>{subs.length} subaccount{subs.length === 1 ? "" : "s"}</div>
        </div>
        <button onClick={onEditAccount} className="px-3 py-1.5 rounded" style={{ border: `1px solid ${C.line}`, fontSize: 13 }}>Edit</button>
```

Also update the file's top comment (`/* ISA parent (Stocks & Shares ISA wrapper) — holds no ledger of its own, just groups its cash and stock subaccounts. */`) to: `/* Investment wrapper (Stocks & Shares ISA or a plain organizational grouping) — holds no ledger of its own, just groups its cash and stock subaccounts. */`.

- [ ] **Step 5: `App.jsx` — three call sites**

Replace:

```javascript
  function accountDisplay(a) {
    if (a.type === "isa-parent") {
      const n = accounts.filter((x) => x.isaParentId === a.id).length;
```

with:

```javascript
  function accountDisplay(a) {
    if (a.type === "investment-parent") {
      const n = accounts.filter((x) => x.parentId === a.id).length;
```

Replace:

```javascript
    const hasSubaccounts = accounts.some((a) => a.isaParentId === id);
```

with:

```javascript
    const hasSubaccounts = accounts.some((a) => a.parentId === id);
```

Update the message right after it (currently `"Can't delete an ISA that still has subaccounts. Delete those first."` — grep this exact string in `App.jsx`'s `requestDeleteAccount()` if it's not immediately below the line above) to: `"Can't delete a wrapper account that still has subaccounts. Delete those first."` — matching the backend's new message from Task 2.

Replace:

```javascript
            selected.type === "isa-parent" ? (
```

with:

```javascript
            selected.type === "investment-parent" ? (
```

- [ ] **Step 6: `Overview.jsx`**

Replace:

```javascript
  accounts.filter((a) => a.type !== "investment" && a.type !== "isa-parent").forEach((a) => { totalsByCurrency[a.currency] = (totalsByCurrency[a.currency] || 0) + (a.balance || 0); });
```

with:

```javascript
  accounts.filter((a) => a.type !== "investment" && a.type !== "investment-parent").forEach((a) => { totalsByCurrency[a.currency] = (totalsByCurrency[a.currency] || 0) + (a.balance || 0); });
```

- [ ] **Step 7: `AccountRow.jsx`**

Update the comment (`// Same three balance shapes as before (isa-parent's subaccount count, ...`) to say `investment-parent's subaccount count`.

Replace:

```javascript
        {a.type === "isa-parent" ? (
          <span style={{ color: C.inkFaint }}>{accounts.filter((x) => x.isaParentId === a.id).length} subaccounts</span>
```

with:

```javascript
        {a.type === "investment-parent" ? (
          <span style={{ color: C.inkFaint }}>{accounts.filter((x) => x.parentId === a.id).length} subaccounts</span>
```

- [ ] **Step 8: Build**

```bash
cd /Users/radu/Code/Claude/ledger-project && yarn build
```

Expected: clean build.

- [ ] **Step 9: Manual browser verification**

Set up a scratch backend (fresh migrated + currency-seeded `.sqlite3` file, `app-settings.yaml` pointed at it via `POST /api/databases/active`, `vite.config.js`'s dev proxy temporarily pointed at the scratch backend's port, `yarn dev` restarted) — same pattern as prior sessions' verification. In the browser:

1. Create a new account, type "Investment wrapper" (`investment-parent`), leave the ISA checkbox unchecked. Save.
2. Try to create a new `investment` account without selecting a wrapper — confirm it's blocked (the Save button does nothing, matching the existing symbol-required behavior) and that the wrapper dropdown never even offers an empty "Not an ISA" option for this type.
3. Select the wrapper just created, add a symbol, save — confirm it succeeds and shows up under that wrapper's page with the "Investment wrapper" label (not "Stocks & Shares ISA").
4. Create a second wrapper, this time checking "This is a Stocks & Shares ISA" — confirm its detail page shows "Stocks & Shares ISA" as the label, and that its own "Edit" button says "Edit" (not "Edit ISA").
5. Add a cash (`asset`) subaccount to the *non-ISA* wrapper — confirm it's accepted (per the "non-ISA wrappers can hold cash too" decision) and shows up under "Cash" on that wrapper's page.
6. Confirm the ISA Allowance page does *not* show the non-ISA wrapper's holding at all, but does show the ISA wrapper's, if it has any transactions.
7. Try deleting a wrapper that still has a subaccount — confirm the UI's existing pre-check still blocks it client-side with the updated message text.

Revert `vite.config.js` and stop/clean up the scratch backend afterward.

- [ ] **Step 10: Commit**

```bash
git add src/components/AccountFormModal.jsx src/components/IsaParentView.jsx src/App.jsx src/components/Overview.jsx src/components/AccountRow.jsx
git commit -m "Frontend UI: investment-parent wrapper, ISA-or-not checkbox, required parent for investment accounts"
```

---

### Task 6: Final verification

**Files:** none — verification only. No real cutover step is needed for this feature (unlike the app-settings/database-switcher plans): this doesn't touch the active-database mechanism, and every real tax-year database already has zero `investment`/`isa-parent` accounts (confirmed directly against all of them before writing this plan), so the schema migration is a pure, risk-free structural change with nothing to reconcile.

- [ ] **Step 1: Full test suite and build**

```bash
cd backend && php bin/phpunit
cd .. && yarn build
```

Expected: both clean.

- [ ] **Step 2: Apply the migration to every real tax-year database**

This project's standing precedent (see CLAUDE.md, and every prior plan's migration section) is that each file picks up a new migration the next time it's switched into and migrated, not all at once. No special action is needed here beyond normal use — switching into any real tax-year file via the in-app switcher and having `MigrationStatusListener` prompt for the migration (or running `doctrine:migrations:migrate` directly against it) picks this up exactly like any other migration.

If you want to apply it to every real file now rather than waiting for each to be switched into naturally:

```bash
cd backend
for f in databases/*.sqlite3; do
  [ "$(basename "$f")" = "development.sqlite3" ] && continue
  echo "=== $f ==="
  ACTIVE_DATABASE_PATH_OVERRIDE="$(pwd)/$f" php bin/console doctrine:migrations:migrate --no-interaction
done
```

(`development.sqlite3` is explicitly skipped — it has one standalone investment account that violates the new `CHECK` constraint and isn't real data; leave it as a reminder to fix or discard separately, not something this plan's verification should touch.)

- [ ] **Step 3: Confirm no real data was affected**

```bash
cd backend
for f in databases/*.sqlite3; do
  [ "$(basename "$f")" = "development.sqlite3" ] && continue
  echo "=== $(basename "$f") ==="
  sqlite3 "$f" "SELECT count(*) FROM account;"
done
```

Expected: the same account counts as before this plan's migrations were applied (this feature adds no new accounts and removes none — only renames a type value that no real file currently uses, and adds constraints nothing currently violates).

- [ ] **Step 4: Update CLAUDE.md**

Find the "Data model" section's description of `isa-parent` (`` An `isa-parent` holds no balance itself — it's a wrapper grouping subaccounts via `isaParentId`. ``) and replace with:

```
- Account types: `asset`, `liability`, `equity`, `income`, `isa-income`,
  `expense`, `investment`, `investment-parent`. An `investment-parent`
  holds no balance itself — it's a wrapper grouping subaccounts via a
  real, enforced foreign key, `parentId` (`Account.parent` backend-side,
  `ON DELETE NO ACTION`). It groups either a Stocks & Shares ISA (when
  its `isaKind` is `"stocks-shares-isa"` — the same field flat ISA
  accounts use, reused here rather than a separate flag) or a plain
  organizational holding with no ISA meaning at all. A `type:
  "investment"` account must always have a parent — enforced at the
  frontend, in `LedgerStateService::hydrateAccount()`, and by a database
  `CHECK` constraint (`type != 'investment' OR parent_id IS NOT NULL`).
```

Search for other `isa-parent`/`isaParentId` mentions in CLAUDE.md (the "Data model" and "ISA allowance engine" sections both reference it) and update them to `investment-parent`/`parentId` consistently.

Add a note to the "Backend" section about the new `foreign_keys` enforcement, near wherever schema/migration conventions are already documented:

```
- **SQLite's `foreign_keys` pragma is enabled on every connection this
  app makes** (`src/Doctrine/ForeignKeysMiddleware`/`ForeignKeysDriver`,
  a Doctrine connection middleware executing `PRAGMA foreign_keys = ON`
  immediately after every real connect — SQLite doesn't enforce foreign
  keys by default, and the setting isn't stored in the database file
  itself, so it has to be set per-connection every time). Every FK in
  the schema is now genuinely enforced, not merely declarative — see
  `docs/superpowers/specs/2026-09-19-generalized-investment-parent-design.md`
  for the audit confirming this doesn't conflict with any existing
  bulk-delete/insert ordering in this codebase.
```

```bash
git add CLAUDE.md
git commit -m "Document investment-parent and foreign_keys enforcement in CLAUDE.md"
```
