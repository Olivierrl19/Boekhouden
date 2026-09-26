import { and, asc, eq, lt, gte, lte, inArray } from "drizzle-orm";
import { schema, type Tx } from "../db";
import { audit } from "../audit";
import { postEntry, reverseEntry, type Actor } from "../ledger/post";
import { resultBalancesByPot, unassignedTransactionIds } from "../ledger/balances";
import { yearClose } from "@/domain/ledger/templates";
import { LedgerError } from "@/domain/ledger/types";
import type { Cents } from "@/domain/money";
import { localDate } from "@/domain/dates";

export interface ChecklistItem {
  key: string;
  label: string;
  ok: boolean;
  detail?: string;
}

/**
 * Year-end checklist (PLAN.md §11.5). More items (cash count, claims, accruals) are added
 * in later build steps; every item must be green before closing.
 */
export async function closingChecklist(tx: Tx, fiscalYearId: string): Promise<ChecklistItem[]> {
  const [fy] = await tx.select().from(schema.fiscalYears).where(eq(schema.fiscalYears.id, fiscalYearId));
  if (!fy) throw new LedgerError("Boekjaar niet gevonden");
  const items: ChecklistItem[] = [];

  const unassigned = await unassignedTransactionIds(tx);
  const inYear = unassigned.length
    ? await tx
        .select({ id: schema.bankTransactions.id })
        .from(schema.bankTransactions)
        .where(
          and(
            inArray(schema.bankTransactions.id, unassigned),
            gte(schema.bankTransactions.bookingDate, fy.startDate),
            lte(schema.bankTransactions.bookingDate, fy.endDate),
          ),
        )
    : [];
  items.push({
    key: "bank_assigned",
    label: "Alle banktransacties van het jaar zijn toegewezen",
    ok: inYear.length === 0,
    detail: inYear.length ? `${inYear.length} nog toe te wijzen` : undefined,
  });

  const previousOpen = await tx
    .select({ label: schema.fiscalYears.label })
    .from(schema.fiscalYears)
    .where(and(lt(schema.fiscalYears.endDate, fy.startDate), inArray(schema.fiscalYears.status, ["open", "closing"])));
  items.push({
    key: "previous_closed",
    label: "Vorige boekjaren zijn afgesloten",
    ok: previousOpen.length === 0,
    detail: previousOpen.map((p) => p.label).join(", ") || undefined,
  });

  return items;
}

/**
 * Close a fiscal year: post T25 (all result accounts to 0590) and T25b (result appropriation),
 * then mark the year closed. `appropriation` must add up to the year's result.
 */
export async function closeFiscalYear(
  tx: Tx,
  input: { fiscalYearId: string; appropriation: { accountId: string; amount: Cents }[] },
  actor: Actor,
) {
  const [fy] = await tx.select().from(schema.fiscalYears).where(eq(schema.fiscalYears.id, input.fiscalYearId));
  if (!fy) throw new LedgerError("Boekjaar niet gevonden");
  if (fy.status === "closed") throw new LedgerError("Boekjaar is al afgesloten");

  const checklist = await closingChecklist(tx, fy.id);
  const failing = checklist.filter((c) => !c.ok);
  if (failing.length) {
    throw new LedgerError(`Afsluiten kan nog niet: ${failing.map((f) => f.label).join("; ")}`);
  }

  await tx.update(schema.fiscalYears).set({ status: "closing" }).where(eq(schema.fiscalYears.id, fy.id));
  const balances = await resultBalancesByPot(tx, fy.id);
  const drafts = yearClose({
    date: localDate(fy.endDate),
    fiscalYearLabel: fy.label,
    balances,
    appropriation: input.appropriation,
  });
  const closing = drafts.closing ? await postEntry(tx, drafts.closing, actor) : null;
  const appropriation = drafts.appropriation ? await postEntry(tx, drafts.appropriation, actor) : null;

  await tx
    .update(schema.fiscalYears)
    .set({ status: "closed", closedAt: new Date(), closedBy: actor.userId })
    .where(eq(schema.fiscalYears.id, fy.id));
  await audit(tx, {
    actorUserId: actor.userId,
    action: "fiscal_year.close",
    entityType: "fiscal_year",
    entityId: fy.id,
    data: {
      result: drafts.result,
      closingEntryId: closing?.id ?? null,
      appropriationEntryId: appropriation?.id ?? null,
      appropriation: input.appropriation,
    },
  });
  return { result: drafts.result, closing, appropriation };
}

/** Reopen a closed year: reverse the closing entries (with reason) and set it back to open. */
export async function reopenFiscalYear(tx: Tx, fiscalYearId: string, reason: string, actor: Actor) {
  if (!reason.trim()) throw new LedgerError("Reden is verplicht om een boekjaar te heropenen");
  const [fy] = await tx.select().from(schema.fiscalYears).where(eq(schema.fiscalYears.id, fiscalYearId));
  if (!fy || fy.status !== "closed") throw new LedgerError("Alleen een afgesloten boekjaar kan heropend worden");
  const laterClosed = await tx
    .select({ label: schema.fiscalYears.label })
    .from(schema.fiscalYears)
    .where(and(gte(schema.fiscalYears.startDate, fy.endDate), eq(schema.fiscalYears.status, "closed")));
  if (laterClosed.length) {
    throw new LedgerError(`Heropen eerst het latere boekjaar ${laterClosed.map((l) => l.label).join(", ")}`);
  }

  await tx.update(schema.fiscalYears).set({ status: "closing", closedAt: null, closedBy: null }).where(eq(schema.fiscalYears.id, fy.id));
  const closingEntries = await tx
    .select()
    .from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.fiscalYearId, fy.id), inArray(schema.journalEntries.template, ["T25", "T25b"])))
    .orderBy(asc(schema.journalEntries.createdAt));
  const reversedIds = new Set(
    (
      await tx
        .select({ id: schema.journalEntries.reversesEntryId })
        .from(schema.journalEntries)
        .where(eq(schema.journalEntries.fiscalYearId, fy.id))
    ).map((r) => r.id),
  );
  for (const entry of closingEntries.reverse()) {
    if (!reversedIds.has(entry.id)) await reverseEntry(tx, entry.id, { reason }, actor);
  }
  await tx.update(schema.fiscalYears).set({ status: "open" }).where(eq(schema.fiscalYears.id, fy.id));
  await audit(tx, {
    actorUserId: actor.userId,
    action: "fiscal_year.reopen",
    entityType: "fiscal_year",
    entityId: fy.id,
    reason,
  });
}
