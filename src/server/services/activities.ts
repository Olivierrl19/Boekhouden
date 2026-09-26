import { eq } from "drizzle-orm";
import { schema, type Tx } from "../db";
import { audit } from "../audit";
import { postEntry, reverseEntry, type Actor } from "../ledger/post";
import { activityBalance } from "../ledger/balances";
import {
  activitySettled,
  chargedToPerson,
  computeSettlement,
  type SettlementShareInput,
} from "@/domain/ledger/templates";
import { LedgerError } from "@/domain/ledger/types";
import type { Cents } from "@/domain/money";
import type { LocalDate } from "@/domain/dates";
import { fiscalYearForDate } from "../ledger/post";

export async function createActivity(
  tx: Tx,
  input: { name: string; heldOn: LocalDate | null; potId: string; description?: string | null; date: LocalDate },
  actor: Actor,
) {
  const fy = await fiscalYearForDate(tx, input.heldOn ?? input.date);
  const [row] = await tx
    .insert(schema.activities)
    .values({
      fiscalYearId: fy.id,
      name: input.name.trim(),
      heldOn: input.heldOn,
      potId: input.potId,
      description: input.description ?? null,
    })
    .returning();
  await audit(tx, {
    actorUserId: actor.userId,
    action: "activity.create",
    entityType: "activity",
    entityId: row.id,
    data: { name: row.name, heldOn: row.heldOn, potId: row.potId },
  });
  return row;
}

async function loadActivity(tx: Tx, activityId: string) {
  const [act] = await tx.select().from(schema.activities).where(eq(schema.activities.id, activityId));
  if (!act) throw new LedgerError("Activiteit niet gevonden");
  return act;
}

/** Preview: who pays what, without booking anything. */
export async function previewSettlement(tx: Tx, activityId: string, shares: SettlementShareInput[]) {
  const balance = await activityBalance(tx, activityId);
  return { balance, allocations: computeSettlement(balance, shares) };
}

/**
 * Distribute everything that is left on "nog te verdelen" and close the activity (T11).
 * `expectedBalance` protects against the balance changing between preview and confirmation.
 */
export async function settleActivity(
  tx: Tx,
  input: { activityId: string; date: LocalDate; shares: SettlementShareInput[]; expectedBalance: Cents },
  actor: Actor,
) {
  const act = await loadActivity(tx, input.activityId);
  if (act.status !== "open") throw new LedgerError("Deze activiteit is al afgerekend");
  const balance = await activityBalance(tx, act.id);
  if (balance !== input.expectedBalance) {
    throw new LedgerError("Het te verdelen bedrag is gewijzigd sinds de voorvertoning; controleer de verdeling opnieuw");
  }
  const [pot] = await tx.select().from(schema.pots).where(eq(schema.pots.id, act.potId));
  if (!pot.defaultExpenseAccountId) throw new LedgerError(`Potje ${pot.name} heeft geen kostenrekening`);

  const allocations = computeSettlement(balance, input.shares);
  const draft = activitySettled({
    activityId: act.id,
    activityName: act.name,
    date: input.date,
    balance,
    allocations,
    potId: pot.id,
    expenseAccountId: pot.defaultExpenseAccountId,
  });
  const entry = draft ? await postEntry(tx, draft, actor) : null;
  await tx
    .update(schema.activities)
    .set({ status: "settled", settlementEntryId: entry?.id ?? null })
    .where(eq(schema.activities.id, act.id));
  await audit(tx, {
    actorUserId: actor.userId,
    action: "activity.settle",
    entityType: "activity",
    entityId: act.id,
    data: {
      balance,
      entryId: entry?.id ?? null,
      allocations: allocations.map((a) => ({ partyId: a.partyId, amount: a.amount })),
    },
  });
  return { entry, allocations };
}

export async function reopenActivity(tx: Tx, activityId: string, reason: string, actor: Actor) {
  const act = await loadActivity(tx, activityId);
  if (act.status !== "settled") throw new LedgerError("Deze activiteit is niet afgerekend");
  if (!reason.trim()) throw new LedgerError("Reden is verplicht");
  await tx
    .update(schema.activities)
    .set({ status: "open", settlementEntryId: null })
    .where(eq(schema.activities.id, act.id));
  if (act.settlementEntryId) await reverseEntry(tx, act.settlementEntryId, { reason }, actor);
  await audit(tx, {
    actorUserId: actor.userId,
    action: "activity.reopen",
    entityType: "activity",
    entityId: act.id,
    reason,
  });
}

/** T12: put an amount directly on someone's account, against an activity or a pot. */
export async function chargePerson(
  tx: Tx,
  input: Parameters<typeof chargedToPerson>[0],
  actor: Actor,
) {
  return postEntry(tx, chargedToPerson(input), actor);
}
