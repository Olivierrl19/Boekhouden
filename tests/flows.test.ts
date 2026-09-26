import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "../src/server/db";
import { postEntry } from "../src/server/ledger/post";
import { assignTransaction, recordTransactions } from "../src/server/services/bank";
import { chargePerson, createActivity, previewSettlement, reopenActivity, settleActivity } from "../src/server/services/activities";
import { chargeContributionsForMonth } from "../src/server/services/contributions";
import { closeFiscalYear, reopenFiscalYear } from "../src/server/services/fiscal-years";
import { ensureFiscalYear } from "../src/server/services/setup";
import {
  accountBalances,
  activityBalance,
  partyBalance,
  resultBalancesByPot,
  trialBalanceTotal,
} from "../src/server/ledger/balances";
import { expenseClaimApproved, openingBalance } from "../src/domain/ledger/templates";
import { cents } from "../src/domain/money";
import { localDate } from "../src/domain/dates";
import { unwrapDbErrors } from "../src/server/errors";
import { closeTestDb, fiscalYearById, IBAN_CHECKING, seedBasic, SYSTEM, testDb, type Basic } from "./helpers";

const db = testDb();
let b: Basic;

beforeEach(async () => {
  b = await seedBasic(db);
  await db.transaction((tx) =>
    postEntry(
      tx,
      openingBalance({
        date: localDate("2026-08-01"),
        bank: [{ ledgerAccountId: b.checking.ledgerAccountId, amount: cents(100000) }],
        persons: [],
        activities: [],
        other: [],
      })!,
      SYSTEM,
    ),
  );
});
afterAll(closeTestDb);

describe("monthly contribution", () => {
  it("charges members active on the 1st, at their type's rate, once", async () => {
    const first = await db.transaction((tx) => chargeContributionsForMonth(tx, localDate("2026-09-01"), SYSTEM));
    expect(first.charged).toBe(2); // Klaas joins on 15 September
    const again = await db.transaction((tx) => chargeContributionsForMonth(tx, localDate("2026-09-20"), SYSTEM));
    expect(again.charged).toBe(0);
    expect(await partyBalance(db, b.jan.id)).toBe(1500);
    expect(await partyBalance(db, b.klaas.id)).toBe(0);
    const october = await db.transaction((tx) => chargeContributionsForMonth(tx, localDate("2026-10-01"), SYSTEM));
    expect(october.charged).toBe(3);
    expect(await partyBalance(db, b.klaas.id)).toBe(1000);
  });

  it("is protected by a unique constraint as well", async () => {
    await db.transaction((tx) => chargeContributionsForMonth(tx, localDate("2026-09-01"), SYSTEM));
    await expect(
      db.insert(schema.contributionCharges).values({ memberId: b.jan.id, month: "2026-09-01", amountCents: 1500 }),
    ).rejects.toThrow();
  });
});

