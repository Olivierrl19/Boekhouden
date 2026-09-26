/** Read models for the overview pages. Pure reads; no writes here. */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "../db";
import {
  accountBalances,
  bankLedgerBalance,
  openActivityBalances,
  partyBalances,
  unassignedTransactionIds,
} from "../ledger/balances";
import { centsFromDb, sum } from "@/domain/money";

export async function dashboardData(fy: typeof schema.fiscalYears.$inferSelect) {
  const db = getDb();
  const unassigned = await unassignedTransactionIds(db);
  const banks = await db.select().from(schema.bankAccounts).orderBy(asc(schema.bankAccounts.name));
  const bankBalances = await Promise.all(
    banks.map(async (b) => {
      const [last] = await db
        .select({ date: schema.bankTransactions.bookingDate })
        .from(schema.bankTransactions)
        .where(eq(schema.bankTransactions.bankAccountId, b.id))
        .orderBy(desc(schema.bankTransactions.bookingDate))
        .limit(1);
      return { ...b, balance: await bankLedgerBalance(db, b.id), lastDate: last?.date ?? null };
    }),
  );
  const persons = await partyBalances(db);
  const activities = await openActivityBalances(db);
  const balances = await accountBalances(db, fy);
  const result = -sum(balances.filter((a) => a.type === "income" || a.type === "expense").map((a) => a.balance));
  return {
    unassignedCount: unassigned.length,
    bankBalances,
    receivable: sum(persons.filter((p) => p.balance > 0).map((p) => p.balance)),
    credit: sum(persons.filter((p) => p.balance < 0).map((p) => p.balance)),
    toDistribute: sum(activities.map((a) => a.balance)),
    openActivities: activities.length,
    result,
  };
}

export async function debtorList() {
  const db = getDb();
  const persons = await partyBalances(db);
  const activities = await openActivityBalances(db);
  return { persons, activities };
}

export async function memberList() {
  const db = getDb();
  const rows = await db
    .select({
      partyId: schema.parties.id,
      name: schema.parties.name,
      email: schema.parties.email,
      cohort: schema.members.cohort,
      joinedOn: schema.members.joinedOn,
      leftOn: schema.members.leftOn,
      typeName: schema.memberTypes.name,
      monthly: schema.memberTypes.monthlyContributionCents,
    })
    .from(schema.members)
    .innerJoin(schema.parties, eq(schema.parties.id, schema.members.partyId))
    .innerJoin(schema.memberTypes, eq(schema.memberTypes.id, schema.members.memberTypeId))
    .orderBy(desc(schema.members.cohort), asc(schema.parties.name));
  const balances = new Map((await partyBalances(db)).map((p) => [p.partyId, p.balance]));
  return rows.map((r) => ({ ...r, balance: balances.get(r.partyId) ?? centsFromDb(0) }));
}

/** All journal lines touching one person, oldest first, with running balance. */
export async function personStatement(partyId: string) {
  const db = getDb();
  const [party] = await db.select().from(schema.parties).where(eq(schema.parties.id, partyId));
  if (!party) return null;
  const lines = await db
    .select({
      entryId: schema.journalEntries.id,
      date: schema.journalEntries.entryDate,
      entryNumber: schema.journalEntries.entryNumber,
      template: schema.journalEntries.template,
      description: schema.journalEntries.description,
      lineDescription: schema.journalLines.description,
      amount: schema.journalLines.amountCents,
      activityName: schema.activities.name,
    })
    .from(schema.journalLines)
    .innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
    .leftJoin(schema.activities, eq(schema.activities.id, schema.journalLines.activityId))
    .where(eq(schema.journalLines.partyId, partyId))
    .orderBy(asc(schema.journalEntries.entryDate), asc(schema.journalEntries.entryNumber));
  let running = 0;
  const withBalance = lines.map((l) => {
    running += l.amount;
    return { ...l, amount: centsFromDb(l.amount), balance: centsFromDb(running) };
  });
  return { party, lines: withBalance, balance: centsFromDb(running) };
}

export async function journalPage(fiscalYearId: string, opts: { limit: number; offset: number; template?: string }) {
  const db = getDb();
  const where = and(
    eq(schema.journalEntries.fiscalYearId, fiscalYearId),
    opts.template ? eq(schema.journalEntries.template, opts.template) : undefined,
  );
  const entries = await db
    .select()
    .from(schema.journalEntries)
    .where(where)
    .orderBy(desc(schema.journalEntries.entryNumber))
    .limit(opts.limit)
    .offset(opts.offset);
  const [{ total }] = await db.select({ total: sql<string>`count(*)` }).from(schema.journalEntries).where(where);
  const ids = entries.map((e) => e.id);
  const lines = ids.length
    ? await db
        .select({
          entryId: schema.journalLines.entryId,
          lineNo: schema.journalLines.lineNo,
          amount: schema.journalLines.amountCents,
          accountCode: schema.ledgerAccounts.code,
          accountName: schema.ledgerAccounts.name,
          potName: schema.pots.name,
          partyName: schema.parties.name,
          activityName: schema.activities.name,
          description: schema.journalLines.description,
        })
        .from(schema.journalLines)
        .innerJoin(schema.ledgerAccounts, eq(schema.ledgerAccounts.id, schema.journalLines.accountId))
        .leftJoin(schema.pots, eq(schema.pots.id, schema.journalLines.potId))
        .leftJoin(schema.parties, eq(schema.parties.id, schema.journalLines.partyId))
        .leftJoin(schema.activities, eq(schema.activities.id, schema.journalLines.activityId))
        .where(inArray(schema.journalLines.entryId, ids))
        .orderBy(asc(schema.journalLines.lineNo))
    : [];
  return {
    total: Number(total),
    entries: entries.map((e) => ({
      ...e,
      lines: lines.filter((l) => l.entryId === e.id).map((l) => ({ ...l, amount: centsFromDb(l.amount) })),
    })),
  };
}

export async function chartWithBalances(fy: typeof schema.fiscalYears.$inferSelect) {
  const db = getDb();
  const balances = await accountBalances(db, fy);
  const pots = await db.select().from(schema.pots).orderBy(asc(schema.pots.name));
  return { balances, pots };
}

export async function fiscalYears() {
  return getDb().select().from(schema.fiscalYears).orderBy(desc(schema.fiscalYears.startDate));
}

export async function orgName() {
  const [s] = await getDb().select({ name: schema.orgSettings.name }).from(schema.orgSettings);
  return s?.name ?? "Boekhouding";
}
