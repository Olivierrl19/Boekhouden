import type { Derived, Entry, Line, State } from "../ledger";

/** Human description of where a journal line went, in UI language (no debit/credit). */
export function lineTarget(state: State, d: Derived, l: Line): string {
  if (l.partyId) return d.partyById.get(l.partyId)?.name ?? "persoon";
  if (l.activityId) return `Activiteit ${state.activities.find((a) => a.id === l.activityId)?.name ?? ""}`;
  if (l.potId) return `Potje ${d.potById.get(l.potId)?.name ?? ""}`;
  const acc = d.accountById.get(l.accountId);
  if (acc?.systemKey === "INTERNAL_TRANSFER") return "Interne overboeking";
  return acc?.name ?? "";
}

/** "Waar geboekt" for an assignment entry: all non-suspense lines. */
export function whereBooked(state: State, d: Derived, entry: Entry | null): string {
  if (!entry) return "";
  return entry.lines
    .filter((l) => d.accountById.get(l.accountId)?.systemKey !== "BANK_SUSPENSE")
    .map((l) => lineTarget(state, d, l))
    .join(" + ");
}

export const TEMPLATE_LABEL: Record<string, string> = {
  T00: "Bankregel", T01: "Contributie", T02: "Betaling", T03: "Terugbetaling", T05: "Declaratie", T07: "Uitgave activiteit",
  T08: "Uitgave dispuut", T09: "Ontvangst dispuut", T10: "Ontvangst activiteit", T11: "Afrekening", T12: "Op rekening",
  T18: "Interne overboeking", T18b: "Interne overboeking", T19: "Kasmutatie", T20: "Kastelling", T21: "Dotatie reserve",
  T22: "Onttrekking reserve", T23: "Overlopende post", T25: "Jaarafsluiting", T25b: "Resultaatbestemming", T26: "Beginbalans",
  T27: "Tegenboeking", T29: "Memoriaal", T31: "Gesplitst",
};
