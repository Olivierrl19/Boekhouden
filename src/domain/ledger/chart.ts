/**
 * Default chart of accounts and pots (PLAN.md §4). Used by the seed and the setup wizard.
 */
import type { SystemKey } from "./types";

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export interface DefaultAccount {
  code: string;
  name: string;
  type: AccountType;
  systemKey?: SystemKey;
  partyKind?: "member" | "external";
  requiresActivity?: boolean;
  manualPostingAllowed?: boolean;
  /** Marks bank/cash ledger accounts; they are linked to a bank_accounts row. */
  bank?: "checking" | "savings" | "cash";
}

export const DEFAULT_ACCOUNTS: DefaultAccount[] = [
  // Equity
  { code: "0500", name: "Algemene reserve", type: "equity", systemKey: "GENERAL_RESERVE" },
  { code: "0510", name: "Bestemmingsreserve lustrum", type: "equity" },
  { code: "0520", name: "Bestemmingsreserve huisfonds", type: "equity" },
  { code: "0590", name: "Resultaat boekjaar (afsluitrekening)", type: "equity", systemKey: "YEAR_RESULT", manualPostingAllowed: false },
  // Liquid assets
  { code: "1000", name: "Betaalrekening", type: "asset", manualPostingAllowed: false, bank: "checking" },
  { code: "1010", name: "Spaarrekening", type: "asset", manualPostingAllowed: false, bank: "savings" },
  { code: "1050", name: "Kas", type: "asset", manualPostingAllowed: false, bank: "cash" },
  { code: "1090", name: "Interne overboekingen onderweg", type: "asset", systemKey: "INTERNAL_TRANSFER", manualPostingAllowed: false },
  { code: "1099", name: "Te verwerken bank- en kasmutaties", type: "asset", systemKey: "BANK_SUSPENSE", manualPostingAllowed: false },
  // Receivables
  { code: "1300", name: "Rekeningen leden", type: "asset", systemKey: "MEMBER_ACCOUNTS", partyKind: "member" },
  { code: "1305", name: "Contributie te ontvangen", type: "asset", systemKey: "CONTRIBUTION_RECEIVABLE", partyKind: "member" },
  { code: "1310", name: "Rekeningen externen", type: "asset", systemKey: "EXTERNAL_ACCOUNTS", partyKind: "external" },
  { code: "1320", name: "Nog te ontvangen bedragen", type: "asset", systemKey: "ACCRUED_INCOME" },
  { code: "1350", name: "Nog te verdelen (activiteiten)", type: "asset", systemKey: "TO_DISTRIBUTE", requiresActivity: true },
  { code: "1400", name: "Vooruitbetaalde kosten", type: "asset", systemKey: "PREPAID_EXPENSES" },
  // Liabilities
  { code: "1600", name: "Crediteuren", type: "liability", systemKey: "ACCOUNTS_PAYABLE", partyKind: "external" },
  { code: "1700", name: "Nog te betalen kosten", type: "liability", systemKey: "ACCRUED_EXPENSES" },
  { code: "1730", name: "Vooruitontvangen bedragen", type: "liability", systemKey: "DEFERRED_INCOME" },
  { code: "1740", name: "Spaartegoeden leden", type: "liability", systemKey: "MEMBER_SAVINGS", partyKind: "member" },
  // Income
  { code: "8000", name: "Contributie", type: "income", systemKey: "CONTRIBUTION" },
  { code: "8100", name: "Sponsoring", type: "income" },
  { code: "8110", name: "Donaties en giften", type: "income", systemKey: "DONATIONS" },
  { code: "8400", name: "Verhuur", type: "income" },
  { code: "8800", name: "Rente", type: "income" },
  { code: "8900", name: "Overige baten", type: "income" },
  { code: "8950", name: "Onttrekking bestemmingsreserves", type: "income", systemKey: "RESERVE_WITHDRAWAL" },
  // Expenses
  { code: "4000", name: "Kosten borrels (dispuutsdeel)", type: "expense" },
  { code: "4100", name: "Huisvesting", type: "expense" },
  { code: "4200", name: "Kosten activiteiten (dispuutsdeel)", type: "expense" },
  { code: "4300", name: "Kosten lustrum", type: "expense" },
  { code: "4400", name: "Bestuurskosten", type: "expense" },
  { code: "4500", name: "Bankkosten", type: "expense" },
  { code: "4600", name: "Kosten ALV", type: "expense" },
  { code: "4700", name: "Representatie en cadeaus", type: "expense" },
  { code: "4800", name: "Kas- en afrondingsverschillen", type: "expense", systemKey: "CASH_DIFFERENCES" },
  { code: "4850", name: "Oninbare vorderingen", type: "expense", systemKey: "BAD_DEBTS" },
  { code: "4900", name: "Dotatie bestemmingsreserves", type: "expense", systemKey: "RESERVE_DOTATION" },
  { code: "4990", name: "Overige kosten", type: "expense" },
];

export interface DefaultPot {
  code: string;
  name: string;
  income?: string; // account code
  expense?: string; // account code
}

export const DEFAULT_POTS: DefaultPot[] = [
  { code: "CONTRIBUTIE", name: "Contributie", income: "8000", expense: "4990" },
  { code: "SPONSORING", name: "Sponsoring", income: "8100", expense: "4990" },
  { code: "DONATIES", name: "Donaties", income: "8110", expense: "4990" },
  { code: "BORRELS", name: "Borrels", income: "8900", expense: "4000" },
  { code: "HUISVESTING", name: "Huisvesting", income: "8400", expense: "4100" },
  { code: "ACTIVITEITEN", name: "Activiteiten", income: "8900", expense: "4200" },
  { code: "LUSTRUM", name: "Lustrum", income: "8900", expense: "4300" },
  { code: "BESTUUR", name: "Bestuur", income: "8900", expense: "4400" },
  { code: "ALV", name: "ALV", income: "8900", expense: "4600" },
  { code: "BANK", name: "Bank", income: "8800", expense: "4500" },
  { code: "RESERVERINGEN", name: "Reserveringen", income: "8950", expense: "4900" },
  { code: "ALGEMEEN", name: "Algemeen", income: "8900", expense: "4990" },
];
