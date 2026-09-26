/**
 * Example association for development and demos. RESETS THE DATABASE.
 *
 * - Fiscal year 2025-2026 (closed) and 2026-2027 (open), starting 1 August.
 * - ~40 members over four member types, a few externals.
 * - Synthetic bank history (monthly contributions paid, rent, bank costs, borrels split
 *   per person, a party with beer kegs bought in advance, an internal transfer to savings).
 * - The open year has a few unassigned transactions and an open activity, so every screen
 *   has something to show.
 *
 * Everything goes through the real services, so the seed also exercises the ledger rules.
 */
import "dotenv/config";
import { sql as dsql, eq } from "drizzle-orm";
import { createDb, schema, type Db, type Tx } from "./index";
import { installDefaults, ensureFiscalYear } from "../services/setup";
import { createExternal, createMember, createMemberType, ensureUser } from "../services/parties";
import { assignTransaction, recordTransactions, type NormalizedBankTransaction } from "../services/bank";
import { chargeContributionsForMonth } from "../services/contributions";
import { createActivity, settleActivity } from "../services/activities";
import { closeFiscalYear } from "../services/fiscal-years";
import { postEntry, type Actor } from "../ledger/post";
import { activityBalance, partyBalance, resultBalancesByPot } from "../ledger/balances";
import { expenseClaimApproved, openingBalance, reserveDotation, type AssignmentTarget } from "@/domain/ledger/templates";
import { cents, type Cents } from "@/domain/money";
import { addDays, addMonths, localDate, type LocalDate } from "@/domain/dates";

const SYSTEM: Actor = { userId: null };
const IBAN = { checking: "NL91RABO0315273637", savings: "NL70RABO3163450289", tikkie: "NL26ABNA0463712345" };

// Deterministic PRNG (mulberry32) so the seed is reproducible.
function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(20260801);
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

// Valid Dutch IBANs for fake members (bank code + 10 digits, check digits computed).
function makeIban(bank: string, account: string): string {
  const rearranged = `${bank}${account}NL00`;
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= "A" && ch <= "Z" ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const d of code) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return `NL${String(98 - remainder).padStart(2, "0")}${bank}${account}`;
}

const FIRST = ["Sanne", "Bram", "Lotte", "Daan", "Eva", "Thijs", "Iris", "Ruben", "Noor", "Sem", "Fleur", "Lucas", "Anna", "Jesse", "Julia", "Max", "Sophie", "Tim", "Emma", "Luuk", "Lisa", "Stijn", "Roos", "Milan", "Femke", "Joris", "Isa", "Koen", "Maud", "Pim", "Vera", "Olaf", "Merel", "Teun", "Floor", "Gijs", "Zoë", "Hidde", "Nina", "Wouter"];
const LAST = ["de Vries", "Jansen", "Bakker", "Visser", "Smit", "Meijer", "de Boer", "Mulder", "de Groot", "Bos", "Vos", "Peters", "Hendriks", "van Leeuwen", "Dekker", "Brouwer", "de Wit", "Dijkstra", "Smits", "de Graaf"];

interface Ctx {
  tx: Tx;
  checkingId: string;
  savingsId: string;
  balances: { checking: number; savings: number };
  volgnr: { checking: number; savings: number };
}

async function bankTx(
  ctx: Ctx,
  account: "checking" | "savings",
  date: LocalDate,
  amount: number,
  counterpartyName: string,
  description: string,
  counterpartyIban: string | null,
  target?: AssignmentTarget | "internal",
) {
  ctx.balances[account] += amount;
  ctx.volgnr[account] += 1;
  const t: NormalizedBankTransaction = {
    accountIban: IBAN[account],
    externalId: String(ctx.volgnr[account]).padStart(18, "0"),
    bookingDate: date,
    valueDate: date,
    amount: cents(amount),
    balanceAfter: cents(ctx.balances[account]),
    counterpartyIban,
    counterpartyName,
    description,
  };
  const { newIds, autoAssigned } = await recordTransactions(
    ctx.tx,
    account === "checking" ? ctx.checkingId : ctx.savingsId,
    [t],
    SYSTEM,
  );
  if (target && target !== "internal" && autoAssigned === 0) {
    await assignTransaction(ctx.tx, newIds[0], [target], SYSTEM);
  }
  return newIds[0];
}

