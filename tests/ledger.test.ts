import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "../src/server/db";
import { postEntry, reverseEntry } from "../src/server/ledger/post";
import {
  accountBalances,
  bankLedgerBalance,
  partyBalance,
  trialBalanceTotal,
  unassignedCount,
} from "../src/server/ledger/balances";
import { memorial, openingBalance } from "../src/domain/ledger/templates";
import { cents } from "../src/domain/money";
import { localDate } from "../src/domain/dates";
import { unwrapDbErrors } from "../src/server/errors";
import { closeTestDb, fiscalYearById, seedBasic, SYSTEM, testDb, type Basic } from "./helpers";

const db = testDb();
let b: Basic;
const dbErr = <T,>(p: Promise<T>) => unwrapDbErrors(() => p);

beforeEach(async () => {
  b = await seedBasic(db);
});
afterAll(closeTestDb);

async function postMemorial(amount = 1000, date = "2026-09-10") {
  return db.transaction((tx) =>
    postEntry(
      tx,
      memorial({
        date: localDate(date),
        description: "Test",
        reason: "Test",
        lines: [
          { account: { id: b.account("0510").id }, amount: cents(amount) },
          { account: { key: "GENERAL_RESERVE" }, amount: cents(-amount) },
        ],
      }),
      SYSTEM,
    ),
  );
}

describe("postEntry", () => {
  it("numbers entries gapless per fiscal year and writes the audit log", async () => {
    const first = await postMemorial();
    const second = await postMemorial();
    expect(first.entryNumber).toBe("2026-2027-000001");
    expect(second.entryNumber).toBe("2026-2027-000002");
    const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "journal.post"));
    expect(log).toHaveLength(2);
    const [{ broken }] = await db.execute<{ broken: string | null }>(sql`select audit_log_verify() as broken`);
    expect(broken).toBeNull();
  });

  it("rolls back numbering when the entry fails", async () => {
    await expect(
      db.transaction((tx) =>
        postEntry(
          tx,
          memorial({
            date: localDate("2026-09-10"),
            description: "Op bank",
            reason: "x",
            lines: [
              { account: { id: b.checking.ledgerAccountId }, amount: cents(100) },
              { account: { key: "GENERAL_RESERVE" }, amount: cents(-100) },
            ],
          }),
          SYSTEM,
        ),
      ),
    ).rejects.toThrow(/handmatig/);
    const ok = await postMemorial();
    expect(ok.entryNumber).toBe("2026-2027-000001");
  });

  it("refuses dates without a fiscal year", async () => {
    await expect(postMemorial(100, "2030-01-01")).rejects.toThrow(/geen boekjaar/);
  });
});

