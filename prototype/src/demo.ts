/**
 * Demo association for the prototype. Everything goes through the store's public API (the
 * same import, assign, settle and close paths a user would use), so the demo also exercises
 * the rules. Dates are relative to "today": the previous fiscal year is complete and closed,
 * the current one runs up to today.
 */
import { LedgerStore, derive, type Actor, type State } from "./ledger";
import { cents, type Cents } from "@/domain/money";
import { addDays, addMonths, fiscalYearFor, type LocalDate } from "@/domain/dates";
import { rabobankAmount, toRabobankCsv } from "@/domain/bank/rabobank-csv";
import type { NormalizedBankTransaction } from "@/domain/bank/types";

export const DEMO_IBAN = { checking: "NL91RABO0315273637", savings: "NL70RABO3163450289", tikkie: "NL26ABNA0463712345" };
const DEMO_FISCUS: Actor = { role: "fiscus", partyId: null, label: "Sanne de Vries (fiscus)" };

function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeIban(bank: string, account: string): string {
  let remainder = 0;
  for (const ch of `${bank}${account}NL00`) {
    const code = ch >= "A" && ch <= "Z" ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const d of code) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return `NL${String(98 - remainder).padStart(2, "0")}${bank}${account}`;
}

const FIRST = ["Sanne", "Bram", "Lotte", "Daan", "Eva", "Thijs", "Iris", "Ruben", "Noor", "Sem", "Fleur", "Lucas", "Anna", "Jesse", "Julia", "Max", "Sophie", "Tim", "Emma", "Luuk", "Lisa", "Stijn", "Roos", "Milan", "Femke", "Joris", "Isa", "Koen", "Maud", "Pim", "Vera", "Olaf"];
const LAST = ["de Vries", "Jansen", "Bakker", "Visser", "Smit", "Meijer", "de Boer", "Mulder", "de Groot", "Bos", "Vos", "Peters", "Hendriks", "van Leeuwen", "Dekker", "Brouwer"];

