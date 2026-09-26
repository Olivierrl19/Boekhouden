/**
 * Derived balances. Nothing here is stored: every figure comes from journal lines.
 *
 * Balance sheet accounts are cumulative across fiscal years (there are no yearly opening
 * entries); income/expense accounts are per fiscal year.
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { schema, type Tx } from "../db";
import { centsFromDb, type Cents } from "@/domain/money";
import type { LocalDate } from "@/domain/dates";

const l = schema.journalLines;
const e = schema.journalEntries;
const a = schema.ledgerAccounts;

export interface AccountBalance {
  accountId: string;
  code: string;
  name: string;
  type: (typeof schema.accountType.enumValues)[number];
  systemKey: string | null;
  balance: Cents;
}

/** Balances per account for a fiscal year (P&L: that year only; balance sheet: cumulative to year end). */
export async function accountBalances(
  tx: Tx,
  fy: { id: string; endDate: string },
): Promise<AccountBalance[]> {
  const rows = await tx
    .select({
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      systemKey: a.systemKey,
      balance: sql<string>`coalesce(sum(${l.amountCents}) filter (where
        (${a.type} in ('income','expense') and ${e.fiscalYearId} = ${fy.id})
        or (${a.type} not in ('income','expense') and ${e.entryDate} <= ${fy.endDate})
      ), 0)`,
    })
    .from(a)
    .leftJoin(l, eq(l.accountId, a.id))
    .leftJoin(e, eq(e.id, l.entryId))
    .groupBy(a.id)
    .orderBy(a.code);
  return rows.map((r) => ({ ...r, balance: centsFromDb(r.balance) }));
}

/** Balance per (income/expense account, pot) within a fiscal year — input for year closing. */
export async function resultBalancesByPot(tx: Tx, fiscalYearId: string) {
  const rows = await tx
    .select({
      accountId: l.accountId,
      potId: l.potId,
      amount: sql<string>`sum(${l.amountCents})`,
    })
    .from(l)
    .innerJoin(e, eq(e.id, l.entryId))
    .innerJoin(a, eq(a.id, l.accountId))
    .where(and(eq(e.fiscalYearId, fiscalYearId), inArray(a.type, ["income", "expense"])))
    .groupBy(l.accountId, l.potId);
  return rows.map((r) => ({ accountId: r.accountId, potId: r.potId as string, amount: centsFromDb(r.amount) }));
}

export interface PartyBalance {
  partyId: string;
  name: string;
  kind: "member" | "external";
  active: boolean;
  balance: Cents; // > 0 owes the association, < 0 credit
}

/** Balance of every person's account (member and external person accounts, plus payables). */
export async function partyBalances(tx: Tx, opts: { upTo?: LocalDate } = {}): Promise<PartyBalance[]> {
  const p = schema.parties;
  const rows = await tx
    .select({
      partyId: p.id,
      name: p.name,
      kind: p.kind,
      active: p.active,
      balance: sql<string>`coalesce(sum(${l.amountCents}) filter (where ${
        opts.upTo ? sql`${e.entryDate} <= ${opts.upTo}` : sql`true`
      }), 0)`,
    })
    .from(p)
    .leftJoin(l, eq(l.partyId, p.id))
    .leftJoin(e, eq(e.id, l.entryId))
    .groupBy(p.id)
    .orderBy(p.name);
  return rows.map((r) => ({ ...r, balance: centsFromDb(r.balance) }));
}

export async function partyBalance(tx: Tx, partyId: string): Promise<Cents> {
  const [row] = await tx
    .select({ balance: sql<string>`coalesce(sum(${l.amountCents}), 0)` })
    .from(l)
    .where(eq(l.partyId, partyId));
  return centsFromDb(row.balance);
}

/** Remaining amount "nog te verdelen" for an activity. */
export async function activityBalance(tx: Tx, activityId: string): Promise<Cents> {
  const [row] = await tx
    .select({ balance: sql<string>`coalesce(sum(${l.amountCents}), 0)` })
    .from(l)
    .innerJoin(a, eq(a.id, l.accountId))
    .where(and(eq(l.activityId, activityId), eq(a.systemKey, "TO_DISTRIBUTE")));
  return centsFromDb(row.balance);
}

export async function openActivityBalances(tx: Tx) {
  const act = schema.activities;
  const rows = await tx
    .select({
      activityId: act.id,
      name: act.name,
      heldOn: act.heldOn,
      status: act.status,
      balance: sql<string>`coalesce(sum(${l.amountCents}) filter (where ${a.systemKey} = 'TO_DISTRIBUTE'), 0)`,
    })
    .from(act)
    .leftJoin(l, eq(l.activityId, act.id))
    .leftJoin(a, eq(a.id, l.accountId))
    .where(eq(act.status, "open"))
    .groupBy(act.id)
    .orderBy(act.heldOn);
  return rows.map((r) => ({ ...r, balance: centsFromDb(r.balance) }));
}

/** Ledger balance of a bank/cash account (optionally up to a date). */
export async function bankLedgerBalance(tx: Tx, bankAccountId: string, upTo?: LocalDate): Promise<Cents> {
  const [bank] = await tx.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, bankAccountId));
  const [row] = await tx
    .select({ balance: sql<string>`coalesce(sum(${l.amountCents}), 0)` })
    .from(l)
    .innerJoin(e, eq(e.id, l.entryId))
    .where(and(eq(l.accountId, bank.ledgerAccountId), upTo ? lte(e.entryDate, upTo) : undefined));
  return centsFromDb(row.balance);
}

/** Bank transactions that still have a non-zero balance on 1099 ("nog toe te wijzen"). */
export async function unassignedTransactionIds(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ id: l.bankTransactionId })
    .from(l)
    .innerJoin(a, eq(a.id, l.accountId))
    .where(eq(a.systemKey, "BANK_SUSPENSE"))
    .groupBy(l.bankTransactionId)
    .having(sql`sum(${l.amountCents}) <> 0`);
  return rows.map((r) => r.id as string);
}

export async function unassignedCount(tx: Tx): Promise<number> {
  return (await unassignedTransactionIds(tx)).length;
}

/** Sum of all journal lines ever. Must always be 0 (activa = passiva). */
export async function trialBalanceTotal(tx: Tx): Promise<Cents> {
  const [row] = await tx.select({ total: sql<string>`coalesce(sum(${l.amountCents}), 0)` }).from(l);
  return centsFromDb(row.total);
}
