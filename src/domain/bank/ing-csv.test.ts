import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { looksLikeIngCsv, parseIngCsv } from "./ing-csv";
import { looksLikeRabobankCsv, CsvFormatError } from "./rabobank-csv";

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/ing/${name}`, import.meta.url), "utf8");

describe("ING CSV", () => {
  it("parses a semicolon export with balances, oldest first", () => {
    const text = fixture("puntkomma-met-saldo.csv");
    expect(looksLikeIngCsv(text)).toBe(true);
    expect(looksLikeRabobankCsv(text)).toBe(false);
    const txs = parseIngCsv(text);
    expect(txs.map((t) => t.amount)).toEqual([-9460, 4649, 4649, -1250]);
    expect(txs.map((t) => t.balanceAfter)).toEqual([99842, 104491, 109140, 107890]);
    expect(txs[0]).toMatchObject({
      accountIban: "NL69INGB0123456789",
      bookingDate: "2026-09-01",
      counterpartyIban: "NL91ABNA0417164300",
      counterpartyName: "Woningstichting",
      description: "Huur woonkamer",
    });
    expect(txs[3].counterpartyIban).toBeNull();
  });

  it("gives identical rows on one day distinct, stable ids", () => {
    const a = parseIngCsv(fixture("puntkomma-met-saldo.csv"));
    const b = parseIngCsv(fixture("puntkomma-met-saldo.csv"));
    expect(new Set(a.map((t) => t.externalId)).size).toBe(4);
    expect(a.map((t) => t.externalId)).toEqual(b.map((t) => t.externalId));
    expect(a[1].externalId.endsWith("-1")).toBe(true);
    expect(a[2].externalId.endsWith("-2")).toBe(true);
  });

  it("parses the English comma export without balances", () => {
    const text = fixture("komma-engels-zonder-saldo.csv");
    expect(looksLikeIngCsv(text)).toBe(true);
    const txs = parseIngCsv(text);
    expect(txs).toHaveLength(2);
    expect(txs[0]).toMatchObject({ bookingDate: "2025-07-01", amount: -102445, balanceAfter: null });
    expect(txs[1]).toMatchObject({ bookingDate: "2025-07-02", amount: 5281, description: "Contributie + 20 LR ophogen" });
  });

  it("refuses unknown Af Bij values and missing columns", () => {
    expect(() => parseIngCsv('"Datum";"Naam / Omschrijving";"Rekening";"Af Bij";"Bedrag (EUR)"\n"20260101";"x";"NL69INGB0123456789";"?";"1,00"\n')).toThrow(CsvFormatError);
    expect(() => parseIngCsv('"Datum";"Naam / Omschrijving"\n"20260101";"x"\n')).toThrow(/ontbreken/);
  });
});
