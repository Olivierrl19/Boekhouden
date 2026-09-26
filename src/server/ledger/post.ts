/**
 * The only code that writes journal entries. Everything that moves money calls postEntry()
 * (or reverseEntry()) inside a transaction, together with its document change and audit log.
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { schema, type Tx } from "../db";
import { audit } from "../audit";
import { validateDraft, mirrorEntry, type PostedLine } from "@/domain/ledger/templates";
import { LedgerError, type AccountRef, type EntryDraft } from "@/domain/ledger/types";
import { cents } from "@/domain/money";
import { localDate, type LocalDate } from "@/domain/dates";

export interface Actor {
  userId: string | null; // null = system (cron, import)
}

export interface PostedEntry {
  id: string;
  entryNumber: string;
  fiscalYearId: string;
}

async function resolveAccounts(tx: Tx, refs: AccountRef[]): Promise<Map<string, typeof schema.ledgerAccounts.$inferSelect>> {
  const accounts = await tx.select().from(schema.ledgerAccounts);
  const byKey = new Map<string, typeof schema.ledgerAccounts.$inferSelect>();
  for (const a of accounts) {
    byKey.set(`id:${a.id}`, a);
    if (a.systemKey) byKey.set(`key:${a.systemKey}`, a);
  }
  const result = new Map<string, typeof schema.ledgerAccounts.$inferSelect>();
  for (const ref of refs) {
    const k = "key" in ref ? `key:${ref.key}` : `id:${ref.id}`;
    const account = byKey.get(k);
    if (!account) throw new LedgerError(`Onbekende grootboekrekening: ${k}`);
    result.set(k, account);
  }
  return result;
}

function refKey(ref: AccountRef): string {
  return "key" in ref ? `key:${ref.key}` : `id:${ref.id}`;
}

export async function fiscalYearForDate(tx: Tx, date: LocalDate) {
  const [fy] = await tx
    .select()
    .from(schema.fiscalYears)
    .where(and(lte(schema.fiscalYears.startDate, date), gte(schema.fiscalYears.endDate, date)));
  if (!fy) throw new LedgerError(`Er is geen boekjaar voor datum ${date}`);
  return fy;
}

/**
 * Validate and write a journal entry. Must be called inside a transaction (the DB checks
 * balance at commit time; numbering locks the fiscal year row).
 */
