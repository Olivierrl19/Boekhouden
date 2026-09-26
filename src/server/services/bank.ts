/**
 * Recording and assigning bank/cash transactions. Parsers (CSV / CAMT.053) produce
 * NormalizedBankTransaction values; this service is connector-agnostic.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Tx } from "../db";
import { audit } from "../audit";
import { postEntry, reverseEntry, type Actor } from "../ledger/post";
import { bankLedgerBalance } from "../ledger/balances";
import {
  assignBankTransaction,
  bankTransactionImported,
  type AssignmentTarget,
} from "@/domain/ledger/templates";
import { centsFromDb, cents, type Cents, formatEuro } from "@/domain/money";
import { localDate, type LocalDate } from "@/domain/dates";
import { normalizeIban } from "./setup";

import type { NormalizedBankTransaction } from "@/domain/bank/types";
export type { NormalizedBankTransaction };

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export interface RecordResult {
  newIds: string[];
  duplicates: number;
  autoAssigned: number;
}

function sameContent(existing: typeof schema.bankTransactions.$inferSelect, tx: NormalizedBankTransaction) {
  return (
    existing.amountCents === tx.amount &&
    existing.bookingDate === tx.bookingDate &&
    (existing.balanceAfterCents ?? null) === (tx.balanceAfter ?? null)
  );
}

/**
 * Store new transactions for one bank account, post T00 for each and auto-assign the
 * certain ones (internal transfers, explicit auto rules). Idempotent.
 *
 * Continuity: when transactions carry `balanceAfter`, the balance before the first new
 * transaction must equal the ledger balance, and the chain must be unbroken; otherwise
 * the whole import is refused. After the import the ledger balance must equal the last
 * reported balance.
 */
