/**
 * Property-based test (PLAN.md §11): after ANY random sequence of events the books hold:
 *  - the sum of all journal lines is 0 (activa = passiva)
 *  - the ledger bank balance equals the last "saldo na transactie"
 *  - "nog toe te wijzen" equals the number of transactions the model left unassigned
 *  - the person accounts (1300/1310) equal the sum of the individual person balances
 *  - settled activities have nothing left to distribute
 *  - after closing the year all income/expense accounts are 0
 *  - the audit log hash chain is intact
 */
import { afterAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { sql } from "drizzle-orm";
import { postEntry, reverseEntry } from "../src/server/ledger/post";
import {
  accountBalances,
  activityBalance,
  bankLedgerBalance,
  partyBalances,
  resultBalancesByPot,
  trialBalanceTotal,
  unassignedCount,
} from "../src/server/ledger/balances";
import { assignTransaction, recordTransactions, unassignTransaction } from "../src/server/services/bank";
import { chargePerson, createActivity, settleActivity } from "../src/server/services/activities";
import { chargeContributionsForMonth } from "../src/server/services/contributions";
import { closeFiscalYear } from "../src/server/services/fiscal-years";
import { expenseClaimApproved, memorial, openingBalance, type AssignmentTarget } from "../src/domain/ledger/templates";
import { cents, sum } from "../src/domain/money";
import { addDays, localDate, type LocalDate } from "../src/domain/dates";
import { schema } from "../src/server/db";
import { closeTestDb, fiscalYearById, IBAN_CHECKING, seedBasic, SYSTEM, testDb, type Basic } from "./helpers";

const db = testDb();
afterAll(closeTestDb);

type Target = "person" | "externalPerson" | "pot" | "activity" | "none";

type Event =
  | { kind: "bank"; amount: number; target: Target; pick: number }
  | { kind: "contribution"; month: number }
  | { kind: "claim"; amount: number; toActivity: boolean; pick: number }
  | { kind: "charge"; amount: number; pick: number }
  | { kind: "newActivity" }
  | { kind: "settle"; pick: number; weights: number[]; dispuut: boolean }
  | { kind: "unassign"; pick: number }
  | { kind: "memorial"; amount: number }
  | { kind: "reverseMemorial"; pick: number };

const amount = fc.integer({ min: 1, max: 500_000 });
const signedAmount = fc.integer({ min: -500_000, max: 500_000 }).filter((n) => n !== 0);
const event: fc.Arbitrary<Event> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("bank" as const), amount: signedAmount, target: fc.constantFrom<Target>("person", "externalPerson", "pot", "activity", "none"), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("contribution" as const), month: fc.integer({ min: 0, max: 11 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("claim" as const), amount, toActivity: fc.boolean(), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("charge" as const), amount: signedAmount, pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("newActivity" as const) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("settle" as const), pick: fc.nat(), weights: fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 3, maxLength: 3 }), dispuut: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("unassign" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("memorial" as const), amount }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("reverseMemorial" as const), pick: fc.nat() }) },
);

