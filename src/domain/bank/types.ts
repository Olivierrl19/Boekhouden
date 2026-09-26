import type { Cents } from "../money";
import type { LocalDate } from "../dates";

/** A bank transaction as produced by any connector (Rabobank CSV, CAMT.053, PSD2 later). */
export interface NormalizedBankTransaction {
  accountIban: string | null; // null for cash
  externalId: string; // idempotency key within the account (Rabobank: Volgnr)
  bookingDate: LocalDate;
  valueDate: LocalDate | null;
  amount: Cents; // + incoming, - outgoing
  balanceAfter: Cents | null;
  counterpartyIban: string | null;
  counterpartyName: string | null;
  description: string;
  endToEndId?: string | null;
  paymentReference?: string | null;
  returnReason?: string | null;
  raw?: Record<string, unknown>;
}