export function createDemoState(today: LocalDate): State {
  const rand = prng(20260801);
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const current = fiscalYearFor(today, 8);
  const previous = fiscalYearFor(addDays(current.startDate, -1), 8);

  const store = new LedgerStore(
    LedgerStore.install({
      name: "Dispuut Demo",
      fiscalYearStartMonth: 8,
      startDate: previous.startDate,
      checkingIban: DEMO_IBAN.checking,
      savingsIban: DEMO_IBAN.savings,
      isDemo: true,
    }),
  );
  const A = DEMO_FISCUS;

  store.batch(() => {
    const s = () => store.getState();
    store.ensureFiscalYear(current.startDate, A);
    const bank = (kind: "checking" | "savings" | "cash") => s().bankAccounts.find((b) => b.kind === kind)!;
    const pot = (code: string) => s().pots.find((p) => p.code === code)!;
    const account = (code: string) => s().accounts.find((a) => a.code === code)!;

    store.setOpeningBalance(
      { date: previous.startDate, bank: [{ bankAccountId: bank("checking").id, amount: cents(245000) }, { bankAccountId: bank("savings").id, amount: cents(500000) }, { bankAccountId: bank("cash").id, amount: cents(15000) }] },
      A,
    );

    const types = {
      lid: store.createMemberType({ name: "Lid", monthly: cents(1500) }, A),
      aspirant: store.createMemberType({ name: "Aspirant", monthly: cents(1000) }, A),
      oud: store.createMemberType({ name: "Oud-lid", monthly: cents(500) }, A),
      reunist: store.createMemberType({ name: "Reünist", monthly: cents(0) }, A),
    };
    const startYear = Number(previous.startDate.slice(0, 4));
    const members = FIRST.map((first, i) => {
      const cohort = startYear - 4 + Math.floor(i / 7);
      const type = cohort <= startYear - 4 ? (i % 2 ? types.oud : types.reunist) : cohort === startYear ? types.aspirant : types.lid;
      return store.createMember(
        {
          firstName: first,
          lastName: LAST[i % LAST.length],
          email: `${first.toLowerCase()}@dispuut-demo.nl`,
          memberTypeId: type.id,
          cohort,
          joinedOn: `${cohort}-09-01` as LocalDate,
          ibans: [makeIban(["INGB", "RABO", "ABNA", "SNSB", "TRIO"][i % 5], String(1000000000 + i * 7919).slice(0, 10))],
        },
        A,
      );
    });
    const bacchus = store.createExternal({ name: "Dispuut Bacchus", email: "fiscus@bacchus.example", ibans: [makeIban("INGB", "0044556677")] }, A);
    store.createExternal({ name: "Drankenhandel De Tap", ibans: [makeIban("RABO", "0123456789")] }, A);
    store.createExternal({ name: "Bakkerij Brood & Co", email: "info@brood.example", ibans: [makeIban("INGB", "0777888999")] }, A);

    for (const fy of s().fiscalYears) {
      for (const [code, kind, amount] of [
        ["CONTRIBUTIE", "income", 480000], ["SPONSORING", "income", 50000], ["HUISVESTING", "expense", 360000], ["BORRELS", "expense", 30000],
        ["ACTIVITEITEN", "expense", 50000], ["BESTUUR", "expense", 20000], ["ALV", "expense", 10000], ["BANK", "expense", 15000], ["RESERVERINGEN", "expense", 50000],
      ] as const) store.setBudget({ fiscalYearId: fy.id, potId: pot(code).id, kind, amount: cents(amount) }, A);
    }

    // Bank simulation with a running balance and Rabobank volgnummers.
    const balance = { checking: 245000, savings: 500000 };
    const volgnr = { checking: 41230, savings: 812 };
    const pending: { t: NormalizedBankTransaction; assign?: Parameters<LedgerStore["assign"]>[1] }[] = [];
    const tx = (acct: "checking" | "savings", date: LocalDate, amount: number, name: string, description: string, cpIban: string | null, assign?: Parameters<LedgerStore["assign"]>[1]) => {
      if (date > today) return;
      balance[acct] += amount;
      volgnr[acct] += 1;
      pending.push({
        t: { accountIban: DEMO_IBAN[acct], externalId: String(volgnr[acct]), bookingDate: date, valueDate: date, amount: cents(amount), balanceAfter: cents(balance[acct]), counterpartyIban: cpIban, counterpartyName: name, description },
        assign,
      });
    };
    const flush = () => {
      if (!pending.length) return;
      store.importTransactions(pending.map((p) => p.t), A, { fileName: "demo" });
      for (const p of pending) {
        if (!p.assign) continue;
        const acct = s().bankAccounts.find((b) => b.iban === p.t.accountIban)!;
        const imported = s().bankTransactions.find((t) => t.bankAccountId === acct.id && t.externalId === p.t.externalId)!;
        if ((derive(s(), false).suspenseByTx.get(imported.id) ?? 0) !== 0) store.assign(imported.id, p.assign, A);
      }
      pending.length = 0;
    };
    const payers = (d: LocalDate) => members.filter((m) => m.member!.joinedOn <= d && s().memberTypes.find((t) => t.id === m.member!.memberTypeId)!.monthly > 0);
    const TAP = makeIban("RABO", "0123456789");

    const lastMonth = today.slice(0, 7);
    for (let first = previous.startDate; first.slice(0, 7) <= lastMonth; first = addMonths(first, 1)) {
      const isCurrentMonth = first.slice(0, 7) === lastMonth;
      if (first === current.startDate) {
        // New academic year: last year's aspirants become full members, new aspirants join.
        for (const m of members.filter((x) => x.member!.memberTypeId === types.aspirant.id)) {
          const p = s().parties.find((x) => x.id === m.id)!;
          store.updateMember(m.id, { email: p.email, memberTypeId: types.lid.id, cohort: p.member!.cohort, ibans: p.ibans, leftOn: null }, A);
        }
      }
      store.chargeContributions(first, A);
      tx("checking", addDays(first, 1), -30000, "Stichting Studentenhuisvesting", "Huur kelder", makeIban("ABNA", "0555666777"), [{ kind: "pot", id: pot("HUISVESTING").id, amount: cents(-30000) }]);
      const borrel = store.createActivity({ name: `Borrel ${first.slice(5, 7)}-${first.slice(0, 4)}`, heldOn: addDays(first, 10), potId: pot("BORRELS").id }, A);
      const kegs = between(2, 4) * 11500;
      tx("checking", addDays(first, 8), -kegs, "Drankenhandel De Tap", "Fusten borrel", TAP, [{ kind: "activity", id: borrel.id, amount: cents(-kegs) }]);
      flush();

      if (first === addMonths(previous.startDate, 2)) {
        // Winter party with Bacchus: kegs bought in October, party in December.
        const winter = store.createActivity({ name: "Winterfeest met Bacchus", heldOn: addDays(addMonths(first, 2), 11), potId: pot("ACTIVITEITEN").id }, A);
        tx("checking", addDays(first, 14), -69000, "Drankenhandel De Tap", "6 fusten winterfeest", TAP, [{ kind: "activity", id: winter.id, amount: cents(-69000) }]);
        flush();
      }
      if (first === addMonths(previous.startDate, 4)) {
        const winter = s().activities.find((a) => a.name === "Winterfeest met Bacchus")!;
        const claim = store.submitClaim({ partyId: members[6].id, amount: cents(8650), description: "Versiering en ijs winterfeest", target: { kind: "activity", id: winter.id }, receipt: null }, { role: "lid", partyId: members[6].id, label: members[6].name });
        store.approveClaim(claim.id, addDays(first, 12), A);
        const bal = derive(s(), false).activityBalance.get(winter.id)!;
        store.settleActivity(
          { activityId: winter.id, date: addDays(first, 14), expectedBalance: bal, shares: [...payers(first).filter(() => rand() < 0.8).map((m) => ({ partyId: m.id, partyKind: "member" as const, method: "equal" as const })), { partyId: bacchus.id, partyKind: "external" as const, method: "fixed" as const, fixedAmount: cents(30000) }] },
          A,
        );
      }
      if (first === addMonths(previous.startDate, 5)) {
        tx("checking", addDays(first, 11), 30000, "ABN AMRO Bank NV", `Tikkie ID 000123456, Winterfeest, Dispuut Bacchus, ${bacchus.ibans[0]}`, DEMO_IBAN.tikkie, [{ kind: "person", id: bacchus.id, amount: cents(30000) }]);
      }
      if (first === addMonths(previous.startDate, 6)) {
        tx("checking", addDays(first, 12), 50000, "Bakkerij Brood & Co", "Sponsoring", makeIban("INGB", "0777888999"), [{ kind: "pot", id: pot("SPONSORING").id, amount: cents(50000) }]);
      }
      if (first === addMonths(previous.startDate, 10)) {
        tx("checking", addDays(first, 19), -100000, "Dispuut Demo", "Naar spaarrekening", DEMO_IBAN.savings);
        tx("savings", addDays(first, 19), 100000, "Dispuut Demo", "Van betaalrekening", DEMO_IBAN.checking);
        tx("savings", addDays(first, 29), 1837, "Rabobank", "Rente", null, [{ kind: "pot", id: pot("BANK").id, amount: cents(1837) }]);
      }
      if (!isCurrentMonth) {
        const bal = derive(s(), false).activityBalance.get(borrel.id) ?? cents(0);
        store.settleActivity(
          { activityId: borrel.id, date: addDays(first, 12), expectedBalance: bal, shares: [...payers(first).filter(() => rand() < 0.7).map((m) => ({ partyId: m.id, partyKind: "member" as const, method: "weight" as const, weight: between(1, 12) })), { partyId: null, method: "fixed" as const, fixedAmount: cents(2500) }] },
          A,
        );
      }
      flush();
      if (!isCurrentMonth) {
        const day = addDays(first, 25);
        for (const m of payers(day)) {
          const owed = derive(s(), false).partyBalance.get(m.id) ?? 0;
          if (owed <= 0 || rand() > 0.85) continue;
          tx("checking", day, owed, m.name, `Dispuut ${m.name}`, m.ibans[0], [{ kind: "person", id: m.id, amount: cents(owed) }]);
        }
        tx("checking", addDays(first, 27), -1250, "Rabobank", "Kosten Rabo BasisPakket", null, [{ kind: "pot", id: pot("BANK").id, amount: cents(-1250) }]);
        flush();
      }
      if (first === addMonths(previous.startDate, 11)) {
        const prevFy = s().fiscalYears.find((f) => f.label === previous.label)!;
        store.dotateReserve({ date: previous.endDate, reserveAccountId: account("0510").id, amount: cents(50000), description: "Dotatie lustrumfonds (begroting)" }, A);
        let pnl = 0;
        for (const e of s().entries) if (e.fiscalYearId === prevFy.id) for (const l of e.lines) { const acc = s().accounts.find((a) => a.id === l.accountId)!; if (acc.type === "income" || acc.type === "expense") pnl += l.amount; }
        store.closeFiscalYear(prevFy.id, -pnl === 0 ? [] : [{ accountId: account("0500").id, amount: cents(-pnl) }], A);
      }
    }

    // Current year: the example from the association — kegs for a party that is still to come.
    const lastBooked = () => s().bankTransactions.filter((t) => t.bankAccountId === bank("checking").id).map((t) => t.bookingDate).sort().at(-1) ?? current.startDate;
    const clamp = (d: LocalDate): LocalDate => {
      const floor = lastBooked() > current.startDate ? lastBooked() : current.startDate;
      return d < floor ? floor : d;
    };
    const party = store.createActivity({ name: "Openingsfeest", heldOn: addDays(addMonths(current.startDate, 3), 13), potId: pot("ACTIVITEITEN").id }, A);
    const kegDay = clamp(addDays(today, -6));
    tx("checking", kegDay, -46000, "Drankenhandel De Tap", "4 fusten openingsfeest", TAP, [{ kind: "activity", id: party.id, amount: cents(-46000) }]);
    flush();
    // Work left to do: a few unassigned lines and claims waiting for approval.
    const someone = members[12];
    tx("checking", clamp(addDays(today, -3)), 4500, someone.name, "borrel + contributie", someone.ibans[0]);
    tx("checking", clamp(addDays(today, -2)), -2399, "Albert Heijn 1234", "Betaalautomaat AH", null);
    tx("checking", clamp(addDays(today, -1)), 2500, "ABN AMRO Bank NV", `Tikkie ID 000987654, Borrel, Dispuut Bacchus, ${bacchus.ibans[0]}`, DEMO_IBAN.tikkie);
    flush();
    store.submitClaim({ partyId: members[9].id, amount: cents(3475), description: "Chips en fris borrel", target: { kind: "activity", id: s().activities.find((a) => a.status === "open" && a.name.startsWith("Borrel"))!.id }, receipt: null }, { role: "lid", partyId: members[9].id, label: members[9].name });
    store.submitClaim({ partyId: members[3].id, amount: cents(1299), description: "Printen ALV-stukken", target: { kind: "pot", id: pot("ALV").id }, receipt: null }, { role: "lid", partyId: members[3].id, label: members[3].name });
  });
  return store.getState();
}

