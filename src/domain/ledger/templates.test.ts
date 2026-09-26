import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { cents, sum, type Cents } from "../money";
import { localDate } from "../dates";
import {
  activitySettled,
  assignBankTransaction,
  bankTransactionImported,
  cashCountDifference,
  chargedToPerson,
  computeSettlement,
  contributionCharged,
  expenseClaimApproved,
  memorial,
  mirrorEntry,
  openingBalance,
  purchaseInvoiceReceived,
  reserveDotation,
  reserveWithdrawal,
  salesInvoiceSent,
  savingsSettled,
  validateDraft,
  writeOff,
  yearClose,
  type AssignmentTarget,
} from "./templates";
import { LedgerError, type EntryDraft, type LineDraft } from "./types";

const D = localDate("2026-09-15");
const tx = (amount: number) => ({ id: "btx1", date: D, amount: cents(amount), description: "test" });

function acc(line: LineDraft): string {
  return "key" in line.account ? line.account.key : `id:${line.account.id}`;
}
function linesOf(draft: EntryDraft) {
  return draft.lines.map((l) => [acc(l), l.amount]);
}
function expectBalanced(draft: EntryDraft) {
  expect(sum(draft.lines.map((l) => l.amount))).toBe(0);
  expect(() => validateDraft(draft)).not.toThrow();
}

describe("validateDraft", () => {
  it("rejects unbalanced, single-line and zero-line drafts", () => {
    const base = { date: D, template: "T29" as const, description: "x", reason: "r" };
    expect(() =>
      validateDraft({ ...base, lines: [{ account: { key: "GENERAL_RESERVE" }, amount: cents(1) }] }),
    ).toThrow(LedgerError);
    expect(() =>
      validateDraft({
        ...base,
        lines: [
          { account: { key: "GENERAL_RESERVE" }, amount: cents(1) },
          { account: { key: "ACCRUED_INCOME" }, amount: cents(-2) },
        ],
      }),
    ).toThrow(/sluit niet/);
    expect(() =>
      validateDraft({
        ...base,
        lines: [
          { account: { key: "GENERAL_RESERVE" }, amount: cents(0) },
          { account: { key: "ACCRUED_INCOME" }, amount: cents(0) },
        ],
      }),
    ).toThrow(/bedrag 0/);
  });

  it("requires a reason for memorial entries", () => {
    expect(() =>
      validateDraft({
        date: D,
        template: "T29",
        description: "x",
        lines: [
          { account: { key: "GENERAL_RESERVE" }, amount: cents(1) },
          { account: { key: "ACCRUED_INCOME" }, amount: cents(-1) },
        ],
      }),
    ).toThrow(/reden/i);
  });
});

describe("T00/T19 bank transaction imported", () => {
  it("debits the bank and credits suspense for incoming money", () => {
    const d = bankTransactionImported({ tx: tx(2500), bankLedgerAccountId: "bank" });
    expect(d.template).toBe("T00");
    expect(linesOf(d)).toEqual([
      ["id:bank", 2500],
      ["BANK_SUSPENSE", -2500],
    ]);
    expect(d.lines.every((l) => l.bankTransactionId === "btx1")).toBe(true);
    expectBalanced(d);
  });
  it("uses T19 for cash and mirrors outgoing amounts", () => {
    const d = bankTransactionImported({ tx: tx(-990), bankLedgerAccountId: "kas", isCash: true });
    expect(d.template).toBe("T19");
    expect(linesOf(d)).toEqual([
      ["id:kas", -990],
      ["BANK_SUSPENSE", 990],
    ]);
  });
  it("refuses zero amounts", () => {
    expect(() => bankTransactionImported({ tx: tx(0), bankLedgerAccountId: "bank" })).toThrow(LedgerError);
  });
});

