import { describe, expect, it } from "vitest";
import { LedgerStore, derive, type Actor } from "./ledger";
import { createDemoState, nextDemoCsv } from "./demo";
import { parseRabobankCsv } from "@/domain/bank/rabobank-csv";
import { cents } from "@/domain/money";
import { localDate } from "@/domain/dates";

const FISCUS: Actor = { role: "fiscus", partyId: null, label: "Fiscus" };
const BESTUUR: Actor = { role: "bestuur", partyId: null, label: "Bestuur" };
const KASCO: Actor = { role: "kascommissie", partyId: null, label: "Kascommissie" };

function demoStore(today = "2026-09-26") {
  return new LedgerStore(createDemoState(localDate(today)));
}

describe("demo association", () => {
  it.each(["2026-09-26", "2026-08-02", "2027-01-15", "2027-07-31"])("passes every integrity check (today = %s)", (today) => {
    const store = demoStore(today);
    const checks = store.verify();
    for (const c of checks) expect(c, c.label).toMatchObject({ ok: true });
    const s = store.getState();
    expect(s.fiscalYears.filter((f) => f.status === "closed")).toHaveLength(1);
    expect(derive(s).unassigned.length).toBeGreaterThan(0);
    expect(s.bankTransactions.every((t) => t.bookingDate <= today)).toBe(true);
  });
});

describe("importing a Rabobank CSV", () => {
  it("adds new lines, is idempotent, and keeps the bank balance equal to the bank", () => {
    const store = demoStore();
    const before = derive(store.getState()).unassigned.length;
    const { csv, count } = nextDemoCsv(store.getState(), localDate("2026-09-26"));
    const txs = parseRabobankCsv(csv);
    const first = store.importTransactions(txs, BESTUUR);
    expect(first.added).toBe(count);
    expect(derive(store.getState()).unassigned.length).toBe(before + count);
    const again = store.importTransactions(txs, BESTUUR);
    expect(again).toMatchObject({ added: 0, duplicates: count });
    expect(store.verify().every((c) => c.ok)).toBe(true);
  });

  it("refuses a file with a gap and leaves the books untouched", () => {
    const store = demoStore();
    const snapshot = store.getState();
    const txs = parseRabobankCsv(nextDemoCsv(snapshot, localDate("2026-09-26")).csv).slice(1);
    expect(() => store.importTransactions(txs, BESTUUR)).toThrow(/ontbreken transacties/);
    expect(store.getState()).toBe(snapshot);
  });

  it("suggests the member behind a known IBAN and books the payment on their account", () => {
    const store = demoStore();
    const { csv } = nextDemoCsv(store.getState(), localDate("2026-09-26"));
    store.importTransactions(parseRabobankCsv(csv), BESTUUR);
    const s = store.getState();
    const tx = derive(s).unassigned.find((t) => store.suggestions(t.id)[0]?.reason === "known_iban")!;
    const suggestion = store.suggestions(tx.id)[0];
    expect(suggestion.target.kind).toBe("person");
    const partyId = (suggestion.target as { partyId: string }).partyId;
    const owed = derive(s).partyBalance.get(partyId)!;
    store.assign(tx.id, [{ kind: "person", id: partyId, amount: tx.amount }], BESTUUR);
    expect(derive(store.getState()).partyBalance.get(partyId)).toBe(owed - tx.amount);
    store.unassign(tx.id, "test", FISCUS);
    expect(derive(store.getState()).partyBalance.get(partyId)).toBe(owed);
    expect(store.verify().every((c) => c.ok)).toBe(true);
  });

  it("finds the payer of a Tikkie by the IBAN in the description", () => {
    const store = demoStore();
    const tikkie = derive(store.getState()).unassigned.find((t) => /tikkie/i.test(t.description))!;
    expect(store.suggestions(tikkie.id)[0]).toMatchObject({ reason: "iban_in_description" });
  });
});

