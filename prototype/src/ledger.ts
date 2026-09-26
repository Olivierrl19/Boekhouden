/**
 * The browser prototype's bookkeeping engine.
 *
 * Same model and rules as the server version (PLAN.md): journal entries whose lines sum to zero,
 * append-only (corrections are reversals), bank lines booked on "te verwerken" (1099) at import
 * and moved by an assignment, an idempotent and gap-checked import, and a hash-chained audit log.
 * The rules the database triggers enforce on the server are enforced in `post()` here.
 *
 * Every public mutation runs inside `transact()`: it works on a copy of the state and only
 * commits when everything succeeded, so a failed action never leaves half a booking behind.
 */
import {
  activitySettled,
  assignBankTransaction,
  bankTransactionImported,
  chargedToPerson,
  computeSettlement,
  contributionCharged,
  expenseClaimApproved,
  memorial,
  mirrorEntry,
  savingsSettled,
  openingBalance,
  reserveDotation,
  validateDraft,
  yearClose,
  type AssignmentTarget,
  type CostTarget,
  type PartyKind,
  type SettlementShareInput,
} from "@/domain/ledger/templates";
import { LedgerError, type AccountRef, type EntryDraft, type LineDraft, type SystemKey } from "@/domain/ledger/types";
import { DEFAULT_ACCOUNTS, DEFAULT_POTS, type AccountType } from "@/domain/ledger/chart";
import { cents, formatEuro, sum, type Cents } from "@/domain/money";
import { addDays, addMonths, fiscalYearFor, firstOfMonth, formatMonthNl, localDate, type LocalDate } from "@/domain/dates";
import { isValidIban, normalizeIban } from "@/domain/bank/iban";
import type { NormalizedBankTransaction } from "@/domain/bank/types";
import { payerIban, suggestAssignment, type Suggestion, type SuggestionTarget } from "@/domain/bank/suggestions";
import { sha256Hex } from "./sha256";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type Role = "fiscus" | "bestuur" | "kascommissie" | "lid";
export interface Actor {
  role: Role;
  partyId: string | null; // for "lid"
  label: string;
}
export const SYSTEM_ACTOR: Actor = { role: "fiscus", partyId: null, label: "Systeem" };

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: SystemKey | null;
  partyKind: PartyKind | null;
  requiresActivity: boolean;
  manualPostingAllowed: boolean;
  active: boolean;
}
export interface Pot { id: string; code: string; name: string; incomeAccountId: string; expenseAccountId: string }
export interface FiscalYear { id: string; label: string; startDate: LocalDate; endDate: LocalDate; status: "open" | "closing" | "closed"; nextEntryNumber: number }
export interface MemberType { id: string; name: string; monthly: Cents; active: boolean }
export interface Party {
  id: string;
  kind: PartyKind;
  name: string;
  email: string | null;
  ibans: string[];
  active: boolean;
  member: { firstName: string; lastName: string; memberTypeId: string; cohort: number | null; joinedOn: LocalDate; leftOn: LocalDate | null } | null;
}
export interface BankAccount { id: string; name: string; iban: string | null; kind: "checking" | "savings" | "cash"; ledgerAccountId: string }
export interface BankTx extends NormalizedBankTransaction {
  id: string;
  bankAccountId: string;
  importedAt: string;
  /** Entered by hand (no bank file yet). A later bank import links to it instead of booking it twice. */
  manual?: boolean;
  /** Volgnummer of the bank-file transaction this manual entry was matched with. */
  matchedExternalId?: string | null;
}
export interface Line {
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
export interface Entry {
  id: string;
  fiscalYearId: string;
  entryNumber: string;
  date: LocalDate;
  template: string;
  description: string;
  sourceType: string | null;
  sourceId: string | null;
  reversesEntryId: string | null;
  isAutomatic: boolean;
  reason: string | null;
  createdBy: string;
  createdAt: string;
  lines: Line[];
}
export interface Activity { id: string; number: string; name: string; heldOn: LocalDate | null; potId: string; status: "open" | "settled"; settlementEntryId: string | null; createdAt: string }
export interface SavingsGoal { id: string; name: string; targetDate: LocalDate | null; monthly: Cents; active: boolean }
export interface Claim {
  id: string;
  partyId: string;
  amount: Cents;
  description: string;
  target: CostTarget;
  status: "submitted" | "approved" | "rejected" | "withdrawn";
  receipt: string | null; // small data URL
  rejectionReason: string | null;
  entryId: string | null;
  submittedAt: string;
  decidedAt: string | null;
}
export interface AuditRecord { id: number; at: string; actor: string; action: string; data: unknown; reason: string | null; prevHash: string | null; hash: string }
export interface BudgetLine { id: string; fiscalYearId: string; potId: string; kind: "income" | "expense"; description: string; amount: Cents }

export interface State {
  version: 2;
  settings: {
    name: string;
    paymentIban: string;
    paymentAccountName: string;
    fiscalYearStartMonth: number;
    isDemo: boolean;
    /** How contribution income is divided over pots (integer weights, e.g. percentages). */
    contributionKey: { potId: string; weight: number }[];
  };
  accounts: Account[];
  pots: Pot[];
  budgets: BudgetLine[];
  savingsGoals: SavingsGoal[];
  fiscalYears: FiscalYear[];
  memberTypes: MemberType[];
  parties: Party[];
  bankAccounts: BankAccount[];
  bankTransactions: BankTx[];
  entries: Entry[];
  activities: Activity[];
  contributionMonths: { memberId: string; month: LocalDate; entryId: string }[];
  claims: Claim[];
  audit: AuditRecord[];
  seq: number;
}

// ---------------------------------------------------------------------------
// Derived data (memoised per state object — state is never mutated after commit)
// ---------------------------------------------------------------------------

export interface Derived {
  accountById: Map<string, Account>;
  accountByKey: Map<string, Account>;
  potById: Map<string, Pot>;
  partyById: Map<string, Party>;
  fyById: Map<string, FiscalYear>;
  entryById: Map<string, Entry>;
  reversedIds: Set<string>;
  bankByLedger: Map<string, BankAccount>;
  /** Balance of each person's current account (rekening: borrels, activities, claims, externals). */
  partyBalance: Map<string, Cents>;
  /** Open contribution per member (> 0 = still to pay, < 0 = paid in advance). */
  contributionBalance: Map<string, Cents>;
  /** Savings per member per goal, key `${partyId}|${goalId}` (positive = saved). */
  savings: Map<string, Cents>;
  /** Total savings per member. */
  savingsByParty: Map<string, Cents>;
  /** Total saved per goal. */
  savingsByGoal: Map<string, Cents>;
  /** "Nog te verdelen" per activity. */
  activityBalance: Map<string, Cents>;
  /** Suspense (1099) balance per bank transaction. 0 or missing = assigned. */
  suspenseByTx: Map<string, Cents>;
  unassigned: BankTx[];
  /** Ledger balance per bank account id. */
  bankBalance: Map<string, Cents>;
}

const derivedCache = new WeakMap<State, Derived>();
/** States currently being mutated by a transaction must never be cached. */
const mutating = new WeakSet<State>();

export function derive(state: State, useCache = true): Derived {
  if (mutating.has(state)) useCache = false;
  const cached = useCache ? derivedCache.get(state) : undefined;
  if (cached) return cached;
  const accountById = new Map(state.accounts.map((a) => [a.id, a]));
  const accountByKey = new Map(state.accounts.filter((a) => a.systemKey).map((a) => [a.systemKey as string, a]));
  const bankByLedger = new Map(state.bankAccounts.map((b) => [b.ledgerAccountId, b]));
  const suspense = accountByKey.get("BANK_SUSPENSE")?.id;
  const toDistribute = accountByKey.get("TO_DISTRIBUTE")?.id;
  const partyBalance = new Map<string, number>();
  const personAccounts = new Set(["MEMBER_ACCOUNTS", "EXTERNAL_ACCOUNTS", "ACCOUNTS_PAYABLE"].map((k) => accountByKey.get(k)?.id));
  const contributionAccount = accountByKey.get("CONTRIBUTION_RECEIVABLE")?.id;
  const savingsAccount = accountByKey.get("MEMBER_SAVINGS")?.id;
  const contributionBalance = new Map<string, number>();
  const savings = new Map<string, number>();
  const savingsByParty = new Map<string, number>();
  const savingsByGoal = new Map<string, number>();
  const activityBalance = new Map<string, number>();
  const suspenseByTx = new Map<string, number>();
  const bankLedgerBalance = new Map<string, number>();
  const reversedIds = new Set<string>();
  for (const e of state.entries) {
    if (e.reversesEntryId) reversedIds.add(e.reversesEntryId);
    for (const l of e.lines) {
      if (l.partyId && personAccounts.has(l.accountId)) partyBalance.set(l.partyId, (partyBalance.get(l.partyId) ?? 0) + l.amount);
      if (l.partyId && l.accountId === contributionAccount) contributionBalance.set(l.partyId, (contributionBalance.get(l.partyId) ?? 0) + l.amount);
      if (l.partyId && l.accountId === savingsAccount) {
        const k = `${l.partyId}|${l.savingsGoalId ?? ""}`;
        savings.set(k, (savings.get(k) ?? 0) - l.amount);
        savingsByParty.set(l.partyId, (savingsByParty.get(l.partyId) ?? 0) - l.amount);
        savingsByGoal.set(l.savingsGoalId ?? "", (savingsByGoal.get(l.savingsGoalId ?? "") ?? 0) - l.amount);
      }
      if (l.accountId === toDistribute && l.activityId) activityBalance.set(l.activityId, (activityBalance.get(l.activityId) ?? 0) + l.amount);
      if (l.accountId === suspense && l.bankTransactionId) suspenseByTx.set(l.bankTransactionId, (suspenseByTx.get(l.bankTransactionId) ?? 0) + l.amount);
      if (bankByLedger.has(l.accountId)) bankLedgerBalance.set(l.accountId, (bankLedgerBalance.get(l.accountId) ?? 0) + l.amount);
    }
  }
  const d: Derived = {
    accountById,
    accountByKey,
    potById: new Map(state.pots.map((p) => [p.id, p])),
    partyById: new Map(state.parties.map((p) => [p.id, p])),
    fyById: new Map(state.fiscalYears.map((f) => [f.id, f])),
    entryById: new Map(state.entries.map((e) => [e.id, e])),
    reversedIds,
    bankByLedger,
    partyBalance: partyBalance as Map<string, Cents>,
    contributionBalance: contributionBalance as Map<string, Cents>,
    savings: savings as Map<string, Cents>,
    savingsByParty: savingsByParty as Map<string, Cents>,
    savingsByGoal: savingsByGoal as Map<string, Cents>,
    activityBalance: activityBalance as Map<string, Cents>,
    suspenseByTx: suspenseByTx as Map<string, Cents>,
    unassigned: state.bankTransactions.filter((t) => (suspenseByTx.get(t.id) ?? 0) !== 0),
    bankBalance: new Map(state.bankAccounts.map((b) => [b.id, cents(bankLedgerBalance.get(b.ledgerAccountId) ?? 0)])),
  };
  if (useCache) derivedCache.set(state, d);
  return d;
}

/** Balances per account for a fiscal year: P&L within the year, balance sheet cumulative to year end. */
export function accountBalances(state: State, fy: FiscalYear): Map<string, Cents> {
  const d = derive(state);
  const out = new Map<string, number>();
  for (const e of state.entries) {
    for (const l of e.lines) {
      const acc = d.accountById.get(l.accountId)!;
      const isResult = acc.type === "income" || acc.type === "expense";
      if (isResult ? e.fiscalYearId === fy.id : e.date <= fy.endDate) out.set(l.accountId, (out.get(l.accountId) ?? 0) + l.amount);
    }
  }
  return out as Map<string, Cents>;
}

/** Result per pot for a year, split into income and expense (both as positive numbers). */
export function resultByPot(state: State, fy: FiscalYear, opts: { excludeClosing?: boolean } = { excludeClosing: true }) {
  const d = derive(state);
  const out = new Map<string, { income: number; expense: number }>();
  for (const e of state.entries) {
    if (e.fiscalYearId !== fy.id) continue;
    if (opts.excludeClosing && (e.template === "T25" || e.template === "T25b" || (e.reversesEntryId && ["T25", "T25b"].includes(d.entryById.get(e.reversesEntryId)?.template ?? "")))) continue;
    for (const l of e.lines) {
      if (!l.potId) continue;
      const acc = d.accountById.get(l.accountId)!;
      const row = out.get(l.potId) ?? { income: 0, expense: 0 };
      if (acc.type === "income") row.income += -l.amount;
      else if (acc.type === "expense") row.expense += l.amount;
      out.set(l.potId, row);
    }
  }
  return out;
}

export type MonthStatus = "paid" | "partial" | "open";
export interface ContributionRow {
  party: Party;
  months: Map<LocalDate, { charged: Cents; covered: Cents; status: MonthStatus }>;
  charged: Cents; // this fiscal year
  open: Cents; // all time, > 0 still to pay
  advance: Cents; // paid ahead (credit)
}

/**
 * Who paid their contribution: payments on the contribution account are matched to the oldest
 * months first (FIFO), so each month shows paid / partly paid / open.
 */
export function contributionOverview(state: State, fy: FiscalYear): { months: LocalDate[]; rows: ContributionRow[] } {
  const d = derive(state);
  const account = d.accountByKey.get("CONTRIBUTION_RECEIVABLE")?.id;
  const months: LocalDate[] = [];
  for (let m = fy.startDate; m <= fy.endDate; m = addMonths(m, 1)) months.push(m);
  const charges = new Map<string, { month: LocalDate; amount: number }[]>();
  const paid = new Map<string, number>();
  for (const e of state.entries) {
    for (const l of e.lines) {
      if (l.accountId !== account || !l.partyId) continue;
      if (e.template === "T01" && !d.reversedIds.has(e.id)) {
        charges.set(l.partyId, [...(charges.get(l.partyId) ?? []), { month: e.date, amount: l.amount }]);
      } else if (!(e.reversesEntryId && d.entryById.get(e.reversesEntryId)?.template === "T01")) {
        paid.set(l.partyId, (paid.get(l.partyId) ?? 0) - l.amount);
      }
    }
  }
  const rows: ContributionRow[] = [];
  for (const party of state.parties.filter((p) => p.member)) {
    const list = (charges.get(party.id) ?? []).sort((a, b) => (a.month < b.month ? -1 : 1));
    let pool = paid.get(party.id) ?? 0;
    const map = new Map<LocalDate, { charged: Cents; covered: Cents; status: MonthStatus }>();
    let charged = 0;
    for (const c of list) {
      const covered = Math.max(0, Math.min(pool, c.amount));
      pool -= covered;
      if (c.month >= fy.startDate && c.month <= fy.endDate) {
        charged += c.amount;
        map.set(c.month, { charged: cents(c.amount), covered: cents(covered), status: covered >= c.amount ? "paid" : covered > 0 ? "partial" : "open" });
      }
    }
    const balance = d.contributionBalance.get(party.id) ?? 0;
    if (!list.length && balance === 0 && !party.active) continue;
    rows.push({ party, months: map, charged: cents(charged), open: cents(Math.max(0, balance)), advance: cents(Math.max(0, -balance)) });
  }
  rows.sort((a, b) => a.party.name.localeCompare(b.party.name));
  return { months, rows };
}

/** Donations per giver (informational party on lines of the donations pot) for a fiscal year. */
export function donationsByGiver(state: State, fy: FiscalYear): { partyId: string | null; amount: Cents }[] {
  const d = derive(state);
  const pot = state.pots.find((p) => p.code === "DONATIES");
  const out = new Map<string | null, number>();
  for (const e of state.entries) {
    if (e.fiscalYearId !== fy.id || e.template === "T25") continue;
    for (const l of e.lines) {
      if (l.potId !== pot?.id || d.accountById.get(l.accountId)?.type !== "income") continue;
      out.set(l.relatedPartyId ?? null, (out.get(l.relatedPartyId ?? null) ?? 0) - l.amount);
    }
  }
  return [...out].map(([partyId, amount]) => ({ partyId, amount: cents(amount) })).filter((x) => x.amount !== 0).sort((a, b) => b.amount - a.amount);
}

/** Upgrade a saved state (e.g. an older backup) to the current version. */
export function migrateState(raw: unknown): State {
  const s = raw as State & { version: number; budgets: unknown[] };
  if (!s || !Array.isArray(s.entries)) throw new Error("Dit is geen back-up van deze boekhouding");
  if (s.version === 2) return s;
  if (s.version !== 1) throw new Error(`Onbekende versie ${s.version}`);
  const nextId = (p: string) => `${p}${(++s.seq).toString(36)}`;
  const add = (code: string) => {
    const def = DEFAULT_ACCOUNTS.find((a) => a.code === code)!;
    if (s.accounts.some((a) => a.code === code)) return;
    s.accounts.push({ id: nextId("a"), code, name: def.name, type: def.type, systemKey: def.systemKey ?? null, partyKind: def.partyKind ?? null, requiresActivity: false, manualPostingAllowed: true, active: true });
  };
  add("1305");
  add("1740");
  const donations = s.accounts.find((a) => a.code === "8110");
  if (donations) donations.systemKey = "DONATIONS";
  if (!s.pots.some((p) => p.code === "DONATIES") && donations) {
    const general = s.pots.find((p) => p.code === "ALGEMEEN")!;
    s.pots.push({ id: nextId("p"), code: "DONATIES", name: "Donaties", incomeAccountId: donations.id, expenseAccountId: general.expenseAccountId });
  }
  const old = s.budgets as unknown as { fiscalYearId: string; potId: string; kind: "income" | "expense"; amount: Cents }[];
  s.budgets = old.map((b) => ({ id: nextId("bl"), fiscalYearId: b.fiscalYearId, potId: b.potId, kind: b.kind, description: "Begroting", amount: b.amount }));
  s.savingsGoals = [];
  s.settings.contributionKey = [{ potId: s.pots.find((p) => p.code === "CONTRIBUTIE")!.id, weight: 100 }];
  const counters = new Map<string, number>();
  for (const a of s.activities as (Activity & { number?: string })[]) {
    const fy = fiscalYearFor(a.heldOn ?? localDate(a.createdAt.slice(0, 10)), s.settings.fiscalYearStartMonth);
    const prefix = `A${fy.startDate.slice(2, 4)}-`;
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    a.number = `${prefix}${String(n).padStart(3, "0")}`;
  }
  s.version = 2;
  return s;
}

export function currentFiscalYear(state: State, today: LocalDate): FiscalYear | null {
  return (
    state.fiscalYears.find((f) => f.startDate <= today && f.endDate >= today) ??
    [...state.fiscalYears].sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0] ??
    null
  );
}

