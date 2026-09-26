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
    expect(upgraded.version).toBe(3);
    expect(upgraded.memberPlanning).toEqual([]);
    expect(upgraded.accounts.some((a) => a.systemKey === "MEMBER_SAVINGS")).toBe(true);
    expect(upgraded.activities.every((a) => /^A\d\d-\d{3}$/.test(a.number))).toBe(true);
  });
});

import { calculateRates, contributionMonthsForPot, expectedContribution, plannedType } from "./ledger";
import { addMonths } from "@/domain/dates";
import { parseIngCsv } from "@/domain/bank/ing-csv";

/** A small association set up like the Weknow sheets: fixed woonkamer/bier parts, planning per month. */
function weknowLike() {
  const store = new LedgerStore(
    LedgerStore.install({ name: "Test", fiscalYearStartMonth: 8, startDate: localDate("2026-08-01"), checkingIban: "NL69INGB0123456789", savingsIban: null }),
  );
  const s0 = store.getState();
  const pot = (code: string) => s0.pots.find((p) => p.code === code)!.id;
  const woon = pot("HUISVESTING");
  const bier = pot("BORRELS");
  const rest = pot("CONTRIBUTIE");
  const truien = store.createPot({ name: "Truien nieuwe lichting", kind: "income" }, FISCUS).id;
  const J = store.createMemberType({ name: "Jongerejaars", monthly: cents(4649), split: [{ potId: woon, amount: cents(550) }, { potId: bier, amount: cents(1500) }], restPotId: rest, paysGeneral: true, paysYoung: true }, FISCUS);
  const B = store.createMemberType({ name: "Buitenland", monthly: cents(3149), split: [{ potId: woon, amount: cents(550) }], restPotId: rest, paysGeneral: true, paysYoung: true }, FISCUS);
  const O = store.createMemberType({ name: "Ouderejaars", monthly: cents(2480), split: [{ potId: woon, amount: cents(350) }], restPotId: rest, paysGeneral: true }, FISCUS);
  const NL = store.createMemberType({ name: "Nieuwe lichting", monthly: cents(4649), split: [{ potId: woon, amount: cents(550) }, { potId: bier, amount: cents(1500) }], restPotId: truien, rateLikeTypeId: J.id }, FISCUS);
  return { store, pot, woon, bier, rest, truien, J, B, O, NL };
}