export async function recordTransactions(
  tx: Tx,
  bankAccountId: string,
  incoming: NormalizedBankTransaction[],
  actor: Actor,
  opts: { importId?: string | null; statementClosing?: { date: LocalDate; amount: Cents } | null } = {},
): Promise<RecordResult> {
  const [bank] = await tx.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, bankAccountId));
  if (!bank) throw new ImportError("Onbekende bankrekening");

  const existingRows = incoming.length
    ? await tx
        .select()
        .from(schema.bankTransactions)
        .where(
          and(
            eq(schema.bankTransactions.bankAccountId, bankAccountId),
            inArray(
              schema.bankTransactions.externalId,
              incoming.map((t) => t.externalId),
            ),
          ),
        )
    : [];
  const existingById = new Map(existingRows.map((r) => [r.externalId, r]));

  const seen = new Set<string>();
  const fresh: NormalizedBankTransaction[] = [];
  let duplicates = 0;
  for (const t of incoming) {
    if (bank.iban && t.accountIban && normalizeIban(t.accountIban) !== bank.iban) {
      throw new ImportError(`Transactie ${t.externalId} hoort niet bij rekening ${bank.iban}`);
    }
    if (seen.has(t.externalId)) throw new ImportError(`Volgnummer ${t.externalId} komt twee keer voor in het bestand`);
    seen.add(t.externalId);
    const existing = existingById.get(t.externalId);
    if (existing) {
      if (!sameContent(existing, t)) {
        throw new ImportError(
          `Transactie ${t.externalId} wijkt af van een eerder geïmporteerde transactie met hetzelfde volgnummer`,
        );
      }
      duplicates++;
    } else {
      fresh.push(t);
    }
  }

  // Keep file order for continuity; banks export in booking order. Sort by date as a safety net
  // without breaking the original order within a day.
  const ordered = fresh
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.bookingDate === b.t.bookingDate ? a.i - b.i : a.t.bookingDate < b.t.bookingDate ? -1 : 1))
    .map(({ t }) => t);

  if (ordered.length > 0 && ordered.some((t) => t.balanceAfter !== null)) {
    if (ordered.some((t) => t.balanceAfter === null)) {
      throw new ImportError("Niet alle transacties hebben een saldo na transactie");
    }
    // Only transactions after everything already booked may be added; a gap in the middle
    // of existing history would change the saldo chain.
    const [last] = await tx
      .select()
      .from(schema.bankTransactions)
      .where(eq(schema.bankTransactions.bankAccountId, bankAccountId))
      .orderBy(desc(schema.bankTransactions.bookingDate), desc(schema.bankTransactions.createdAt))
      .limit(1);
    if (last && ordered[0].bookingDate < last.bookingDate) {
      throw new ImportError(
        `Nieuwe transactie van ${ordered[0].bookingDate} ligt vóór de laatst geïmporteerde transactie (${last.bookingDate})`,
      );
    }
    let running = await bankLedgerBalance(tx, bankAccountId);
    for (const t of ordered) {
      const before = cents((t.balanceAfter as number) - t.amount);
      if (before !== running) {
        throw new ImportError(
          `Saldo sluit niet aan vóór transactie ${t.externalId} van ${t.bookingDate}: verwacht ${formatEuro(running)}, ` +
            `bank meldt ${formatEuro(before)}. Er ontbreken transacties; exporteer een periode die aansluit op de vorige import.`,
        );
      }
      running = t.balanceAfter as Cents;
    }
  }

  const newIds: string[] = [];
  for (const t of ordered) {
    const [row] = await tx
      .insert(schema.bankTransactions)
      .values({
        bankAccountId,
        externalId: t.externalId,
        bookingDate: t.bookingDate,
        valueDate: t.valueDate,
        amountCents: t.amount,
        balanceAfterCents: t.balanceAfter,
        counterpartyIban: t.counterpartyIban ? normalizeIban(t.counterpartyIban) : null,
        counterpartyName: t.counterpartyName,
        description: t.description,
        endToEndId: t.endToEndId ?? null,
        paymentReference: t.paymentReference ?? null,
        returnReason: t.returnReason ?? null,
        raw: t.raw ?? null,
        importId: opts.importId ?? null,
        enteredBy: actor.userId,
      })
      .returning({ id: schema.bankTransactions.id });
    newIds.push(row.id);
    if (t.amount !== 0) {
      await postEntry(
        tx,
        bankTransactionImported({
          tx: { id: row.id, date: t.bookingDate, amount: t.amount, description: t.description },
          bankLedgerAccountId: bank.ledgerAccountId,
          isCash: bank.kind === "cash",
        }),
        actor,
      );
    }
  }

  const last = ordered.at(-1);
  if (last && last.balanceAfter !== null) {
    const ledger = await bankLedgerBalance(tx, bankAccountId);
    if (ledger !== last.balanceAfter) {
      throw new ImportError(`Banksaldo in de boekhouding (${formatEuro(ledger)}) ≠ saldo bank (${formatEuro(last.balanceAfter)})`);
    }
  }
  if (opts.statementClosing) {
    const ledger = await bankLedgerBalance(tx, bankAccountId, opts.statementClosing.date);
    if (ledger !== opts.statementClosing.amount) {
      throw new ImportError(
        `Eindsaldo afschrift (${formatEuro(opts.statementClosing.amount)}) ≠ banksaldo in de boekhouding (${formatEuro(ledger)})`,
      );
    }
  }

  // Certain matches only: internal transfers between own accounts.
  let autoAssigned = 0;
  if (newIds.length > 0) {
    const ownIbans = new Set(
      (await tx.select({ iban: schema.bankAccounts.iban }).from(schema.bankAccounts))
        .map((r) => r.iban)
        .filter((x): x is string => !!x),
    );
    const rows = await tx.select().from(schema.bankTransactions).where(inArray(schema.bankTransactions.id, newIds));
    for (const row of rows) {
      if (row.amountCents !== 0 && row.counterpartyIban && ownIbans.has(row.counterpartyIban) && row.counterpartyIban !== bank.iban) {
        await assignTransaction(tx, row.id, [{ kind: "internal", amount: cents(row.amountCents) }], actor, {
          isAutomatic: true,
        });
        autoAssigned++;
      }
    }
  }

  await audit(tx, {
    actorUserId: actor.userId,
    action: "bank.record",
    entityType: "bank_account",
    entityId: bankAccountId,
    data: { new: newIds.length, duplicates, autoAssigned, importId: opts.importId ?? null },
  });
  return { newIds, duplicates, autoAssigned };
}