describe("activity: buy beer kegs now, split later", () => {
  it("keeps costs on 'nog te verdelen' until the settlement puts them on everyone's account", async () => {
    const feest = await db.transaction((tx) =>
      createActivity(tx, { name: "Openingsfeest", heldOn: localDate("2026-11-14"), potId: b.pot("ACTIVITEITEN").id, date: localDate("2026-09-01") }, SYSTEM),
    );
    // Kegs paid from the bank in September.
    const { newIds } = await db.transaction((tx) =>
      recordTransactions(
        tx,
        b.checking.id,
        [
          {
            accountIban: IBAN_CHECKING,
            externalId: "1",
            bookingDate: localDate("2026-09-10"),
            valueDate: null,
            amount: cents(-30000),
            balanceAfter: cents(70000),
            counterpartyIban: null,
            counterpartyName: "Drankenhandel",
            description: "4 fusten",
          },
        ],
        SYSTEM,
      ),
    );
    await db.transaction((tx) =>
      assignTransaction(tx, newIds[0], [{ kind: "activity", activityId: feest.id, amount: cents(-30000) }], SYSTEM),
    );
    // Jan declares € 45,00 for decorations.
    await db.transaction((tx) =>
      postEntry(
        tx,
        expenseClaimApproved({
          claimId: "c1",
          partyId: b.jan.id,
          date: localDate("2026-11-15"),
          amount: cents(4500),
          target: { kind: "activity", activityId: feest.id },
          description: "Versiering",
        }),
        SYSTEM,
      ),
    );
    expect(await activityBalance(db, feest.id)).toBe(34500);

    const shares = [
      { partyId: b.jan.id, partyKind: "member" as const, method: "equal" as const },
      { partyId: b.piet.id, partyKind: "member" as const, method: "equal" as const },
      { partyId: b.dispuutX.id, partyKind: "external" as const, method: "fixed" as const, fixedAmount: cents(12000) },
      { partyId: null, method: "fixed" as const, fixedAmount: cents(2500) },
    ];
    const preview = await previewSettlement(db, feest.id, shares);
    expect(preview.allocations.map((a) => a.amount)).toEqual([10000, 10000, 12000, 2500]);

    await db.transaction((tx) =>
      settleActivity(tx, { activityId: feest.id, date: localDate("2026-11-20"), shares, expectedBalance: preview.balance }, SYSTEM),
    );
    expect(await activityBalance(db, feest.id)).toBe(0);
    expect(await partyBalance(db, b.jan.id)).toBe(10000 - 4500);
    expect(await partyBalance(db, b.piet.id)).toBe(10000);
    expect(await partyBalance(db, b.dispuutX.id)).toBe(12000);
    const pnl = await resultBalancesByPot(db, b.fy.id);
    expect(pnl.find((r) => r.potId === b.pot("ACTIVITEITEN").id)!.amount).toBe(2500);

    // Settled: nothing more can be booked on it (checked by the database).
    await expect(
      unwrapDbErrors(() =>
        db.transaction((tx) =>
          chargePerson(
            tx,
            {
              partyId: b.piet.id,
              partyKind: "member",
              date: localDate("2026-11-21"),
              amount: cents(100),
              target: { kind: "activity", activityId: feest.id },
              description: "Te laat",
            },
            SYSTEM,
          ),
        ),
      ),
    ).rejects.toThrow(/afgerekend/);

    // Reopen: the settlement is reversed and everything is back on 'nog te verdelen'.
    await db.transaction((tx) => reopenActivity(tx, feest.id, "Dispuut X betaalt minder", SYSTEM));
    expect(await activityBalance(db, feest.id)).toBe(34500);
    expect(await partyBalance(db, b.piet.id)).toBe(0);
    expect(await trialBalanceTotal(db)).toBe(0);
  });

  it("refuses to settle when the balance changed after the preview", async () => {
    const act = await db.transaction((tx) =>
      createActivity(tx, { name: "Borrel", heldOn: localDate("2026-09-20"), potId: b.pot("BORRELS").id, date: localDate("2026-09-20") }, SYSTEM),
    );
    await db.transaction((tx) =>
      chargePerson(
        tx,
        { partyId: b.jan.id, partyKind: "member", date: localDate("2026-09-20"), amount: cents(-2000), target: { kind: "activity", activityId: act.id }, description: "Jan kocht chips" },
        SYSTEM,
      ),
    );
    await expect(
      db.transaction((tx) =>
        settleActivity(
          tx,
          { activityId: act.id, date: localDate("2026-09-21"), shares: [{ partyId: b.piet.id, partyKind: "member", method: "equal" }], expectedBalance: cents(1) },
          SYSTEM,
        ),
      ),
    ).rejects.toThrow(/gewijzigd/);
  });

  it("the database refuses to mark an activity settled while money is left to distribute", async () => {
    const act = await db.transaction((tx) =>
      createActivity(tx, { name: "Borrel", heldOn: null, potId: b.pot("BORRELS").id, date: localDate("2026-09-20") }, SYSTEM),
    );
    await db.transaction((tx) =>
      chargePerson(
        tx,
        { partyId: b.jan.id, partyKind: "member", date: localDate("2026-09-20"), amount: cents(-2000), target: { kind: "activity", activityId: act.id }, description: "Chips" },
        SYSTEM,
      ),
    );
    await expect(
      unwrapDbErrors(() => db.update(schema.activities).set({ status: "settled" }).where(eq(schema.activities.id, act.id))),
    ).rejects.toThrow(/nog 2000 cent te verdelen/);
  });
});

