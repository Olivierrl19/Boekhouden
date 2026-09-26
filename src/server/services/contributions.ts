import { and, eq, isNull, lte, or, gte } from "drizzle-orm";
import { schema, type Tx } from "../db";
import { audit } from "../audit";
import { postEntry, type Actor } from "../ledger/post";
import { contributionCharged } from "@/domain/ledger/templates";
import { cents } from "@/domain/money";
import { formatMonthNl, firstOfMonth, type LocalDate } from "@/domain/dates";

/**
 * Charge the monthly contribution (T01) to every member who is a member on the 1st of the
 * month, at the rate of their member type. Idempotent per member and month (unique index +
 * existence check), so running it twice books nothing extra.
 */
export async function chargeContributionsForMonth(tx: Tx, monthInput: LocalDate, actor: Actor) {
  const month = firstOfMonth(monthInput);
  const [pot] = await tx.select().from(schema.pots).where(eq(schema.pots.code, "CONTRIBUTIE"));
  const [income] = await tx
    .select()
    .from(schema.ledgerAccounts)
    .where(eq(schema.ledgerAccounts.systemKey, "CONTRIBUTION"));
  if (!pot || !income) throw new Error("Potje Contributie of rekening Contributie ontbreekt");

  const candidates = await tx
    .select({
      partyId: schema.members.partyId,
      name: schema.parties.name,
      amount: schema.memberTypes.monthlyContributionCents,
      typeName: schema.memberTypes.name,
    })
    .from(schema.members)
    .innerJoin(schema.parties, eq(schema.parties.id, schema.members.partyId))
    .innerJoin(schema.memberTypes, eq(schema.memberTypes.id, schema.members.memberTypeId))
    .where(
      and(
        lte(schema.members.joinedOn, month),
        or(isNull(schema.members.leftOn), gte(schema.members.leftOn, month)),
      ),
    );

  const already = new Set(
    (
      await tx
        .select({ memberId: schema.contributionCharges.memberId })
        .from(schema.contributionCharges)
        .where(eq(schema.contributionCharges.month, month))
    ).map((r) => r.memberId),
  );

  let charged = 0;
  for (const c of candidates) {
    if (already.has(c.partyId) || c.amount === 0) continue;
    const [charge] = await tx
      .insert(schema.contributionCharges)
      .values({ memberId: c.partyId, month, amountCents: c.amount })
      .returning({ id: schema.contributionCharges.id });
    const entry = await postEntry(
      tx,
      contributionCharged({
        chargeId: charge.id,
        partyId: c.partyId,
        month,
        amount: cents(c.amount),
        potId: pot.id,
        incomeAccountId: income.id,
        description: `Contributie ${formatMonthNl(month)} (${c.typeName})`,
      }),
      actor,
    );
    await tx
      .update(schema.contributionCharges)
      .set({ entryId: entry.id })
      .where(eq(schema.contributionCharges.id, charge.id));
    charged++;
  }
  await audit(tx, {
    actorUserId: actor.userId,
    action: "contribution.charge_month",
    entityType: "contribution",
    entityId: month,
    data: { month, charged },
  });
  return { month, charged };
}
