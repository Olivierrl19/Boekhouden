import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import {
  decodeBankFile,
  looksLikeRabobankCsv,
  parseCsv,
  parseRabobankCsv,
  rabobankAmount,
  toRabobankCsv,
  CsvFormatError,
} from "./rabobank-csv";
import { extractIbans, formatIban, isValidIban } from "./iban";
import { payerIban, suggestAssignment, type SuggestionContext } from "./suggestions";

const fixture = (name: string) => readFileSync(new URL(`../../../fixtures/rabobank/${name}`, import.meta.url));

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, commas and newlines inside fields", () => {
    expect(parseCsv('"a","b ""c"", d"\r\n"x\ny",""\n')).toEqual([
      ["a", 'b "c", d'],
      ["x\ny", ""],
    ]);
  });
  it("refuses an unterminated quote", () => {
    expect(() => parseCsv('"abc')).toThrow(CsvFormatError);
  });
});

describe("Rabobank CSV", () => {
  it("parses the multi-account fixture", () => {
    const text = decodeBankFile(fixture("betaal-en-spaar.csv"));
    expect(looksLikeRabobankCsv(text)).toBe(true);
    const txs = parseRabobankCsv(text);
    expect(txs).toHaveLength(5);
    expect(txs[0]).toMatchObject({
      accountIban: "NL91RABO0315273637",
      externalId: "41231",
      bookingDate: "2026-09-01",
      amount: 1500,
      balanceAfter: 101500,
      counterpartyIban: "NL20INGB0001234567",
      counterpartyName: "J. Jansen",
      description: "Contributie september, Jan",
    });
    expect(txs[1].amount).toBe(-125050);
    expect(txs[1].balanceAfter).toBe(-23550);
    expect(txs[1].counterpartyName).toBe('Zaalverhuur "De Kelder", B.V.');
    expect(txs[1].description).toBe("Factuur 2026-17 huur okt, nov");
    expect(txs[4].accountIban).toBe("NL70RABO3163450289");
    // saldo chain within one account is consistent
    expect(txs[2].balanceAfter! - txs[2].amount).toBe(txs[1].balanceAfter);
  });

  it("decodes Windows-1252 exports", () => {
    const txs = parseRabobankCsv(decodeBankFile(fixture("windows-1252.csv")));
    expect(txs[0].counterpartyName).toBe("Zoë Brouwer");
    expect(txs[0].amount).toBe(750);
  });

  it("finds columns by name even when they are reordered", () => {
    const text = '"Bedrag","Volgnr","Saldo na trn","Datum","IBAN/BBAN"\n"-3,00","7","+10,00","2026-01-02","NL91 RABO 0315 2736 37"\n';
    expect(parseRabobankCsv(text)[0]).toMatchObject({ amount: -300, externalId: "7", accountIban: "NL91RABO0315273637" });
  });

  it("explains which column is missing and which line is wrong", () => {
    expect(() => parseRabobankCsv('"Datum","Bedrag"\n"2026-01-01","1,00"\n')).toThrow(/Volgnr/);
    expect(() =>
      parseRabobankCsv('"IBAN/BBAN","Volgnr","Datum","Bedrag","Saldo na trn"\n"NL91RABO0315273637","1","2026-13-01","1,00","1,00"\n'),
    ).toThrow(/Regel 2/);
  });

  it("round-trips through the writer", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1e8, max: 1e8 }).filter((n) => n !== 0), { minLength: 1, maxLength: 20 }), (amounts) => {
        let balance = 0;
        const rows = amounts.map((a, i) => {
          balance += a;
          return { iban: "NL91RABO0315273637", volgnr: i + 1, date: "2026-09-01", amount: rabobankAmount(a), balanceAfter: rabobankAmount(balance), description: `tx "${i}", test` };
        });
        const parsed = parseRabobankCsv(toRabobankCsv(rows));
        expect(parsed.map((p) => p.amount)).toEqual(amounts);
        expect(parsed.at(-1)!.balanceAfter).toBe(balance);
      }),
    );
  });
});

describe("IBAN helpers", () => {
  it("validates, formats and extracts", () => {
    expect(isValidIban("NL91 RABO 0315 2736 37")).toBe(true);
    expect(isValidIban("NL00RABO0315273637")).toBe(false);
    expect(formatIban("nl91rabo0315273637")).toBe("NL91 RABO 0315 2736 37");
    expect(extractIbans("Tikkie ID 1, Borrel, Piet, NL91ABNA0417164300 en NL00XXXX0000000000")).toEqual(["NL91ABNA0417164300"]);
  });
});

describe("suggestions", () => {
  const ctx: SuggestionContext = {
    ownIbans: ["NL91RABO0315273637", "NL70RABO3163450289"],
    thisAccountIban: "NL91RABO0315273637",
    partyByIban: new Map([
      ["NL20INGB0001234567", { id: "jan", name: "Jan" }],
      ["NL91ABNA0417164300", { id: "piet", name: "Piet" }],
    ]),
    lastByCounterparty: new Map([["NL44RABO0123456789", { target: { kind: "pot", potId: "bank" }, label: "Potje Bank" }]]),
  };

  it("marks transfers between own accounts as certain", () => {
    const s = suggestAssignment({ counterpartyIban: "NL70RABO3163450289", description: "" }, ctx);
    expect(s).toEqual([expect.objectContaining({ reason: "internal", autoBook: true })]);
  });
  it("suggests the person behind a known IBAN, never auto-booked", () => {
    const s = suggestAssignment({ counterpartyIban: "NL20INGB0001234567", description: "x" }, ctx);
    expect(s[0]).toMatchObject({ reason: "known_iban", target: { kind: "person", partyId: "jan" }, autoBook: false });
  });
  it("finds the payer inside a Tikkie description", () => {
    const tx = { counterpartyIban: "NL26ABNA0463712345", description: "Tikkie ID 1, Borrel, Piet, NL91ABNA0417164300" };
    expect(suggestAssignment(tx, ctx)[0]).toMatchObject({ reason: "iban_in_description", target: { partyId: "piet" } });
    expect(payerIban(tx, ctx.ownIbans)).toBe("NL91ABNA0417164300");
  });
  it("offers 'same as last time'", () => {
    const s = suggestAssignment({ counterpartyIban: "NL44RABO0123456789", description: "Kosten" }, ctx);
    expect(s[0]).toMatchObject({ reason: "same_as_last", target: { kind: "pot", potId: "bank" } });
  });
  it("has nothing to say about unknown counterparties", () => {
    expect(suggestAssignment({ counterpartyIban: null, description: "AH" }, ctx)).toEqual([]);
  });
});
