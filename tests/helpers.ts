import "dotenv/config";
import { sql as dsql, eq } from "drizzle-orm";
import { createDb, schema, type Db } from "../src/server/db";
import { installDefaults, ensureFiscalYear } from "../src/server/services/setup";
import { createMember, createMemberType, createExternal } from "../src/server/services/parties";
import { cents } from "../src/domain/money";
import { localDate } from "../src/domain/dates";
import type { Actor } from "../src/server/ledger/post";

export const SYSTEM: Actor = { userId: null };

let handle: ReturnType<typeof createDb> | undefined;

export function testDb(): Db {
  if (!handle) {
    const url = process.env.DATABASE_URL_TEST;
    if (!url) throw new Error("DATABASE_URL_TEST is not set");
    handle = createDb(url);
  }
  return handle.db;
}

export async function closeTestDb() {
  await handle?.sql.end();
  handle = undefined;
}

/** Wipe all data (TRUNCATE bypasses the row-level immutability triggers on purpose). */
export async function resetDb(db: Db) {
  const tables = await db.execute<{ tablename: string }>(
    dsql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = tables.map((t) => `"${t.tablename}"`).join(", ");
  await db.execute(dsql.raw(`TRUNCATE ${names} RESTART IDENTITY CASCADE`));
}

export const IBAN_CHECKING = "NL91RABO0315273637";
export const IBAN_SAVINGS = "NL70RABO3163450289";
export const IBAN_JAN = "NL20INGB0001234567";
export const IBAN_PIET = "NL91ABNA0417164300";

/** A small association: chart, 2026-2027 fiscal year, two member types, three members, one external. */
export async function seedBasic(db: Db) {
  await resetDb(db);
  return db.transaction(async (tx) => {
    await installDefaults(
      tx,
      {
        name: "Dispuut Test",
        shortName: "Test",
        fiscalYearStartMonth: 8,
        paymentIban: IBAN_CHECKING,
        bankAccounts: [
          { name: "Betaalrekening", iban: IBAN_CHECKING, kind: "checking" },
          { name: "Spaarrekening", iban: IBAN_SAVINGS, kind: "savings" },
          { name: "Kas", iban: null, kind: "cash" },
        ],
      },
      SYSTEM,
    );
    const fy = await ensureFiscalYear(tx, localDate("2026-09-01"), SYSTEM);
    const lid = await createMemberType(tx, { name: "Lid", monthlyContribution: cents(1500) }, SYSTEM);
    const aspirant = await createMemberType(tx, { name: "Aspirant", monthlyContribution: cents(1000) }, SYSTEM);
    const jan = await createMember(
      tx,
      { firstName: "Jan", lastName: "Jansen", email: "jan@example.nl", memberTypeId: lid.id, joinedOn: localDate("2024-09-01"), ibans: [IBAN_JAN] },
      SYSTEM,
    );
    const piet = await createMember(
      tx,
      { firstName: "Piet", lastName: "Pietersen", email: "piet@example.nl", memberTypeId: lid.id, joinedOn: localDate("2025-09-01"), ibans: [IBAN_PIET] },
      SYSTEM,
    );
    const klaas = await createMember(
      tx,
      { firstName: "Klaas", lastName: "Klaassen", email: null, memberTypeId: aspirant.id, joinedOn: localDate("2026-09-15") },
      SYSTEM,
    );
    const dispuutX = await createExternal(tx, { name: "Dispuut X" }, SYSTEM);
    const banks = await tx.select().from(schema.bankAccounts);
    const pots = await tx.select().from(schema.pots);
    const accounts = await tx.select().from(schema.ledgerAccounts);
    const pot = (code: string) => pots.find((p) => p.code === code)!;
    const account = (code: string) => accounts.find((a) => a.code === code)!;
    return {
      fy,
      memberTypes: { lid, aspirant },
      jan,
      piet,
      klaas,
      dispuutX,
      checking: banks.find((b) => b.kind === "checking")!,
      savings: banks.find((b) => b.kind === "savings")!,
      cash: banks.find((b) => b.kind === "cash")!,
      pot,
      account,
    };
  });
}

export type Basic = Awaited<ReturnType<typeof seedBasic>>;

export async function fiscalYearById(db: Db, id: string) {
  const [fy] = await db.select().from(schema.fiscalYears).where(eq(schema.fiscalYears.id, id));
  return fy;
}
