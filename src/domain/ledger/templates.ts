/**
 * Journal entry templates (PLAN.md §5). Every template is a pure function that turns a
 * business event into an EntryDraft whose lines sum to zero. No I/O, no clock.
 *
 * Sign convention: amount > 0 is debit, amount < 0 is credit.
 */
import { allocate, cents, negate, sum, ZERO, type Cents } from "../money";
import type { LocalDate } from "../dates";
import {
  LedgerError,
  type AccountRef,
  type EntryDraft,
  type LineDraft,
  type TemplateCode,
} from "./types";

export type PartyKind = "member" | "external";

export function personAccount(kind: PartyKind): AccountRef {
  return { key: kind === "member" ? "MEMBER_ACCOUNTS" : "EXTERNAL_ACCOUNTS" };
}

/** Structural validation shared by all templates and by postEntry(). */
export function validateDraft(draft: EntryDraft): void {
  if (draft.lines.length < 2) {
    throw new LedgerError("Een journaalpost heeft minimaal twee regels nodig");
  }
  for (const line of draft.lines) {
    if (!Number.isSafeInteger(line.amount)) {
      throw new LedgerError(`Bedrag is geen geheel aantal centen: ${line.amount}`);
    }
    if (line.amount === 0) throw new LedgerError("Een journaalregel mag geen bedrag 0 hebben");
  }
  const total = sum(draft.lines.map((l) => l.amount));
  if (total !== 0) {
    throw new LedgerError(`Journaalpost sluit niet: verschil ${total} cent`);
  }
  if (!draft.description.trim()) throw new LedgerError("Omschrijving is verplicht");
  if ((draft.template === "T29" || draft.template === "T23" || draft.template === "T27" ||
       draft.template === "T28") && !draft.reason?.trim()) {
    throw new LedgerError("Een reden/toelichting is verplicht voor deze boeking");
  }
}

function build(draft: EntryDraft): EntryDraft {
  // Drop nothing silently: templates must not produce zero lines.
  validateDraft(draft);
  return draft;
}

function nonZero(value: Cents, what: string): void {
  if (value === 0) throw new LedgerError(`${what} mag niet 0 zijn`);
}

// ---------------------------------------------------------------------------
// T00 / T19 — bank or cash transaction imported: bank ↔ suspense (1099)
// ---------------------------------------------------------------------------

export interface BankTxRef {
  id: string;
  date: LocalDate;
  amount: Cents; // + incoming, - outgoing
  description: string;
}

export function bankTransactionImported(input: {
  tx: BankTxRef;
  bankLedgerAccountId: string;
  isCash?: boolean;
}): EntryDraft {
  const { tx } = input;
  nonZero(tx.amount, "Bedrag banktransactie");
  return build({
    date: tx.date,
    template: input.isCash ? "T19" : "T00",
    description: tx.description || (input.isCash ? "Kasmutatie" : "Banktransactie"),
    sourceType: "bank_transaction",
    sourceId: tx.id,
    isAutomatic: true,
    lines: [
      { account: { id: input.bankLedgerAccountId }, amount: tx.amount, bankTransactionId: tx.id },
      { account: { key: "BANK_SUSPENSE" }, amount: negate(tx.amount), bankTransactionId: tx.id },
    ],
  });
}

// ---------------------------------------------------------------------------
// Assigning a bank transaction ("waar geboekt"): T02/T03/T07/T08/T09/T10/T14/T16/T18/T18b/T31
// ---------------------------------------------------------------------------

export type AssignmentTarget =
  | { kind: "person"; partyId: string; partyKind: PartyKind; amount: Cents; description?: string }
  | { kind: "contribution"; partyId: string; amount: Cents; description?: string }
  | { kind: "savings"; partyId: string; goalId: string; amount: Cents; description?: string }
  | { kind: "activity"; activityId: string; amount: Cents; description?: string }
  | { kind: "pot"; potId: string; accountId: string; amount: Cents; description?: string; relatedPartyId?: string | null }
  | { kind: "purchase_invoice"; invoiceId: string; partyId: string; amount: Cents; description?: string }
  | { kind: "sales_invoice"; invoiceId: string; partyId: string; amount: Cents; description?: string }
  | { kind: "internal"; amount: Cents; description?: string };

