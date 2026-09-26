export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, "").toUpperCase();
}

/** ISO 13616 mod-97 check. */
export function isValidIban(iban: string): boolean {
  const s = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= "A" && ch <= "Z" ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

/** Group an IBAN in blocks of four for display. */
export function formatIban(iban: string): string {
  return normalizeIban(iban).replace(/(.{4})/g, "$1 ").trim();
}

/**
 * Find the payer's IBAN inside a description. Tikkie payouts arrive from Tikkie's own account
 * with "Tikkie ID …, <omschrijving>, <naam>, <IBAN betaler>" in the description.
 */
export function extractIbans(text: string): string[] {
  const found: string[] = [];
  for (const m of text.toUpperCase().matchAll(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g)) {
    if (isValidIban(m[0])) found.push(m[0]);
  }
  return found;
}