describe("assigning a bank transaction", () => {
  const cases: [string, AssignmentTarget, string, [string, number]][] = [
    ["T02 payment from member", { kind: "person", partyId: "p", partyKind: "member", amount: cents(2500) }, "T02", ["MEMBER_ACCOUNTS", -2500]],
    ["T03 refund to member", { kind: "person", partyId: "p", partyKind: "member", amount: cents(-2500) }, "T03", ["MEMBER_ACCOUNTS", 2500]],
    ["T02 payment from external", { kind: "person", partyId: "p", partyKind: "external", amount: cents(2500) }, "T02", ["EXTERNAL_ACCOUNTS", -2500]],
    ["T07 activity expense", { kind: "activity", activityId: "a", amount: cents(-2500) }, "T07", ["TO_DISTRIBUTE", 2500]],
    ["T10 activity income", { kind: "activity", activityId: "a", amount: cents(2500) }, "T10", ["TO_DISTRIBUTE", -2500]],
    ["T08 pot expense", { kind: "pot", potId: "pot", accountId: "4500", amount: cents(-2500) }, "T08", ["id:4500", 2500]],
    ["T09 pot income", { kind: "pot", potId: "pot", accountId: "8800", amount: cents(2500) }, "T09", ["id:8800", -2500]],
    ["T14 purchase invoice paid", { kind: "purchase_invoice", invoiceId: "i", partyId: "p", amount: cents(-2500) }, "T14", ["ACCOUNTS_PAYABLE", 2500]],
    ["T16 sales invoice received", { kind: "sales_invoice", invoiceId: "i", partyId: "p", amount: cents(2500) }, "T16", ["EXTERNAL_ACCOUNTS", -2500]],
    ["T18 internal transfer out", { kind: "internal", amount: cents(-2500) }, "T18", ["INTERNAL_TRANSFER", 2500]],
    ["T18b internal transfer in", { kind: "internal", amount: cents(2500) }, "T18b", ["INTERNAL_TRANSFER", -2500]],
  ];
  it.each(cases)("%s", (_name, target, template, targetLine) => {
    const d = assignBankTransaction({ tx: tx(target.amount), targets: [target] });
    expect(d.template).toBe(template);
    expect(linesOf(d)).toEqual([["BANK_SUSPENSE", target.amount], targetLine]);
    expectBalanced(d);
  });

  it("T31 split over several targets", () => {
    const d = assignBankTransaction({
      tx: tx(-10000),
      targets: [
        { kind: "activity", activityId: "a", amount: cents(-7000) },
        { kind: "pot", potId: "pot", accountId: "4000", amount: cents(-3000) },
      ],
    });
    expect(d.template).toBe("T31");
    expect(linesOf(d)).toEqual([
      ["BANK_SUSPENSE", -10000],
      ["TO_DISTRIBUTE", 7000],
      ["id:4000", 3000],
    ]);
    expectBalanced(d);
  });

  it("refuses targets that do not add up to the transaction amount", () => {
    expect(() =>
      assignBankTransaction({
        tx: tx(-10000),
        targets: [{ kind: "activity", activityId: "a", amount: cents(-9999) }],
      }),
    ).toThrow(/niet gelijk/);
  });
});

describe("T01 contribution", () => {
  it("puts it on the member's contribution account and books income on the contribution pot", () => {
    const d = contributionCharged({
      chargeId: "c",
      partyId: "p",
      month: localDate("2026-09-01"),
      amount: cents(1500),
      incomeAccountId: "8000",
      split: [{ potId: "pot", weight: 1 }],
      description: "Contributie september 2026",
    });
    expect(d.template).toBe("T01");
    expect(linesOf(d)).toEqual([
      ["CONTRIBUTION_RECEIVABLE", 1500],
      ["id:8000", -1500],
    ]);
    expect(d.lines[0].partyId).toBe("p");
    expect(d.lines[1].potId).toBe("pot");
  });

  it("divides the income over pots with the key, exactly to the cent", () => {
    const d = contributionCharged({
      chargeId: "c",
      partyId: "p",
      month: localDate("2026-09-01"),
      amount: cents(1000),
      incomeAccountId: "8000",
      split: [{ potId: "huis", weight: 1 }, { potId: "act", weight: 1 }, { potId: "res", weight: 1 }, { potId: "leeg", weight: 0 }],
      description: "Contributie",
    });
    expect(d.lines.slice(1).map((l) => [l.potId, l.amount])).toEqual([["huis", -334], ["act", -333], ["res", -333]]);
    expectBalanced(d);
  });

  it("refuses an empty key", () => {
    expect(() => contributionCharged({ chargeId: "c", partyId: "p", month: localDate("2026-09-01"), amount: cents(1), incomeAccountId: "8000", split: [], description: "x" })).toThrow(/verdeelsleutel/);
  });
});