describe("permissions", () => {
  it("the audit committee can look but never change", () => {
    const store = demoStore();
    const tx = derive(store.getState()).unassigned[0];
    expect(() => store.assign(tx.id, [{ kind: "internal", amount: tx.amount }], KASCO)).toThrow(/kascommissie/);
    expect(() => store.chargeContributions(localDate("2026-09-01"), KASCO)).toThrow(/kascommissie/);
  });
  it("a member can only claim for themselves; only the fiscus approves", () => {
    const store = demoStore();
    const [a, b] = store.getState().parties.filter((p) => p.kind === "member");
    const pot = store.getState().pots[0];
    const lid: Actor = { role: "lid", partyId: a.id, label: a.name };
    expect(() => store.submitClaim({ partyId: b.id, amount: cents(100), description: "x", target: { kind: "pot", id: pot.id }, receipt: null }, lid)).toThrow(/jezelf/);
    const c = store.submitClaim({ partyId: a.id, amount: cents(100), description: "x", target: { kind: "pot", id: pot.id }, receipt: null }, lid);
    expect(() => store.approveClaim(c.id, localDate("2026-09-26"), BESTUUR)).toThrow(/rechten/);
    const owed = derive(store.getState()).partyBalance.get(a.id) ?? 0;
    store.approveClaim(c.id, localDate("2026-09-26"), FISCUS);
    expect(derive(store.getState()).partyBalance.get(a.id)).toBe(owed - 100);
  });
});

describe("activity settlement", () => {
  it("distributes 'nog te verdelen' exactly and locks the activity", () => {
    const store = demoStore();
    const party = store.getState().activities.find((a) => a.name === "Openingsfeest")!;
    const members = store.getState().parties.filter((p) => p.kind === "member").slice(0, 7);
    const shares = members.map((m) => ({ partyId: m.id, partyKind: "member" as const, method: "equal" as const }));
    const { balance, allocations } = store.previewSettlement(party.id, shares);
    expect(balance).toBe(46000);
    expect(allocations.reduce((s, a) => s + a.amount, 0)).toBe(46000);
    store.settleActivity({ activityId: party.id, date: localDate("2026-09-26"), shares, expectedBalance: balance }, FISCUS);
    expect(derive(store.getState()).activityBalance.get(party.id)).toBe(0);
    expect(() => store.chargePerson({ partyId: members[0].id, date: localDate("2026-09-26"), amount: cents(100), target: { kind: "activity", id: party.id }, description: "x" }, FISCUS)).toThrow(/afgerekend/);
    store.reopenActivity(party.id, "vergeten", FISCUS);
    expect(derive(store.getState()).activityBalance.get(party.id)).toBe(46000);
    expect(store.verify().every((c) => c.ok)).toBe(true);
  });
});

describe("contribution", () => {
  it("is booked once per member per month", () => {
    const store = demoStore();
    expect(store.chargeContributions(localDate("2026-09-01"), BESTUUR)).toBe(0); // already done by the demo
  });
});

import { contributionOverview, donationsByGiver, migrateState, resultByPot, type State } from "./ledger";
import { rabobankAmount, toRabobankCsv } from "@/domain/bank/rabobank-csv";

function freshStore() {
  const store = new LedgerStore(
    LedgerStore.install({ name: "Test", fiscalYearStartMonth: 8, startDate: localDate("2026-08-01"), checkingIban: "NL91RABO0315273637", savingsIban: null }),
  );
  const type = store.createMemberType({ name: "Lid", monthly: cents(1500) }, FISCUS);
  const jan = store.createMember({ firstName: "Jan", lastName: "Jansen", memberTypeId: type.id, joinedOn: localDate("2026-08-01"), ibans: ["NL20INGB0001234567"] }, FISCUS);
  return { store, jan, type };
}
const csv = (rows: { volgnr: number; date: string; amount: number; balance: number; iban?: string; name?: string; desc?: string }[]) =>
  parseRabobankCsv(toRabobankCsv(rows.map((r) => ({ iban: "NL91RABO0315273637", volgnr: r.volgnr, date: r.date, amount: rabobankAmount(r.amount), balanceAfter: rabobankAmount(r.balance), counterpartyIban: r.iban, counterpartyName: r.name, description: r.desc }))));