describe("database invariants (bypassing the application)", () => {
  it("journal lines and entries cannot be updated or deleted", async () => {
    await postMemorial();
    await expect(unwrapDbErrors(() => db.execute(sql`update journal_lines set amount_cents = 5`))).rejects.toThrow(/onveranderlijk/);
    await expect(unwrapDbErrors(() => db.execute(sql`delete from journal_lines`))).rejects.toThrow(/onveranderlijk/);
    await expect(unwrapDbErrors(() => db.execute(sql`update journal_entries set description = 'x'`))).rejects.toThrow(/onveranderlijk/);
    await expect(unwrapDbErrors(() => db.execute(sql`delete from audit_log`))).rejects.toThrow(/onveranderlijk/);
  });

  it("an unbalanced entry is rejected at commit", async () => {
    const reserve = b.account("0510").id;
    await expect(
      db.transaction(async (tx) => {
        const [e] = await tx
          .insert(schema.journalEntries)
          .values({ fiscalYearId: b.fy.id, entryNumber: "X-1", entryDate: "2026-09-10", template: "T29", description: "x", reason: "x" })
          .returning();
        await tx.insert(schema.journalLines).values([
          { entryId: e.id, lineNo: 1, accountId: reserve, amountCents: 100 },
          { entryId: e.id, lineNo: 2, accountId: b.account("0500").id, amountCents: -99 },
        ]);
      }),
    ).rejects.toThrow(/sluit niet/);
  });

  it("an entry with a single line is rejected at commit", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx
          .insert(schema.journalEntries)
          .values({ fiscalYearId: b.fy.id, entryNumber: "X-1", entryDate: "2026-09-10", template: "T29", description: "x", reason: "x" });
      }),
    ).rejects.toThrow(/minder dan twee/);
  });

  it("income lines need a pot and person accounts need the right kind of party", async () => {
    const insert = (lines: { accountId: string; amountCents: number; partyId?: string; potId?: string }[]) =>
      dbErr(db.transaction(async (tx) => {
        const [e] = await tx
          .insert(schema.journalEntries)
          .values({ fiscalYearId: b.fy.id, entryNumber: `X-${Math.random()}`, entryDate: "2026-09-10", template: "T12", description: "x" })
          .returning();
        await tx.insert(schema.journalLines).values(lines.map((l, i) => ({ entryId: e.id, lineNo: i + 1, ...l })));
      }));
    await expect(
      insert([
        { accountId: b.account("1300").id, amountCents: 100, partyId: b.jan.id },
        { accountId: b.account("8900").id, amountCents: -100 },
      ]),
    ).rejects.toThrow(/potje/);
    await expect(
      insert([
        { accountId: b.account("1300").id, amountCents: 100, partyId: b.dispuutX.id },
        { accountId: b.account("8900").id, amountCents: -100, potId: b.pot("ALGEMEEN").id },
      ]),
    ).rejects.toThrow(/member/);
    await expect(
      insert([
        { accountId: b.account("1300").id, amountCents: 100 },
        { accountId: b.account("8900").id, amountCents: -100, potId: b.pot("ALGEMEEN").id },
      ]),
    ).rejects.toThrow(/persoon/);
  });

  it("bank accounts cannot be booked without their bank transaction", async () => {
    await expect(
      dbErr(db.transaction(async (tx) => {
        const [e] = await tx
          .insert(schema.journalEntries)
          .values({ fiscalYearId: b.fy.id, entryNumber: "X-1", entryDate: "2026-09-10", template: "T12", description: "x" })
          .returning();
        await tx.insert(schema.journalLines).values([
          { entryId: e.id, lineNo: 1, accountId: b.checking.ledgerAccountId, amountCents: 100 },
          { entryId: e.id, lineNo: 2, accountId: b.account("0500").id, amountCents: -100 },
        ]);
      })),
    ).rejects.toThrow(/banktransactie/);
  });

  it("closed fiscal years accept no entries", async () => {
    await db.update(schema.fiscalYears).set({ status: "closed" }).where(eq(schema.fiscalYears.id, b.fy.id));
    await expect(postMemorial()).rejects.toThrow(/afgesloten/);
    await expect(
      dbErr(db.execute(
        sql`insert into journal_entries (fiscal_year_id, entry_number, entry_date, template, description, reason)
            values (${b.fy.id}, 'X', '2026-09-10', 'T29', 'x', 'x')`,
      )),
    ).rejects.toThrow(/afgesloten/);
  });

  it("entries must be dated inside their fiscal year", async () => {
    await expect(
      dbErr(db.execute(
        sql`insert into journal_entries (fiscal_year_id, entry_number, entry_date, template, description, reason)
            values (${b.fy.id}, 'X', '2027-08-01', 'T29', 'x', 'x')`,
      )),
    ).rejects.toThrow(/buiten boekjaar/);
  });

  it("fiscal years cannot overlap", async () => {
    await expect(
      db.insert(schema.fiscalYears).values({ label: "overlap", startDate: "2027-01-01", endDate: "2027-12-31" }),
    ).rejects.toThrow();
  });
});

describe("reversals", () => {
  it("mirror the original, can happen only once, and cannot themselves be reversed", async () => {
    const original = await postMemorial(2500);
    const reversal = await db.transaction((tx) => reverseEntry(tx, original.id, { reason: "Vergissing" }, SYSTEM));
    expect(await trialBalanceTotal(db)).toBe(0);
    const balances = await accountBalances(db, await fiscalYearById(db, b.fy.id));
    expect(balances.find((a) => a.code === "0510")!.balance).toBe(0);
    await expect(db.transaction((tx) => reverseEntry(tx, original.id, { reason: "x" }, SYSTEM))).rejects.toThrow(/al tegengeboekt/);
    await expect(db.transaction((tx) => reverseEntry(tx, reversal.id, { reason: "x" }, SYSTEM))).rejects.toThrow(/tegenboeking/);
  });

  it("require a reason", async () => {
    const original = await postMemorial();
    await expect(db.transaction((tx) => reverseEntry(tx, original.id, { reason: " " }, SYSTEM))).rejects.toThrow(/Reden/);
  });
});

describe("opening balance (T26)", () => {
  it("sets bank and person balances, with the difference in the general reserve", async () => {
    await db.transaction(async (tx) => {
      const draft = openingBalance({
        date: localDate("2026-08-01"),
        bank: [{ ledgerAccountId: b.checking.ledgerAccountId, amount: cents(150000) }],
        persons: [{ partyId: b.jan.id, partyKind: "member", amount: cents(2500) }],
        activities: [],
        other: [],
      })!;
      await postEntry(tx, draft, SYSTEM);
    });
    expect(await bankLedgerBalance(db, b.checking.id)).toBe(150000);
    expect(await partyBalance(db, b.jan.id)).toBe(2500);
    const balances = await accountBalances(db, await fiscalYearById(db, b.fy.id));
    expect(balances.find((a) => a.code === "0500")!.balance).toBe(-152500);
    expect(await unassignedCount(db)).toBe(0);
  });
});
