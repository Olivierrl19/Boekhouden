/**
 * Parser for Rabobank "CSV" exports (Rabo Internetbankieren → Download transacties → CSV).
 *
 * Columns are looked up by NAME, not position, so an added or moved column doesn't break the
 * import. Amounts are parsed as strings into cents (never floats). One file may contain several
 * accounts (e.g. betaal + spaar): every row carries its own IBAN.
 *
 * NOTE: no real export was available while writing this; fixtures in /fixtures/rabobank are
 * synthetic, built from the documented column layout. Verify against a real export.
 */
import { parseEuroString } from "../money";
import { localDate } from "../dates";
import { normalizeIban } from "./iban";
import type { NormalizedBankTransaction } from "./types";

export const RABOBANK_COLUMNS = [
  "IBAN/BBAN", "Munt", "BIC", "Volgnr", "Datum", "Rentedatum", "Bedrag", "Saldo na trn",
  "Tegenrekening IBAN/BBAN", "Naam tegenpartij", "Naam uiteindelijke partij", "Naam initiërende partij",
  "BIC tegenpartij", "Code", "Batch ID", "Transactiereferentie", "Machtigingskenmerk", "Incassant ID",
  "Betalingskenmerk", "Omschrijving-1", "Omschrijving-2", "Omschrijving-3", "Reden retour",
  "Oorspr bedrag", "Oorspr munt", "Koers",
] as const;

const REQUIRED = ["IBAN/BBAN", "Volgnr", "Datum", "Bedrag", "Saldo na trn"] as const;

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvFormatError";
  }
}

/** RFC 4180-style CSV: quoted fields, doubled quotes, commas/newlines inside quotes. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (inQuotes) throw new CsvFormatError("Onverwacht einde van het bestand (niet-afgesloten aanhalingsteken)");
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

/** Decode file bytes: UTF-8 when valid, otherwise Windows-1252 (older Rabobank exports). */
export function decodeBankFile(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("windows-1252").decode(data);
  }
}

export function looksLikeRabobankCsv(text: string): boolean {
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  return firstLine.includes("IBAN/BBAN") && firstLine.includes("Volgnr") && firstLine.includes("Saldo na trn");
}

export function parseRabobankCsv(text: string): NormalizedBankTransaction[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new CsvFormatError("Het bestand is leeg");
  const header = rows[0].map((h) => h.trim());
  const index = new Map(header.map((h, i) => [h, i]));
  const missing = REQUIRED.filter((c) => !index.has(c));
  if (missing.length) {
    throw new CsvFormatError(
      `Dit lijkt geen Rabobank CSV-export: kolom(men) ${missing.map((m) => `"${m}"`).join(", ")} ontbreken`,
    );
  }
  const get = (row: string[], col: string) => {
    const i = index.get(col);
    return i === undefined ? "" : (row[i] ?? "").trim();
  };

  return rows.slice(1).map((row, n) => {
    const line = n + 2;
    try {
      const counterpartyIban = get(row, "Tegenrekening IBAN/BBAN");
      const description = ["Omschrijving-1", "Omschrijving-2", "Omschrijving-3"]
        .map((c) => get(row, c))
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const raw: Record<string, string> = {};
      header.forEach((h, i) => {
        if (row[i]) raw[h] = row[i];
      });
      const rente = get(row, "Rentedatum");
      return {
        accountIban: normalizeIban(get(row, "IBAN/BBAN")),
        externalId: get(row, "Volgnr").replace(/^0+(?=\d)/, ""),
        bookingDate: localDate(get(row, "Datum")),
        valueDate: rente ? localDate(rente) : null,
        amount: parseEuroString(get(row, "Bedrag")),
        balanceAfter: parseEuroString(get(row, "Saldo na trn")),
        counterpartyIban: counterpartyIban ? normalizeIban(counterpartyIban) : null,
        counterpartyName: get(row, "Naam tegenpartij") || null,
        description,
        endToEndId: get(row, "Transactiereferentie") || null,
        paymentReference: get(row, "Betalingskenmerk") || null,
        returnReason: get(row, "Reden retour") || null,
        raw,
      } satisfies NormalizedBankTransaction;
    } catch (err) {
      throw new CsvFormatError(`Regel ${line}: ${(err as Error).message}`);
    }
  });
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Write transactions in Rabobank CSV layout (used for demo files and tests). */
export function toRabobankCsv(
  rows: {
    iban: string;
    volgnr: number | string;
    date: string;
    amount: string; // "+12,50"
    balanceAfter: string;
    counterpartyIban?: string;
    counterpartyName?: string;
    description?: string;
  }[],
): string {
  const lines = [RABOBANK_COLUMNS.map(quote).join(",")];
  for (const r of rows) {
    const values: Record<string, string> = {
      "IBAN/BBAN": r.iban,
      Munt: "EUR",
      BIC: "RABONL2U",
      Volgnr: String(r.volgnr).padStart(18, "0"),
      Datum: r.date,
      Rentedatum: r.date,
      Bedrag: r.amount,
      "Saldo na trn": r.balanceAfter,
      "Tegenrekening IBAN/BBAN": r.counterpartyIban ?? "",
      "Naam tegenpartij": r.counterpartyName ?? "",
      Code: r.counterpartyIban ? "tb" : "bc",
      "Omschrijving-1": r.description ?? "",
    };
    lines.push(RABOBANK_COLUMNS.map((c) => quote(values[c] ?? "")).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Cents → Rabobank amount notation ("+1234,56" / "-12,50"). */
export function rabobankAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "+";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}
