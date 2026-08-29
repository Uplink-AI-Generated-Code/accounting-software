# Ledger

A personal double-entry ledger for cash accounts, UK Stocks & Shares ISAs, and stock trading — built as a single-page React app with no backend. Everything lives in your browser's storage.

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

```bash
yarn install
yarn dev
```

Then open the printed local URL. No environment variables, database, or account required — data is kept in your browser via `window.storage` (see `storageShim.js`), so it's local to whichever browser and machine you're using.

## Data model, briefly

A **transaction** is just a set of **lines**. Each line belongs to one account and carries its own amount, date, and description — there's no transaction-level date, so two linked entries can legitimately be dated differently (e.g. a card payment posting a day after the purchase).

An account's `amount` sign means increase/decrease uniformly across every account type; the ledger UI labels this "In"/"Out" rather than using debit/credit terminology.

Investment accounts hold exactly one security. Nothing about price-per-share is ever stored — it's always computed from the cash and unit amounts you enter.

## What this isn't

- **Not a market data tool.** There's no price feed. "Portfolio value" is your own last trade price applied to your current holding, not what the market says it's worth today.
- **Not tax or financial advice.** The ISA allowance logic reflects the rules as understood at the time of writing; if it disagrees with HMRC or your provider, trust them.
- **Not multi-user or synced.** Storage is local to the browser. There's no login, no server, and no sharing between devices.

## Tech

React, Tailwind, [Recharts](https://recharts.org/) for the combined stock chart, [Lucide](https://lucide.dev/) for icons. Single main component file (`ledger-app.jsx`); see `CLAUDE.md` if you're developing this further with Claude Code — it documents the sign conventions and shared logic that aren't obvious from the code alone.