function assignmentTemplate(target: AssignmentTarget): TemplateCode {
  const incoming = target.amount > 0;
  switch (target.kind) {
    case "person":
    case "contribution":
      return incoming ? "T02" : "T03";
    case "savings":
      return "T33";
    case "activity":
      return incoming ? "T10" : "T07";
    case "pot":
      return incoming ? "T09" : "T08";
    case "purchase_invoice":
      return "T14";
    case "sales_invoice":
      return "T16";
    case "internal":
      return incoming ? "T18b" : "T18";
  }
}

function assignmentLine(target: AssignmentTarget): LineDraft {
  // The bank amount sits on 1099 with the opposite sign; the target receives -amount.
  const amount = negate(target.amount);
  const description = target.description ?? null;
  switch (target.kind) {
    case "person":
      return { account: personAccount(target.partyKind), amount, partyId: target.partyId, description };
    case "contribution":
      return { account: { key: "CONTRIBUTION_RECEIVABLE" }, amount, partyId: target.partyId, description };
    case "savings":
      return { account: { key: "MEMBER_SAVINGS" }, amount, partyId: target.partyId, savingsGoalId: target.goalId, description };
    case "activity":
      return { account: { key: "TO_DISTRIBUTE" }, amount, activityId: target.activityId, description };
    case "pot":
      return { account: { id: target.accountId }, amount, potId: target.potId, relatedPartyId: target.relatedPartyId ?? null, description };
    case "purchase_invoice":
      return {
        account: { key: "ACCOUNTS_PAYABLE" },
        amount,
        partyId: target.partyId,
        invoiceId: target.invoiceId,
        description,
      };
    case "sales_invoice":
      return {
        account: { key: "EXTERNAL_ACCOUNTS" },
        amount,
        partyId: target.partyId,
        invoiceId: target.invoiceId,
        description,
      };
    case "internal":
      return { account: { key: "INTERNAL_TRANSFER" }, amount, description };
  }
}

export function assignBankTransaction(input: {
  tx: BankTxRef;
  targets: AssignmentTarget[];
  isAutomatic?: boolean;
  description?: string;
}): EntryDraft {
  const { tx, targets } = input;
  if (targets.length === 0) throw new LedgerError("Kies minimaal één bestemming");
  for (const t of targets) nonZero(t.amount, "Bedrag per bestemming");
  const assigned = sum(targets.map((t) => t.amount));
  if (assigned !== tx.amount) {
    throw new LedgerError(
      `Toegewezen bedrag (${assigned}) is niet gelijk aan het bedrag van de transactie (${tx.amount})`,
    );
  }
  return build({
    date: tx.date,
    template: targets.length === 1 ? assignmentTemplate(targets[0]) : "T31",
    description: input.description ?? tx.description ?? "Toewijzing",
    sourceType: "bank_transaction",
    sourceId: tx.id,
    isAutomatic: input.isAutomatic ?? false,
    lines: [
      { account: { key: "BANK_SUSPENSE" }, amount: tx.amount, bankTransactionId: tx.id },
      ...targets.map((t) => ({ ...assignmentLine(t), bankTransactionId: tx.id })),
    ],
  });
}

// ---------------------------------------------------------------------------
// T01 — monthly contribution
// ---------------------------------------------------------------------------

/**
 * The monthly contribution is owed on the member's contribution account (1305) and booked as
 * income on account Contributie, divided over pots with the association's key (verdeelsleutel).
 */
export function contributionCharged(input: {
  chargeId: string;
  partyId: string;
  month: LocalDate; // first day of month, also the booking date
  amount: Cents;
  incomeAccountId: string;
  /** Pots with integer weights (e.g. percentages). The income is split exactly (largest remainder). */
  split: { potId: string; weight: number }[];
  description: string;
}): EntryDraft {
  if (input.amount <= 0) throw new LedgerError("Contributie moet positief zijn");
  if (input.split.length === 0) throw new LedgerError("De contributie-verdeelsleutel is leeg");
  const parts = allocate(input.amount, input.split.map((p) => p.weight));
  return build({
    date: input.month,
    template: "T01",
    description: input.description,
    sourceType: "contribution_charge",
    sourceId: input.chargeId,
    isAutomatic: true,
    lines: [
      { account: { key: "CONTRIBUTION_RECEIVABLE" }, amount: input.amount, partyId: input.partyId },
      ...input.split
        .map((p, i) => ({ account: { id: input.incomeAccountId }, amount: negate(parts[i]), potId: p.potId }))
        .filter((l) => l.amount !== 0),
    ],
  });
}