/** Cash book: manually entered cash mutation (T19), afterwards assigned like a bank line. */
export async function recordCashMutation(
  tx: Tx,
  input: { bankAccountId: string; date: LocalDate; amount: Cents; description: string },
  actor: Actor,
) {
  const [bank] = await tx.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, input.bankAccountId));
  if (!bank || bank.kind !== "cash") throw new ImportError("Dit is geen kasrekening");
  if (input.amount === 0) throw new ImportError("Bedrag mag niet 0 zijn");
  const [{ n }] = await tx
    .select({ n: sql<string>`count(*)` })
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.bankAccountId, bank.id));
  const result = await recordTransactions(
    tx,
    bank.id,
    [
      {
        accountIban: null,
        externalId: `KAS-${String(Number(n) + 1).padStart(6, "0")}`,
        bookingDate: input.date,
        valueDate: input.date,
        amount: input.amount,
        balanceAfter: null,
        counterpartyIban: null,
        counterpartyName: null,
        description: input.description,
      },
    ],
    actor,
  );
  return result.newIds[0];
}

async function loadTransaction(tx: Tx, bankTransactionId: string) {
  const [row] = await tx
    .select()
    .from(schema.bankTransactions)
    .where(eq(schema.bankTransactions.id, bankTransactionId));
  if (!row) throw new ImportError("Banktransactie niet gevonden");
  return row;
}

/** Remaining (unassigned) amount of a transaction: its balance on 1099, negated. */
export async function unassignedAmount(tx: Tx, bankTransactionId: string): Promise<Cents> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${schema.journalLines.amountCents}), 0)` })
    .from(schema.journalLines)
    .innerJoin(schema.ledgerAccounts, eq(schema.ledgerAccounts.id, schema.journalLines.accountId))
    .where(
      and(
        eq(schema.journalLines.bankTransactionId, bankTransactionId),
        eq(schema.ledgerAccounts.systemKey, "BANK_SUSPENSE"),
      ),
    );
  // After import 1099 carries -amount; an assignment brings it back to 0.
  return cents(-centsFromDb(row.total));
}

export async function assignTransaction(
  tx: Tx,
  bankTransactionId: string,
  targets: AssignmentTarget[],
  actor: Actor,
  opts: { isAutomatic?: boolean; description?: string } = {},
) {
  const row = await loadTransaction(tx, bankTransactionId);
  const open = await unassignedAmount(tx, bankTransactionId);
  if (open === 0) throw new ImportError("Deze transactie is al toegewezen");
  if (open !== row.amountCents) throw new ImportError("Deze transactie is gedeeltelijk toegewezen; maak dat eerst ongedaan");
  const entry = await postEntry(
    tx,
    assignBankTransaction({
      tx: {
        id: row.id,
        date: localDate(row.bookingDate),
        amount: cents(row.amountCents),
        description: row.description || row.counterpartyName || "Banktransactie",
      },
      targets,
      isAutomatic: opts.isAutomatic,
      description: opts.description,
    }),
    actor,
  );
  await audit(tx, {
    actorUserId: actor.userId,
    action: opts.isAutomatic ? "bank.assign.auto" : "bank.assign",
    entityType: "bank_transaction",
    entityId: row.id,
    data: { entryId: entry.id, targets: targets.map((t) => ({ kind: t.kind, amount: t.amount })) },
  });
  return entry;
}

/** Undo the current assignment of a transaction (T30 = reversal of the assignment entry). */
export async function unassignTransaction(tx: Tx, bankTransactionId: string, reason: string, actor: Actor) {
  const row = await loadTransaction(tx, bankTransactionId);
  const entries = await tx
    .select()
    .from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.sourceType, "bank_transaction"), eq(schema.journalEntries.sourceId, row.id)))
    .orderBy(asc(schema.journalEntries.createdAt));
  const reversed = new Set(entries.map((e) => e.reversesEntryId).filter(Boolean));
  const active = entries.filter(
    (e) => e.template !== "T00" && e.template !== "T19" && !e.reversesEntryId && !reversed.has(e.id),
  );
  if (active.length === 0) throw new ImportError("Deze transactie is niet toegewezen");
  for (const entry of active) {
    await reverseEntry(tx, entry.id, { reason }, actor);
  }
  await audit(tx, {
    actorUserId: actor.userId,
    action: "bank.unassign",
    entityType: "bank_transaction",
    entityId: row.id,
    reason,
  });
}
