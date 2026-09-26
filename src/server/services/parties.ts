import { eq } from "drizzle-orm";
import { schema, type Tx } from "../db";
import { audit } from "../audit";
import { cents, type Cents } from "@/domain/money";
import type { LocalDate } from "@/domain/dates";
import type { Actor } from "../ledger/post";
import { isValidIban, normalizeIban } from "./setup";

export async function createMemberType(
  tx: Tx,
  input: { name: string; monthlyContribution: Cents },
  actor: Actor,
) {
  cents(input.monthlyContribution);
  if (input.monthlyContribution < 0) throw new Error("Contributie kan niet negatief zijn");
  const [row] = await tx
    .insert(schema.memberTypes)
    .values({ name: input.name.trim(), monthlyContributionCents: input.monthlyContribution })
    .returning();
  await audit(tx, {
    actorUserId: actor.userId,
    action: "member_type.create",
    entityType: "member_type",
    entityId: row.id,
    data: { name: row.name, monthlyContributionCents: row.monthlyContributionCents },
  });
  return row;
}

async function addIbans(tx: Tx, partyId: string, ibans: string[]) {
  for (const raw of ibans) {
    const iban = normalizeIban(raw);
    if (!isValidIban(iban)) throw new Error(`Ongeldig IBAN: ${raw}`);
    const [existing] = await tx.select().from(schema.partyIbans).where(eq(schema.partyIbans.iban, iban));
    if (existing && existing.partyId !== partyId) {
      throw new Error(`IBAN ${iban} hoort al bij iemand anders`);
    }
    if (!existing) await tx.insert(schema.partyIbans).values({ iban, partyId });
  }
}

export interface CreateMemberInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  memberTypeId: string;
  cohort?: number | null;
  joinedOn: LocalDate;
  ibans?: string[];
}

/** Creates the party, member row, known IBANs and (if an e-mail is given) a login user. */
export async function createMember(tx: Tx, input: CreateMemberInput, actor: Actor) {
  const email = input.email?.trim().toLowerCase() || null;
  const name = `${input.firstName.trim()} ${input.lastName.trim()}`;
  const [party] = await tx
    .insert(schema.parties)
    .values({ kind: "member", name, email })
    .returning();
  await tx.insert(schema.members).values({
    partyId: party.id,
    memberTypeId: input.memberTypeId,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    cohort: input.cohort ?? null,
    joinedOn: input.joinedOn,
  });
  await addIbans(tx, party.id, input.ibans ?? []);
  if (email) await ensureUser(tx, { email, name, partyId: party.id });
  await audit(tx, {
    actorUserId: actor.userId,
    action: "member.create",
    entityType: "party",
    entityId: party.id,
    data: { name, email, memberTypeId: input.memberTypeId, joinedOn: input.joinedOn },
  });
  return party;
}

export async function createExternal(
  tx: Tx,
  input: { name: string; email?: string | null; notes?: string | null; ibans?: string[] },
  actor: Actor,
) {
  const [party] = await tx
    .insert(schema.parties)
    .values({
      kind: "external",
      name: input.name.trim(),
      email: input.email?.trim().toLowerCase() || null,
      notes: input.notes ?? null,
    })
    .returning();
  await addIbans(tx, party.id, input.ibans ?? []);
  await audit(tx, {
    actorUserId: actor.userId,
    action: "external.create",
    entityType: "party",
    entityId: party.id,
    data: { name: party.name },
  });
  return party;
}

/** Make sure a login user exists for this e-mail address (and link it to the party). */
export async function ensureUser(tx: Tx, input: { email: string; name?: string | null; partyId?: string | null }) {
  const email = input.email.trim().toLowerCase();
  const [existing] = await tx.select().from(schema.users).where(eq(schema.users.email, email));
  if (existing) {
    if (input.partyId && !existing.partyId) {
      await tx.update(schema.users).set({ partyId: input.partyId }).where(eq(schema.users.id, existing.id));
    }
    return existing;
  }
  const [user] = await tx
    .insert(schema.users)
    .values({ email, name: input.name ?? null, partyId: input.partyId ?? null })
    .returning();
  return user;
}

export async function rememberIban(tx: Tx, partyId: string, iban: string, actor: Actor) {
  await addIbans(tx, partyId, [iban]);
  await audit(tx, {
    actorUserId: actor.userId,
    action: "party.iban.add",
    entityType: "party",
    entityId: partyId,
    data: { iban: normalizeIban(iban) },
  });
}