describe("closing a fiscal year", () => {
  it("moves the result to the reserves, zeroes P&L and locks the year; reopening reverses it", async () => {
    await db.transaction((tx) => chargeContributionsForMonth(tx, localDate("2026-09-01"), SYSTEM));
    const fy = await fiscalYearById(db, b.fy.id);
    await db.transaction((tx) =>
      closeFiscalYear(
        tx,
        {
          fiscalYearId: fy.id,
          appropriation: [
            { accountId: b.account("0500").id, amount: cents(2000) },
            { accountId: b.account("0510").id, amount: cents(1000) },
          ],
        },
        SYSTEM,
      ),
    );
    const closed = await fiscalYearById(db, fy.id);
    expect(closed.status).toBe("closed");
    const balances = await accountBalances(db, closed);
    for (const a of balances.filter((x) => x.type === "income" || x.type === "expense")) expect(a.balance).toBe(0);
    expect(balances.find((a) => a.code === "0590")!.balance).toBe(0);
    expect(balances.find((a) => a.code === "0510")!.balance).toBe(-1000);
    await expect(db.transaction((tx) => chargeContributionsForMonth(tx, localDate("2026-10-01"), SYSTEM))).rejects.toThrow(/afgesloten/);

    // Balance sheet accounts carry over into the next year without opening entries.
    const next = await db.transaction((tx) => ensureFiscalYear(tx, localDate("2027-08-01"), SYSTEM));
    const nextBalances = await accountBalances(db, next);
    expect(nextBalances.find((a) => a.code === "1000")!.balance).toBe(100000);
    expect(nextBalances.find((a) => a.code === "1300")!.balance).toBe(3000);

    await db.transaction((tx) => reopenFiscalYear(tx, fy.id, "Correctie kascommissie", SYSTEM));
    const reopened = await fiscalYearById(db, fy.id);
    expect(reopened.status).toBe("open");
    const after = await accountBalances(db, reopened);
    expect(after.find((a) => a.code === "8000")!.balance).toBe(-3000);
    expect(after.find((a) => a.code === "0510")!.balance).toBe(0);
    expect(await trialBalanceTotal(db)).toBe(0);
  });

  it("refuses an appropriation that does not match the result", async () => {
    await db.transaction((tx) => chargeContributionsForMonth(tx, localDate("2026-09-01"), SYSTEM));
    await expect(
      db.transaction((tx) =>
        closeFiscalYear(tx, { fiscalYearId: b.fy.id, appropriation: [{ accountId: b.account("0500").id, amount: cents(1) }] }, SYSTEM),
      ),
    ).rejects.toThrow(/niet gelijk/);
    expect((await fiscalYearById(db, b.fy.id)).status).toBe("open");
  });

  it("refuses while bank transactions are unassigned", async () => {
    await db.transaction((tx) =>
      recordTransactions(
        tx,
        b.checking.id,
        [
          {
            accountIban: IBAN_CHECKING,
            externalId: "1",
            bookingDate: localDate("2026-09-10"),
            valueDate: null,
            amount: cents(500),
            balanceAfter: cents(100500),
            counterpartyIban: null,
            counterpartyName: null,
            description: "?",
          },
        ],
        SYSTEM,
      ),
    );
    await expect(
      db.transaction((tx) => closeFiscalYear(tx, { fiscalYearId: b.fy.id, appropriation: [] }, SYSTEM)),
    ).rejects.toThrow(/toegewezen/);
  });

  it("keeps the audit log chain intact through all of this", async () => {
    await db.transaction((tx) => chargeContributionsForMonth(tx, localDate("2026-09-01"), SYSTEM));
    const [{ broken }] = await db.execute<{ broken: string | null }>(sql`select audit_log_verify() as broken`);
    expect(broken).toBeNull();
  });
});
