import type { Cents } from "../money";
import type { LocalDate } from "../dates";

/** Accounts with a fixed role in the system. Bank/cash ledger accounts are linked via bank_accounts. */
export const SYSTEM_KEYS = [
  "GENERAL_RESERVE",
  "YEAR_RESULT",
  "INTERNAL_TRANSFER",
  "BANK_SUSPENSE",
  "MEMBER_ACCOUNTS",
  "EXTERNAL_ACCOUNTS",
  "TO_DISTRIBUTE",
  "ACCRUED_INCOME",
  "PREPAID_EXPENSES",
  "ACCOUNTS_PAYABLE",
  "ACCRUED_EXPENSES",
  "DEFERRED_INCOME",
  "CASH_DIFFERENCES",
  "BAD_DEBTS",
  "RESERVE_DOTATION",
  "RESERVE_WITHDRAWAL",
  "CONTRIBUTION",
] as const;
export type SystemKey = (typeof SYSTEM_KEYS)[number];

export type AccountRef = { key: SystemKey } | { id: string };

export const TEMPLATE_CODES = {
  T00: "Banktransactie geïmporteerd",
  T01: "Contributie",
  T02: "Betaling van persoon",
  T03: "Terugbetaling aan persoon",
  T05: "Declaratie goedgekeurd",
  T07: "Uitgave voor activiteit",
  T08: "Uitgave dispuut",
  T09: "Ontvangst dispuut",
  T10: "Ontvangst voor activiteit",
  T11: "Activiteit afgerekend",
  T12: "Op rekening gezet",
  T13: "Inkoopfactuur ontvangen",
  T14: "Inkoopfactuur betaald",
  T15: "Verkoopfactuur verstuurd",
  T16: "Verkoopfactuur ontvangen",
  T17: "Creditnota",
  T18: "Interne overboeking (uit)",
  T18b: "Interne overboeking (in)",
  T19: "Kasmutatie",
  T20: "Kastelling verschil",
  T21: "Dotatie bestemmingsreserve",
  T22: "Onttrekking bestemmingsreserve",
  T23: "Overlopende post",
  T24: "Tegenboeking overlopende post",
  T25: "Jaarafsluiting",
  T25b: "Resultaatbestemming",
  T26: "Beginbalans",
  T27: "Correctie (tegenboeking)",
  T28: "Afboeken oninbaar",
  T29: "Memoriaal",
  T31: "Gesplitste toewijzing",
} as const;
export type TemplateCode = keyof typeof TEMPLATE_CODES;

export interface LineDraft {
  account: AccountRef;
  amount: Cents; // > 0 debit, < 0 credit, never 0
  potId?: string | null;
  activityId?: string | null;
  partyId?: string | null;
  bankTransactionId?: string | null;
  invoiceId?: string | null;
  description?: string | null;
}

export interface EntryDraft {
  date: LocalDate;
  template: TemplateCode;
  description: string;
  lines: LineDraft[];
  sourceType?: string | null;
  sourceId?: string | null;
  reason?: string | null;
  isAutomatic?: boolean;
  autoReverse?: boolean;
  reversesEntryId?: string | null;
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}