describe("contribution payments, savings and donations", () => {
  it("assigns a payment to the contribution account", () => {
    const d = assignBankTransaction({ tx: tx(1500), targets: [{ kind: "contribution", partyId: "p", amount: cents(1500) }] });
    expect(d.template).toBe("T02");
    expect(linesOf(d)).toEqual([["BANK_SUSPENSE", 1500], ["CONTRIBUTION_RECEIVABLE", -1500]]);
  });
  it("assigns a savings deposit to the member's savings goal", () => {
    const d = assignBankTransaction({ tx: tx(2000), targets: [{ kind: "savings", partyId: "p", goalId: "lustrum", amount: cents(2000) }] });
    expect(d.template).toBe("T33");
    expect(linesOf(d)).toEqual([["BANK_SUSPENSE", 2000], ["MEMBER_SAVINGS", -2000]]);
    expect(d.lines[1].savingsGoalId).toBe("lustrum");
  });
  it("records the donor on a donation without making it a person balance", () => {
    const d = assignBankTransaction({ tx: tx(5000), targets: [{ kind: "pot", potId: "don", accountId: "8110", amount: cents(5000), relatedPartyId: "oudlid" }] });
    expect(d.lines[1]).toMatchObject({ potId: "don", relatedPartyId: "oudlid" });
    expect(d.lines[1].partyId ?? null).toBeNull();
  });
  it("T32 moves savings to the member's account", () => {
    const d = savingsSettled({ partyId: "p", goalId: "lustrum", goalName: "Lustrumreis", date: D, amount: cents(25000) });
    expect(linesOf(d)).toEqual([["MEMBER_SAVINGS", 25000], ["MEMBER_ACCOUNTS", -25000]]);
    expectBalanced(d);
  });
});

describe("T05 expense claim approved", () => {
  it("puts the cost on the activity and credits the claimant", () => {
    const d = expenseClaimApproved({
      claimId: "c",
      partyId: "p",
      date: D,
      amount: cents(4599),
      target: { kind: "activity", activityId: "a" },
      description: "Bierfusten",
    });
    expect(linesOf(d)).toEqual([
      ["TO_DISTRIBUTE", 4599],
      ["MEMBER_ACCOUNTS", -4599],
    ]);
  });
  it("can go to a pot instead", () => {
    const d = expenseClaimApproved({
      claimId: "c",
      partyId: "p",
      date: D,
      amount: cents(1000),
      target: { kind: "pot", potId: "pot", accountId: "4400" },
      description: "Bestuursetentje",
    });
    expect(linesOf(d)).toEqual([
      ["id:4400", 1000],
      ["MEMBER_ACCOUNTS", -1000],
    ]);
  });
});

describe("T12 charge to person", () => {
  it("puts an amount on an external's account against an activity", () => {
    const d = chargedToPerson({
      partyId: "ext",
      partyKind: "external",
      date: D,
      amount: cents(12000),
      target: { kind: "activity", activityId: "a" },
      description: "Deel feest dispuut X",
    });
    expect(linesOf(d)).toEqual([
      ["EXTERNAL_ACCOUNTS", 12000],
      ["TO_DISTRIBUTE", -12000],
    ]);
  });
});