describe("member planning and contribution split (Weknow workflow)", () => {
  it("charges the planned type per month and divides it over woonkamer, bier and the rest", () => {
    const { store, woon, bier, rest, truien, J, O, NL } = weknowLike();
    const tyga = store.createMember({ firstName: "Tyga", lastName: "", memberTypeId: J.id, joinedOn: localDate("2026-08-01") }, FISCUS);
    const nieuw = store.createMember({ firstName: "Nieuw lid", lastName: "", memberTypeId: J.id, joinedOn: localDate("2026-11-01") }, FISCUS);
    expect(tyga.name).toBe("Tyga");
    store.setPlanning({ memberId: tyga.id, fromMonth: localDate("2026-11-01"), toMonth: localDate("2027-07-01"), memberTypeId: O.id }, FISCUS);
    store.setPlanning({ memberId: nieuw.id, fromMonth: localDate("2026-11-01"), toMonth: localDate("2026-12-01"), memberTypeId: NL.id }, FISCUS);
    store.setPlanning({ memberId: tyga.id, fromMonth: localDate("2027-01-01"), toMonth: localDate("2027-01-01"), memberTypeId: null }, FISCUS);
    const s = () => store.getState();
    expect(plannedType(s(), tyga, localDate("2026-10-15"))?.name).toBe("Jongerejaars");
    expect(plannedType(s(), tyga, localDate("2026-11-01"))?.name).toBe("Ouderejaars");
    expect(plannedType(s(), tyga, localDate("2027-01-01"))).toBeNull();
    expect(plannedType(s(), nieuw, localDate("2026-10-01"))).toBeNull(); // not a member yet
    expect(plannedType(s(), nieuw, localDate("2027-02-01"))?.name).toBe("Jongerejaars");

    for (const m of ["2026-10-01", "2026-11-01", "2027-01-01"]) store.chargeContributions(localDate(m), FISCUS);
    const fy = s().fiscalYears[0];
    const byPot = resultByPot(s(), fy);
    // Oct: Tyga J (5,50 + 15,00 + 25,99). Nov: Tyga O (3,50 + 21,30), nieuw NL (5,50 + 15,00 + 26,49 truien). Jan: nieuw J, Tyga afwezig.
    expect(byPot.get(woon)!.income).toBe(550 + 350 + 550 + 550);
    expect(byPot.get(bier)!.income).toBe(1500 + 1500 + 1500);
    expect(byPot.get(truien)!.income).toBe(2599);
    expect(byPot.get(rest)!.income).toBe(2599 + 2130 + 2599);
    expect(contributionMonthsForPot(s(), fy, bier)).toEqual(new Map([[tyga.id, 1], [nieuw.id, 2]]));
    // charged months are fixed: planning them again changes nothing
    store.setPlanning({ memberId: tyga.id, fromMonth: localDate("2026-10-01"), toMonth: localDate("2026-10-01"), memberTypeId: null }, FISCUS);
    expect(plannedType(s(), tyga, localDate("2026-10-01"))?.name).toBe("Jongerejaars");
    expect(store.verify().every((c) => c.ok)).toBe(true);
  });

  it("refuses fixed parts above the contribution", () => {
    const { store, woon, J } = weknowLike();
    expect(() => store.updateMemberType(J.id, { name: "Jongerejaars", monthly: cents(1000), split: [{ potId: woon, amount: cents(1200) }] }, FISCUS)).toThrow(/hoger/);
  });

  it("calculates the rates from the budget exactly like the Begroting 26-27 sheet", () => {
    const { store, pot, woon, bier, J, B, O, NL } = weknowLike();
    const fy = store.getState().fiscalYears[0];
    // Member-months as in the sheet: 148 J, 12 B, 94 O, 8 NL.
    const add = (name: string, type: string, months: number, from = "2026-08-01") => {
      const m = store.createMember({ firstName: name, lastName: "", memberTypeId: type, joinedOn: localDate(from) }, FISCUS);
      const last = addMonths(localDate(from), months - 1);
      store.setPlanning({ memberId: m.id, fromMonth: localDate(from), toMonth: last, memberTypeId: type }, FISCUS);
      if (addMonths(last, 1) <= fy.endDate) store.setPlanning({ memberId: m.id, fromMonth: addMonths(last, 1), toMonth: fy.endDate, memberTypeId: null }, FISCUS);
      return m;
    };
    for (let i = 0; i < 12; i++) add(`J${i}`, J.id, 12); // 144
    add("Jx", J.id, 4); // 148
    add("B", B.id, 12); // 12
    for (let i = 0; i < 7; i++) add(`O${i}`, O.id, 12); // 84
    add("Ox", O.id, 10); // 94
    for (let i = 0; i < 4; i++) add(`NL${i}`, NL.id, 2, "2026-11-01"); // 8
    const months = calculateRates(store.getState(), fy).months;
    expect([months.get(J.id), months.get(B.id), months.get(O.id), months.get(NL.id)]).toEqual([148, 12, 94, 8]);

    for (const [desc, amount] of [["Pisang", 3000], ["Cadeaus", 60000], ["Fotoboer", 3000], ["Bestuur", 12000], ["Website", 10000], ["Rekening kosten", 40000], ["Toernooien", 200000], ["Activiteiten", 130000], ["Initiatieven", 15000], ["Voorwerpen Gagel", 5000], ["Buitenland", 3000], ["Spaarplan Lustrum", 40000], ["Overig", 20000]] as const) {
      store.addBudgetLine({ fiscalYearId: fy.id, potId: pot("ALGEMEEN"), kind: "expense", description: desc, amount: cents(amount), sharedBy: "all" }, FISCUS);
    }
    store.addBudgetLine({ fiscalYearId: fy.id, potId: pot("ACTIVITEITEN"), kind: "expense", description: "Voor kiesdatum", amount: cents(55000), sharedBy: "young" }, FISCUS);
    store.addBudgetLine({ fiscalYearId: fy.id, potId: pot("ACTIVITEITEN"), kind: "expense", description: "Na kiesdatum", amount: cents(20000), sharedBy: "young" }, FISCUS);
    store.addBudgetLine({ fiscalYearId: fy.id, potId: woon, kind: "expense", description: "Huur woonkamer", amount: cents(103005), sharedBy: "none" }, FISCUS);
    store.addBudgetLine({ fiscalYearId: fy.id, potId: bier, kind: "expense", description: "Bier", amount: cents(234000), sharedBy: "none" }, FISCUS);

    const calc = calculateRates(store.getState(), fy);
    expect(calc.general).toEqual({ total: 541000, months: 254 });
    expect(calc.young).toEqual({ total: 75000, months: 160 });
    const rate = (id: string) => calc.rates.find((r) => r.typeId === id)!.rate;
    expect([rate(J.id), rate(B.id), rate(O.id), rate(NL.id)]).toEqual([4649, 3149, 2480, 4649]);

    // Expected contribution per pot = planning × rates, divided like the real charges.
    const expected = expectedContribution(store.getState(), fy);
    expect(expected.get(bier)).toBe((148 + 8) * 1500);
    expect(expected.get(woon)).toBe((148 + 12 + 8) * 550 + 94 * 350);
  });
});