// T32 — use a member's savings (spaarplan) to pay what they owe on their account
export function savingsSettled(input: {
  partyId: string;
  goalId: string;
  goalName: string;
  date: LocalDate;
  amount: Cents; // > 0: moved from savings to the member's account
}): EntryDraft {
  nonZero(input.amount, "Bedrag");
  return build({
    date: input.date,
    template: "T32",
    description: `Spaargeld ${input.goalName} verrekend`,
    sourceType: "savings_goal",
    sourceId: input.goalId,
    lines: [
      { account: { key: "MEMBER_SAVINGS" }, amount: input.amount, partyId: input.partyId, savingsGoalId: input.goalId },
      { account: { key: "MEMBER_ACCOUNTS" }, amount: negate(input.amount), partyId: input.partyId },
    ],
  });
}

// ---------------------------------------------------------------------------
// Cost/income target used by claims, charges and purchase invoices
// ---------------------------------------------------------------------------

export type CostTarget =
  | { kind: "activity"; activityId: string }
  | { kind: "pot"; potId: string; accountId: string };

function costTargetLine(target: CostTarget, amount: Cents, description?: string | null): LineDraft {
  return target.kind === "activity"
    ? { account: { key: "TO_DISTRIBUTE" }, amount, activityId: target.activityId, description }
    : { account: { id: target.accountId }, amount, potId: target.potId, description };
}

// T05 — expense claim approved: cost on activity or pot, credit on claimant's account
export function expenseClaimApproved(input: {
  claimId: string;
  partyId: string;
  date: LocalDate;
  amount: Cents;
  target: CostTarget;
  description: string;
}): EntryDraft {
  if (input.amount <= 0) throw new LedgerError("Declaratiebedrag moet positief zijn");
  return build({
    date: input.date,
    template: "T05",
    description: input.description,
    sourceType: "expense_claim",
    sourceId: input.claimId,
    lines: [
      costTargetLine(input.target, input.amount),
      { account: { key: "MEMBER_ACCOUNTS" }, amount: negate(input.amount), partyId: input.partyId },
    ],
  });
}

// T12 — put an amount on someone's account (activity or pot income on the other side)
export function chargedToPerson(input: {
  partyId: string;
  partyKind: PartyKind;
  date: LocalDate;
  amount: Cents; // > 0: person owes more; < 0: person gets credit
  target: CostTarget;
  description: string;
  sourceType?: string;
  sourceId?: string;
}): EntryDraft {
  nonZero(input.amount, "Bedrag");
  return build({
    date: input.date,
    template: "T12",
    description: input.description,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    lines: [
      { account: personAccount(input.partyKind), amount: input.amount, partyId: input.partyId },
      costTargetLine(input.target, negate(input.amount)),
    ],
  });
}

// ---------------------------------------------------------------------------
// T11 — settle an activity: distribute the "to distribute" balance
// ---------------------------------------------------------------------------

export type ShareMethod = "equal" | "weight" | "fixed";

export interface SettlementShareInput {
  /** null partyId = the association itself (dispuutsdeel, charged to the activity's pot). */
  partyId: string | null;
  partyKind?: PartyKind;
  method: ShareMethod;
  weight?: number; // for "weight"
  fixedAmount?: Cents; // for "fixed"
}

export interface SettlementAllocation {
  partyId: string | null;
  partyKind?: PartyKind;
  amount: Cents;
}

/**
 * Compute who pays what. Fixed amounts first; the remainder is split over "equal" (weight 1)
 * and "weight" shares with the largest remainder method. The result always sums to `total`.
 */