describe("contribution per member", () => {
  it("divides contribution income over pots with the key and shows who paid which month", () => {
    const { store, jan } = freshStore();
    const s0 = store.getState();
    const pot = (code: string) => s0.pots.find((p) => p.code === code)!.id;
    store.setContributionKey([{ potId: pot("HUISVESTING"), weight: 60 }, { potId: pot("RESERVERINGEN"), weight: 40 }], FISCUS);
    for (const m of ["2026-08-01", "2026-09-01", "2026-10-01"]) store.chargeContributions(localDate(m), FISCUS);
    const fy = store.getState().fiscalYears[0];
    const byPot = resultByPot(store.getState(), fy);
    expect(byPot.get(pot("HUISVESTING"))!.income).toBe(2700);
    expect(byPot.get(pot("RESERVERINGEN"))!.income).toBe(1800);

    // Jan pays one and a half months: August paid, September partly, October open.
    store.importTransactions(csv([{ volgnr: 1, date: "2026-10-05", amount: 2250, balance: 2250, iban: "NL20INGB0001234567", name: "Jan", desc: "Contributie" }]), FISCUS);
    const tx = derive(store.getState()).unassigned[0];
    // 22,50 is not a whole number of months, but the description says "Contributie"
    expect(store.suggestions(tx.id)[0]).toMatchObject({ reason: "contribution", label: expect.stringContaining("omschrijving") });
    store.assign(tx.id, [{ kind: "contribution", id: jan.id, amount: tx.amount }], FISCUS);
    const row = contributionOverview(store.getState(), fy).rows.find((r) => r.party.id === jan.id)!;
    expect([...row.months.values()].map((m) => m.status)).toEqual(["paid", "partial", "open"]);
    expect(row.open).toBe(2250);
    // contribution is separate from the member's current account
    expect(derive(store.getState()).partyBalance.get(jan.id) ?? 0).toBe(0);
  });

  it("suggests contribution when a member pays a whole number of months, and assigns in bulk", () => {
    const { store, jan } = freshStore();
    store.chargeContributions(localDate("2026-09-01"), FISCUS);
    store.importTransactions(csv([{ volgnr: 1, date: "2026-09-03", amount: 3000, balance: 3000, iban: "NL20INGB0001234567", name: "Jan" }]), FISCUS);
    const tx = derive(store.getState()).unassigned[0];
    expect(store.suggestions(tx.id)[0]).toMatchObject({ reason: "contribution", target: { kind: "contribution", partyId: jan.id } });
    store.assignMany([{ txId: tx.id, part: { kind: "contribution", id: jan.id, amount: tx.amount } }], BESTUUR);
    expect(derive(store.getState()).contributionBalance.get(jan.id)).toBe(-1500); // one month paid ahead
  });
});

describe("savings plans", () => {
  it("keeps savings apart and settles them against what a member owes", () => {
    const { store, jan } = freshStore();
    const goal = store.createSavingsGoal({ name: "Lustrumreis", targetDate: null, monthly: cents(2000) }, FISCUS);
    store.importTransactions(csv([{ volgnr: 1, date: "2026-09-01", amount: 5000, balance: 5000, iban: "NL20INGB0001234567", name: "Jan", desc: "sparen" }]), FISCUS);
    const tx = derive(store.getState()).unassigned[0];
    store.assign(tx.id, [{ kind: "savings", id: jan.id, goalId: goal.id, amount: tx.amount }], FISCUS);
    expect(derive(store.getState()).savings.get(`${jan.id}|${goal.id}`)).toBe(5000);
    const trip = store.createActivity({ name: "Reis", heldOn: localDate("2026-10-01"), potId: store.getState().pots[0].id }, FISCUS);
    store.chargePerson({ partyId: jan.id, date: localDate("2026-10-01"), amount: cents(3500), target: { kind: "activity", id: trip.id }, description: "Reis" }, FISCUS);
    const r = store.settleSavingsForGoal(goal.id, localDate("2026-10-02"), "owed", FISCUS);
    expect(r).toEqual({ members: 1, total: 3500 });
    const d = derive(store.getState());
    expect(d.partyBalance.get(jan.id)).toBe(0);
    expect(d.savings.get(`${jan.id}|${goal.id}`)).toBe(1500);
    expect(() => store.settleSavings({ partyId: jan.id, goalId: goal.id, amount: cents(2000), date: localDate("2026-10-02") }, FISCUS)).toThrow(/maar/);
    expect(store.verify().every((c) => c.ok)).toBe(true);
  });
});

