/**
 * First-run installation (PLAN.md §9), used by the /setup wizard: creates the association,
 * chart of accounts, the current fiscal year, the first member type, the fiscus as a member
 * with the fiscus role, and the opening balance of the bank/cash accounts.
 */
import { eq, sql } from "drizzle-orm";
import { schema, type Tx } from "../db";
import { audit } from "../audit";
import { postEntry, type Actor } from "../ledger/post";
import { installDefaults, ensureFiscalYear, isValidIban, normalizeIban } from "./setup";
import { createMember, createMemberType } from "./parties";
import { openingBalance } from "@/domain/ledger/templates";
import type { Cents } from "@/domain/money";
import type { LocalDate } from "@/domain/dates";

export interface InstallAssociationInput {
  name: string;
  shortName: string;
  fiscalYearStartMonth: number;
  startDate: LocalDate;
  fiscus: { firstName: string; lastName: string; email: string };
  memberType: { name: string; monthlyContribution: Cents };
  checking: { iban: string; openingBalance: Cents };
  savings: { iban: string; openingBalance: Cents } | null;
  cashOpeningBalance: Cents;
}

export async function installAssociation(tx: Tx, input: InstallAssociationInput, actor: Actor) {
  for (const iban of [input.checking.iban, input.savings?.iban].filter((x): x is string => !!x)) {
    if (!isValidIban(iban)) throw new Error(`Ongeldig IBAN: ${iban}`);
  }
  if (input.savings && normalizeIban(input.savings.iban) === normalizeIban(input.checking.iban)) {
    throw new Error("Betaal- en spaarrekening moeten verschillende IBANs hebben");
  }

  await installDefaults(
    tx,
    {
      name: input.name,
      shortName: input.shortName,
      fiscalYearStartMonth: input.fiscalYearStartMonth,
      paymentIban: input.checking.iban,
      paymentAccountName: input.name,
      bankAccounts: [
        { name: "Betaalrekening", iban: input.checking.iban, kind: "checking" },
        ...(input.savings ? [{ name: "Spaarrekening", iban: input.savings.iban, kind: "savings" as const }] : []),
        { name: "Kas", iban: null, kind: "cash" },
      ],
    },
    actor,
  );
  const fy = await ensureFiscalYear(tx, input.startDate, actor);
  const memberType = await createMemberType(tx, input.memberType, actor);
  const fiscus = await createMember(
    tx,
    {
      firstName: input.fiscus.firstName,
      lastName: input.fiscus.lastName,
      email: input.fiscus.email,
      memberTypeId: memberType.id,
      joinedOn: input.startDate,
    },
    actor,
  );
  const [user] = await tx.select().from(schema.users).where(eq(schema.users.partyId, fiscus.id));
  await tx.insert(schema.roleAssignments).values({ userId: user.id, fiscalYearId: fy.id, role: "fiscus" });

  const banks = await tx.select().from(schema.bankAccounts);
  const ledgerOf = (kind: "checking" | "savings" | "cash") => banks.find((b) => b.kind === kind)!.ledgerAccountId;
  const draft = openingBalance({
    date: input.startDate,
    bank: [
      { ledgerAccountId: ledgerOf("checking"), amount: input.checking.openingBalance },
      ...(input.savings ? [{ ledgerAccountId: ledgerOf("savings"), amount: input.savings.openingBalance }] : []),
      { ledgerAccountId: ledgerOf("cash"), amount: input.cashOpeningBalance },
    ],
    persons: [],
    activities: [],
    other: [],
  });
  if (draft) await postEntry(tx, draft, actor);

  await markSetupCompleted(tx);
  await audit(tx, {
    actorUserId: actor.userId,
    action: "setup.complete",
    entityType: "org_settings",
    entityId: "1",
    data: { name: input.name, startDate: input.startDate, fiscusEmail: input.fiscus.email },
  });
  return { fiscalYear: fy, fiscusUserId: user.id };
}

export async function markSetupCompleted(tx: Tx, opts: { isDemo?: boolean } = {}) {
  await tx
    .update(schema.orgSettings)
    .set({ setupCompleted: true, isDemo: opts.isDemo ?? false, updatedAt: new Date() })
    .where(eq(schema.orgSettings.id, 1));
}

/**
 * Wipe everything so the wizard can run again. Only allowed for the demo association: real
 * books are never deleted (TRUNCATE bypasses the row-level immutability triggers on purpose).
 */
export async function wipeDemo(tx: Tx) {
  const [s] = await tx.select().from(schema.orgSettings);
  if (!s?.isDemo) throw new Error("Alleen een voorbeelddispuut kan worden gewist");
  const tables = await tx.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  await tx.execute(sql.raw(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`));
}

export async function isSetupCompleted(tx: Tx): Promise<boolean> {
  const [s] = await tx.select({ done: schema.orgSettings.setupCompleted }).from(schema.orgSettings);
  return !!s?.done;
}
