@AGENTS.md

# Boekhouden — CLAUDE.md

Bookkeeping app for a Dutch student association ("dispuut"). The full design lives in `PLAN.md`
(data model, chart of accounts, journal templates T00–T31, state diagrams, decision log).
**Read PLAN.md before changing anything financial.** If code and PLAN.md disagree, stop and ask.

## Core principles (non-negotiable)

1. **The bank is the source of truth.** Every imported bank transaction is immediately posted
   against `1099 Te verwerken bankmutaties` (template T00). Assigning a transaction is a second
   entry that moves the amount from 1099 to a person / activity / pot / invoice / internal transfer.
   "Nog toe te wijzen" = bank transactions whose 1099 balance ≠ 0.
2. **Double-entry under the hood.** Every event produces one journal entry whose lines sum to zero.
   The UI talks about people, activities, pots and the bank — never debit/credit, except in the
   Memoriaal screen and the read-only views for the treasurer ("fiscus") and audit committee.
3. **Posted data is immutable.** Corrections are reversal entries (`reverseEntry`, template T27).
   Every action writes to the append-only, hash-chained `audit_log`. Enforced by DB triggers.
4. **Amounts are integer euro cents** (`Cents` in `src/domain/money.ts`). Never floats, never
   `parseFloat`/`Number("12.50")` on money. Parse strings with `parseEuroString`. Split with
   `allocate` (largest remainder) so sums are exact.
5. **Imports are idempotent**: `UNIQUE (bank_account_id, external_id)`.
6. **The balance always holds**: sum of all lines = 0; ledger bank balance = last "saldo na trn".
7. **No guessing.** Never auto-book on probability. Auto-book only internal transfers between own
   IBANs and rules the fiscus explicitly marked `auto_book`. Everything else is a suggestion.

## Rules for code

- **All money mutations go through `postEntry()` / `reverseEntry()`** in `src/server/ledger/`,
  inside one DB transaction together with the document status change and the audit log entry.
  Never insert into `journal_entries` / `journal_lines` anywhere else.
- **Journal templates are pure functions** in `src/domain/ledger/templates.ts`
  (`input → EntryDraft`). No DB access, no `Date.now()`. Each template has a unit test.
- Accounts are referenced in templates by `systemKey` (`{ key: "MEMBER_ACCOUNTS" }`) or by id
  (pot default accounts, resolved by the service). Never by code string.
- Sign convention: `amountCents > 0` = debit, `< 0` = credit. Person account balance > 0 means the
  person owes the association; < 0 means credit ("tegoed").
- Authorization is checked in every server action with `requireRole()` / `requireUser()`
  (`src/server/auth/roles.ts`). Never rely on hiding UI. Audit committee ("kascommissie") is
  read-only everywhere.
- Validate all action input with Zod.
- DB-level invariants live in `drizzle/0001_invariants.sql` (triggers). If you add a rule that can
  be enforced in the DB, enforce it there *and* in `postEntry()`.
- Dates: `YYYY-MM-DD` strings (`LocalDate`) for booking dates; timezone Europe/Amsterdam.
- Code, identifiers and comments in **English**; all UI text in **Dutch**.
- No VAT logic. `vat_code` columns exist and must stay `NULL`.
- Only free services (Vercel Hobby, Neon Free, SMTP of choice, S3-compatible storage).

## Project structure

```
src/domain/            pure logic: money, dates, ledger templates, allocation, parsers, reports
src/server/db/         Drizzle schema (schema.ts), client (index.ts), seed (seed.ts)
src/server/ledger/     postEntry, reverseEntry, balances
src/server/services/   use-cases (one file per area)
src/server/auth/       Auth.js config, roles
src/server/audit.ts    audit log writer
src/app/               Next.js App Router pages + server actions (Dutch UI)
src/components/ui/     shadcn-style primitives (hand-written; registry is not reachable)
drizzle/               SQL migrations (generated + hand-written invariants)
fixtures/              bank export samples (synthetic, documented as such)
tests/                 DB integration and property tests (unit tests sit next to domain code)
```

## Commands

Production runs on **Vercel (Hobby) + Neon (Free)**; no Docker. `npm run vercel-build` applies
migrations (using `DATABASE_URL_UNPOOLED` if set) and then builds. First-run setup happens in the
browser at `/setup` (guarded by `SETUP_CODE`); see README.

```bash
npm run db:migrate            # apply migrations (drizzle/) to DATABASE_URL
npm run db:seed               # demo association (resets the database!); also available as a button in /setup
npm run dev                   # http://localhost:3000 — without EMAIL_SERVER the magic link is printed to the console
npm test                      # unit + DB tests (needs DATABASE_URL_TEST, an empty Postgres database)
npm run test:unit             # pure tests only, no database
npm run typecheck && npm run lint
npm run db:generate           # after changing schema.ts → new migration
```

Always run `npm run typecheck`, `npm run lint` and `npm test` before committing.

## Build order (PLAN.md §14)

a ✅ schema/auth/roles/seed · b ✅ ledger engine + invariants · c bank import · d assign screen ·
e members/contribution/monthly mail · f claims/invoices · g activities/settlements ·
h cash/memorial/reserves · i reports/year-end/audit pack/setup wizard.
Update this line when a step is finished.

## Ask the user (in Dutch) when

association-specific rules are unclear (contribution amounts, who may approve, which reserves).
Don't assume.
