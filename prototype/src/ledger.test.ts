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
