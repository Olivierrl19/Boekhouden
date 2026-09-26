/**
 * Parser for ING "Af- en bijschrijvingen" CSV exports (Mijn ING → Downloaden → Kommagescheiden CSV
 * of Puntkommagescheiden CSV). Handles the Dutch and the English column names, comma and
 * semicolon separated files, and files with or without "Saldo na mutatie".
 *
 * ING exports have no sequence number, so the idempotency key is derived from the transaction
 * itself: date, amount, counterparty, name and message, plus a counter for identical rows on the
 * same day. Re-importing an overlapping period therefore recognises transactions already present,
 * as long as whole days are exported (ING always does).
 *
 * The file lists the newest transaction first; the result is returned oldest first.
 */
import { parseEuroString } from "../money";
import { localDate } from "../dates";
import { normalizeIban } from "./iban";
import { CsvFormatError, parseCsv } from "./rabobank-csv";
import type { NormalizedBankTransaction } from "./types";

const COLUMNS = {
  date: ["Datum", "Date"],
  name: ["Naam / Omschrijving", "Name / Description"],
  account: ["Rekening", "Account"],
  counterparty: ["Tegenrekening", "Counterparty"],
  code: ["Code"],
  sign: ["Af Bij", "Debit/credit"],
  amount: ["Bedrag (EUR)", "Amount (EUR)"],
  kind: ["Mutatiesoort", "Transaction type"],
  message: ["Mededelingen", "Notifications", "Omschrijving"],
  balance: ["Saldo na mutatie", "Resulting balance"],
} as const;

export function looksLikeIngCsv(text: string): boolean {
  const first = (text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "").replace(/"/g, "");
  return (first.includes("Naam / Omschrijving") || first.includes("Name / Description")) &&
    (first.includes("Af Bij") || first.includes("Debit/credit"));
}

/** Small deterministic string hash (FNV-1a, 32 bit) for the idempotency key. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}

function ingDate(raw: string): string {
  const s = raw.trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const nl = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s);
  if (nl) return `${nl[3]}-${nl[2].padStart(2, "0")}-${nl[1].padStart(2, "0")}`;
  return s;
}

export function parseIngCsv(text: string): NormalizedBankTransaction[] {
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
  const rows = parseCsv(text, delimiter);
  if (rows.length === 0) throw new CsvFormatError("Het bestand is leeg");
  const header = rows[0].map((h) => h.trim());
  const col = (names: readonly string[]) => {
    const i = header.findIndex((h) => names.includes(h));
    return i < 0 ? null : i;
  };
  const idx = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, col(names)])) as Record<keyof typeof COLUMNS, number | null>;
  const missing = (["date", "name", "account", "sign", "amount"] as const).filter((k) => idx[k] === null);
  if (missing.length) {
    throw new CsvFormatError(`Dit lijkt geen ING CSV-export: kolom(men) ${missing.map((m) => `"${COLUMNS[m][0]}"`).join(", ")} ontbreken`);
  }
  const get = (row: string[], k: keyof typeof COLUMNS) => (idx[k] === null ? "" : (row[idx[k] as number] ?? "").trim());

  const parsed = rows.slice(1).map((row, n) => {
    try {
      const sign = get(row, "sign").toLowerCase();
      if (!["af", "bij", "debit", "credit"].includes(sign)) throw new Error(`onbekende waarde "${get(row, "sign")}" in kolom Af Bij`);
      const abs = parseEuroString(get(row, "amount"));
      if (abs < 0) throw new Error("bedrag hoort zonder minteken te staan");
      const amount = (sign === "af" || sign === "debit" ? -abs : abs) as NormalizedBankTransaction["amount"];
      const counterparty = get(row, "counterparty").replace(/\s/g, "");
      const balance = get(row, "balance");
      const raw: Record<string, string> = {};
      header.forEach((h, i) => {
        if (row[i]) raw[h] = row[i];
      });
      const message = get(row, "message").replace(/\s+/g, " ").trim();
      return {
        accountIban: normalizeIban(get(row, "account")),
        externalId: "",
        bookingDate: localDate(ingDate(get(row, "date"))),
        valueDate: null,
        amount,
        balanceAfter: balance ? parseEuroString(balance) : null,
        counterpartyIban: counterparty && /^[A-Z]{2}\d{2}/i.test(counterparty) ? normalizeIban(counterparty) : null,
        counterpartyName: get(row, "name") || null,
        description: message,
        raw,
      } satisfies NormalizedBankTransaction;
    } catch (err) {
      throw new CsvFormatError(`Regel ${n + 2}: ${(err as Error).message}`);
    }
  });

  const chronological = orderOldestFirst(parsed);
  const counter = new Map<string, number>();
  for (const t of chronological) {
    const base = `${t.accountIban}|${t.bookingDate}|${t.amount}|${t.counterpartyIban ?? ""}|${t.counterpartyName ?? ""}|${t.description}`;
    const n = (counter.get(base) ?? 0) + 1;
    counter.set(base, n);
    t.externalId = `ING-${t.bookingDate.replace(/-/g, "")}-${fnv1a(base)}-${n}`;
  }
  return chronological;
}

/** ING lists newest first. Reverse when needed; with balances, pick the order whose saldo chain holds. */
function orderOldestFirst(rows: NormalizedBankTransaction[]): NormalizedBankTransaction[] {
  if (rows.length < 2) return rows;
  const reversed = [...rows].reverse();
  const chainHolds = (list: NormalizedBankTransaction[]) =>
    list.every((t, i) => i === 0 || t.balanceAfter === null || list[i - 1].balanceAfter === null || (list[i - 1].balanceAfter as number) + t.amount === t.balanceAfter);
  const datesAscending = (list: NormalizedBankTransaction[]) => list.every((t, i) => i === 0 || list[i - 1].bookingDate <= t.bookingDate);
  if (rows.every((t) => t.balanceAfter !== null)) {
    if (datesAscending(rows) && chainHolds(rows)) return rows;
    if (datesAscending(reversed) && chainHolds(reversed)) return reversed;
  }
  if (datesAscending(reversed)) return reversed; // also when all rows share one date: ING order is newest first
  if (datesAscending(rows)) return rows;
  return [...rows].sort((a, b) => (a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : 0));
}