async function run(b: Basic, events: Event[], closeYear: boolean) {
  const START = localDate("2026-08-01");
  let day = 0;
  const nextDate = (): LocalDate => addDays(START, Math.min(360, Math.floor(day++ / 2)));
  let bankBalance = 100000;
  let volgnr = 0;
  const unassigned = new Set<string>();
  const assigned: string[] = [];
  const openActivities: string[] = [];
  const settled: string[] = [];
  const memorials: string[] = [];
  const members = [b.jan, b.piet, b.klaas];

  await db.transaction((tx) =>
    postEntry(
      tx,
      openingBalance({ date: START, bank: [{ ledgerAccountId: b.checking.ledgerAccountId, amount: cents(bankBalance) }], persons: [], activities: [], other: [] })!,
      SYSTEM,
    ),
  );
  const first = await db.transaction((tx) =>
    createActivity(tx, { name: "Activiteit 0", heldOn: null, potId: b.pot("ACTIVITEITEN").id, date: START }, SYSTEM),
  );
  openActivities.push(first.id);

  for (const ev of events) {
    const date = nextDate();
    switch (ev.kind) {
      case "bank": {
        bankBalance += ev.amount;
        volgnr++;
        const { newIds } = await db.transaction((tx) =>
          recordTransactions(
            tx,
            b.checking.id,
            [
              {
                accountIban: IBAN_CHECKING,
                externalId: String(volgnr),
                bookingDate: date,
                valueDate: date,
                amount: cents(ev.amount),
                balanceAfter: cents(bankBalance),
                counterpartyIban: null,
                counterpartyName: "x",
                description: `tx ${volgnr}`,
              },
            ],
            SYSTEM,
          ),
        );
        const id = newIds[0];
        let target: AssignmentTarget | null = null;
        const a = cents(ev.amount);
        if (ev.target === "person") target = { kind: "person", partyId: members[ev.pick % 3].id, partyKind: "member", amount: a };
        if (ev.target === "externalPerson") target = { kind: "person", partyId: b.dispuutX.id, partyKind: "external", amount: a };
        if (ev.target === "pot") target = { kind: "pot", potId: b.pot("ALGEMEEN").id, accountId: ev.amount > 0 ? b.account("8900").id : b.account("4990").id, amount: a };
        if (ev.target === "activity" && openActivities.length) target = { kind: "activity", activityId: openActivities[ev.pick % openActivities.length], amount: a };
        if (target) {
          await db.transaction((tx) => assignTransaction(tx, id, [target], SYSTEM));
          assigned.push(id);
        } else {
          unassigned.add(id);
        }
        break;
      }
      case "contribution":
        await db.transaction((tx) => chargeContributionsForMonth(tx, localDate(`${ev.month < 5 ? 2026 : 2027}-${String(((ev.month + 7) % 12) + 1).padStart(2, "0")}-01`), SYSTEM));
        break;
      case "claim": {
        if (ev.toActivity && !openActivities.length) break;
        await db.transaction((tx) =>
          postEntry(
            tx,
            expenseClaimApproved({
              claimId: `c${day}`,
              partyId: members[ev.pick % 3].id,
              date,
              amount: cents(ev.amount),
              target: ev.toActivity
                ? { kind: "activity", activityId: openActivities[ev.pick % openActivities.length] }
                : { kind: "pot", potId: b.pot("BESTUUR").id, accountId: b.account("4400").id },
              description: "Declaratie",
            }),
            SYSTEM,
          ),
        );
        break;
      }
      case "charge": {
        if (!openActivities.length) break;
        await db.transaction((tx) =>
          chargePerson(
            tx,
            {
              partyId: members[ev.pick % 3].id,
              partyKind: "member",
              date,
              amount: cents(ev.amount),
              target: { kind: "activity", activityId: openActivities[ev.pick % openActivities.length] },
              description: "Op rekening",
            },
            SYSTEM,
          ),
        );
        break;
      }
      case "newActivity": {
        const act = await db.transaction((tx) =>
          createActivity(tx, { name: `Activiteit ${day}`, heldOn: date, potId: b.pot("ACTIVITEITEN").id, date }, SYSTEM),
        );
        openActivities.push(act.id);
        break;
      }
      case "settle": {
        if (!openActivities.length) break;
        const [id] = openActivities.splice(ev.pick % openActivities.length, 1);
        const balance = await activityBalance(db, id);
        const shares = [
          ...members.map((m, i) => ({ partyId: m.id, partyKind: "member" as const, method: "weight" as const, weight: ev.weights[i] })),
          ...(ev.dispuut ? [{ partyId: null, method: "equal" as const }] : []),
          { partyId: b.dispuutX.id, partyKind: "external" as const, method: "equal" as const },
        ];
        await db.transaction((tx) => settleActivity(tx, { activityId: id, date, shares, expectedBalance: balance }, SYSTEM));
        settled.push(id);
        break;
      }
      case "unassign": {
        if (!assigned.length) break;
        const [id] = assigned.splice(ev.pick % assigned.length, 1);
        // Transactions assigned to an activity that has been settled cannot be unassigned (DB refuses) — skip those.
        try {
          await db.transaction((tx) => unassignTransaction(tx, id, "Test", SYSTEM));
          unassigned.add(id);
        } catch (err) {
          if (!String((err as Error & { cause?: Error }).cause?.message ?? (err as Error).message).includes("afgerekend")) throw err;
          assigned.push(id);
        }
        break;
      }
      case "memorial": {
        const e = await db.transaction((tx) =>
          postEntry(
            tx,
            memorial({
              date,
              description: "Reservering",
              reason: "Test",
              lines: [
                { account: { id: b.account("0500").id }, amount: cents(ev.amount) },
                { account: { id: b.account("0520").id }, amount: cents(-ev.amount) },
              ],
            }),
            SYSTEM,
          ),
        );
        memorials.push(e.id);
        break;
      }
      case "reverseMemorial": {
        if (!memorials.length) break;
        const [id] = memorials.splice(ev.pick % memorials.length, 1);
        await db.transaction((tx) => reverseEntry(tx, id, { reason: "Test" }, SYSTEM));
        break;
      }
    }
  }

  // ---- Invariants -------------------------------------------------------------
  expect(await trialBalanceTotal(db)).toBe(0);
  expect(await bankLedgerBalance(db, b.checking.id)).toBe(bankBalance);
  expect(await unassignedCount(db)).toBe(unassigned.size);
  for (const id of settled) expect(await activityBalance(db, id)).toBe(0);

  const fy = await fiscalYearById(db, b.fy.id);
  const balances = await accountBalances(db, fy);
  const byKey = (k: string) => balances.find((a) => a.systemKey === k)!.balance;
  const persons = await partyBalances(db);
  expect(byKey("MEMBER_ACCOUNTS") + byKey("CONTRIBUTION_RECEIVABLE")).toBe(sum(persons.filter((p) => p.kind === "member").map((p) => p.balance)));
  expect(byKey("EXTERNAL_ACCOUNTS") + byKey("ACCOUNTS_PAYABLE")).toBe(
    sum(persons.filter((p) => p.kind === "external").map((p) => p.balance)),
  );
  // Assets = liabilities + equity + result (all signs: sum of every balance is 0).
  expect(sum(balances.map((a) => a.balance))).toBe(0);

  if (closeYear && unassigned.size === 0) {
    const result = -sum((await resultBalancesByPot(db, fy.id)).map((r) => r.amount));
    await db.transaction((tx) =>
      closeFiscalYear(tx, { fiscalYearId: fy.id, appropriation: result === 0 ? [] : [{ accountId: b.account("0500").id, amount: cents(result) }] }, SYSTEM),
    );
    const after = await accountBalances(db, await fiscalYearById(db, fy.id));
    for (const a of after.filter((x) => x.type === "income" || x.type === "expense")) expect(a.balance).toBe(0);
    expect(after.find((a) => a.systemKey === "YEAR_RESULT")!.balance).toBe(0);
    expect(await trialBalanceTotal(db)).toBe(0);
  }

  const [{ broken }] = await db.execute<{ broken: string | null }>(sql`select audit_log_verify() as broken`);
  expect(broken).toBeNull();
  const [{ n }] = await db.execute<{ n: string }>(sql`select count(*) as n from ${schema.journalEntries}`);
  return Number(n);
}

describe("property: the books always balance after random events", () => {
  it(
    "holds for random event sequences (including year closing)",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(event, { minLength: 1, maxLength: 40 }), fc.boolean(), async (events, closeYear) => {
          const b = await seedBasic(db);
          await run(b, events, closeYear);
        }),
        { numRuns: 30, endOnFailure: true },
      );
    },
    600_000,
  );
});