describe("T11 activity settlement", () => {
  it("splits equally, with fixed amounts and a share for the association", () => {
    const allocations = computeSettlement(cents(10000), [
      { partyId: "a", partyKind: "member", method: "equal" },
      { partyId: "b", partyKind: "member", method: "equal" },
      { partyId: "c", partyKind: "member", method: "equal" },
      { partyId: "ext", partyKind: "external", method: "fixed", fixedAmount: cents(2500) },
      { partyId: null, method: "fixed", fixedAmount: cents(1000) },
    ]);
    expect(allocations.map((a) => a.amount)).toEqual([2167, 2167, 2166, 2500, 1000]);

    const d = activitySettled({
      activityId: "act",
      activityName: "Feest",
      date: D,
      balance: cents(10000),
      allocations,
      potId: "pot",
      expenseAccountId: "4200",
    })!;
    expect(d.template).toBe("T11");
    expect(linesOf(d)).toEqual([
      ["TO_DISTRIBUTE", -10000],
      ["MEMBER_ACCOUNTS", 2167],
      ["MEMBER_ACCOUNTS", 2167],
      ["MEMBER_ACCOUNTS", 2166],
      ["EXTERNAL_ACCOUNTS", 2500],
      ["id:4200", 1000],
    ]);
    expectBalanced(d);
  });

  it("splits by weight (streepjes)", () => {
    const allocations = computeSettlement(cents(9000), [
      { partyId: "a", partyKind: "member", method: "weight", weight: 12 },
      { partyId: "b", partyKind: "member", method: "weight", weight: 6 },
      { partyId: "c", partyKind: "member", method: "weight", weight: 0 },
    ]);
    expect(allocations.map((a) => a.amount)).toEqual([6000, 3000, 0]);
  });

  it("returns a surplus (negative balance) to the participants", () => {
    const allocations = computeSettlement(cents(-300), [
      { partyId: "a", partyKind: "member", method: "equal" },
      { partyId: "b", partyKind: "member", method: "equal" },
    ]);
    expect(allocations.map((a) => a.amount)).toEqual([-150, -150]);
    const d = activitySettled({
      activityId: "act",
      activityName: "Feest",
      date: D,
      balance: cents(-300),
      allocations,
      potId: "pot",
      expenseAccountId: "4200",
    })!;
    expect(linesOf(d)).toEqual([
      ["TO_DISTRIBUTE", 300],
      ["MEMBER_ACCOUNTS", -150],
      ["MEMBER_ACCOUNTS", -150],
    ]);
  });

  it("books nothing when there is nothing to distribute", () => {
    expect(
      activitySettled({
        activityId: "act",
        activityName: "Feest",
        date: D,
        balance: cents(0),
        allocations: computeSettlement(cents(0), [{ partyId: "a", partyKind: "member", method: "equal" }]),
        potId: "pot",
        expenseAccountId: "4200",
      }),
    ).toBeNull();
  });

  it("refuses fixed amounts that do not add up when nobody takes the rest", () => {
    expect(() =>
      computeSettlement(cents(1000), [{ partyId: "a", partyKind: "member", method: "fixed", fixedAmount: cents(900) }]),
    ).toThrow(/verschil/);
  });

  it("refuses duplicate participants", () => {
    expect(() =>
      computeSettlement(cents(1000), [
        { partyId: "a", partyKind: "member", method: "equal" },
        { partyId: "a", partyKind: "member", method: "equal" },
      ]),
    ).toThrow(/één keer/);
  });

  it("property: every settlement distributes exactly the balance", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e9, max: 1e9 }),
        fc.array(
          fc.oneof(
            fc.record({ method: fc.constant("equal" as const) }),
            fc.record({ method: fc.constant("weight" as const), weight: fc.integer({ min: 0, max: 50 }) }),
          ),
          { minLength: 1, maxLength: 80 },
        ),
        fc.integer({ min: 0, max: 5 }),
        (total, variable, fixedCount) => {
          const fixed = Array.from({ length: fixedCount }, (_, i) => ({
            partyId: `f${i}`,
            partyKind: "external" as const,
            method: "fixed" as const,
            fixedAmount: cents(Math.trunc(total / 10) + i),
          }));
          const shares = [
            ...variable.map((v, i) => ({ ...v, partyId: `m${i}`, partyKind: "member" as const })),
            ...fixed,
          ];
          if (!shares.some((s) => s.method === "equal" || (s.method === "weight" && s.weight > 0))) return;
          const allocations = computeSettlement(cents(total), shares);
          expect(sum(allocations.map((a) => a.amount))).toBe(total);
          const d = activitySettled({
            activityId: "act",
            activityName: "x",
            date: D,
            balance: cents(total),
            allocations,
            potId: "pot",
            expenseAccountId: "4200",
          });
          if (d) expectBalanced(d);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("T13/T15 invoices and T17 mirror", () => {
  it("T13 purchase invoice on a pot", () => {
    const d = purchaseInvoiceReceived({
      invoiceId: "i",
      partyId: "sup",
      date: D,
      amount: cents(30000),
      target: { kind: "pot", potId: "pot", accountId: "4100" },
      description: "Huur zaal",
    });
    expect(linesOf(d)).toEqual([
      ["id:4100", 30000],
      ["ACCOUNTS_PAYABLE", -30000],
    ]);
    expect(d.lines[1].invoiceId).toBe("i");
  });

  it("T15 sales invoice with two lines, and its credit note (T17)", () => {
    const d = salesInvoiceSent({
      invoiceId: "i",
      partyId: "spons",
      date: D,
      description: "Factuur 2026-001",
      lines: [
        { potId: "s", incomeAccountId: "8100", amount: cents(50000) },
        { potId: "h", incomeAccountId: "8400", amount: cents(7500) },
      ],
    });
    expect(linesOf(d)).toEqual([
      ["EXTERNAL_ACCOUNTS", 57500],
      ["id:8100", -50000],
      ["id:8400", -7500],
    ]);
    const credit = mirrorEntry({
      original: {
        id: "e1",
        description: d.description,
        lines: d.lines.map((l) => ({
          accountId: acc(l),
          amount: l.amount,
          potId: l.potId ?? null,
          activityId: null,
          partyId: l.partyId ?? null,
          bankTransactionId: null,
          invoiceId: l.invoiceId ?? null,
          description: null,
        })),
      },
      template: "T17",
      date: D,
    });
    expect(credit.lines.map((l) => l.amount)).toEqual([-57500, 50000, 7500]);
    expect(credit.reversesEntryId).toBe("e1");
  });
});

describe("T20 cash count", () => {
  it("books a shortage as cost", () => {
    const d = cashCountDifference({
      cashCountId: "k",
      date: D,
      cashLedgerAccountId: "kas",
      counted: cents(4000),
      book: cents(4250),
      potId: "alg",
    })!;
    expect(linesOf(d)).toEqual([
      ["id:kas", -250],
      ["CASH_DIFFERENCES", 250],
    ]);
  });
  it("books nothing when the count matches", () => {
    expect(
      cashCountDifference({ cashCountId: "k", date: D, cashLedgerAccountId: "kas", counted: cents(1), book: cents(1), potId: "alg" }),
    ).toBeNull();
  });
});

describe("T21/T22 reserves", () => {
  it("dotation goes through the P&L into the reserve", () => {
    const d = reserveDotation({ date: D, reserveAccountId: "0510", amount: cents(50000), potId: "res", description: "Lustrum" });
    expect(linesOf(d)).toEqual([
      ["RESERVE_DOTATION", 50000],
      ["id:0510", -50000],
    ]);
  });
  it("withdrawal releases the reserve as income", () => {
    const d = reserveWithdrawal({ date: D, reserveAccountId: "0510", amount: cents(20000), potId: "res", description: "Lustrum" });
    expect(linesOf(d)).toEqual([
      ["id:0510", 20000],
      ["RESERVE_WITHDRAWAL", -20000],
    ]);
  });
});

describe("T23/T29 memorial", () => {
  it("T23 marks accruals for automatic reversal", () => {
    const d = memorial({
      date: localDate("2027-07-31"),
      description: "Nog te betalen huur juli",
      reason: "Factuur komt in augustus",
      autoReverse: true,
      lines: [
        { account: { id: "4100" }, amount: cents(30000), potId: "h" },
        { account: { key: "ACCRUED_EXPENSES" }, amount: cents(-30000) },
      ],
    });
    expect(d.template).toBe("T23");
    expect(d.autoReverse).toBe(true);
  });
});

describe("T25 year close", () => {
  const balances = [
    { accountId: "8000", potId: "c", amount: cents(-500000) }, // income
    { accountId: "4000", potId: "b", amount: cents(120000) }, // expense
    { accountId: "4500", potId: "k", amount: cents(0) },
  ];

  it("closes result accounts to 0590 and appropriates the profit", () => {
    const { closing, appropriation, result } = yearClose({
      date: localDate("2026-07-31"),
      fiscalYearLabel: "2025-2026",
      balances,
      appropriation: [
        { accountId: "0500", amount: cents(280000) },
        { accountId: "0510", amount: cents(100000) },
      ],
    });
    expect(result).toBe(380000);
    expect(linesOf(closing!)).toEqual([
      ["id:8000", 500000],
      ["id:4000", -120000],
      ["YEAR_RESULT", -380000],
    ]);
    expect(linesOf(appropriation!)).toEqual([
      ["YEAR_RESULT", 380000],
      ["id:0500", -280000],
      ["id:0510", -100000],
    ]);
  });

  it("handles a loss", () => {
    const { appropriation, result } = yearClose({
      date: localDate("2026-07-31"),
      fiscalYearLabel: "2025-2026",
      balances: [{ accountId: "4000", potId: "b", amount: cents(1000) }],
      appropriation: [{ accountId: "0500", amount: cents(-1000) }],
    });
    expect(result).toBe(-1000);
    expect(linesOf(appropriation!)).toEqual([
      ["YEAR_RESULT", -1000],
      ["id:0500", 1000],
    ]);
  });

  it("refuses an appropriation that does not match the result", () => {
    expect(() =>
      yearClose({
        date: localDate("2026-07-31"),
        fiscalYearLabel: "x",
        balances,
        appropriation: [{ accountId: "0500", amount: cents(1) }],
      }),
    ).toThrow(/niet gelijk/);
  });
});

describe("T26 opening balance", () => {
  it("balances the difference against the general reserve", () => {
    const d = openingBalance({
      date: localDate("2026-08-01"),
      bank: [{ ledgerAccountId: "1000", amount: cents(250000) }],
      persons: [
        { partyId: "a", partyKind: "member", amount: cents(3000) },
        { partyId: "b", partyKind: "member", amount: cents(-1000) },
      ],
      activities: [{ activityId: "feest", amount: cents(45000) }],
      other: [{ accountId: "0510", amount: cents(-100000) }],
    })!;
    expect(linesOf(d).at(-1)).toEqual(["GENERAL_RESERVE", -197000]);
    expectBalanced(d);
  });
});

describe("T28 write-off", () => {
  it("writes off a member balance", () => {
    const d = writeOff({ partyId: "p", partyKind: "member", date: D, amount: cents(4200), potId: "alg", reason: "Vertrokken" });
    expect(linesOf(d)).toEqual([
      ["BAD_DEBTS", 4200],
      ["MEMBER_ACCOUNTS", -4200],
    ]);
  });
});

describe("property: every template output balances", () => {
  const amount = fc.integer({ min: 1, max: 1e10 }).map((n) => cents(n));
  it("assignments with random splits", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1e8, max: 1e8 }).filter((n) => n !== 0), { minLength: 1, maxLength: 10 }), (parts) => {
        const total = parts.reduce((a, b) => a + b, 0);
        if (total === 0) return;
        const targets: AssignmentTarget[] = parts.map((p, i) =>
          i % 2 === 0
            ? { kind: "person", partyId: `p${i}`, partyKind: "member", amount: cents(p) }
            : { kind: "pot", potId: "pot", accountId: "4990", amount: cents(p) },
        );
        expectBalanced(assignBankTransaction({ tx: tx(total), targets }));
      }),
    );
  });
  it("contribution, claims and charges", () => {
    fc.assert(
      fc.property(amount, (a: Cents) => {
        expectBalanced(
          contributionCharged({ chargeId: "c", partyId: "p", month: localDate("2026-09-01"), amount: a, incomeAccountId: "8000", split: [{ potId: "x", weight: 3 }, { potId: "y", weight: 7 }], description: "c" }),
        );
        expectBalanced(
          expenseClaimApproved({ claimId: "c", partyId: "p", date: D, amount: a, target: { kind: "activity", activityId: "a" }, description: "d" }),
        );
        expectBalanced(
          chargedToPerson({ partyId: "p", partyKind: "member", date: D, amount: a, target: { kind: "pot", potId: "x", accountId: "8900" }, description: "d" }),
        );
      }),
    );
  });
});