export async function postEntry(tx: Tx, draft: EntryDraft, actor: Actor): Promise<PostedEntry> {
  validateDraft(draft);
  localDate(draft.date);

  const accounts = await resolveAccounts(tx, draft.lines.map((l) => l.account));
  for (const line of draft.lines) {
    const account = accounts.get(refKey(line.account))!;
    const isManual = draft.template === "T29" || draft.template === "T23";
    if (isManual && !account.manualPostingAllowed) {
      throw new LedgerError(`Op rekening ${account.code} ${account.name} kan niet handmatig worden geboekt`);
    }
    const isResult = account.type === "income" || account.type === "expense";
    if (isResult && !line.potId) throw new LedgerError(`Rekening ${account.code} vereist een potje`);
    if (!isResult && line.potId) throw new LedgerError(`Rekening ${account.code} mag geen potje hebben`);
    if (account.requiresParty && !line.partyId) throw new LedgerError(`Rekening ${account.code} vereist een persoon`);
    if (!account.requiresParty && line.partyId) throw new LedgerError(`Rekening ${account.code} mag geen persoon hebben`);
    if (account.requiresActivity && !line.activityId) {
      throw new LedgerError(`Rekening ${account.code} vereist een activiteit`);
    }
  }

  const fy = await fiscalYearForDate(tx, draft.date);
  if (fy.status === "closed") throw new LedgerError(`Boekjaar ${fy.label} is afgesloten`);
  if (fy.status === "closing" && !["T25", "T25b", "T27"].includes(draft.template)) {
    throw new LedgerError(`Boekjaar ${fy.label} is in afsluiting`);
  }

  // Gapless numbering: the UPDATE row-locks the fiscal year until commit.
  const [{ n }] = await tx
    .update(schema.fiscalYears)
    .set({ nextEntryNumber: sql`${schema.fiscalYears.nextEntryNumber} + 1` })
    .where(eq(schema.fiscalYears.id, fy.id))
    .returning({ n: sql<number>`${schema.fiscalYears.nextEntryNumber} - 1` });
  const entryNumber = `${fy.label}-${String(n).padStart(6, "0")}`;

  const [entry] = await tx
    .insert(schema.journalEntries)
    .values({
      fiscalYearId: fy.id,
      entryNumber,
      entryDate: draft.date,
      template: draft.template,
      description: draft.description,
      sourceType: draft.sourceType ?? null,
      sourceId: draft.sourceId ?? null,
      reversesEntryId: draft.reversesEntryId ?? null,
      isAutomatic: draft.isAutomatic ?? false,
      autoReverse: draft.autoReverse ?? false,
      reason: draft.reason ?? null,
      createdBy: actor.userId,
    })
    .returning({ id: schema.journalEntries.id });

  await tx.insert(schema.journalLines).values(
    draft.lines.map((line, i) => ({
      entryId: entry.id,
      lineNo: i + 1,
      accountId: accounts.get(refKey(line.account))!.id,
      amountCents: line.amount,
      potId: line.potId ?? null,
      activityId: line.activityId ?? null,
      partyId: line.partyId ?? null,
      bankTransactionId: line.bankTransactionId ?? null,
      invoiceId: line.invoiceId ?? null,
      description: line.description ?? null,
    })),
  );

  await audit(tx, {
    actorUserId: actor.userId,
    action: "journal.post",
    entityType: "journal_entry",
    entityId: entry.id,
    reason: draft.reason ?? null,
    data: {
      entryNumber,
      template: draft.template,
      date: draft.date,
      description: draft.description,
      lines: draft.lines.map((l) => ({ account: refKey(l.account), amount: l.amount })),
    },
  });

  return { id: entry.id, entryNumber, fiscalYearId: fy.id };
}

export async function loadEntry(tx: Tx, entryId: string) {
  const [entry] = await tx.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, entryId));
  if (!entry) throw new LedgerError("Journaalpost niet gevonden");
  const lines = await tx
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entryId))
    .orderBy(asc(schema.journalLines.lineNo));
  const posted: PostedLine[] = lines.map((l) => ({
    accountId: l.accountId,
    amount: cents(l.amountCents),
    potId: l.potId,
    activityId: l.activityId,
    partyId: l.partyId,
    bankTransactionId: l.bankTransactionId,
    invoiceId: l.invoiceId,
    description: l.description,
  }));
  return { entry, lines: posted };
}

/**
 * Post the exact mirror of an entry (T27). The reversal is dated on the original date when
 * that year is still open, otherwise the caller must pass a date in an open year.
 */
export async function reverseEntry(
  tx: Tx,
  entryId: string,
  opts: { reason: string; date?: LocalDate; template?: "T27" | "T24" | "T17" },
  actor: Actor,
): Promise<PostedEntry> {
  if (!opts.reason.trim()) throw new LedgerError("Reden is verplicht voor een tegenboeking");
  const { entry, lines } = await loadEntry(tx, entryId);
  if (entry.template === "T00" || entry.template === "T19") {
    throw new LedgerError("Een geïmporteerde banktransactie kan niet worden tegengeboekt");
  }
  const [existing] = await tx
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.reversesEntryId, entryId));
  if (existing) throw new LedgerError("Deze journaalpost is al tegengeboekt");
  if (entry.reversesEntryId) throw new LedgerError("Een tegenboeking kan niet zelf worden tegengeboekt");

  const draft = mirrorEntry({
    original: { id: entry.id, description: entry.description, lines },
    template: opts.template ?? "T27",
    date: opts.date ?? localDate(entry.entryDate),
    reason: opts.reason,
  });
  draft.sourceType = entry.sourceType;
  draft.sourceId = entry.sourceId;
  return postEntry(tx, draft, actor);
}
