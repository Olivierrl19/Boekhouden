import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  assignTransaction,
  recordCashMutation,
  recordTransactions,
  unassignTransaction,
  unassignedAmount,
  type NormalizedBankTransaction,
} from "../src/server/services/bank";
import { postEntry } from "../src/server/ledger/post";
import {
  accountBalances,
  bankLedgerBalance,
  partyBalance,
  trialBalanceTotal,
  unassignedCount,
} from "../src/server/ledger/balances";
import { openingBalance } from "../src/domain/ledger/templates";
import { cents } from "../src/domain/money";
import { localDate } from "../src/domain/dates";
import {
  closeTestDb,
  fiscalYearById,
  IBAN_CHECKING,
  IBAN_JAN,
  IBAN_SAVINGS,
  seedBasic,
  SYSTEM,
  testDb,
  type Basic,
} from "./helpers";

const db = testDb();
let b: Basic;

function t(
  volgnr: number,
  date: string,
  amount: number,
  balanceAfter: number,
  extra: Partial<NormalizedBankTransaction> = {},
): NormalizedBankTransaction {
  return {
    accountIban: IBAN_CHECKING,
    externalId: String(volgnr),
    bookingDate: localDate(date),
    valueDate: localDate(date),
    amount: cents(amount),
    balanceAfter: cents(balanceAfter),
    counterpartyIban: null,
    counterpartyName: "Tegenpartij",
    description: `Transactie ${volgnr}`,
    ...extra,
  };
}