/**
 * A Rabobank CSV with new transactions that continue exactly where the checking account's
 * history ends (same volgnr sequence and saldo chain), so importing it demonstrates the flow.
 */
export function nextDemoCsv(state: State, today: LocalDate): { fileName: string; csv: string; count: number } {
  const checking = state.bankAccounts.find((b) => b.kind === "checking")!;
  const txs = state.bankTransactions.filter((t) => t.bankAccountId === checking.id);
  const last = txs.at(-1);
  let volgnr = last ? Number(last.externalId) : 1;
  let balance: number = last?.balanceAfter ?? derive(state).bankBalance.get(checking.id) ?? 0;
  const date = last && last.bookingDate > today ? last.bookingDate : today;
  const members = state.parties.filter((p) => p.kind === "member" && p.active && p.ibans.length);
  const bacchus = state.parties.find((p) => p.name === "Dispuut Bacchus");
  const d = derive(state);
  const owing = members.filter((m) => (d.partyBalance.get(m.id) ?? 0) > 0).slice(0, 3);
  const rows: { amount: number; name: string; desc: string; iban: string | null }[] = [
    ...owing.map((m) => ({ amount: d.partyBalance.get(m.id)!, name: m.name, desc: `Dispuut ${m.member?.firstName ?? m.name}`, iban: m.ibans[0] })),
    ...(bacchus ? [{ amount: 1750, name: "ABN AMRO Bank NV", desc: `Tikkie ID 000555111, Borrel, Dispuut Bacchus, ${bacchus.ibans[0] ?? ""}`, iban: DEMO_IBAN.tikkie }] : []),
    { amount: -1845, name: "Jumbo Utrecht", desc: "Betaalautomaat, chips borrel", iban: null },
    { amount: -1250, name: "Rabobank", desc: "Kosten Rabo BasisPakket", iban: null },
  ];
  const csvRows = rows.map((r) => {
    volgnr += 1;
    balance += r.amount;
    return { iban: checking.iban!, volgnr, date, amount: rabobankAmount(r.amount), balanceAfter: rabobankAmount(balance), counterpartyIban: r.iban ?? undefined, counterpartyName: r.name, description: r.desc };
  });
  return { fileName: `CSV_A_${checking.iban}_EUR_${date.replace(/-/g, "")}.csv`, csv: toRabobankCsv(csvRows), count: csvRows.length };
}

export type { Cents };
