# Ledger

A personal double-entry ledger for cash accounts, UK Stocks & Shares ISAs, and stock trading — a single-page React app backed by a small Symfony API and a local SQLite database.

## Why this exists

Most personal finance apps either oversimplify (a single running balance, no real double-entry) or assume a specific broker's data feed. This is built around a small set of ideas instead:

- **Real double-entry.** Every transaction is a set of lines across accounts that should net to zero, not a single "amount" with a category tag.
- **Nothing invented.** No live share prices, no assumed exchange rates. Every number shown is either something you entered or a value derived from what you entered — the app is always explicit about which.
- **UK ISA rules, properly modeled.** Annual allowance, sub-caps (Cash, Lifetime, Innovative Finance), and flexible-ISA replacement rules with the correct current-year-vs-prior-year ordering — not just a running total.

## Features

**Accounts & ledger**
- Asset, liability, equity, income, expense, investment, and ISA-wrapper account types
- Multi-line split transactions (e.g. one payment covering a purchase and a fee) with live balance-imbalance feedback
- Per-line dates and descriptions — two sides of a linked entry can genuinely disagree on either
- Manual reordering of same-date entries
- Currency-exchange tagging on cash lines, for matching a foreign-currency payment to its domestic counterpart
- Smart matching: as you link an account or split a transaction, the app searches your existing unmatched entries for a plausible counterpart — including across cash and stock accounts — and offers it before you re-enter it by hand

**Stocks & Shares ISA**
- One security per investment account (symbol, currency, and cost basis all tracked per account)
- ISA wrapper accounts group Cash, Stocks & Shares, Lifetime, and Innovative Finance ISA subaccounts
- Allowance tracking against the current or a past tax year, with sub-caps
- Flexible ISA support: withdrawals and replacements are simulated in chronological order, correctly distinguishing money that can be replaced into *any* ISA (this year's own subscriptions) from money that can only go back into the *same* ISA (prior years')

**Stock accounts**
- Cost basis (average-cost method) and a "mark to last trade" portfolio value, shown side by side — never presented as a live market price, because there isn't one
- Combined chart: units as bars, cost basis and portfolio value as lines on a shared axis, with year-over-year comparison

**Overview & organization**
- Cascading, saveable grouping (by type, institution, and/or currency, up to three levels) shared between the sidebar and the account overview
- Per-account and combined balances by currency

**Safety nets**
- Deleting an account with existing entries asks first, and never deletes the other side of anything linked to another account — it's split off into its own standalone record instead
- Navigating away from an unsaved edit prompts you to save, discard, or stay, rather than silently losing it

## Getting started

Backend first (Symfony, SQLite via Doctrine):

```bash
cd backend
composer install
php bin/console doctrine:migrations:migrate
symfony server:start --port=8000
```

Then, in another terminal, the frontend:

```bash
yarn install
yarn dev
```

Open the printed local URL — the Vite dev server proxies `/api/*` to the Symfony backend on :8000, so both need to be running. No account or login is required; this is a single-user app and the data lives in `backend/var/data_dev.db`, local to whichever machine runs the backend.

If you're moving data from an earlier, browser-only version of this app, see `backend/src/Command/ImportLocalStorageCommand.php` for the one-time `app:import-local-storage` migration.

## Data model, briefly

A **transaction** is just a set of **lines**. Each line belongs to one account and carries its own amount, date, and description — there's no transaction-level date, so two linked entries can legitimately be dated differently (e.g. a card payment posting a day after the purchase).

An account's `amount` sign means increase/decrease uniformly across every account type; the ledger UI labels this "In"/"Out" rather than using debit/credit terminology.

Investment accounts hold exactly one security. Nothing about price-per-share is ever stored — it's always computed from the cash and unit amounts you enter.

## What this isn't

- **Not a market data tool.** There's no price feed. "Portfolio value" is your own last trade price applied to your current holding, not what the market says it's worth today.
- **Not tax or financial advice.** The ISA allowance logic reflects the rules as understood at the time of writing; if it disagrees with HMRC or your provider, trust them.
- **Not multi-user or synced.** One SQLite database, no login, no sharing between devices. If you run the backend on one machine, that's where your data lives.

## Tech

**Frontend:** React, Tailwind, [Recharts](https://recharts.org/) for the combined stock chart, [Lucide](https://lucide.dev/) for icons — split into `src/lib/` (formatting, matching, ISA rules, stock math — no JSX) and `src/components/` (the views).

**Backend:** Symfony (API-only, no Twig), Doctrine ORM + Migrations, SQLite. `GET /api/state` covers the frontend's initial load; every write after that goes through discrete per-entity endpoints (`/api/accounts/{id}`, `/api/settings`, `/api/transactions/batch`) instead of replacing the whole ledger at once.

See `CLAUDE.md` if you're developing this further with Claude Code — it documents the sign conventions and shared logic that aren't obvious from the code alone.