export function computeSettlement(
  total: Cents,
  shares: readonly SettlementShareInput[],
): SettlementAllocation[] {
  if (shares.length === 0) {
    if (total === 0) return [];
    throw new LedgerError("Kies minimaal één deelnemer om het bedrag over te verdelen");
  }
  const seen = new Set<string>();
  for (const s of shares) {
    const key = s.partyId ?? "__dispuut__";
    if (seen.has(key)) throw new LedgerError("Iedere deelnemer mag maar één keer voorkomen");
    seen.add(key);
    if (s.partyId !== null && !s.partyKind) throw new LedgerError("Soort deelnemer ontbreekt");
    if (s.method === "fixed" && (s.fixedAmount === undefined || !Number.isSafeInteger(s.fixedAmount))) {
      throw new LedgerError("Vast bedrag ontbreekt");
    }
    if (s.method === "weight" && (!Number.isSafeInteger(s.weight) || (s.weight ?? -1) < 0)) {
      throw new LedgerError("Gewicht moet een geheel getal ≥ 0 zijn");
    }
  }

  const fixedTotal = sum(shares.filter((s) => s.method === "fixed").map((s) => s.fixedAmount as Cents));
  const remainder = cents(total - fixedTotal);
  const variableIdx = shares
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.method !== "fixed");
  const weights = variableIdx.map(({ s }) => (s.method === "equal" ? 1 : (s.weight as number)));

  let variableAmounts: Cents[];
  if (variableIdx.length === 0 || weights.every((w) => w === 0)) {
    if (remainder !== 0) {
      throw new LedgerError(
        `De vaste bedragen tellen niet op tot het te verdelen bedrag (verschil ${remainder} cent)`,
      );
    }
    variableAmounts = variableIdx.map(() => ZERO);
  } else {
    variableAmounts = allocate(remainder, weights);
  }

  const result: SettlementAllocation[] = shares.map((s) => ({
    partyId: s.partyId,
    partyKind: s.partyKind,
    amount: s.method === "fixed" ? (s.fixedAmount as Cents) : ZERO,
  }));
  variableIdx.forEach(({ i }, k) => {
    result[i].amount = variableAmounts[k];
  });
  return result;
}

export function activitySettled(input: {
  activityId: string;
  activityName: string;
  date: LocalDate;
  balance: Cents; // current balance on 1350 for this activity (debit = costs to distribute)
  allocations: SettlementAllocation[];
  potId: string; // pot of the activity, for the association's share
  expenseAccountId: string;
}): EntryDraft | null {
  const allocated = sum(input.allocations.map((a) => a.amount));
  if (allocated !== input.balance) {
    throw new LedgerError(
      `Verdeling (${allocated}) sluit niet aan op het te verdelen saldo (${input.balance})`,
    );
  }
  if (input.balance === 0 && input.allocations.every((a) => a.amount === 0)) return null;

  const lines: LineDraft[] = [];
  if (input.balance !== 0) {
    lines.push({
      account: { key: "TO_DISTRIBUTE" },
      amount: negate(input.balance),
      activityId: input.activityId,
    });
  }
  for (const a of input.allocations) {
    if (a.amount === 0) continue;
    if (a.partyId === null) {
      lines.push({
        account: { id: input.expenseAccountId },
        amount: a.amount,
        potId: input.potId,
        activityId: input.activityId,
        description: "Dispuutsdeel",
      });
    } else {
      lines.push({
        account: personAccount(a.partyKind as PartyKind),
        amount: a.amount,
        partyId: a.partyId,
        activityId: input.activityId,
      });
    }
  }
  return build({
    date: input.date,
    template: "T11",
    description: `Afrekening ${input.activityName}`,
    sourceType: "activity",
    sourceId: input.activityId,
    lines,
  });
}

// ---------------------------------------------------------------------------
// T13 / T15 / T17 — invoices
// ---------------------------------------------------------------------------

export function purchaseInvoiceReceived(input: {
  invoiceId: string;
  partyId: string;
  date: LocalDate;
  amount: Cents;
  target: CostTarget;
  description: string;
}): EntryDraft {
  nonZero(input.amount, "Factuurbedrag");
  return build({
    date: input.date,
    template: "T13",
    description: input.description,
    sourceType: "purchase_invoice",
    sourceId: input.invoiceId,
    lines: [
      costTargetLine(input.target, input.amount),
      {
        account: { key: "ACCOUNTS_PAYABLE" },
        amount: negate(input.amount),
        partyId: input.partyId,
        invoiceId: input.invoiceId,
      },
    ],
  });
}

export function salesInvoiceSent(input: {
  invoiceId: string;
  partyId: string;
  date: LocalDate;
  description: string;
  lines: { potId: string; incomeAccountId: string; amount: Cents; description?: string }[];
}): EntryDraft {
  const total = sum(input.lines.map((l) => l.amount));
  nonZero(total, "Factuurtotaal");
  return build({
    date: input.date,
    template: "T15",
    description: input.description,
    sourceType: "sales_invoice",
    sourceId: input.invoiceId,
    lines: [
      { account: { key: "EXTERNAL_ACCOUNTS" }, amount: total, partyId: input.partyId, invoiceId: input.invoiceId },
      ...input.lines
        .filter((l) => l.amount !== 0)
        .map((l) => ({
          account: { id: l.incomeAccountId },
          amount: negate(l.amount),
          potId: l.potId,
          description: l.description ?? null,
        })),
    ],
  });
}

