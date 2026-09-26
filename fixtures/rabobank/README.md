# Rabobank CSV fixtures

**Synthetic.** No real Rabobank export was available when these were made. They follow the
documented Rabobank CSV layout (quoted fields, comma separated, `+12,50` amounts, 18-digit
`Volgnr`, `Saldo na trn` per row). Replace or extend with an anonymised real export to verify
the parser (`src/domain/bank/rabobank-csv.ts`).

- `betaal-en-spaar.csv` — two accounts in one file, a Tikkie payout, an internal transfer,
  quotes and commas inside descriptions, a thousands amount.
- `windows-1252.csv` — same layout encoded in Windows-1252 (ë in a name).