async function reset(db: Db) {
  const tables = await db.execute<{ tablename: string }>(dsql`select tablename from pg_tables where schemaname = 'public'`);
  if (tables.length) await db.execute(dsql.raw(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`));
}

export async function seed(db: Db) {
  await reset(db);
  await db.transaction(async (tx) => {
    await installDefaults(
      tx,
      {
        name: "Dispuut Demo",
        shortName: "Demo",
        fiscalYearStartMonth: 8,
        paymentIban: IBAN.checking,
        paymentAccountName: "Dispuut Demo",
        mailFrom: "fiscus@dispuut-demo.nl",
        bankAccounts: [
          { name: "Rabo betaalrekening", iban: IBAN.checking, kind: "checking" },
          { name: "Rabo spaarrekening", iban: IBAN.savings, kind: "savings" },
          { name: "Kas", iban: null, kind: "cash" },
        ],
      },
      SYSTEM,
    );
    const fy1 = await ensureFiscalYear(tx, localDate("2025-08-01"), SYSTEM);
    const fy2 = await ensureFiscalYear(tx, localDate("2026-08-01"), SYSTEM);

    const types = {
      lid: await createMemberType(tx, { name: "Lid", monthlyContribution: cents(1500) }, SYSTEM),
      aspirant: await createMemberType(tx, { name: "Aspirant", monthlyContribution: cents(1000) }, SYSTEM),
      oudLid: await createMemberType(tx, { name: "Oud-lid", monthlyContribution: cents(500) }, SYSTEM),
      reunist: await createMemberType(tx, { name: "Reünist", monthlyContribution: cents(0) }, SYSTEM),
    };

    // Members: cohorts 2021–2025. The newest cohort joins in September 2026 as aspirant.
    const members: { id: string; name: string; iban: string; joinedOn: LocalDate; type: string }[] = [];
    for (let i = 0; i < 40; i++) {
      const cohort = 2021 + Math.floor(i / 8);
      const first = FIRST[i];
      const last = LAST[i % LAST.length];
      const joinedOn = localDate(cohort === 2026 ? "2026-09-15" : `${cohort}-09-01`);
      const type = cohort <= 2021 ? (i % 2 ? types.oudLid : types.reunist) : cohort === 2025 ? types.aspirant : types.lid;
      const iban = makeIban(pick(["INGB", "RABO", "ABNA", "SNSB", "TRIO"]), String(1000000000 + i * 7919).slice(0, 10));
      const email = `${first.toLowerCase().replace("ë", "e")}@dispuut-demo.nl`;
      const party = await createMember(
        tx,
        { firstName: first, lastName: last, email, memberTypeId: type.id, cohort, joinedOn, ibans: [iban] },
        SYSTEM,
      );
      members.push({ id: party.id, name: `${first} ${last}`, iban, joinedOn, type: type.name });
    }
    // The 2025 cohort became full members on 1 August 2026.
    for (const m of members.filter((x) => x.type === "Aspirant")) {
      await tx.update(schema.members).set({ memberTypeId: types.lid.id }).where(eq(schema.members.partyId, m.id));
    }
    // New aspirants in September 2026.
    const newcomers = [["Jip", "Kok"], ["Tess", "Maas"], ["Ties", "Post"], ["Lina", "Kuiper"]];
    for (const [i, [first, last]] of newcomers.entries()) {
      const iban = makeIban("INGB", String(2000000000 + i * 104729).slice(0, 10));
      const party = await createMember(
        tx,
        { firstName: first, lastName: last, email: `${first.toLowerCase()}@dispuut-demo.nl`, memberTypeId: types.aspirant.id, cohort: 2026, joinedOn: localDate("2026-09-15"), ibans: [iban] },
        SYSTEM,
      );
      members.push({ id: party.id, name: `${first} ${last}`, iban, joinedOn: localDate("2026-09-15"), type: "Aspirant" });
    }

    const externals = {
      bacchus: await createExternal(tx, { name: "Dispuut Bacchus", email: "fiscus@bacchus.example" }, SYSTEM),
      tap: await createExternal(tx, { name: "Drankenhandel De Tap", ibans: [makeIban("RABO", "0123456789")] }, SYSTEM),
      sponsor: await createExternal(tx, { name: "Bakkerij Brood & Co", email: "info@brood.example" }, SYSTEM),
    };

    // Users and roles. Previous board: Bram (fiscus 2025-2026); current: Sanne.
    const byFirst = (f: string) => members.find((m) => m.name.startsWith(f))!;
    const role = async (email: string, fyId: string, r: "fiscus" | "bestuur" | "kascommissie") => {
      const user = await ensureUser(tx, { email });
      await tx.insert(schema.roleAssignments).values({ userId: user.id, fiscalYearId: fyId, role: r });
    };
    await role("bram@dispuut-demo.nl", fy1.id, "fiscus");
    await role("lotte@dispuut-demo.nl", fy1.id, "bestuur");
    await role("sanne@dispuut-demo.nl", fy2.id, "fiscus");
    await role("daan@dispuut-demo.nl", fy2.id, "bestuur");
    await role("eva@dispuut-demo.nl", fy2.id, "bestuur");
    await role("thijs@dispuut-demo.nl", fy1.id, "kascommissie");
    await role("thijs@dispuut-demo.nl", fy2.id, "kascommissie");

    const pots = await tx.select().from(schema.pots);
    const accounts = await tx.select().from(schema.ledgerAccounts);
    const pot = (code: string) => pots.find((p) => p.code === code)!;
    const acc = (code: string) => accounts.find((a) => a.code === code)!;
    const banks = await tx.select().from(schema.bankAccounts);
    const ctx: Ctx = {
      tx,
      checkingId: banks.find((b) => b.kind === "checking")!.id,
      savingsId: banks.find((b) => b.kind === "savings")!.id,
      balances: { checking: 245000, savings: 500000 },
      volgnr: { checking: 41230, savings: 812 },
    };

    // Budgets for both years.
    const budget: [string, "income" | "expense", number][] = [
      ["CONTRIBUTIE", "income", 540000], ["SPONSORING", "income", 50000], ["HUISVESTING", "expense", 360000],
      ["BORRELS", "expense", 40000], ["ACTIVITEITEN", "expense", 60000], ["BESTUUR", "expense", 25000],
      ["ALV", "expense", 10000], ["BANK", "expense", 15000], ["RESERVERINGEN", "expense", 50000],
    ];
    for (const fy of [fy1, fy2]) {
      for (const [code, kind, amount] of budget) {
        await tx.insert(schema.budgetLines).values({ fiscalYearId: fy.id, potId: pot(code).id, kind, amountCents: amount });
      }
    }

    // ---- 2025-2026 ------------------------------------------------------------
    await postEntry(
      tx,
      openingBalance({
        date: localDate("2025-08-01"),
        bank: [
          { ledgerAccountId: acc("1000").id, amount: cents(245000) },
          { ledgerAccountId: acc("1010").id, amount: cents(500000) },
          { ledgerAccountId: acc("1050").id, amount: cents(15000) },
        ],
        persons: [],
        activities: [],
        other: [{ accountId: acc("0510").id, amount: cents(-100000) }],
      })!,
      SYSTEM,
    );

    const activeOn = (d: LocalDate) => members.filter((m) => m.joinedOn <= d);
    const payers = (d: LocalDate) => activeOn(d).filter((m) => m.type !== "Reünist");

    // Bank transactions must be recorded in date order (the import refuses gaps and back-dating),
    // so each month runs: contribution, rent (day 2), borrel kegs (day 9), special events,
    // member payments (day 26), bank costs (day 28).
    async function month(
      first: LocalDate,
      opts: { settleBorrel: boolean; paymentShare: number; bankCosts?: boolean; specials?: () => Promise<void> },
    ) {
      await chargeContributionsForMonth(tx, first, SYSTEM);
      await bankTx(ctx, "checking", addDays(first, 1), -30000, "Stichting Studentenhuisvesting", "Huur kelder", makeIban("ABNA", "0555666777"), {
        kind: "pot", potId: pot("HUISVESTING").id, accountId: acc("4100").id, amount: cents(-30000),
      });
      const borrel = await createActivity(tx, { name: `Borrel ${first.slice(0, 7)}`, heldOn: addDays(first, 10), potId: pot("BORRELS").id, date: first }, SYSTEM);
      const kegs = between(2, 4) * 11500;
      await bankTx(ctx, "checking", addDays(first, 8), -kegs, "Drankenhandel De Tap", "Fusten borrel", makeIban("RABO", "0123456789"), {
        kind: "activity", activityId: borrel.id, amount: cents(-kegs),
      });
      if (opts.settleBorrel) {
        // Split per person by streepjes; the association pays € 25 itself.
        const attendees = payers(first).filter(() => rand() < 0.7);
        const balance = await activityBalance(tx, borrel.id);
        await settleActivity(
          tx,
          {
            activityId: borrel.id,
            date: addDays(first, 12),
            expectedBalance: balance,
            shares: [
              ...attendees.map((m) => ({ partyId: m.id, partyKind: "member" as const, method: "weight" as const, weight: between(1, 12) })),
              { partyId: null, method: "fixed" as const, fixedAmount: cents(2500) },
            ],
          },
          SYSTEM,
        );
      }
      await opts.specials?.();
      if (opts.paymentShare > 0) {
        const day = addDays(first, 25);
        for (const m of payers(day)) {
          const owed = await partyBalance(tx, m.id);
          if (owed <= 0 || rand() > opts.paymentShare) continue;
          await bankTx(ctx, "checking", day, owed, m.name, `Dispuut ${m.name}`, m.iban, {
            kind: "person", partyId: m.id, partyKind: "member", amount: cents(owed),
          });
        }
      }
      if (opts.bankCosts === false) return;
      await bankTx(ctx, "checking", addDays(first, 27), -1250, "Rabobank", "Kosten Rabo BasisPakket", null, {
        kind: "pot", potId: pot("BANK").id, accountId: acc("4500").id, amount: cents(-1250),
      });
    }

    // Winter party with Bacchus: kegs bought in October, party in December, Bacchus pays by Tikkie in January.
    const winter = await createActivity(tx, { name: "Winterfeest met Bacchus", heldOn: localDate("2025-12-12"), potId: pot("ACTIVITEITEN").id, date: localDate("2025-10-01") }, SYSTEM);
    const specials2025: Record<string, () => Promise<void>> = {
      "2025-10-01": async () => {
        await bankTx(ctx, "checking", localDate("2025-10-15"), -69000, "Drankenhandel De Tap", "6 fusten winterfeest", makeIban("RABO", "0123456789"), {
          kind: "activity", activityId: winter.id, amount: cents(-69000),
        });
      },
      "2025-12-01": async () => {
        await postEntry(
          tx,
          expenseClaimApproved({ claimId: "seed-claim-1", partyId: byFirst("Iris").id, date: localDate("2025-12-13"), amount: cents(8650), target: { kind: "activity", activityId: winter.id }, description: "Versiering en ijs" }),
          SYSTEM,
        );
        const balance = await activityBalance(tx, winter.id);
        const attendees = payers(localDate("2025-12-12")).filter(() => rand() < 0.8);
        await settleActivity(
          tx,
          {
            activityId: winter.id,
            date: localDate("2025-12-15"),
            expectedBalance: balance,
            shares: [
              ...attendees.map((m) => ({ partyId: m.id, partyKind: "member" as const, method: "equal" as const })),
              { partyId: externals.bacchus.id, partyKind: "external" as const, method: "fixed" as const, fixedAmount: cents(30000) },
            ],
          },
          SYSTEM,
        );
      },
      "2026-01-01": async () => {
        await bankTx(ctx, "checking", localDate("2026-01-12"), 30000, "ABN AMRO Bank NV", "Tikkie ID 000123456, Winterfeest, Dispuut Bacchus, NL44ABNA0123456789", IBAN.tikkie, {
          kind: "person", partyId: externals.bacchus.id, partyKind: "external", amount: cents(30000),
        });
      },
      "2026-02-01": async () => {
        await bankTx(ctx, "checking", localDate("2026-02-13"), 50000, "Bakkerij Brood & Co", "Sponsoring 2025-2026", makeIban("INGB", "0777888999"), {
          kind: "pot", potId: pot("SPONSORING").id, accountId: acc("8100").id, amount: cents(50000),
        });
      },
      "2026-06-01": async () => {
        await bankTx(ctx, "checking", localDate("2026-06-20"), -100000, "Dispuut Demo", "Naar spaarrekening", IBAN.savings, "internal");
        await bankTx(ctx, "savings", localDate("2026-06-20"), 100000, "Dispuut Demo", "Van betaalrekening", IBAN.checking, "internal");
        await bankTx(ctx, "savings", localDate("2026-06-30"), 1837, "Rabobank", "Rente", null, {
          kind: "pot", potId: pot("BANK").id, accountId: acc("8800").id, amount: cents(1837),
        });
      },
    };

    for (let i = 0; i < 12; i++) {
      const first = addMonths(localDate("2025-08-01"), i);
      await month(first, { settleBorrel: true, paymentShare: i === 11 ? 1 : 0.85, specials: specials2025[first] });
    }
    await postEntry(tx, reserveDotation({ date: localDate("2026-07-31"), reserveAccountId: acc("0510").id, amount: cents(50000), potId: pot("RESERVERINGEN").id, description: "Dotatie lustrumfonds (begroting)" }), SYSTEM);

    // Close 2025-2026: the whole result goes to the general reserve.
    const result = -(await resultBalancesByPot(tx, fy1.id)).reduce((s, r) => s + r.amount, 0);
    await closeFiscalYear(
      tx,
      { fiscalYearId: fy1.id, appropriation: result === 0 ? [] : [{ accountId: acc("0500").id, amount: cents(result) as Cents }] },
      SYSTEM,
    );

    // ---- 2026-2027 (open) -----------------------------------------------------
    await month(localDate("2026-08-01"), { settleBorrel: true, paymentShare: 0.8 });
    const opening = await createActivity(tx, { name: "Openingsfeest", heldOn: localDate("2026-11-14"), potId: pot("ACTIVITEITEN").id, date: localDate("2026-09-01") }, SYSTEM);
    await month(localDate("2026-09-01"), {
      settleBorrel: false,
      paymentShare: 0,
      bankCosts: false, // "today" in the demo is late September
      specials: async () => {
        // The user's example: kegs for the opening party in November, bought in September.
        await bankTx(ctx, "checking", localDate("2026-09-18"), -46000, "Drankenhandel De Tap", "4 fusten openingsfeest", makeIban("RABO", "0123456789"), {
          kind: "activity", activityId: opening.id, amount: cents(-46000),
        });
        // A few unassigned transactions, so the dashboard shows work to do.
        const someone = members[12];
        await bankTx(ctx, "checking", localDate("2026-09-22"), 4500, someone.name, "borrel + contributie", someone.iban);
        await bankTx(ctx, "checking", localDate("2026-09-23"), -2399, "Albert Heijn 1234", "Betaalautomaat AH", null);
        await bankTx(ctx, "checking", localDate("2026-09-24"), 2500, "ABN AMRO Bank NV", "Tikkie ID 000987654, Borrel sept, Dispuut Bacchus, NL44ABNA0123456789", IBAN.tikkie);
      },
    });
  });
}

if (process.argv[1]?.endsWith("seed.ts")) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, sql } = createDb(url);
  seed(db)
    .then(() => console.log("Voorbeelddispuut aangemaakt. Log in als sanne@dispuut-demo.nl (fiscus)."))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => sql.end());
}