// ---------------------------------------------------------------------------
// Mirror (T17 credit note, T24 auto-reversal, T27 correction)
// ---------------------------------------------------------------------------

export interface PostedLine {
  accountId: string;
  amount: Cents;
  potId: string | null;
  activityId: string | null;
  partyId: string | null;
  bankTransactionId: string | null;
  invoiceId: string | null;
  savingsGoalId?: string | null;
  relatedPartyId?: string | null;
  description: string | null;
}

export function mirrorEntry(input: {
  original: { id: string; description: string; lines: PostedLine[] };
  template: "T17" | "T24" | "T27";
  date: LocalDate;
  reason?: string;
  description?: string;
}): EntryDraft {
  return build({
    date: input.date,
    template: input.template,
    description: input.description ?? `Tegenboeking: ${input.original.description}`,
    reason: input.reason ?? null,
    reversesEntryId: input.original.id,
    sourceType: "journal_entry",
    sourceId: input.original.id,
    lines: input.original.lines.map((l) => ({
      account: { id: l.accountId },
      amount: negate(l.amount),
      potId: l.potId,
      activityId: l.activityId,
      partyId: l.partyId,
      bankTransactionId: l.bankTransactionId,
      invoiceId: l.invoiceId,
      savingsGoalId: l.savingsGoalId ?? null,
      relatedPartyId: l.relatedPartyId ?? null,
      description: l.description,
    })),
  });
}

// ---------------------------------------------------------------------------
// T20 — cash count difference
// ---------------------------------------------------------------------------

export function cashCountDifference(input: {
  cashCountId: string;
  date: LocalDate;
  cashLedgerAccountId: string;
  counted: Cents;
  book: Cents;
  potId: string;
}): EntryDraft | null {
  const difference = cents(input.counted - input.book);
  if (difference === 0) return null;
  return build({
    date: input.date,
    template: "T20",
    description: difference < 0 ? "Kastekort bij telling" : "Kasoverschot bij telling",
    sourceType: "cash_count",
    sourceId: input.cashCountId,
    lines: [
      { account: { id: input.cashLedgerAccountId }, amount: difference },
      { account: { key: "CASH_DIFFERENCES" }, amount: negate(difference), potId: input.potId },
    ],
  });
}

// ---------------------------------------------------------------------------
// T21 / T22 — designated reserves
// ---------------------------------------------------------------------------

export function reserveDotation(input: {
  date: LocalDate;
  reserveAccountId: string;
  amount: Cents;
  potId: string;
  description: string;
}): EntryDraft {
  if (input.amount <= 0) throw new LedgerError("Dotatie moet positief zijn");
  return build({
    date: input.date,
    template: "T21",
    description: input.description,
    lines: [
      { account: { key: "RESERVE_DOTATION" }, amount: input.amount, potId: input.potId },
      { account: { id: input.reserveAccountId }, amount: negate(input.amount) },
    ],
  });
}

export function reserveWithdrawal(input: {
  date: LocalDate;
  reserveAccountId: string;
  amount: Cents;
  potId: string;
  description: string;
}): EntryDraft {
  if (input.amount <= 0) throw new LedgerError("Onttrekking moet positief zijn");
  return build({
    date: input.date,
    template: "T22",
    description: input.description,
    lines: [
      { account: { id: input.reserveAccountId }, amount: input.amount },
      { account: { key: "RESERVE_WITHDRAWAL" }, amount: negate(input.amount), potId: input.potId },
    ],
  });
}

// ---------------------------------------------------------------------------
// T23 / T29 — memorial (manual) entries
// ---------------------------------------------------------------------------

export function memorial(input: {
  date: LocalDate;
  description: string;
  reason: string;
  lines: LineDraft[];
  autoReverse?: boolean;
}): EntryDraft {
  return build({
    date: input.date,
    template: input.autoReverse ? "T23" : "T29",
    description: input.description,
    reason: input.reason,
    autoReverse: input.autoReverse ?? false,
    lines: input.lines,
  });
}

