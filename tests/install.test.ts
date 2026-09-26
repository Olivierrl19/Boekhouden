import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "../src/server/db";
import { installAssociation, isSetupCompleted, markSetupCompleted, wipeDemo } from "../src/server/services/install";
import { bankLedgerBalance, trialBalanceTotal } from "../src/server/ledger/balances";
import { cents } from "../src/domain/money";
import { localDate } from "../src/domain/dates";
import { closeTestDb, IBAN_CHECKING, IBAN_SAVINGS, resetDb, SYSTEM, testDb } from "./helpers";

const db = testDb();
beforeEach(() => resetDb(db));
afterAll(closeTestDb);

const input = {
  name: "Dispuut Nieuw",
  shortName: "Nieuw",
  fiscalYearStartMonth: 8,
  startDate: localDate("2026-08-01"),
  fiscus: { firstName: "Fien", lastName: "Fiscus", email: "Fien@Example.nl" },
  memberType: { name: "Lid", monthlyContribution: cents(1500) },
  checking: { iban: IBAN_CHECKING, openingBalance: cents(123456) },
  savings: { iban: IBAN_SAVINGS, openingBalance: cents(500000) },
  cashOpeningBalance: cents(2000),
};

describe("setup wizard installation", () => {
  it("creates the association, fiscus with role, fiscal year and opening balances", async () => {
    expect(await isSetupCompleted(db)).toBe(false);
    const { fiscusUserId, fiscalYear } = await db.transaction((tx) => installAssociation(tx, input, SYSTEM));
    expect(await isSetupCompleted(db)).toBe(true);
    expect(fiscalYear.label).toBe("2026-2027");

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, fiscusUserId));
    expect(user.email).toBe("fien@example.nl");
    const roles = await db.select().from(schema.roleAssignments).where(eq(schema.roleAssignments.userId, fiscusUserId));
    expect(roles.map((r) => r.role)).toEqual(["fiscus"]);

    const banks = await db.select().from(schema.bankAccounts);
    expect(await bankLedgerBalance(db, banks.find((b) => b.kind === "checking")!.id)).toBe(123456);
    expect(await bankLedgerBalance(db, banks.find((b) => b.kind === "savings")!.id)).toBe(500000);
    expect(await bankLedgerBalance(db, banks.find((b) => b.kind === "cash")!.id)).toBe(2000);
    expect(await trialBalanceTotal(db)).toBe(0);
  });

  it("works without savings account and with zero balances", async () => {
    await db.transaction((tx) =>
      installAssociation(tx, { ...input, savings: null, checking: { iban: IBAN_CHECKING, openingBalance: cents(0) }, cashOpeningBalance: cents(0) }, SYSTEM),
    );
    expect(await db.select().from(schema.journalEntries)).toHaveLength(0);
    expect(await db.select().from(schema.bankAccounts)).toHaveLength(2);
  });

  it("rejects invalid IBANs and rolls back completely", async () => {
    await expect(
      db.transaction((tx) => installAssociation(tx, { ...input, checking: { iban: "NL00RABO0000000000", openingBalance: cents(0) } }, SYSTEM)),
    ).rejects.toThrow(/IBAN/);
    expect(await isSetupCompleted(db)).toBe(false);
    expect(await db.select().from(schema.ledgerAccounts)).toHaveLength(0);
  });

  it("can only be installed once", async () => {
    await db.transaction((tx) => installAssociation(tx, input, SYSTEM));
    await expect(db.transaction((tx) => installAssociation(tx, input, SYSTEM))).rejects.toThrow(/al ingericht/);
  });
});

describe("wiping", () => {
  it("refuses to wipe real books", async () => {
    await db.transaction((tx) => installAssociation(tx, input, SYSTEM));
    await expect(db.transaction((tx) => wipeDemo(tx))).rejects.toThrow(/voorbeelddispuut/);
    expect(await isSetupCompleted(db)).toBe(true);
  });

  it("wipes a demo association completely", async () => {
    await db.transaction(async (tx) => {
      await installAssociation(tx, input, SYSTEM);
      await markSetupCompleted(tx, { isDemo: true });
    });
    await db.transaction((tx) => wipeDemo(tx));
    expect(await isSetupCompleted(db)).toBe(false);
    expect(await db.select().from(schema.journalEntries)).toHaveLength(0);
  });
});