// ---------------------------------------------------------------------------
// Permissions (same capability model as the server, PLAN.md §10)
// ---------------------------------------------------------------------------

export type Capability = "viewAll" | "edit" | "approve" | "admin";
const CAPS: Record<Capability, Role[]> = {
  viewAll: ["fiscus", "bestuur", "kascommissie"],
  edit: ["fiscus", "bestuur"],
  approve: ["fiscus"],
  admin: ["fiscus"],
};
export function can(actor: Actor, capability: Capability): boolean {
  return CAPS[capability].includes(actor.role);
}
function require(actor: Actor, capability: Capability) {
  if (!can(actor, capability)) {
    throw new LedgerError(actor.role === "kascommissie" ? "De kascommissie kan alleen kijken, niets wijzigen" : "Je hebt geen rechten voor deze actie");
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ImportError extends Error {}

/** One destination of a bank transaction as chosen in the UI ("waar geboekt"). */
export interface AssignPart {
  kind: "person" | "contribution" | "savings" | "activity" | "pot" | "internal";
  id?: string; // party, activity or pot
  goalId?: string; // savings goal
  donorId?: string | null; // informational, for donations to a pot
  amount: Cents;
  description?: string;
}

export interface ImportResult { added: number; duplicates: number; autoAssigned: number; accounts: string[] }

type Listener = () => void;

export class LedgerStore {
  private state: State;
  private listeners = new Set<Listener>();
  constructor(
    initial: State,
    private readonly persist: (s: State) => void = () => {},
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.state = initial;
  }

  // -- plumbing -------------------------------------------------------------

  getState = (): State => this.state;
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  replaceState(next: State) {
    this.state = next;
    this.persist(next);
    this.listeners.forEach((l) => l());
  }

  private depth = 0;

  /** Run `fn` on a working copy; commit only when it succeeds. Nested calls join the outer one. */
  transact<T>(fn: (s: State) => T): T {
    if (this.depth > 0) return fn(this.state);
    const working = structuredClone(this.state);
    const previous = this.state;
    this.state = working;
    this.depth++;
    mutating.add(working);
    try {
      const result = fn(working);
      this.depth--;
      mutating.delete(working);
      derivedCache.delete(working);
      this.persist(working);
      this.listeners.forEach((l) => l());
      return result;
    } catch (err) {
      this.depth--;
      mutating.delete(working);
      this.state = previous;
      throw err;
    }
  }

  /** Derived data; never cached while a transaction is mutating the working copy. */
  private dv(s: State): Derived {
    return derive(s, this.depth === 0);
  }

  private id(s: State, prefix: string) {
    s.seq += 1;
    return `${prefix}${s.seq.toString(36)}`;
  }
  private now() {
    return this.clock().toISOString();
  }

  private audit(s: State, actor: Actor, action: string, data: unknown, reason: string | null = null) {
    const prev = s.audit.at(-1)?.hash ?? null;
    const record = { id: s.audit.length + 1, at: this.now(), actor: actor.label, action, data: JSON.parse(JSON.stringify(data ?? null)), reason };
    const hash = sha256Hex((prev ?? "") + JSON.stringify(record));
    s.audit.push({ ...record, prevHash: prev, hash });
  }

  // -- the single write path for money --------------------------------------

  private resolve(s: State, ref: AccountRef): Account {
    const acc = "key" in ref ? s.accounts.find((a) => a.systemKey === ref.key) : s.accounts.find((a) => a.id === ref.id);
    if (!acc) throw new LedgerError(`Onbekende grootboekrekening ${"key" in ref ? ref.key : ref.id}`);
    return acc;
  }

  private post(s: State, draft: EntryDraft, actor: Actor): Entry {
    validateDraft(draft);
    const fy = s.fiscalYears.find((f) => f.startDate <= draft.date && f.endDate >= draft.date);
    if (!fy) throw new LedgerError(`Er is geen boekjaar voor ${draft.date}`);
    if (fy.status === "closed") throw new LedgerError(`Boekjaar ${fy.label} is afgesloten`);
    if (fy.status === "closing" && !["T25", "T25b", "T27"].includes(draft.template)) throw new LedgerError(`Boekjaar ${fy.label} is in afsluiting`);

    if (draft.reversesEntryId) {
      const original = s.entries.find((e) => e.id === draft.reversesEntryId);
      if (!original) throw new LedgerError("Tegen te boeken journaalpost bestaat niet");
      if (original.reversesEntryId) throw new LedgerError("Een tegenboeking kan niet zelf worden tegengeboekt");
      if (s.entries.some((e) => e.reversesEntryId === original.id)) throw new LedgerError("Deze journaalpost is al tegengeboekt");
    }
    const reversedTemplate = draft.reversesEntryId ? s.entries.find((e) => e.id === draft.reversesEntryId)?.template : undefined;
    const manual = draft.template === "T29" || draft.template === "T23";

    const lines: Line[] = draft.lines.map((l: LineDraft) => {
      const acc = this.resolve(s, l.account);
      if (!acc.active) throw new LedgerError(`Rekening ${acc.code} is niet actief`);
      const isResult = acc.type === "income" || acc.type === "expense";
      if (isResult && !l.potId) throw new LedgerError(`Rekening ${acc.code} ${acc.name} vereist een potje`);
      if (!isResult && l.potId) throw new LedgerError(`Rekening ${acc.code} mag geen potje hebben`);
      if (acc.partyKind) {
        const party = s.parties.find((p) => p.id === l.partyId);
        if (!party) throw new LedgerError(`Rekening ${acc.code} vereist een persoon`);
        if (party.kind !== acc.partyKind) throw new LedgerError(`Rekening ${acc.code} is voor ${acc.partyKind === "member" ? "leden" : "externen"}`);
      } else if (l.partyId) throw new LedgerError(`Rekening ${acc.code} mag geen persoon hebben`);
      if (acc.requiresActivity && !l.activityId) throw new LedgerError(`Rekening ${acc.code} vereist een activiteit`);
      if (l.activityId) {
        const act = s.activities.find((a) => a.id === l.activityId);
        if (!act) throw new LedgerError("Onbekende activiteit");
        if (act.status !== "open") throw new LedgerError(`Activiteit "${act.name}" is afgerekend; heropen de activiteit eerst`);
      }
      if (acc.systemKey === "MEMBER_SAVINGS") {
        if (!l.savingsGoalId || !s.savingsGoals.some((g) => g.id === l.savingsGoalId)) throw new LedgerError("Kies een spaardoel");
      } else if (l.savingsGoalId) throw new LedgerError("Een spaardoel hoort alleen bij spaartegoeden");
      if (l.relatedPartyId && !s.parties.some((p) => p.id === l.relatedPartyId)) throw new LedgerError("Onbekende persoon");
      if (manual && !acc.manualPostingAllowed) throw new LedgerError(`Op rekening ${acc.code} ${acc.name} kan niet handmatig worden geboekt`);
      if (acc.systemKey === "BANK_SUSPENSE" && !l.bankTransactionId) throw new LedgerError("Te verwerken bankmutaties kan alleen via een banktransactie");
      const bank = s.bankAccounts.find((b) => b.ledgerAccountId === acc.id);
      if (bank) {
        if (!l.bankTransactionId) {
          const allowed = draft.template === "T26" || (draft.template === "T20" && bank.kind === "cash") ||
            (draft.template === "T27" && (reversedTemplate === "T26" || reversedTemplate === "T20"));
          if (!allowed) throw new LedgerError(`${bank.name} kan alleen via een banktransactie worden geboekt`);
        } else {
          const btx = s.bankTransactions.find((t) => t.id === l.bankTransactionId);
          if (!btx || btx.bankAccountId !== bank.id) throw new LedgerError("Banktransactie hoort niet bij deze rekening");
          if (btx.amount !== l.amount) throw new LedgerError("Bedrag op bankrekening wijkt af van de banktransactie");
          if (s.entries.some((e) => e.lines.some((x) => x.bankTransactionId === btx.id && x.accountId === acc.id))) {
            throw new LedgerError("Banktransactie is al op de bankrekening geboekt");
          }
        }
      }
      return {
        accountId: acc.id,
        amount: l.amount,
        potId: l.potId ?? null,
        activityId: l.activityId ?? null,
        partyId: l.partyId ?? null,
        bankTransactionId: l.bankTransactionId ?? null,
        invoiceId: l.invoiceId ?? null,
        savingsGoalId: l.savingsGoalId ?? null,
        relatedPartyId: l.relatedPartyId ?? null,
        description: l.description ?? null,
      };
    });
    if (sum(lines.map((l) => l.amount)) !== 0) throw new LedgerError("Journaalpost sluit niet");

    const entry: Entry = {
      id: this.id(s, "e"),
      fiscalYearId: fy.id,
      entryNumber: `${fy.label}-${String(fy.nextEntryNumber).padStart(6, "0")}`,
      date: draft.date,
      template: draft.template,
      description: draft.description,
      sourceType: draft.sourceType ?? null,
      sourceId: draft.sourceId ?? null,
      reversesEntryId: draft.reversesEntryId ?? null,
      isAutomatic: draft.isAutomatic ?? false,
      reason: draft.reason ?? null,
      createdBy: actor.label,
      createdAt: this.now(),
      lines,
    };
    fy.nextEntryNumber += 1;
    s.entries.push(entry);
    this.audit(s, actor, "journal.post", { entry: entry.entryNumber, template: entry.template, description: entry.description, lines: lines.map((l) => [l.accountId, l.amount]) }, draft.reason ?? null);
    return entry;
  }

  private reverse(s: State, entryId: string, reason: string, actor: Actor, date?: LocalDate): Entry {
    if (!reason.trim()) throw new LedgerError("Reden is verplicht voor een tegenboeking");
    const original = s.entries.find((e) => e.id === entryId);
    if (!original) throw new LedgerError("Journaalpost niet gevonden");
    if (original.template === "T00" || original.template === "T19") throw new LedgerError("Een geïmporteerde banktransactie kan niet worden tegengeboekt");
    const draft = mirrorEntry({ original: { id: original.id, description: original.description, lines: original.lines }, template: "T27", date: date ?? original.date, reason });
    draft.sourceType = original.sourceType;
    draft.sourceId = original.sourceId;
    return this.post(s, draft, actor);
  }

  // -- setup ----------------------------------------------------------------

  static install(input: {
    name: string;
    fiscalYearStartMonth: number;
    startDate: LocalDate;
    checkingIban: string;
    savingsIban: string | null;
    isDemo?: boolean;
  }): State {
    for (const iban of [input.checkingIban, input.savingsIban].filter((x): x is string => !!x)) {
      if (!isValidIban(iban)) throw new LedgerError(`Ongeldig IBAN: ${iban}`);
    }
    const s: State = {
      version: 2,
      settings: { name: input.name, paymentIban: normalizeIban(input.checkingIban), paymentAccountName: input.name, fiscalYearStartMonth: input.fiscalYearStartMonth, isDemo: !!input.isDemo, contributionKey: [] },
      accounts: [], pots: [], budgets: [], savingsGoals: [], fiscalYears: [], memberTypes: [], parties: [], bankAccounts: [],
      bankTransactions: [], entries: [], activities: [], contributionMonths: [], claims: [], audit: [], seq: 0,
    };
    const nextId = (p: string) => `${p}${(++s.seq).toString(36)}`;
    const byCode = new Map<string, string>();
    for (const a of DEFAULT_ACCOUNTS) {
      if (a.bank === "savings" && !input.savingsIban) continue;
      const id = nextId("a");
      byCode.set(a.code, id);
      s.accounts.push({
        id, code: a.code, name: a.bank === "checking" ? "Betaalrekening" : a.name, type: a.type, systemKey: a.systemKey ?? null,
        partyKind: a.partyKind ?? null, requiresActivity: !!a.requiresActivity, manualPostingAllowed: a.manualPostingAllowed ?? true, active: true,
      });
      if (a.bank) {
        s.bankAccounts.push({
          id: nextId("b"), name: a.bank === "checking" ? "Betaalrekening" : a.bank === "savings" ? "Spaarrekening" : "Kas",
          iban: a.bank === "checking" ? normalizeIban(input.checkingIban) : a.bank === "savings" ? normalizeIban(input.savingsIban!) : null,
          kind: a.bank, ledgerAccountId: id,
        });
      }
    }
    for (const p of DEFAULT_POTS) {
      s.pots.push({ id: nextId("p"), code: p.code, name: p.name, incomeAccountId: byCode.get(p.income!)!, expenseAccountId: byCode.get(p.expense!)! });
    }
    s.settings.contributionKey = [{ potId: s.pots.find((p) => p.code === "CONTRIBUTIE")!.id, weight: 100 }];
    const fy = fiscalYearFor(input.startDate, input.fiscalYearStartMonth);
    s.fiscalYears.push({ id: nextId("f"), label: fy.label, startDate: fy.startDate, endDate: fy.endDate, status: "open", nextEntryNumber: 1 });
    return s;
  }

  ensureFiscalYear(date: LocalDate, actor: Actor = SYSTEM_ACTOR): FiscalYear {
    return this.transact((s) => this.ensureFy(s, date, actor));
  }
  private ensureFy(s: State, date: LocalDate, actor: Actor): FiscalYear {
    const period = fiscalYearFor(date, s.settings.fiscalYearStartMonth);
    const existing = s.fiscalYears.find((f) => f.label === period.label);
    if (existing) return existing;
    const fy: FiscalYear = { id: this.id(s, "f"), ...period, status: "open", nextEntryNumber: 1 };
    s.fiscalYears.push(fy);
    this.audit(s, actor, "fiscal_year.create", period);
    return fy;
  }

  setOpeningBalance(input: { date: LocalDate; bank: { bankAccountId: string; amount: Cents }[] }, actor: Actor) {
    require(actor, "admin");
    return this.transact((s) => {
      if (s.entries.some((e) => e.template === "T26")) throw new LedgerError("Er is al een beginbalans");
      const draft = openingBalance({
        date: input.date,
        bank: input.bank.map((b) => ({ ledgerAccountId: s.bankAccounts.find((x) => x.id === b.bankAccountId)!.ledgerAccountId, amount: b.amount })),
        persons: [], activities: [], other: [],
      });
      if (draft) this.post(s, draft, actor);
    });
  }

  // -- members and externals ------------------------------------------------

  createMemberType(input: { name: string; monthly: Cents }, actor: Actor): MemberType {
    require(actor, "admin");
    return this.transact((s) => {
      if (!input.name.trim()) throw new LedgerError("Naam is verplicht");
      if (input.monthly < 0) throw new LedgerError("Contributie kan niet negatief zijn");
      if (s.memberTypes.some((t) => t.name.toLowerCase() === input.name.trim().toLowerCase())) throw new LedgerError("Deze soort bestaat al");
      const t: MemberType = { id: this.id(s, "t"), name: input.name.trim(), monthly: input.monthly, active: true };
      s.memberTypes.push(t);
      this.audit(s, actor, "member_type.create", t);
      return t;
    });
  }

  updateMemberType(id: string, input: { name: string; monthly: Cents }, actor: Actor) {
    require(actor, "admin");
    this.transact((s) => {
      const t = s.memberTypes.find((x) => x.id === id);
      if (!t) throw new LedgerError("Onbekende soort lid");
      if (input.monthly < 0) throw new LedgerError("Contributie kan niet negatief zijn");
      this.audit(s, actor, "member_type.update", { id, before: { ...t }, after: input });
      t.name = input.name.trim();
      t.monthly = input.monthly;
    });
  }

  private addIbans(s: State, party: Party, ibans: string[]) {
    for (const raw of ibans.filter((x) => x.trim())) {
      const iban = normalizeIban(raw);
      if (!isValidIban(iban)) throw new LedgerError(`Ongeldig IBAN: ${raw}`);
      const other = s.parties.find((p) => p.id !== party.id && p.ibans.includes(iban));
      if (other) throw new LedgerError(`IBAN ${iban} hoort al bij ${other.name}`);
      if (!party.ibans.includes(iban)) party.ibans.push(iban);
    }
  }

  createMember(input: { firstName: string; lastName: string; email?: string | null; memberTypeId: string; cohort?: number | null; joinedOn: LocalDate; ibans?: string[] }, actor: Actor): Party {
    require(actor, "edit");
    return this.transact((s) => {
      if (!input.firstName.trim() || !input.lastName.trim()) throw new LedgerError("Voor- en achternaam zijn verplicht");
      if (!s.memberTypes.some((t) => t.id === input.memberTypeId)) throw new LedgerError("Kies een soort lid");
      const p: Party = {
        id: this.id(s, "m"), kind: "member", name: `${input.firstName.trim()} ${input.lastName.trim()}`,
        email: input.email?.trim().toLowerCase() || null, ibans: [], active: true,
        member: { firstName: input.firstName.trim(), lastName: input.lastName.trim(), memberTypeId: input.memberTypeId, cohort: input.cohort ?? null, joinedOn: input.joinedOn, leftOn: null },
      };
      s.parties.push(p);
      this.addIbans(s, p, input.ibans ?? []);
      this.audit(s, actor, "member.create", { id: p.id, name: p.name });
      return p;
    });
  }

  updateMember(id: string, input: { email: string | null; memberTypeId: string; cohort: number | null; ibans: string[]; leftOn: LocalDate | null }, actor: Actor) {
    require(actor, "edit");
    this.transact((s) => {
      const p = s.parties.find((x) => x.id === id && x.member);
      if (!p?.member) throw new LedgerError("Onbekend lid");
      const before = structuredClone(p);
      p.email = input.email?.trim().toLowerCase() || null;
      p.member.memberTypeId = input.memberTypeId;
      p.member.cohort = input.cohort;
      if (input.leftOn && input.leftOn < p.member.joinedOn) throw new LedgerError("Uitschrijfdatum ligt vóór de inschrijfdatum");
      p.member.leftOn = input.leftOn;
      p.active = !input.leftOn;
      p.ibans = [];
      this.addIbans(s, p, input.ibans);
      this.audit(s, actor, "member.update", { id, before, after: structuredClone(p) });
    });
  }

  createExternal(input: { name: string; email?: string | null; ibans?: string[] }, actor: Actor): Party {
    require(actor, "edit");
    return this.transact((s) => {
      if (!input.name.trim()) throw new LedgerError("Naam is verplicht");
      const p: Party = { id: this.id(s, "x"), kind: "external", name: input.name.trim(), email: input.email?.trim() || null, ibans: [], active: true, member: null };
      s.parties.push(p);
      this.addIbans(s, p, input.ibans ?? []);
      this.audit(s, actor, "external.create", { id: p.id, name: p.name });
      return p;
    });
  }

  rememberIban(partyId: string, iban: string, actor: Actor) {
    require(actor, "edit");
    this.transact((s) => {
      const p = s.parties.find((x) => x.id === partyId);
      if (!p) throw new LedgerError("Onbekende persoon");
      this.addIbans(s, p, [iban]);
      this.audit(s, actor, "party.iban.add", { partyId, iban });
    });
  }

  // -- bank -------------------------------------------------------------------

  importTransactions(txs: NormalizedBankTransaction[], actor: Actor, opts: { fileName?: string } = {}): ImportResult {
    require(actor, "edit");
    return this.transact((s) => {
      const byAccount = new Map<string, NormalizedBankTransaction[]>();
      for (const t of txs) {
        const iban = t.accountIban ? normalizeIban(t.accountIban) : "";
        byAccount.set(iban, [...(byAccount.get(iban) ?? []), t]);
      }
      const result: ImportResult = { added: 0, duplicates: 0, autoAssigned: 0, accounts: [] };
      for (const [iban, list] of byAccount) {
        const bank = s.bankAccounts.find((b) => b.iban === iban);
        if (!bank) throw new ImportError(`Rekening ${iban || "(zonder IBAN)"} komt niet voor in de boekhouding. Voeg hem toe of exporteer alleen jullie eigen rekeningen.`);
        const r = this.importForAccount(s, bank, list, actor);
        result.added += r.added;
        result.duplicates += r.duplicates;
        result.autoAssigned += r.autoAssigned;
        result.accounts.push(bank.name);
      }
      this.audit(s, actor, "bank.import", { file: opts.fileName ?? null, ...result });
      return result;
    });
  }

  private importForAccount(s: State, bank: BankAccount, list: NormalizedBankTransaction[], actor: Actor) {
    const own = s.bankTransactions.filter((t) => t.bankAccountId === bank.id);
    const existing = new Map<string, BankTx>();
    for (const t of own) {
      existing.set(t.externalId, t);
      if (t.matchedExternalId) existing.set(t.matchedExternalId, t);
    }
    const seen = new Set<string>();
    let fresh: NormalizedBankTransaction[] = [];
    let duplicates = 0;
    for (const t of list) {
      if (seen.has(t.externalId)) throw new ImportError(`Volgnummer ${t.externalId} komt twee keer voor in het bestand`);
      seen.add(t.externalId);
      const old = existing.get(t.externalId);
      if (old) {
        const differs = old.manual ? old.amount !== t.amount : old.amount !== t.amount || old.bookingDate !== t.bookingDate || old.balanceAfter !== t.balanceAfter;
        if (differs) throw new ImportError(`Transactie ${t.externalId} wijkt af van een eerder geïmporteerde transactie met hetzelfde volgnummer`);
        duplicates++;
      } else fresh.push(t);
    }
    // Keep bank order (volgnr) within a day.
    fresh.sort((a, b) => (a.bookingDate === b.bookingDate ? Number(a.externalId) - Number(b.externalId) || 0 : a.bookingDate < b.bookingDate ? -1 : 1));

    // Transactions entered by hand earlier are linked to their bank-file counterpart (same amount,
    // at most 3 days apart) instead of being booked a second time.
    const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
    let matched = 0;
    const manualOpen = own.filter((t) => t.manual && !t.matchedExternalId);
    fresh = fresh.filter((t) => {
      const m = manualOpen.find((x) => !x.matchedExternalId && x.amount === t.amount && dayDiff(x.bookingDate, t.bookingDate) <= 3);
      if (!m) return true;
      m.matchedExternalId = t.externalId;
      m.balanceAfter = t.balanceAfter;
      if (!m.counterpartyIban && t.counterpartyIban) m.counterpartyIban = t.counterpartyIban;
      matched++;
      return false;
    });

    const lastRow = [...list].filter((t) => t.balanceAfter !== null).sort((a, b) => (a.bookingDate === b.bookingDate ? Number(a.externalId) - Number(b.externalId) : a.bookingDate < b.bookingDate ? -1 : 1)).at(-1);
    const unmatchedManual = () => s.bankTransactions.filter((t) => t.bankAccountId === bank.id && t.manual && !t.matchedExternalId);
    const simpleChain = matched === 0 && unmatchedManual().length === 0;

    if (fresh.length && fresh.some((t) => t.balanceAfter !== null)) {
      if (fresh.some((t) => t.balanceAfter === null)) throw new ImportError("Niet alle transacties hebben een saldo na transactie");
      const last = own.filter((t) => !t.manual).sort((a, b) => (a.bookingDate < b.bookingDate ? 1 : -1))[0];
      if (last && fresh[0].bookingDate < last.bookingDate) {
        throw new ImportError(`Nieuwe transactie van ${fresh[0].bookingDate} ligt vóór de laatst geïmporteerde transactie (${last.bookingDate}). Exporteer een periode die aansluit op de vorige import.`);
      }
      if (simpleChain) {
        let running: number = this.dv(s).bankBalance.get(bank.id) ?? 0;
        for (const t of fresh) {
          const before = (t.balanceAfter as number) - t.amount;
          if (before !== running) {
            throw new ImportError(
              `Saldo sluit niet aan vóór transactie ${t.externalId} van ${t.bookingDate}: de boekhouding verwacht ${formatEuro(cents(running))}, de bank meldt ${formatEuro(cents(before))}. ` +
                `Er ontbreken transacties (of de beginbalans klopt niet). Exporteer een periode die aansluit op de vorige import.`,
            );
          }
          running = t.balanceAfter as number;
        }
      }
    }

    let autoAssigned = 0;
    for (const t of fresh) {
      const tx: BankTx = { ...t, accountIban: bank.iban, id: this.id(s, "t"), bankAccountId: bank.id, importedAt: this.now() };
      s.bankTransactions.push(tx);
      if (t.amount === 0) continue;
      this.post(s, bankTransactionImported({ tx: { id: tx.id, date: tx.bookingDate, amount: tx.amount, description: tx.description || tx.counterpartyName || "Banktransactie" }, bankLedgerAccountId: bank.ledgerAccountId, isCash: bank.kind === "cash" }), actor);
      const isOwn = s.bankAccounts.some((b) => b.iban && b.iban === tx.counterpartyIban && b.id !== bank.id);
      if (isOwn) {
        this.assignIn(s, tx.id, [{ kind: "internal", amount: tx.amount }], actor, { isAutomatic: true });
        autoAssigned++;
      }
    }

    // With hand-entered transactions involved, check the end result against the bank's saldo.
    if (!simpleChain && lastRow && lastRow.balanceAfter !== null) {
      const stray = unmatchedManual().filter((t) => t.bookingDate <= lastRow.bookingDate);
      if (stray.length) {
        throw new ImportError(
          `De met de hand toegevoegde transactie(s) ${stray.map((t) => `${formatEuro(t.amount)} op ${t.bookingDate}`).join(", ")} staan niet in het bankbestand. Controleer ze (bedrag of datum) en maak ze zo nodig ongedaan.`,
        );
      }
      const later = sum(unmatchedManual().map((t) => t.amount));
      const ledger = (this.dv(s).bankBalance.get(bank.id) ?? 0) - later;
      if (ledger !== lastRow.balanceAfter) {
        throw new ImportError(`Na de import sluit het saldo niet aan: de boekhouding komt op ${formatEuro(cents(ledger))}, de bank op ${formatEuro(lastRow.balanceAfter)}. Er ontbreken transacties.`);
      }
    }
    return { added: fresh.length, duplicates: duplicates + matched, autoAssigned };
  }

  /** Enter a bank transaction by hand (no export available yet). A later import links to it. */
  addManualBankTransaction(
    input: { bankAccountId: string; date: LocalDate; amount: Cents; counterpartyName: string; counterpartyIban: string | null; description: string },
    actor: Actor,
  ): string {
    require(actor, "edit");
    return this.transact((s) => {
      const bank = s.bankAccounts.find((b) => b.id === input.bankAccountId && b.kind !== "cash");
      if (!bank) throw new LedgerError("Kies een bankrekening");
      if (input.amount === 0) throw new LedgerError("Bedrag mag niet 0 zijn");
      if (!input.counterpartyName.trim() && !input.description.trim()) throw new LedgerError("Vul een tegenpartij of omschrijving in");
      const iban = input.counterpartyIban?.trim() ? normalizeIban(input.counterpartyIban) : null;
      if (iban && !isValidIban(iban)) throw new LedgerError(`Ongeldig IBAN: ${input.counterpartyIban}`);
      const n = s.bankTransactions.filter((t) => t.manual).length + 1;
      const tx: BankTx = {
        id: this.id(s, "t"), bankAccountId: bank.id, accountIban: bank.iban, externalId: `HAND-${n}`, bookingDate: input.date, valueDate: input.date,
        amount: input.amount, balanceAfter: null, counterpartyIban: iban, counterpartyName: input.counterpartyName.trim() || null,
        description: input.description.trim(), importedAt: this.now(), manual: true, matchedExternalId: null,
      };
      s.bankTransactions.push(tx);
      this.post(s, bankTransactionImported({ tx: { id: tx.id, date: tx.bookingDate, amount: tx.amount, description: tx.description || tx.counterpartyName || "Banktransactie" }, bankLedgerAccountId: bank.ledgerAccountId }), actor);
      if (iban && s.bankAccounts.some((b) => b.iban === iban && b.id !== bank.id)) {
        this.assignIn(s, tx.id, [{ kind: "internal", amount: tx.amount }], actor, { isAutomatic: true });
      }
      this.audit(s, actor, "bank.manual", { id: tx.id, amount: tx.amount, date: tx.bookingDate, counterparty: tx.counterpartyName });
      return tx.id;
    });
  }

  recordCash(input: { date: LocalDate; amount: Cents; description: string }, actor: Actor): string {
    require(actor, "edit");
    return this.transact((s) => {
      const kas = s.bankAccounts.find((b) => b.kind === "cash");
      if (!kas) throw new LedgerError("Er is geen kas");
      if (input.amount === 0) throw new LedgerError("Bedrag mag niet 0 zijn");
      if (!input.description.trim()) throw new LedgerError("Omschrijving is verplicht");
      const n = s.bankTransactions.filter((t) => t.bankAccountId === kas.id).length + 1;
      const tx: BankTx = {
        id: this.id(s, "t"), bankAccountId: kas.id, accountIban: null, externalId: `KAS-${n}`, bookingDate: input.date, valueDate: input.date,
        amount: input.amount, balanceAfter: null, counterpartyIban: null, counterpartyName: null, description: input.description.trim(), importedAt: this.now(),
      };
      s.bankTransactions.push(tx);
      this.post(s, bankTransactionImported({ tx: { id: tx.id, date: tx.bookingDate, amount: tx.amount, description: tx.description }, bankLedgerAccountId: kas.ledgerAccountId, isCash: true }), actor);
      this.audit(s, actor, "cash.record", { id: tx.id, amount: input.amount, description: tx.description });
      return tx.id;
    });
  }

  suggestions(txId: string): Suggestion[] {
    const tx = this.state.bankTransactions.find((t) => t.id === txId);
    return tx ? this.suggestionsIn(this.state, tx) : [];
  }

  private suggestionsIn(s: State, tx: BankTx): Suggestion[] {
    const d = this.dv(s);
    const partyByIban = new Map<string, { id: string; name: string }>();
    for (const p of s.parties) for (const i of p.ibans) partyByIban.set(i, { id: p.id, name: p.name });
    const lastByCounterparty = new Map<string, { target: SuggestionTarget; label: string }>();
    const txById = new Map(s.bankTransactions.map((t) => [t.id, t]));
    const contributionAccount = d.accountByKey.get("CONTRIBUTION_RECEIVABLE")?.id;
    const savingsAccount = d.accountByKey.get("MEMBER_SAVINGS")?.id;
    for (const e of s.entries) {
      if (e.sourceType !== "bank_transaction" || e.template === "T00" || e.template === "T19" || e.reversesEntryId || d.reversedIds.has(e.id)) continue;
      const btx = e.sourceId ? txById.get(e.sourceId) : undefined;
      if (!btx?.counterpartyIban || btx.id === tx.id || Math.sign(btx.amount) !== Math.sign(tx.amount)) continue;
      const targets = e.lines.filter((l) => d.accountById.get(l.accountId)?.systemKey !== "BANK_SUSPENSE");
      if (targets.length !== 1) continue;
      const t = targets[0];
      const name = t.partyId ? d.partyById.get(t.partyId)?.name ?? "" : "";
      let target: SuggestionTarget | null = null;
      let label = "";
      if (t.partyId && t.accountId === contributionAccount) { target = { kind: "contribution", partyId: t.partyId }; label = `contributie van ${name}`; }
      else if (t.partyId && t.accountId === savingsAccount && t.savingsGoalId) { target = { kind: "savings", partyId: t.partyId, goalId: t.savingsGoalId }; label = `spaarplan ${s.savingsGoals.find((g) => g.id === t.savingsGoalId)?.name} van ${name}`; }
      else if (t.partyId) { target = { kind: "person", partyId: t.partyId }; label = `rekening van ${name}`; }
      else if (t.activityId) { const a = s.activities.find((x) => x.id === t.activityId); target = { kind: "activity", activityId: t.activityId }; label = `${a?.number} ${a?.name}`; }
      else if (t.potId) { target = { kind: "pot", potId: t.potId }; label = `potje ${d.potById.get(t.potId)?.name}`; }
      if (target) lastByCounterparty.set(btx.counterpartyIban, { target, label });
    }
    const bank = s.bankAccounts.find((b) => b.id === tx.bankAccountId);
    const out = suggestAssignment(tx, {
      ownIbans: s.bankAccounts.map((b) => b.iban).filter((x): x is string => !!x),
      thisAccountIban: bank?.iban ?? null,
      partyByIban,
      lastByCounterparty,
    }).filter((sg) => sg.target.kind !== "activity" || s.activities.find((a) => a.id === (sg.target as { activityId: string }).activityId)?.status === "open");

    // The description says what it is ("spaarplan", "contributie"): suggest that for the known member.
    if (tx.amount > 0) {
      const member = out.map((o) => ("partyId" in o.target ? d.partyById.get(o.target.partyId) : undefined)).find((p) => p?.kind === "member");
      const goal = s.savingsGoals.find((g) => g.active && (tx.description.toLowerCase().includes(g.name.toLowerCase().split(" ")[0]) || /spaar|sparen/i.test(tx.description)));
      if (member && goal && /spaar|sparen|lustrum|reis/i.test(tx.description) && !out.some((o) => o.target.kind === "savings")) {
        out.unshift({ reason: "same_as_last", label: `Spaarplan ${goal.name} van ${member.name} (omschrijving)`, target: { kind: "savings", partyId: member.id, goalId: goal.id }, autoBook: false });
      } else if (member && /contributie/i.test(tx.description) && !out.some((o) => o.target.kind === "contribution")) {
        out.unshift({ reason: "contribution", label: `Contributie van ${member.name} (omschrijving)`, target: { kind: "contribution", partyId: member.id }, autoBook: false });
      }
    }
    // A member paying exactly their open contribution or a whole number of months: suggest contribution first.
    if (tx.amount > 0 && !out.some((o) => o.target.kind === "savings" && out.indexOf(o) === 0)) {
      for (const sg of [...out]) {
        if (sg.target.kind !== "person") continue;
        const party = d.partyById.get(sg.target.partyId);
        const type = party?.member ? s.memberTypes.find((t) => t.id === party.member!.memberTypeId) : null;
        if (!party || !type || type.monthly <= 0) continue;
        const open = d.contributionBalance.get(party.id) ?? 0;
        if (out.some((o) => o.target.kind === "contribution" && o.target.partyId === party.id)) break;
        if (tx.amount === open || tx.amount % type.monthly === 0) {
          const months = tx.amount / type.monthly;
          const label = `Contributie van ${party.name}${Number.isInteger(months) ? ` (${months} ${months === 1 ? "maand" : "maanden"})` : ""}`;
          out.splice(out.indexOf(sg), 0, { reason: "contribution", label, target: { kind: "contribution", partyId: party.id }, autoBook: false });
          break;
        }
      }
    }
    return out;
  }

  /** Resolve the UI's simple target description into an AssignmentTarget. */
  buildTarget(s: State, t: AssignPart): AssignmentTarget {
    if (t.kind === "internal") return { kind: "internal", amount: t.amount };
    if (t.kind === "person" || t.kind === "contribution" || t.kind === "savings") {
      const p = s.parties.find((x) => x.id === t.id);
      if (!p) throw new LedgerError("Kies een persoon");
      if (t.kind === "person") return { kind: "person", partyId: p.id, partyKind: p.kind, amount: t.amount, description: t.description };
      if (p.kind !== "member") throw new LedgerError(t.kind === "contribution" ? "Alleen leden betalen contributie" : "Alleen leden hebben een spaarplan");
      if (t.kind === "contribution") return { kind: "contribution", partyId: p.id, amount: t.amount, description: t.description };
      const goal = s.savingsGoals.find((g) => g.id === t.goalId);
      if (!goal) throw new LedgerError("Kies een spaardoel");
      return { kind: "savings", partyId: p.id, goalId: goal.id, amount: t.amount, description: t.description };
    }
    if (t.kind === "activity") {
      if (!s.activities.some((a) => a.id === t.id)) throw new LedgerError("Kies een activiteit");
      return { kind: "activity", activityId: t.id!, amount: t.amount, description: t.description };
    }
    const pot = s.pots.find((p) => p.id === t.id);
    if (!pot) throw new LedgerError("Kies een potje");
    if (t.donorId && !s.parties.some((p) => p.id === t.donorId)) throw new LedgerError("Onbekende gever");
    return { kind: "pot", potId: pot.id, accountId: t.amount > 0 ? pot.incomeAccountId : pot.expenseAccountId, amount: t.amount, description: t.description, relatedPartyId: t.donorId ?? null };
  }

  assign(txId: string, parts: AssignPart[], actor: Actor, opts: { rememberIbanFor?: string | null } = {}) {
    require(actor, "edit");
    this.transact((s) => {
      const targets = parts.map((p) => this.buildTarget(s, p));
      this.assignIn(s, txId, targets, actor, {});
      if (opts.rememberIbanFor) {
        const tx = s.bankTransactions.find((t) => t.id === txId)!;
        const iban = payerIban(tx, s.bankAccounts.map((b) => b.iban).filter((x): x is string => !!x));
        const party = s.parties.find((p) => p.id === opts.rememberIbanFor);
        if (iban && party && !s.parties.some((p) => p.ibans.includes(iban))) {
          this.addIbans(s, party, [iban]);
          this.audit(s, actor, "party.iban.add", { partyId: party.id, iban });
        }
      }
    });
  }

  /** Assign several transactions at once (e.g. all contribution payments), each as one target. */
  assignMany(items: { txId: string; part: AssignPart }[], actor: Actor): number {
    require(actor, "edit");
    return this.transact((s) => {
      for (const it of items) this.assignIn(s, it.txId, [this.buildTarget(s, it.part)], actor, {});
      return items.length;
    });
  }

  private assignIn(s: State, txId: string, targets: AssignmentTarget[], actor: Actor, opts: { isAutomatic?: boolean }) {
    const tx = s.bankTransactions.find((t) => t.id === txId);
    if (!tx) throw new LedgerError("Banktransactie niet gevonden");
    const open = -(this.dv(s).suspenseByTx.get(tx.id) ?? 0);
    if (open === 0) throw new LedgerError("Deze transactie is al toegewezen");
    this.post(s, assignBankTransaction({ tx: { id: tx.id, date: tx.bookingDate, amount: tx.amount, description: tx.description || tx.counterpartyName || "Banktransactie" }, targets, isAutomatic: opts.isAutomatic }), actor);
    this.audit(s, actor, opts.isAutomatic ? "bank.assign.auto" : "bank.assign", { tx: tx.externalId, targets: targets.map((t) => ({ kind: t.kind, amount: t.amount })) });
  }

  unassign(txId: string, reason: string, actor: Actor) {
    require(actor, "edit");
    this.transact((s) => {
      const d = this.dv(s);
      const active = s.entries.filter((e) => e.sourceType === "bank_transaction" && e.sourceId === txId && e.template !== "T00" && e.template !== "T19" && !e.reversesEntryId && !d.reversedIds.has(e.id));
      if (!active.length) throw new LedgerError("Deze transactie is niet toegewezen");
      for (const e of active) this.reverse(s, e.id, reason, actor);
      this.audit(s, actor, "bank.unassign", { txId }, reason);
    });
  }

  /** The current (non-reversed) assignment entry of a transaction, if any. */
  assignmentOf(txId: string): Entry | null {
    const s = this.state;
    const d = this.dv(s);
    return s.entries.find((e) => e.sourceType === "bank_transaction" && e.sourceId === txId && e.template !== "T00" && e.template !== "T19" && !e.reversesEntryId && !d.reversedIds.has(e.id)) ?? null;
  }

  // -- contribution ---------------------------------------------------------

  chargeContributions(monthInput: LocalDate, actor: Actor): number {
    require(actor, "edit");
    return this.transact((s) => this.chargeMonth(s, monthInput, actor));
  }
  private chargeMonth(s: State, monthInput: LocalDate, actor: Actor): number {
    const month = firstOfMonth(monthInput);
    const income = s.accounts.find((a) => a.systemKey === "CONTRIBUTION")!;
    const split = s.settings.contributionKey.filter((k) => k.weight > 0);
    if (!split.length) throw new LedgerError("Stel eerst de verdeling van de contributie over de potjes in");
    let n = 0;
    for (const p of s.parties) {
      const m = p.member;
      if (!m || m.joinedOn > month || (m.leftOn && m.leftOn < month)) continue;
      if (s.contributionMonths.some((c) => c.memberId === p.id && c.month === month)) continue;
      const type = s.memberTypes.find((t) => t.id === m.memberTypeId)!;
      if (type.monthly === 0) continue;
      const entry = this.post(s, contributionCharged({ chargeId: `${p.id}:${month}`, partyId: p.id, month, amount: type.monthly, incomeAccountId: income.id, split, description: `Contributie ${formatMonthNl(month)} (${type.name})` }), actor);
      s.contributionMonths.push({ memberId: p.id, month, entryId: entry.id });
      n++;
    }
    this.audit(s, actor, "contribution.month", { month, charged: n });
    return n;
  }

  // -- activities ------------------------------------------------------------

  createActivity(input: { name: string; heldOn: LocalDate | null; potId: string }, actor: Actor): Activity {
    require(actor, "edit");
    return this.transact((s) => {
      if (!input.name.trim()) throw new LedgerError("Naam is verplicht");
      if (!s.pots.some((p) => p.id === input.potId)) throw new LedgerError("Kies een potje");
      const a: Activity = { id: this.id(s, "act"), number: this.nextActivityNumber(s, input.heldOn ?? localDate(this.now().slice(0, 10))), name: input.name.trim(), heldOn: input.heldOn, potId: input.potId, status: "open", settlementEntryId: null, createdAt: this.now() };
      s.activities.push(a);
      this.audit(s, actor, "activity.create", a);
      return a;
    });
  }

  chargePerson(input: { partyId: string; date: LocalDate; amount: Cents; target: { kind: "activity" | "pot"; id: string }; description: string }, actor: Actor) {
    require(actor, "edit");
    this.transact((s) => {
      const party = s.parties.find((p) => p.id === input.partyId);
      if (!party) throw new LedgerError("Kies een persoon");
      if (!input.description.trim()) throw new LedgerError("Omschrijving is verplicht");
      let target: CostTarget;
      if (input.target.kind === "activity") target = { kind: "activity", activityId: input.target.id };
      else {
        const pot = s.pots.find((p) => p.id === input.target.id);
        if (!pot) throw new LedgerError("Kies een potje");
        target = { kind: "pot", potId: pot.id, accountId: input.amount > 0 ? pot.incomeAccountId : pot.expenseAccountId };
      }
      this.post(s, chargedToPerson({ partyId: party.id, partyKind: party.kind, date: input.date, amount: input.amount, target, description: input.description.trim() }), actor);
    });
  }

  previewSettlement(activityId: string, shares: SettlementShareInput[]) {
    const balance = this.dv(this.state).activityBalance.get(activityId) ?? cents(0);
    return { balance, allocations: computeSettlement(balance, shares) };
  }

  settleActivity(input: { activityId: string; date: LocalDate; shares: SettlementShareInput[]; expectedBalance: Cents }, actor: Actor) {
    require(actor, "approve");
    return this.transact((s) => {
      const act = s.activities.find((a) => a.id === input.activityId);
      if (!act) throw new LedgerError("Activiteit niet gevonden");
      if (act.status !== "open") throw new LedgerError("Deze activiteit is al afgerekend");
      const balance = this.dv(s).activityBalance.get(act.id) ?? cents(0);
      if (balance !== input.expectedBalance) throw new LedgerError("Het te verdelen bedrag is gewijzigd; controleer de verdeling opnieuw");
      const pot = s.pots.find((p) => p.id === act.potId)!;
      const allocations = computeSettlement(balance, input.shares);
      const draft = activitySettled({ activityId: act.id, activityName: act.name, date: input.date, balance, allocations, potId: pot.id, expenseAccountId: pot.expenseAccountId });
      const entry = draft ? this.post(s, draft, actor) : null;
      act.status = "settled";
      act.settlementEntryId = entry?.id ?? null;
      this.audit(s, actor, "activity.settle", { activity: act.name, balance, allocations: allocations.map((a) => [a.partyId, a.amount]) });
      return allocations;
    });
  }

  reopenActivity(activityId: string, reason: string, actor: Actor) {
    require(actor, "approve");
    this.transact((s) => {
      const act = s.activities.find((a) => a.id === activityId);
      if (!act || act.status !== "settled") throw new LedgerError("Deze activiteit is niet afgerekend");
      if (!reason.trim()) throw new LedgerError("Reden is verplicht");
      act.status = "open";
      if (act.settlementEntryId) this.reverse(s, act.settlementEntryId, reason, actor);
      act.settlementEntryId = null;
      this.audit(s, actor, "activity.reopen", { activity: act.name }, reason);
    });
  }

  // -- claims ------------------------------------------------------------------

  submitClaim(input: { partyId: string; amount: Cents; description: string; target: { kind: "activity" | "pot"; id: string }; receipt: string | null }, actor: Actor): Claim {
    if (actor.role === "kascommissie") require(actor, "edit");
    if (actor.role === "lid" && actor.partyId !== input.partyId) throw new LedgerError("Je kunt alleen voor jezelf declareren");
    return this.transact((s) => {
      const party = s.parties.find((p) => p.id === input.partyId && p.kind === "member");
      if (!party) throw new LedgerError("Alleen leden kunnen declareren");
      if (input.amount <= 0) throw new LedgerError("Bedrag moet positief zijn");
      if (!input.description.trim()) throw new LedgerError("Omschrijving is verplicht");
      let target: CostTarget;
      if (input.target.kind === "activity") {
        const act = s.activities.find((a) => a.id === input.target.id);
        if (!act || act.status !== "open") throw new LedgerError("Kies een open activiteit");
        target = { kind: "activity", activityId: act.id };
      } else {
        const pot = s.pots.find((p) => p.id === input.target.id);
        if (!pot) throw new LedgerError("Kies een potje");
        target = { kind: "pot", potId: pot.id, accountId: pot.expenseAccountId };
      }
      const c: Claim = { id: this.id(s, "c"), partyId: party.id, amount: input.amount, description: input.description.trim(), target, status: "submitted", receipt: input.receipt, rejectionReason: null, entryId: null, submittedAt: this.now(), decidedAt: null };
      s.claims.push(c);
      this.audit(s, actor, "claim.submit", { id: c.id, party: party.name, amount: c.amount, description: c.description });
      return c;
    });
  }

  approveClaim(id: string, date: LocalDate, actor: Actor) {
    require(actor, "approve");
    this.transact((s) => {
      const c = s.claims.find((x) => x.id === id);
      if (!c || c.status !== "submitted") throw new LedgerError("Deze declaratie kan niet (meer) worden goedgekeurd");
      const entry = this.post(s, expenseClaimApproved({ claimId: c.id, partyId: c.partyId, date, amount: c.amount, target: c.target, description: `Declaratie: ${c.description}` }), actor);
      c.status = "approved";
      c.entryId = entry.id;
      c.decidedAt = this.now();
      this.audit(s, actor, "claim.approve", { id });
    });
  }

  rejectClaim(id: string, reason: string, actor: Actor) {
    require(actor, "approve");
    this.transact((s) => {
      const c = s.claims.find((x) => x.id === id);
      if (!c || c.status !== "submitted") throw new LedgerError("Deze declaratie kan niet (meer) worden afgewezen");
      if (!reason.trim()) throw new LedgerError("Geef een reden op");
      c.status = "rejected";
      c.rejectionReason = reason.trim();
      c.decidedAt = this.now();
      this.audit(s, actor, "claim.reject", { id }, reason);
    });
  }

  withdrawClaim(id: string, actor: Actor) {
    this.transact((s) => {
      const c = s.claims.find((x) => x.id === id);
      if (!c || c.status !== "submitted") throw new LedgerError("Deze declaratie kan niet worden ingetrokken");
      if (actor.role === "lid" && actor.partyId !== c.partyId) throw new LedgerError("Je kunt alleen je eigen declaraties intrekken");
      if (actor.role === "kascommissie") require(actor, "edit");
      c.status = "withdrawn";
      c.decidedAt = this.now();
      this.audit(s, actor, "claim.withdraw", { id });
    });
  }

  undoClaimApproval(id: string, reason: string, actor: Actor) {
    require(actor, "approve");
    this.transact((s) => {
      const c = s.claims.find((x) => x.id === id);
      if (!c || c.status !== "approved" || !c.entryId) throw new LedgerError("Deze declaratie is niet goedgekeurd");
      this.reverse(s, c.entryId, reason, actor);
      c.status = "submitted";
      c.entryId = null;
      c.decidedAt = null;
      this.audit(s, actor, "claim.unapprove", { id }, reason);
    });
  }

  // -- manual entries, reserves, budgets --------------------------------------

  postMemorial(input: { date: LocalDate; description: string; reason: string; lines: { accountId: string; amount: Cents; potId?: string | null; partyId?: string | null; activityId?: string | null }[] }, actor: Actor) {
    require(actor, "admin");
    this.transact((s) => {
      this.post(s, memorial({ date: input.date, description: input.description, reason: input.reason, lines: input.lines.map((l) => ({ account: { id: l.accountId }, amount: l.amount, potId: l.potId ?? null, partyId: l.partyId ?? null, activityId: l.activityId ?? null })) }), actor);
    });
  }

  dotateReserve(input: { date: LocalDate; reserveAccountId: string; amount: Cents; description: string }, actor: Actor) {
    require(actor, "admin");
    this.transact((s) => {
      const pot = s.pots.find((p) => p.code === "RESERVERINGEN")!;
      this.post(s, reserveDotation({ date: input.date, reserveAccountId: input.reserveAccountId, amount: input.amount, potId: pot.id, description: input.description }), actor);
    });
  }

  reverseEntry(entryId: string, reason: string, actor: Actor) {
    require(actor, "admin");
    this.transact((s) => {
      const e = s.entries.find((x) => x.id === entryId);
      if (e && e.sourceType && e.sourceType !== "journal_entry" && !["T29", "T23", "T21", "T22"].includes(e.template)) {
        throw new LedgerError("Deze boeking hoort bij een document (bank, activiteit, declaratie); maak het daar ongedaan");
      }
      this.reverse(s, entryId, reason, actor);
    });
  }

  addBudgetLine(input: Omit<BudgetLine, "id">, actor: Actor): BudgetLine {
    require(actor, "admin");
    return this.transact((s) => {
      if (input.amount < 0) throw new LedgerError("Een begrotingsbedrag kan niet negatief zijn; kies baten of lasten");
      if (!s.pots.some((p) => p.id === input.potId)) throw new LedgerError("Kies een potje");
      if (!input.description.trim()) throw new LedgerError("Omschrijving is verplicht");
      const line: BudgetLine = { ...input, description: input.description.trim(), id: this.id(s, "bl") };
      s.budgets.push(line);
      this.audit(s, actor, "budget.add", line);
      return line;
    });
  }

  updateBudgetLine(id: string, input: Partial<Omit<BudgetLine, "id" | "fiscalYearId">>, actor: Actor) {
    require(actor, "admin");
    this.transact((s) => {
      const line = s.budgets.find((b) => b.id === id);
      if (!line) throw new LedgerError("Begrotingsregel niet gevonden");
      if (input.amount !== undefined && input.amount < 0) throw new LedgerError("Een begrotingsbedrag kan niet negatief zijn");
      this.audit(s, actor, "budget.update", { id, before: { ...line }, after: input });
      Object.assign(line, input);
    });
  }

  removeBudgetLine(id: string, actor: Actor) {
    require(actor, "admin");
    this.transact((s) => {
      const i = s.budgets.findIndex((b) => b.id === id);
      if (i < 0) throw new LedgerError("Begrotingsregel niet gevonden");
      this.audit(s, actor, "budget.remove", s.budgets[i]);
      s.budgets.splice(i, 1);
    });
  }

  /** Fill a year's budget from last year's budget or last year's actual figures (per pot). */
  copyBudget(fromFyId: string, toFyId: string, mode: "budget" | "actual", actor: Actor): number {
    require(actor, "admin");
    return this.transact((s) => {
      const from = s.fiscalYears.find((f) => f.id === fromFyId);
      if (!from || !s.fiscalYears.some((f) => f.id === toFyId)) throw new LedgerError("Onbekend boekjaar");
      let n = 0;
      if (mode === "budget") {
        for (const b of s.budgets.filter((x) => x.fiscalYearId === fromFyId)) {
          s.budgets.push({ ...b, id: this.id(s, "bl"), fiscalYearId: toFyId });
          n++;
        }
      } else {
        for (const [potId, r] of resultByPot(s, from)) {
          if (r.income > 0) { s.budgets.push({ id: this.id(s, "bl"), fiscalYearId: toFyId, potId, kind: "income", description: `Realisatie ${from.label}`, amount: cents(r.income) }); n++; }
          if (r.expense > 0) { s.budgets.push({ id: this.id(s, "bl"), fiscalYearId: toFyId, potId, kind: "expense", description: `Realisatie ${from.label}`, amount: cents(r.expense) }); n++; }
        }
      }
      this.audit(s, actor, "budget.copy", { from: fromFyId, to: toFyId, mode, lines: n });
      return n;
    });
  }

  createPot(input: { name: string; kind: "expense" | "income" | "both" }, actor: Actor): Pot {
    require(actor, "admin");
    return this.transact((s) => {
      const name = input.name.trim();
      if (!name) throw new LedgerError("Naam is verplicht");
      if (s.pots.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new LedgerError("Dit potje bestaat al");
      const general = s.pots.find((p) => p.code === "ALGEMEEN")!;
      const pot: Pot = { id: this.id(s, "p"), code: name.toUpperCase().replace(/[^A-Z0-9]+/g, "_"), name, incomeAccountId: general.incomeAccountId, expenseAccountId: general.expenseAccountId };
      s.pots.push(pot);
      this.audit(s, actor, "pot.create", pot);
      return pot;
    });
  }

  setContributionKey(key: { potId: string; weight: number }[], actor: Actor) {
    require(actor, "admin");
    this.transact((s) => {
      const clean = key.filter((k) => k.weight > 0);
      if (!clean.length) throw new LedgerError("Kies minimaal één potje");
      for (const k of clean) {
        if (!Number.isInteger(k.weight) || k.weight < 0) throw new LedgerError("Gebruik hele getallen (bijv. procenten)");
        if (!s.pots.some((p) => p.id === k.potId)) throw new LedgerError("Onbekend potje");
      }
      if (new Set(clean.map((k) => k.potId)).size !== clean.length) throw new LedgerError("Elk potje mag maar één keer voorkomen");
      this.audit(s, actor, "contribution.key", { before: s.settings.contributionKey, after: clean });
      s.settings.contributionKey = clean;
    });
  }

  // -- savings plans (spaarplannen) -----------------------------------------------

  createSavingsGoal(input: { name: string; targetDate: LocalDate | null; monthly: Cents }, actor: Actor): SavingsGoal {
    require(actor, "admin");
    return this.transact((s) => {
      if (!input.name.trim()) throw new LedgerError("Naam is verplicht");
      if (input.monthly < 0) throw new LedgerError("Maandbedrag kan niet negatief zijn");
      const g: SavingsGoal = { id: this.id(s, "g"), name: input.name.trim(), targetDate: input.targetDate, monthly: input.monthly, active: true };
      s.savingsGoals.push(g);
      this.audit(s, actor, "savings.goal.create", g);
      return g;
    });
  }

  updateSavingsGoal(id: string, input: { name: string; targetDate: LocalDate | null; monthly: Cents; active: boolean }, actor: Actor) {
    require(actor, "admin");
    this.transact((s) => {
      const g = s.savingsGoals.find((x) => x.id === id);
      if (!g) throw new LedgerError("Spaardoel niet gevonden");
      this.audit(s, actor, "savings.goal.update", { before: { ...g }, after: input });
      Object.assign(g, { ...input, name: input.name.trim() });
    });
  }

  /**
   * Use savings to pay what members owe: moves money from their savings (goal) to their account.
   * `amount` per member; use `settleSavingsForGoal` to do this for everyone at once.
   */
  settleSavings(input: { partyId: string; goalId: string; amount: Cents; date: LocalDate }, actor: Actor) {
    require(actor, "approve");
    this.transact((s) => this.settleSavingsIn(s, input, actor));
  }
  private settleSavingsIn(s: State, input: { partyId: string; goalId: string; amount: Cents; date: LocalDate }, actor: Actor) {
    const goal = s.savingsGoals.find((g) => g.id === input.goalId);
    if (!goal) throw new LedgerError("Spaardoel niet gevonden");
    const saved = this.dv(s).savings.get(`${input.partyId}|${goal.id}`) ?? 0;
    if (input.amount <= 0) throw new LedgerError("Bedrag moet positief zijn");
    if (input.amount > saved) throw new LedgerError(`Er is maar ${formatEuro(cents(saved))} gespaard`);
    this.post(s, savingsSettled({ partyId: input.partyId, goalId: goal.id, goalName: goal.name, date: input.date, amount: input.amount }), actor);
  }

  /** For every member: use savings for this goal to pay their open balance (never more than saved). */
  settleSavingsForGoal(goalId: string, date: LocalDate, mode: "owed" | "all", actor: Actor): { members: number; total: Cents } {
    require(actor, "approve");
    return this.transact((s) => {
      const d = this.dv(s);
      let members = 0;
      let total = 0;
      for (const p of s.parties.filter((x) => x.kind === "member")) {
        const saved = d.savings.get(`${p.id}|${goalId}`) ?? 0;
        if (saved <= 0) continue;
        const owed = d.partyBalance.get(p.id) ?? 0;
        const amount = mode === "all" ? saved : Math.min(saved, Math.max(0, owed));
        if (amount <= 0) continue;
        this.settleSavingsIn(s, { partyId: p.id, goalId, amount: cents(amount), date }, actor);
        members++;
        total += amount;
      }
      return { members, total: cents(total) };
    });
  }

  // -- fiscal year --------------------------------------------------------------

  closingChecklist(fyId: string) {
    const s = this.state;
    const d = this.dv(s);
    const fy = d.fyById.get(fyId)!;
    const unassignedInYear = d.unassigned.filter((t) => t.bookingDate >= fy.startDate && t.bookingDate <= fy.endDate).length;
    const previousOpen = s.fiscalYears.filter((f) => f.endDate < fy.startDate && f.status !== "closed");
    const openClaims = s.claims.filter((c) => c.status === "submitted").length;
    const internal = this.dv(s).accountByKey.get("INTERNAL_TRANSFER")!;
    const internalBalance = accountBalances(s, fy).get(internal.id) ?? 0;
    return [
      { key: "bank", label: "Alle banktransacties van het jaar zijn toegewezen", ok: unassignedInYear === 0, detail: unassignedInYear ? `${unassignedInYear} nog toe te wijzen` : "" },
      { key: "internal", label: "Interne overboekingen zijn aan beide kanten binnen", ok: internalBalance === 0, detail: internalBalance ? formatEuro(cents(internalBalance)) + " onderweg" : "" },
      { key: "claims", label: "Geen declaraties die nog wachten op goedkeuring", ok: openClaims === 0, detail: openClaims ? `${openClaims} ingediend` : "" },
      { key: "previous", label: "Vorige boekjaren zijn afgesloten", ok: previousOpen.length === 0, detail: previousOpen.map((f) => f.label).join(", ") },
    ];
  }

  closeFiscalYear(fyId: string, appropriation: { accountId: string; amount: Cents }[], actor: Actor) {
    require(actor, "admin");
    return this.transact((s) => {
      const fy = s.fiscalYears.find((f) => f.id === fyId);
      if (!fy || fy.status === "closed") throw new LedgerError("Dit boekjaar kan niet worden afgesloten");
      const failing = this.closingChecklist(fy.id).filter((c) => !c.ok);
      if (failing.length) throw new LedgerError(`Afsluiten kan nog niet: ${failing.map((f) => f.label.toLowerCase()).join("; ")}`);
      fy.status = "closing";
      const d = this.dv(s);
      const perAccountPot = new Map<string, number>();
      for (const e of s.entries) {
        if (e.fiscalYearId !== fy.id) continue;
        for (const l of e.lines) {
          const acc = d.accountById.get(l.accountId)!;
          if (acc.type !== "income" && acc.type !== "expense") continue;
          const k = `${l.accountId}|${l.potId}`;
          perAccountPot.set(k, (perAccountPot.get(k) ?? 0) + l.amount);
        }
      }
      const drafts = yearClose({
        date: fy.endDate,
        fiscalYearLabel: fy.label,
        balances: [...perAccountPot].map(([k, amount]) => ({ accountId: k.split("|")[0], potId: k.split("|")[1], amount: cents(amount) })),
        appropriation,
      });
      if (drafts.closing) this.post(s, drafts.closing, actor);
      if (drafts.appropriation) this.post(s, drafts.appropriation, actor);
      fy.status = "closed";
      this.audit(s, actor, "fiscal_year.close", { label: fy.label, result: drafts.result });
      this.ensureFy(s, addDays(fy.endDate, 1), actor);
      return drafts.result;
    });
  }
  reopenFiscalYear(fyId: string, reason: string, actor: Actor) {
    require(actor, "admin");
    this.transact((s) => {
      if (!reason.trim()) throw new LedgerError("Reden is verplicht om een boekjaar te heropenen");
      const fy = s.fiscalYears.find((f) => f.id === fyId);
      if (!fy || fy.status !== "closed") throw new LedgerError("Alleen een afgesloten boekjaar kan heropend worden");
      if (s.fiscalYears.some((f) => f.startDate > fy.endDate && f.status === "closed")) throw new LedgerError("Heropen eerst het latere boekjaar");
      fy.status = "closing";
      const d = this.dv(s);
      const closing = s.entries.filter((e) => e.fiscalYearId === fy.id && (e.template === "T25" || e.template === "T25b") && !d.reversedIds.has(e.id));
      for (const e of closing.reverse()) this.reverse(s, e.id, reason, actor);
      fy.status = "open";
      this.audit(s, actor, "fiscal_year.reopen", { label: fy.label }, reason);
    });
  }

  // -- integrity ------------------------------------------------------------------

  /** Full self-check (shown on the "Controle" page). */
  verify(): { label: string; ok: boolean; detail: string }[] {
    const s = this.state;
    const d = this.dv(s);
    const total = sum(s.entries.flatMap((e) => e.lines.map((l) => l.amount)));
    const unbalanced = s.entries.filter((e) => sum(e.lines.map((l) => l.amount)) !== 0).length;
    const bankChecks = s.bankAccounts.filter((b) => b.kind !== "cash").map((b) => {
      const txs = s.bankTransactions.filter((t) => t.bankAccountId === b.id);
      const order = (t: BankTx) => Number(t.matchedExternalId ?? t.externalId) || 0;
      const last = txs.filter((t) => t.balanceAfter !== null).sort((a, b) => (a.bookingDate === b.bookingDate ? order(a) - order(b) : a.bookingDate < b.bookingDate ? -1 : 1)).at(-1);
      // Hand-entered transactions not yet confirmed by a bank file come on top of the bank's last saldo.
      const pendingManual = sum(txs.filter((t) => t.manual && !t.matchedExternalId).map((t) => t.amount));
      const ledger = (d.bankBalance.get(b.id) ?? 0) - pendingManual;
      return { b, ok: !last || last.balanceAfter === ledger, ledger, bank: last?.balanceAfter ?? null };
    });
    let prev: string | null = null;
    let brokenAt: number | null = null;
    for (const r of s.audit) {
      const { prevHash, hash, ...record } = r;
      if (prevHash !== prev || sha256Hex((prev ?? "") + JSON.stringify(record)) !== hash) { brokenAt = r.id; break; }
      prev = hash;
    }
    const numbering = s.fiscalYears.every((fy) => {
      const nums = s.entries.filter((e) => e.fiscalYearId === fy.id).map((e) => Number(e.entryNumber.split("-").at(-1)));
      return nums.every((n, i) => n === i + 1);
    });
    return [
      { label: "Alle journaalposten sluiten op nul", ok: unbalanced === 0, detail: unbalanced ? `${unbalanced} posten sluiten niet` : `${s.entries.length} posten` },
      { label: "Activa = passiva (som van alle regels is € 0,00)", ok: total === 0, detail: formatEuro(total) },
      ...bankChecks.map((c) => ({ label: `Banksaldo ${c.b.name} = laatste saldo van de bank`, ok: c.ok, detail: c.bank === null ? "nog geen import" : `${formatEuro(cents(c.ledger))} / bank ${formatEuro(c.bank)}` })),
      { label: "Journaalnummers lopen zonder gaten", ok: numbering, detail: "" },
      { label: "Logboek is niet gewijzigd (hash-keten klopt)", ok: brokenAt === null, detail: brokenAt === null ? `${s.audit.length} regels` : `gebroken bij regel ${brokenAt}` },
    ];
  }

  private nextActivityNumber(s: State, date: LocalDate): string {
    const fy = fiscalYearFor(date, s.settings.fiscalYearStartMonth);
    const prefix = `A${fy.startDate.slice(2, 4)}-`;
    const used = s.activities.filter((a) => a.number?.startsWith(prefix)).map((a) => Number(a.number.slice(prefix.length)));
    return `${prefix}${String((used.length ? Math.max(...used) : 0) + 1).padStart(3, "0")}`;
  }

  // -- demo helpers (used by the demo generator only) --------------------------

  /** @internal Run several operations as one atomic batch. */
  batch<T>(fn: () => T): T {
    return this.transact(() => fn());
  }
}

export function today(): LocalDate {
  return localDate(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
}
