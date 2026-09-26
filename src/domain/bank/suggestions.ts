/**
 * Deterministic assignment suggestions (PLAN.md §7). No probabilities: a suggestion is either
 * certain (internal transfer → may be auto-booked) or a pre-filled proposal the user confirms.
 */
import { extractIbans, normalizeIban } from "./iban";

export type SuggestionTarget =
  | { kind: "internal" }
  | { kind: "person"; partyId: string }
  | { kind: "contribution"; partyId: string }
  | { kind: "savings"; partyId: string; goalId: string }
  | { kind: "activity"; activityId: string }
  | { kind: "pot"; potId: string };

export interface Suggestion {
  reason: "internal" | "contribution" | "known_iban" | "iban_in_description" | "same_as_last";
  label: string; // Dutch, shown in the UI
  target: SuggestionTarget;
  autoBook: boolean;
}

export interface SuggestionContext {
  ownIbans: string[];
  thisAccountIban: string | null;
  /** Known IBAN → party. */
  partyByIban: Map<string, { id: string; name: string }>;
  /** Last confirmed single-target assignment per counterparty IBAN. */
  lastByCounterparty: Map<string, { target: SuggestionTarget; label: string }>;
}

export function suggestAssignment(
  tx: { counterpartyIban: string | null; description: string },
  ctx: SuggestionContext,
): Suggestion[] {
  const out: Suggestion[] = [];
  const cp = tx.counterpartyIban ? normalizeIban(tx.counterpartyIban) : null;
  const own = new Set(ctx.ownIbans.map(normalizeIban));

  if (cp && own.has(cp) && cp !== ctx.thisAccountIban) {
    return [{ reason: "internal", label: "Overboeking tussen eigen rekeningen", target: { kind: "internal" }, autoBook: true }];
  }

  const seen = new Set<string>();
  if (cp) {
    const party = ctx.partyByIban.get(cp);
    if (party) {
      out.push({ reason: "known_iban", label: `Rekening van ${party.name} (bekend IBAN)`, target: { kind: "person", partyId: party.id }, autoBook: false });
      seen.add(party.id);
    }
  }
  for (const iban of extractIbans(tx.description)) {
    if (iban === cp || own.has(iban)) continue;
    const party = ctx.partyByIban.get(iban);
    if (party && !seen.has(party.id)) {
      out.push({ reason: "iban_in_description", label: `Rekening van ${party.name} (IBAN in omschrijving, bijv. Tikkie)`, target: { kind: "person", partyId: party.id }, autoBook: false });
      seen.add(party.id);
    }
  }
  if (cp) {
    const last = ctx.lastByCounterparty.get(cp);
    if (last && !(last.target.kind === "person" && seen.has(last.target.partyId)) && !out.some((o) => JSON.stringify(o.target) === JSON.stringify(last.target))) {
      out.push({ reason: "same_as_last", label: `Zelfde als vorige keer: ${last.label}`, target: last.target, autoBook: false });
    }
  }
  return out;
}

/** Payer IBAN worth remembering for a person: counterparty, or the IBAN inside a Tikkie description. */
export function payerIban(tx: { counterpartyIban: string | null; description: string }, ownIbans: string[]): string | null {
  const own = new Set(ownIbans.map(normalizeIban));
  const inDescription = extractIbans(tx.description).filter((i) => !own.has(i));
  if (/tikkie/i.test(tx.description) && inDescription.length) return inDescription.at(-1)!;
  return tx.counterpartyIban ? normalizeIban(tx.counterpartyIban) : (inDescription.at(-1) ?? null);
}