describe("returning a surplus and charging many at once", () => {
  it("gives beer money back pro rata and charges a turflijst", () => {
    const { store, bier, J } = weknowLike();
    const a = store.createMember({ firstName: "A", lastName: "", memberTypeId: J.id, joinedOn: localDate("2026-08-01") }, FISCUS);
    const b = store.createMember({ firstName: "B", lastName: "", memberTypeId: J.id, joinedOn: localDate("2026-10-01") }, FISCUS);
    for (const m of ["2026-08-01", "2026-09-01", "2026-10-01"]) store.chargeContributions(localDate(m), FISCUS);
    const fy = store.getState().fiscalYears[0];
    const months = contributionMonthsForPot(store.getState(), fy, bier);
    expect(months).toEqual(new Map([[a.id, 3], [b.id, 1]]));
    store.returnPotSurplus({ potId: bier, date: localDate("2026-10-31"), amount: cents(2000), shares: [...months].map(([partyId, weight]) => ({ partyId, weight })), description: "Geld terug bier" }, FISCUS);
    const d = derive(store.getState());
    expect(d.partyBalance.get(a.id)).toBe(-1500);
    expect(d.partyBalance.get(b.id)).toBe(-500);
    expect(resultByPot(store.getState(), fy).get(bier)).toEqual({ income: 6000, expense: 2000 });
    expect(() => store.returnPotSurplus({ potId: bier, date: localDate("2026-10-31"), amount: cents(100), shares: [{ partyId: a.id, weight: 1 }], description: "x" }, BESTUUR)).toThrow();

    const n = store.chargeMany({ date: localDate("2026-10-31"), target: { kind: "pot", id: bier }, description: "Turf oktober", items: [{ partyId: a.id, amount: cents(910) }, { partyId: b.id, amount: cents(0) }] }, BESTUUR);
    expect(n).toBe(1);
    expect(derive(store.getState()).partyBalance.get(a.id)).toBe(-1500 + 910);
    expect(() => store.chargeMany({ date: localDate("2026-10-31"), target: { kind: "pot", id: bier }, description: "x", items: [{ partyId: a.id, amount: cents(100) }] }, KASCO)).toThrow();
    expect(store.verify().every((c) => c.ok)).toBe(true);
  });
});

describe("importing an ING CSV", () => {
  it("checks the saldo against the opening balance and is idempotent", () => {
    const { store } = weknowLike();
    const bank = store.getState().bankAccounts.find((x) => x.kind === "checking")!;
    store.setOpeningBalance({ date: localDate("2026-08-01"), bank: [{ bankAccountId: bank.id, amount: cents(109302) }] }, FISCUS);
    const file = [
      '"Datum";"Naam / Omschrijving";"Rekening";"Tegenrekening";"Code";"Af Bij";"Bedrag (EUR)";"Mutatiesoort";"Mededelingen";"Saldo na mutatie";"Tag"',
      '"20260902";"J. Jansen";"NL69INGB0123456789";"NL44RABO0123456789";"OV";"Bij";"46,49";"Overschrijving";"Contributie";"1.044,91";""',
      '"20260901";"Verhuurder";"NL69INGB0123456789";"NL91ABNA0417164300";"GT";"Af";"94,60";"Online bankieren";"Huur woonkamer";"998,42";""',
    ].join("\r\n");
    const r = store.importTransactions(parseIngCsv(file), FISCUS);
    expect(r.added).toBe(2);
    expect(store.importTransactions(parseIngCsv(file), FISCUS)).toMatchObject({ added: 0, duplicates: 2 });
    expect(store.verify().every((c) => c.ok)).toBe(true);
    // A gap (wrong opening balance) is refused.
    const other = weknowLike().store;
    const bank2 = other.getState().bankAccounts.find((x) => x.kind === "checking")!;
    other.setOpeningBalance({ date: localDate("2026-08-01"), bank: [{ bankAccountId: bank2.id, amount: cents(100000) }] }, FISCUS);
    expect(() => other.importTransactions(parseIngCsv(file), FISCUS)).toThrow(/Saldo sluit niet aan/);
  });
});
