import { eq } from "drizzle-orm";
import { schema, type Tx } from "../db";
import { audit } from "../audit";
import { DEFAULT_ACCOUNTS, DEFAULT_POTS } from "@/domain/ledger/chart";
import { fiscalYearFor, type LocalDate } from "@/domain/dates";
import type { Actor } from "../ledger/post";

export interface InstallInput {
  name: string;
  shortName: string;
  fiscalYearStartMonth: number;
  paymentIban?: string | null;
  paymentAccountName?: string | null;
  mailFrom?: string | null;
  bankAccounts: { name: string; iban: string | null; kind: "checking" | "savings" | "cash" }[];
}

export { isValidIban, normalizeIban } from "@/domain/bank/iban";
import { isValidIban, normalizeIban } from "@/domain/bank/iban";

/**
 * Install organisation settings, the default chart of accounts, pots and bank accounts.
 * Only allowed on an empty database.
 */
export async function installDefaults(tx: Tx, input: InstallInput, actor: Actor): Promise<void> {
  const existing = await tx.select().from(schema.orgSettings);
  if (existing.length > 0) throw new Error("Het dispuut is al ingericht");

  await tx.insert(schema.orgSettings).values({
    id: 1,
    name: input.name,
    shortName: input.shortName,
    fiscalYearStartMonth: input.fiscalYearStartMonth,
    paymentIban: input.paymentIban ? normalizeIban(input.paymentIban) : null,
    paymentAccountName: input.paymentAccountName ?? input.name,
    mailFrom: input.mailFrom ?? null,
  });

  const accountIds = new Map<string, string>();
  for (const acc of DEFAULT_ACCOUNTS) {
    if (acc.bank) continue; // created per bank account below
    const [row] = await tx
      .insert(schema.ledgerAccounts)
      .values({
        code: acc.code,
        name: acc.name,
        type: acc.type,
        systemKey: acc.systemKey ?? null,
        requiresParty: !!acc.partyKind,
        partyKind: acc.partyKind ?? null,
        requiresActivity: acc.requiresActivity ?? false,
        manualPostingAllowed: acc.manualPostingAllowed ?? true,
      })
      .returning({ id: schema.ledgerAccounts.id });
    accountIds.set(acc.code, row.id);
  }

  // Bank and cash accounts: codes 1000.. (checking), 1010.. (savings), 1050.. (cash).
  const baseCode = { checking: 1000, savings: 1010, cash: 1050 } as const;
  const used = { checking: 0, savings: 0, cash: 0 };
  for (const bank of input.bankAccounts) {
    const code = String(baseCode[bank.kind] + used[bank.kind]++);
    if (bank.kind !== "cash" && (!bank.iban || !isValidIban(bank.iban))) {
      throw new Error(`Ongeldig IBAN voor ${bank.name}`);
    }
    const [ledger] = await tx
      .insert(schema.ledgerAccounts)
      .values({ code, name: bank.name, type: "asset", manualPostingAllowed: false })
      .returning({ id: schema.ledgerAccounts.id });
    await tx.insert(schema.bankAccounts).values({
      name: bank.name,
      iban: bank.iban ? normalizeIban(bank.iban) : null,
      kind: bank.kind,
      ledgerAccountId: ledger.id,
    });
  }

  for (const pot of DEFAULT_POTS) {
    await tx.insert(schema.pots).values({
      code: pot.code,
      name: pot.name,
      defaultIncomeAccountId: pot.income ? accountIds.get(pot.income) : null,
      defaultExpenseAccountId: pot.expense ? accountIds.get(pot.expense) : null,
    });
  }

  await audit(tx, {
    actorUserId: actor.userId,
    action: "setup.install",
    entityType: "org_settings",
    entityId: "1",
    data: { name: input.name, bankAccounts: input.bankAccounts.length },
  });
}

export async function getSettings(tx: Tx) {
  const [settings] = await tx.select().from(schema.orgSettings).where(eq(schema.orgSettings.id, 1));
  return settings ?? null;
}

/** Create the fiscal year containing `date` if it does not exist yet. */
export async function ensureFiscalYear(tx: Tx, date: LocalDate, actor: Actor) {
  const settings = await getSettings(tx);
  if (!settings) throw new Error("Het dispuut is nog niet ingericht");
  const period = fiscalYearFor(date, settings.fiscalYearStartMonth);
  const [existing] = await tx.select().from(schema.fiscalYears).where(eq(schema.fiscalYears.label, period.label));
  if (existing) return existing;
  const [fy] = await tx
    .insert(schema.fiscalYears)
    .values({ label: period.label, startDate: period.startDate, endDate: period.endDate })
    .returning();
  await audit(tx, {
    actorUserId: actor.userId,
    action: "fiscal_year.create",
    entityType: "fiscal_year",
    entityId: fy.id,
    data: period,
  });
  return fy;
}