beforeEach(async () => {
  b = await seedBasic(db);
  // Opening balance: € 1.000,00 on the checking account on 1 August.
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

const record = (txs: NormalizedBankTransaction[], bankAccountId = b.checking.id) =>
  db.transaction((tx) => recordTransactions(tx, bankAccountId, txs, SYSTEM));

describe("recording bank transactions", () => {
  it("books each transaction on the bank and on 'to assign', so the bank balance always matches", async () => {
    const result = await record([t(1, "2026-09-01", 2500, 102500), t(2, "2026-09-02", -1000, 101500)]);
    expect(result.newIds).toHaveLength(2);
    expect(await bankLedgerBalance(db, b.checking.id)).toBe(101500);
    expect(await unassignedCount(db)).toBe(2);
    expect(await trialBalanceTotal(db)).toBe(0);
  });

  it("is idempotent: importing the same transactions again books nothing", async () => {
    await record([t(1, "2026-09-01", 2500, 102500)]);
    const again = await record([t(1, "2026-09-01", 2500, 102500), t(2, "2026-09-03", 500, 103000)]);
    expect(again.duplicates).toBe(1);
    expect(again.newIds).toHaveLength(1);
    expect(await bankLedgerBalance(db, b.checking.id)).toBe(103000);
  });

  it("refuses a transaction whose content differs from an earlier one with the same volgnr", async () => {
    await record([t(1, "2026-09-01", 2500, 102500)]);
    await expect(record([t(1, "2026-09-01", 2600, 102600)])).rejects.toThrow(/wijkt af/);
  });

  it("refuses an import that leaves a gap in the balance chain", async () => {
    await expect(record([t(5, "2026-09-10", 1000, 150000)])).rejects.toThrow(/ontbreken transacties/);
    expect(await bankLedgerBalance(db, b.checking.id)).toBe(100000);
  });

  it("refuses transactions of another account", async () => {
    await expect(record([t(1, "2026-09-01", 2500, 102500, { accountIban: IBAN_SAVINGS })])).rejects.toThrow(/hoort niet bij/);
  });

  it("auto-assigns internal transfers, and 1090 is zero once both sides are in", async () => {
    await record([t(1, "2026-09-05", -50000, 50000, { counterpartyIban: IBAN_SAVINGS })]);
    expect(await unassignedCount(db)).toBe(0);
    await record(
      [
        {
          ...t(1, "2026-09-05", 50000, 50000, { counterpartyIban: IBAN_CHECKING }),
          accountIban: IBAN_SAVINGS,
        },
      ],
      b.savings.id,
    );
    expect(await unassignedCount(db)).toBe(0);
    const balances = await accountBalances(db, await fiscalYearById(db, b.fy.id));
    expect(balances.find((a) => a.code === "1090")!.balance).toBe(0);
    expect(balances.find((a) => a.code === "1010")!.balance).toBe(50000);
    expect(balances.find((a) => a.code === "1000")!.balance).toBe(50000);
  });
});

describe("assigning (waar geboekt)", () => {
  it("a payment from a member lowers their balance and clears 'to assign'", async () => {
    const { newIds } = await record([t(1, "2026-09-01", 3000, 103000, { counterpartyIban: IBAN_JAN })]);
    await db.transaction((tx) =>
      assignTransaction(tx, newIds[0], [{ kind: "person", partyId: b.jan.id, partyKind: "member", amount: cents(3000) }], SYSTEM),
    );
    expect(await partyBalance(db, b.jan.id)).toBe(-3000); // credit ("tegoed")
    expect(await unassignedCount(db)).toBe(0);
    await expect(
      db.transaction((tx) =>
        assignTransaction(tx, newIds[0], [{ kind: "person", partyId: b.jan.id, partyKind: "member", amount: cents(3000) }], SYSTEM),
      ),
    ).rejects.toThrow(/al toegewezen/);
  });

  it("undoing an assignment puts the transaction back in the list", async () => {
    const { newIds } = await record([t(1, "2026-09-01", -1250, 98750)]);
    await db.transaction((tx) =>
      assignTransaction(
        tx,
        newIds[0],
        [{ kind: "pot", potId: b.pot("BANK").id, accountId: b.account("4500").id, amount: cents(-1250) }],
        SYSTEM,
      ),
    );
    expect(await unassignedCount(db)).toBe(0);
    await db.transaction((tx) => unassignTransaction(tx, newIds[0], "Verkeerd potje", SYSTEM));
    expect(await unassignedCount(db)).toBe(1);
    expect(await unassignedAmount(db, newIds[0])).toBe(-1250);
    // and it can be assigned again
    await db.transaction((tx) =>
      assignTransaction(
        tx,
        newIds[0],
        [{ kind: "pot", potId: b.pot("BESTUUR").id, accountId: b.account("4400").id, amount: cents(-1250) }],
        SYSTEM,
      ),
    );
    expect(await unassignedCount(db)).toBe(0);
    expect(await trialBalanceTotal(db)).toBe(0);
  });

  it("split assignment must add up to the transaction", async () => {
    const { newIds } = await record([t(1, "2026-09-01", -10000, 90000)]);
    await expect(
      db.transaction((tx) =>
        assignTransaction(tx, newIds[0], [{ kind: "internal", amount: cents(-9000) }], SYSTEM),
      ),
    ).rejects.toThrow(/niet gelijk/);
  });

  it("an imported bank transaction itself can never be reversed", async () => {
    await record([t(1, "2026-09-01", 2500, 102500)]);
    const [{ id }] = await db.query.journalEntries.findMany({ where: (e, { eq }) => eq(e.template, "T00") });
    const { reverseEntry } = await import("../src/server/ledger/post");
    await expect(db.transaction((tx) => reverseEntry(tx, id, { reason: "x" }, SYSTEM))).rejects.toThrow(/niet worden tegengeboekt/);
  });
});

describe("cash book", () => {
  it("records cash mutations that are assigned like bank lines", async () => {
    const id = await db.transaction((tx) =>
      recordCashMutation(tx, { bankAccountId: b.cash.id, date: localDate("2026-09-12"), amount: cents(4000), description: "Contant van Jan" }, SYSTEM),
    );
    expect(await bankLedgerBalance(db, b.cash.id)).toBe(4000);
    await db.transaction((tx) =>
      assignTransaction(tx, id, [{ kind: "person", partyId: b.jan.id, partyKind: "member", amount: cents(4000) }], SYSTEM),
    );
    expect(await partyBalance(db, b.jan.id)).toBe(-4000);
  });
});