describe("manual bank transactions", () => {
  it("are linked to the bank file later instead of being booked twice", () => {
    const { store, jan } = freshStore();
    const id = store.addManualBankTransaction({ bankAccountId: store.getState().bankAccounts[0].id, date: localDate("2026-09-02"), amount: cents(1500), counterpartyName: "Jan", counterpartyIban: "NL20INGB0001234567", description: "contributie" }, BESTUUR);
    store.assign(id, [{ kind: "contribution", id: jan.id, amount: cents(1500) }], BESTUUR);
    expect(store.verify().every((c) => c.ok)).toBe(true);
    const result = store.importTransactions(csv([
      { volgnr: 1, date: "2026-09-01", amount: -1250, balance: -1250, name: "Rabobank" },
      { volgnr: 2, date: "2026-09-03", amount: 1500, balance: 250, iban: "NL20INGB0001234567", name: "Jan" },
    ]), BESTUUR);
    expect(result).toMatchObject({ added: 1, duplicates: 1 });
    expect(store.getState().bankTransactions.find((t) => t.id === id)!.matchedExternalId).toBe("2");
    expect(derive(store.getState()).bankBalance.get(store.getState().bankAccounts[0].id)).toBe(250);
    expect(store.verify().every((c) => c.ok)).toBe(true);
  });

  it("refuses an import when a hand-entered transaction is missing from the bank file", () => {
    const { store } = freshStore();
    store.addManualBankTransaction({ bankAccountId: store.getState().bankAccounts[0].id, date: localDate("2026-09-02"), amount: cents(999), counterpartyName: "Fout", counterpartyIban: null, description: "" }, BESTUUR);
    expect(() => store.importTransactions(csv([{ volgnr: 1, date: "2026-09-05", amount: 500, balance: 500 }]), BESTUUR)).toThrow(/niet in het bankbestand/);
  });
});

describe("activities, donations and old backups", () => {
  it("numbers activities per fiscal year", () => {
    const { store } = freshStore();
    const pot = store.getState().pots[0].id;
    expect(store.createActivity({ name: "a", heldOn: localDate("2026-09-01"), potId: pot }, FISCUS).number).toBe("A26-001");
    expect(store.createActivity({ name: "b", heldOn: localDate("2026-10-01"), potId: pot }, FISCUS).number).toBe("A26-002");
    expect(store.createActivity({ name: "c", heldOn: localDate("2027-09-01"), potId: pot }, FISCUS).number).toBe("A27-001");
  });

  it("records who donated", () => {
    const { store, jan } = freshStore();
    const donations = store.getState().pots.find((p) => p.code === "DONATIES")!;
    store.importTransactions(csv([{ volgnr: 1, date: "2026-09-01", amount: 5000, balance: 5000, name: "Jan" }]), FISCUS);
    store.assign(derive(store.getState()).unassigned[0].id, [{ kind: "pot", id: donations.id, donorId: jan.id, amount: cents(5000) }], FISCUS);
    expect(donationsByGiver(store.getState(), store.getState().fiscalYears[0])).toEqual([{ partyId: jan.id, amount: 5000 }]);
    expect(derive(store.getState()).partyBalance.get(jan.id) ?? 0).toBe(0);
  });

  it("upgrades a version-1 backup", () => {
    const v1 = structuredClone(demoStore().getState()) as unknown as Record<string, unknown> & State;
    // simulate an old backup
    (v1 as unknown as { version: number }).version = 1;
    v1.accounts = v1.accounts.filter((a) => a.code !== "1305" && a.code !== "1740");
    (v1 as unknown as { budgets: unknown[] }).budgets = [];
    for (const a of v1.activities) delete (a as { number?: string }).number;
    const upgraded = migrateState(v1);
    expect(upgraded.version).toBe(2);
    expect(upgraded.accounts.some((a) => a.systemKey === "MEMBER_SAVINGS")).toBe(true);
    expect(upgraded.activities.every((a) => /^A\d\d-\d{3}$/.test(a.number))).toBe(true);
  });
});