// ---------------------------------------------------------------------------
// T25 / T25b — year end closing and result appropriation
// ---------------------------------------------------------------------------

export function yearClose(input: {
  date: LocalDate;
  fiscalYearLabel: string;
  /** Balance per income/expense account × pot for the fiscal year (debit positive). */
  balances: { accountId: string; potId: string; amount: Cents }[];
  /** Where the result goes. Amounts are the result share (profit positive). Must sum to the result. */
  appropriation: { accountId: string; amount: Cents }[];
}): { closing: EntryDraft | null; appropriation: EntryDraft | null; result: Cents } {
  const nonZeroBalances = input.balances.filter((b) => b.amount !== 0);
  const balanceTotal = sum(nonZeroBalances.map((b) => b.amount));
  const result = negate(balanceTotal); // profit = credit surplus

  const appropriated = sum(input.appropriation.map((a) => a.amount));
  if (appropriated !== result) {
    throw new LedgerError(
      `Resultaatbestemming (${appropriated}) is niet gelijk aan het resultaat (${result})`,
    );
  }

  let closing: EntryDraft | null = null;
  if (nonZeroBalances.length > 0) {
    const lines: LineDraft[] = nonZeroBalances.map((b) => ({
      account: { id: b.accountId },
      amount: negate(b.amount),
      potId: b.potId,
    }));
    if (balanceTotal !== 0) lines.push({ account: { key: "YEAR_RESULT" }, amount: balanceTotal });
    closing = build({
      date: input.date,
      template: "T25",
      description: `Jaarafsluiting ${input.fiscalYearLabel}`,
      isAutomatic: true,
      lines,
    });
  }

  let appropriation: EntryDraft | null = null;
  const shares = input.appropriation.filter((a) => a.amount !== 0);
  if (result !== 0) {
    appropriation = build({
      date: input.date,
      template: "T25b",
      description: `Resultaatbestemming ${input.fiscalYearLabel}`,
      lines: [
        { account: { key: "YEAR_RESULT" }, amount: result },
        ...shares.map((a) => ({ account: { id: a.accountId }, amount: negate(a.amount) })),
      ],
    });
  }
  return { closing, appropriation, result };
}

// ---------------------------------------------------------------------------
// T26 — opening balance (setup wizard)
// ---------------------------------------------------------------------------

export function openingBalance(input: {
  date: LocalDate;
  bank: { ledgerAccountId: string; amount: Cents }[];
  persons: { partyId: string; partyKind: PartyKind; amount: Cents }[];
  activities: { activityId: string; amount: Cents }[];
  other: { accountId: string; amount: Cents }[];
}): EntryDraft | null {
  const lines: LineDraft[] = [
    ...input.bank.map((b) => ({ account: { id: b.ledgerAccountId }, amount: b.amount })),
    ...input.persons.map((p) => ({ account: personAccount(p.partyKind), amount: p.amount, partyId: p.partyId })),
    ...input.activities.map((a) => ({
      account: { key: "TO_DISTRIBUTE" } as AccountRef,
      amount: a.amount,
      activityId: a.activityId,
    })),
    ...input.other.map((o) => ({ account: { id: o.accountId }, amount: o.amount })),
  ].filter((l) => l.amount !== 0);
  if (lines.length === 0) return null;
  const balancing = negate(sum(lines.map((l) => l.amount)));
  if (balancing !== 0) lines.push({ account: { key: "GENERAL_RESERVE" }, amount: balancing });
  return build({
    date: input.date,
    template: "T26",
    description: "Beginbalans",
    reason: "Beginsituatie ingesteld bij installatie",
    lines,
  });
}

// ---------------------------------------------------------------------------
// T28 — write off an uncollectable balance
// ---------------------------------------------------------------------------

export function writeOff(input: {
  partyId: string;
  partyKind: PartyKind;
  date: LocalDate;
  amount: Cents; // positive: amount the person owed that is written off
  potId: string;
  reason: string;
}): EntryDraft {
  if (input.amount <= 0) throw new LedgerError("Af te boeken bedrag moet positief zijn");
  return build({
    date: input.date,
    template: "T28",
    description: "Afboeken oninbare vordering",
    reason: input.reason,
    lines: [
      { account: { key: "BAD_DEBTS" }, amount: input.amount, potId: input.potId },
      { account: personAccount(input.partyKind), amount: negate(input.amount), partyId: input.partyId },
    ],
  });
}
